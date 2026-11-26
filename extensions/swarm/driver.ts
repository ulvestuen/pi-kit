// One swarm worker = one long-lived `pi --mode rpc` child. The driver frames stdout as strict LF-delimited JSONL
// (not readline, which also splits on U+2028/U+2029), correlates command responses by id, answers extension dialogs
// with "cancelled" so a worker can never block on a UI nobody sees, and reports every session event. See docs/rpc.md.

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { basename } from "node:path";
import { StringDecoder } from "node:string_decoder";

export interface PiCommand {
  command: string;
  args: string[];
}

/** How to start Pi from inside Pi: the running CLI script under the same runtime, else `pi` on PATH. */
export function piInvocation(argv = process.argv, execPath = process.execPath): PiCommand {
  const script = argv[1];
  const virtual = script && (script.startsWith("/$bunfs/root/") || /^[A-Za-z]:[\\/]~BUN[\\/]root[\\/]/.test(script));
  if (script && !virtual && existsSync(script)) return { command: execPath, args: [script] };
  if (!/^(node|bun)(\.exe)?$/i.test(basename(execPath))) return { command: execPath, args: [] };
  return { command: "pi", args: [] };
}

/** Splits a byte stream into LF-terminated records, dropping an optional CR. Unicode separators stay inside records. */
export class LineSplitter {
  private readonly decoder = new StringDecoder("utf8");
  private buffer = "";
  push(chunk: Buffer | string, onLine: (line: string) => void) {
    this.buffer += typeof chunk === "string" ? chunk : this.decoder.write(chunk);
    let nl: number;
    while ((nl = this.buffer.indexOf("\n")) >= 0) {
      let line = this.buffer.slice(0, nl);
      this.buffer = this.buffer.slice(nl + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (line) onLine(line);
    }
  }
}

export interface RpcWorkerOptions {
  name: string;
  cwd: string;
  pi: PiCommand;
  /** Arguments after `--mode rpc`. */
  args: string[];
  env: Record<string, string>;
  /** Inherited variables to drop (for example the coordinator's PI_SESSION_FILE). */
  unset?: string[];
  onEvent: (event: any) => void;
  onExit: (info: { code: number | null; signal: NodeJS.Signals | null; expected: boolean; stderr: string }) => void;
  commandTimeoutMs?: number;
}

export class RpcWorker {
  private child: ChildProcess | null = null;
  private nextId = 1;
  private readonly waiting = new Map<string, { resolve: (r: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private stderr = "";
  private stopping = false;
  private exitPromise: Promise<void> | null = null;

  constructor(private readonly options: RpcWorkerOptions) {}

  get running(): boolean {
    return this.child !== null;
  }

  get pid(): number | undefined {
    return this.child?.pid;
  }

  start(extraArgs: string[] = []): void {
    if (this.child) return;
    const { pi, cwd, env } = this.options;
    this.stopping = false;
    this.stderr = "";
    const childEnv: NodeJS.ProcessEnv = { ...process.env, ...env };
    for (const key of this.options.unset ?? []) delete childEnv[key];
    const child = spawn(pi.command, [...pi.args, "--mode", "rpc", ...this.options.args, ...extraArgs], {
      cwd,
      env: childEnv,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.child = child;
    const splitter = new LineSplitter();
    child.stdout!.on("data", (chunk: Buffer) => splitter.push(chunk, (line) => this.onLine(line)));
    child.stderr!.on("data", (chunk: Buffer) => {
      this.stderr = (this.stderr + chunk.toString("utf8")).slice(-8_000);
    });
    child.stdin!.on("error", () => undefined);
    this.exitPromise = new Promise((resolve) => {
      let done = false;
      const finish = (code: number | null, signal: NodeJS.Signals | null, error?: Error) => {
        if (done) return;
        done = true;
        this.child = null;
        for (const [, w] of this.waiting) {
          clearTimeout(w.timer);
          w.reject(new Error(error?.message ?? `worker exited (${signal ?? code})`));
        }
        this.waiting.clear();
        if (error) this.stderr += `\n${error.message}`;
        this.options.onExit({ code, signal, expected: this.stopping, stderr: this.stderr });
        resolve();
      };
      child.on("exit", (code, signal) => finish(code, signal));
      child.on("error", (error) => finish(null, null, error));
    });
  }

  /** Send a prompt; resolves with Pi's disposition ("started" | "queued" | "handled"). */
  async prompt(message: string): Promise<string> {
    const response = await this.command({ type: "prompt", message, streamingBehavior: "followUp" });
    return response?.data?.disposition ?? "started";
  }

  command(record: Record<string, unknown>, timeoutMs = this.options.commandTimeoutMs ?? 30_000): Promise<any> {
    const child = this.child;
    if (!child) return Promise.reject(new Error(`worker ${this.options.name} is not running`));
    const id = `swarm-${this.nextId++}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        reject(new Error(`${record.type} timed out`));
      }, timeoutMs);
      this.waiting.set(id, { resolve, reject, timer });
      child.stdin!.write(JSON.stringify({ ...record, id }) + "\n");
    });
  }

  /** Abort the run, close stdin (orderly shutdown), then escalate to SIGTERM and SIGKILL. */
  async stop(graceMs = 3_000): Promise<void> {
    const child = this.child;
    if (!child) return;
    this.stopping = true;
    const exited = this.exitPromise!;
    await Promise.race([this.command({ type: "abort" }, graceMs).catch(() => undefined), exited]);
    child.stdin!.end();
    const wait = (ms: number) => Promise.race([exited.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), ms).unref())]);
    if (await wait(graceMs)) return;
    child.kill("SIGTERM");
    if (await wait(graceMs)) return;
    child.kill("SIGKILL");
    await exited;
  }

  private onLine(line: string) {
    let record: any;
    try {
      record = JSON.parse(line);
    } catch {
      return;
    }
    if (record?.type === "response" && typeof record.id === "string" && this.waiting.has(record.id)) {
      const w = this.waiting.get(record.id)!;
      this.waiting.delete(record.id);
      clearTimeout(w.timer);
      if (record.success === false) w.reject(new Error(record.error ?? `${record.command} failed`));
      else w.resolve(record);
      return;
    }
    if (record?.type === "extension_ui_request") {
      if (["select", "confirm", "input", "editor"].includes(record.method)) {
        this.child?.stdin?.write(JSON.stringify({ type: "extension_ui_response", id: record.id, cancelled: true }) + "\n");
        return;
      }
    }
    this.options.onEvent(record);
  }
}
