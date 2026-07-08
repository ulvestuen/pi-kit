/**
 * exe.dev backend — jobs run on a cloud VM instead of this machine.
 *
 * exe.dev's API is SSH (https://exe.dev/docs/api): `ssh exe.dev <command>`
 * manages VMs (`new`, `ls --json`, `rm`), and `ssh <vm>.exe.xyz` is a full
 * SSH connection into a VM. The default exeuntu image ships with `pi`
 * preinstalled, so a job is: pipe a run script onto the VM over ssh, start
 * it with setsid+nohup so it survives the connection, and poll its done
 * marker and pid file — the remote twins of the local markers — over ssh.
 *
 * The backend reuses one VM (config.exedevVm) for all jobs, creating it on
 * first use when allowed. It never deletes the VM: that is a billable,
 * user-owned resource (`ssh exe.dev rm <vm>` when you are done with it).
 */

import { shellQuote } from "../../fleet/tmux.ts";
import {
  buildEnvExports,
  buildPiShellCommand,
  buildShellCommand,
} from "../agent-command.ts";
import type { SpawnConfig } from "../config.ts";
import {
  resolveStatus,
  type ExecFn,
  type LaunchRequest,
  type SpawnBackend,
  type SpawnJob,
} from "../jobs.ts";

/** Lifecycle commands go to the exe.dev "lobby", not a VM. */
export const EXEDEV_LOBBY = "exe.dev";

const SSH_PROBE_TIMEOUT_MS = 30_000;
const SSH_LAUNCH_TIMEOUT_MS = 60_000;
const VM_CREATE_TIMEOUT_MS = 300_000;
const VM_READY_TIMEOUT_MS = 180_000;
const VM_READY_POLL_MS = 5_000;

/** Job directory on the VM, relative to $HOME. */
export function remoteJobDir(jobName: string): string {
  return `.pi-spawn/${jobName}`;
}

/** Shell fragment resolving a job's absolute directory on the VM. */
function remoteDirExpr(remoteDir: string): string {
  return `"$HOME/"${shellQuote(remoteDir)}`;
}

/**
 * The run script executed on the VM. It records its own pid (setsid makes
 * it a session leader, so that pid also names the process group), runs pi
 * from $HOME with output captured to the job log, and writes the exit code
 * to the done marker.
 */
export function buildRemoteRunScript(options: {
  jobName: string;
  piCommand: string;
  remoteDir: string;
  envExports: string[];
  /** Optional cwd for prebuilt synchronous runner commands. */
  cwd?: string;
}): string {
  const d = remoteDirExpr(options.remoteDir);
  const cwd = options.cwd ? shellQuote(options.cwd) : '"$HOME"';
  return [
    "#!/bin/sh",
    `# pi-spawn job ${options.jobName}: one detached sub-agent on this VM.`,
    `d=${d}`,
    'echo $$ > "$d/pid"',
    ...options.envExports,
    `cd ${cwd} || { echo 127 > "$d/done"; exit 127; }`,
    `{ ${options.piCommand}; echo $? > "$d/done"; } > "$d/job.log" 2>&1`,
    "",
  ].join("\n");
}

/**
 * The launch command run over ssh with the run script on stdin: store the
 * script, then double-fork it into its own session so it survives both the
 * ssh connection and any later SIGHUP.
 */
export function buildLaunchCommand(remoteDir: string): string {
  const d = remoteDirExpr(remoteDir);
  return [
    `d=${d}`,
    'mkdir -p "$d"',
    'cat > "$d/run.sh"',
    'chmod 700 "$d/run.sh"',
    '(setsid nohup sh "$d/run.sh" > /dev/null 2>&1 &)',
    "echo launched",
  ].join(" && ");
}

/**
 * One-round-trip status probe: prints `done:<exitcode>`, `running`, or
 * `lost`. Distinguishing these from ssh/network failure matters — refresh
 * must not mark a job lost just because the network blipped.
 */
export function buildProbeCommand(remoteDir: string): string {
  const d = remoteDirExpr(remoteDir);
  return (
    `d=${d}; ` +
    'if [ -s "$d/done" ]; then echo "done:$(cat "$d/done")"; ' +
    'elif [ -s "$d/pid" ] && kill -0 "$(cat "$d/pid")" 2>/dev/null; then echo running; ' +
    "else echo lost; fi"
  );
}

/** Tail the remote job log; prints a placeholder when there is none yet. */
export function buildTailCommand(remoteDir: string, maxBytes: number): string {
  const d = remoteDirExpr(remoteDir);
  if (!Number.isFinite(maxBytes)) {
    return `d=${d}; cat "$d/job.log" 2>/dev/null || echo "(no output yet)"`;
  }
  return `d=${d}; tail -c ${Math.max(1, Math.floor(maxBytes))} "$d/job.log" 2>/dev/null || echo "(no output yet)"`;
}

/** SIGTERM the job's process group (setsid made pid == pgid). */
export function buildKillCommand(remoteDir: string): string {
  const d = remoteDirExpr(remoteDir);
  return `d=${d}; if [ -s "$d/pid" ]; then kill -TERM -- "-$(cat "$d/pid")" 2>/dev/null || kill -TERM "$(cat "$d/pid")" 2>/dev/null; fi; true`;
}

/** Shape of `ssh exe.dev ls --json` (see https://exe.dev/docs/api). */
export interface ExedevVmInfo {
  vm_name: string;
  ssh_dest?: string;
  status?: string;
}

/** Parse `ssh exe.dev ls --json` output into its VM list. */
export function parseVmList(stdout: string): ExedevVmInfo[] {
  const parsed = JSON.parse(stdout);
  const vms = Array.isArray(parsed) ? parsed : parsed?.vms;
  if (!Array.isArray(vms)) {
    throw new Error("unexpected `ssh exe.dev ls --json` output shape");
  }
  return vms.filter(
    (vm: any): vm is ExedevVmInfo => typeof vm?.vm_name === "string",
  );
}

export function createExedevBackend(
  exec: ExecFn,
  config: SpawnConfig,
  options: { now?: () => number; sleep?: (ms: number) => Promise<void> } = {},
): SpawnBackend {
  const now = options.now ?? Date.now;
  const sleep =
    options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));

  const ssh = (
    dest: string,
    command: string,
    opts: { stdin?: string; timeoutMs?: number } = {},
  ) =>
    exec(
      config.sshBinary,
      ["-o", "BatchMode=yes", dest, command],
      { timeoutMs: SSH_PROBE_TIMEOUT_MS, ...opts },
    );

  const fallbackDest = () => `${config.exedevVm}.${config.exedevDomain}`;

  /** Find or create the configured VM; returns its ssh destination. */
  const ensureVm = async (): Promise<string> => {
    const list = await ssh(EXEDEV_LOBBY, "ls --json");
    if (list.exitCode !== 0) {
      throw new Error(
        `\`ssh exe.dev ls\` failed: ${list.stderr.trim() || "is your exe.dev SSH access set up? Try \`ssh exe.dev whoami\`"}`,
      );
    }
    let vms: ExedevVmInfo[];
    try {
      vms = parseVmList(list.stdout);
    } catch (e: any) {
      throw new Error(`could not parse exe.dev VM list: ${e?.message ?? e}`);
    }
    const existing = vms.find((vm) => vm.vm_name === config.exedevVm);
    if (existing) return existing.ssh_dest || fallbackDest();

    if (!config.exedevAutoCreate) {
      throw new Error(
        `exe.dev VM "${config.exedevVm}" does not exist and exedevAutoCreate is off; create it with: ssh exe.dev new --name=${config.exedevVm}`,
      );
    }
    const created = await ssh(
      EXEDEV_LOBBY,
      `new --name=${config.exedevVm} --json`,
      { timeoutMs: VM_CREATE_TIMEOUT_MS },
    );
    if (created.exitCode !== 0) {
      throw new Error(
        `could not create exe.dev VM "${config.exedevVm}": ${created.stderr.trim() || created.stdout.trim() || "unknown error"}`,
      );
    }
    const dest = fallbackDest();
    const deadline = now() + VM_READY_TIMEOUT_MS;
    for (;;) {
      const probe = await ssh(dest, "true");
      if (probe.exitCode === 0) return dest;
      if (now() >= deadline) {
        throw new Error(
          `exe.dev VM "${config.exedevVm}" was created but did not accept SSH within ${Math.round(VM_READY_TIMEOUT_MS / 1000)}s`,
        );
      }
      await sleep(VM_READY_POLL_MS);
    }
  };

  return {
    name: "exedev",

    async available() {
      const probe = await exec(config.sshBinary, ["-V"]);
      return probe.exitCode === 0
        ? undefined
        : `${config.sshBinary} is not available (the exedev backend needs an ssh client)`;
    },

    async launch(request: LaunchRequest): Promise<SpawnJob> {
      const dest = await ensureVm();
      const remoteDir = remoteJobDir(request.jobName);
      const runScript = buildRemoteRunScript({
        jobName: request.jobName,
        piCommand: request.command
          ? buildShellCommand(request.command, request.args ?? [])
          : buildPiShellCommand(
              config.piBinary,
              request.agent,
              request.task,
            ),
        remoteDir,
        envExports: config.exedevForwardEnv
          ? buildEnvExports(config.envPassthrough, process.env)
          : [],
        cwd: request.command ? request.cwd : undefined,
      });
      const launched = await ssh(dest, buildLaunchCommand(remoteDir), {
        stdin: runScript,
        timeoutMs: SSH_LAUNCH_TIMEOUT_MS,
      });
      if (launched.exitCode !== 0 || !launched.stdout.includes("launched")) {
        throw new Error(
          `could not launch job on ${dest}: ${launched.stderr.trim() || launched.stdout.trim() || "unknown error"}`,
        );
      }
      const at = now();
      return {
        name: request.jobName,
        backend: "exedev",
        agent: request.agent.name,
        task: request.task,
        cwd: request.cwd,
        status: "running",
        createdAt: at,
        updatedAt: at,
        vmName: config.exedevVm,
        sshDest: dest,
        remoteDir,
      };
    },

    async refresh(job: SpawnJob): Promise<boolean> {
      if (!job.sshDest || !job.remoteDir) return false;
      const probe = await ssh(job.sshDest, buildProbeCommand(job.remoteDir));
      // ssh/network failure: keep the last known state rather than guessing.
      if (probe.exitCode !== 0) return false;
      const answer = probe.stdout.trim();
      const resolved = answer.startsWith("done:")
        ? resolveStatus(answer.slice("done:".length), false)
        : answer === "running"
          ? resolveStatus(undefined, true)
          : resolveStatus(undefined, false);
      if (
        resolved.status === job.status &&
        resolved.exitCode === job.exitCode
      ) {
        return false;
      }
      job.status = resolved.status;
      job.exitCode = resolved.exitCode;
      job.updatedAt = now();
      return true;
    },

    async output(job: SpawnJob, maxBytes: number): Promise<string> {
      if (!job.sshDest || !job.remoteDir) return "(no output yet)";
      const tail = await ssh(
        job.sshDest,
        buildTailCommand(job.remoteDir, maxBytes),
      );
      if (tail.exitCode !== 0) {
        return `(could not read remote log: ${tail.stderr.trim() || "ssh failed"})`;
      }
      return tail.stdout === "" ? "(no output yet)" : tail.stdout;
    },

    async kill(job: SpawnJob): Promise<void> {
      if (!job.sshDest || !job.remoteDir) return;
      await ssh(job.sshDest, buildKillCommand(job.remoteDir));
    },
  };
}
