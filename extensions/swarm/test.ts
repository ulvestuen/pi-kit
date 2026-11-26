import { after, describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { LineSplitter } from "./driver.ts";
import { formatUnread, parseMentions, Router, validName, type AgentHandle } from "./router.ts";
import { startServer, type ServerApi } from "./server.ts";
import { Mutex, readJsonl, SwarmStore } from "./store.ts";
import { parseSwarmArgs, Swarm } from "./swarm.ts";
import { addWorktree, excludeDir, removeWorktree, worktreeStatus } from "./worktree.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const tmp = (p = "swarm-") => mkdtempSync(join(tmpdir(), p));
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
async function until(check: () => boolean, what: string, ms = 10_000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await tick(20);
  }
}
function gitRepo(): string {
  const dir = tmp("swarm-repo-");
  const g = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "pipe" });
  g("init", "-q", "-b", "main");
  g("config", "user.email", "t@example.com");
  g("config", "user.name", "t");
  g("config", "commit.gpgsign", "false");
  writeFileSync(join(dir, "README.md"), "hi\n");
  g("add", ".");
  g("commit", "-q", "-m", "init");
  return dir;
}
const g = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: "pipe" }).toString().trim();

/** A router member that records wakes and settles when told. */
class FakeAgent implements AgentHandle {
  wakes: string[] = [];
  stopped = false;
  async deliver(text: string) {
    this.wakes.push(text);
  }
  async stop() {
    this.stopped = true;
  }
}

function routerFixture(opts: { maxActive?: number; maxWakes?: number } = {}) {
  const store = new SwarmStore(tmp(), "s1", "goal");
  const router = new Router(store, { maxActive: opts.maxActive ?? 4, maxWakes: opts.maxWakes ?? 50 });
  const agents: Record<string, FakeAgent> = {};
  const add = async (name: string, state: "waiting" | "working" = "waiting") => {
    await store.upsertMember(name, { state });
    agents[name] = new FakeAgent();
    router.attach(name, agents[name]);
  };
  return { store, router, agents, add };
}

describe("store", () => {
  it("serializes concurrent appends into dense ids and intact lines", async () => {
    const store = new SwarmStore(tmp(), "s1", "goal");
    await Promise.all(Array.from({ length: 200 }, (_, i) => store.append({ from: `w${i % 7}`, mentions: [], kind: "message", body: `m${i} ` + "x".repeat(i * 37) })));
    const lines = readFileSync(store.boardFile, "utf8").trimEnd().split("\n");
    assert.equal(lines.length, 200);
    const parsed = lines.map((l) => JSON.parse(l));
    assert.deepEqual(parsed.map((m) => m.id), Array.from({ length: 200 }, (_, i) => i + 1));
    await store.close();
  });

  it("writes roster.json atomically and keeps every concurrent patch", async () => {
    const store = new SwarmStore(tmp(), "s1", "goal");
    await Promise.all(Array.from({ length: 50 }, (_, i) => store.upsertMember(`w${i}`, { state: i % 2 ? "working" : "waiting" })));
    const roster = JSON.parse(readFileSync(store.rosterFile, "utf8"));
    assert.equal(roster.members.length, 50);
    assert.equal(roster.goal, "goal");
    assert.ok(!existsSync(`${store.rosterFile}.${process.pid}.tmp`));
    await store.close();
  });

  it("refuses a second open of the same swarm and skips a torn last line", async () => {
    const root = tmp();
    const store = new SwarmStore(root, "s1", "goal");
    assert.throws(() => new SwarmStore(root, "s1", "goal"), /already open/);
    await store.append({ from: "a", mentions: [], kind: "message", body: "ok" });
    writeFileSync(store.boardFile, readFileSync(store.boardFile, "utf8") + '{"id":2,"ts');
    assert.equal(readJsonl(store.boardFile).length, 1);
    await store.close();
    assert.doesNotThrow(() => new SwarmStore(root, "s1", "goal"));
  });

  it("Mutex keeps running after a failed section", async () => {
    const m = new Mutex();
    const order: number[] = [];
    await assert.rejects(m.run(() => Promise.reject(new Error("x"))));
    await m.run(() => order.push(1));
    assert.deepEqual(order, [1]);
  });
});

describe("mentions", () => {
  const known = ["builder", "verifier", "docs-writer"];
  it("finds known @names, @all, @human, @coordinator in order, deduped and lowercased", () => {
    assert.deepEqual(parseMentions("@Builder done, @verifier please check. cc @builder @all", known), ["builder", "verifier", "all"]);
    assert.deepEqual(parseMentions("@coordinator @human: @docs-writer.", known), ["coordinator", "human", "docs-writer"]);
  });
  it("ignores unknown names, emails, paths, and code", () => {
    assert.deepEqual(parseMentions("mail a@builder.io, see src/@verifier, `@builder` and\n```\n@verifier\n```\n@nobody", known), []);
  });
  it("validates worker names", () => {
    assert.ok(validName("builder-2"));
    for (const bad of ["coordinator", "human", "all", "system", "Builder", "2x", "a b", "x-", ""]) assert.equal(validName(bad), false, bad);
  });
  it("formats unread messages, keeping the newest within budget", () => {
    const msgs = Array.from({ length: 5 }, (_, i) => ({ id: i + 1, ts: "t", from: "a", mentions: ["b"], kind: "message" as const, body: "y".repeat(100) }));
    const out = formatUnread("b", msgs, 300);
    assert.match(out, /#1–#5/);
    assert.match(out, /3 older unread message\(s\) omitted/);
    assert.match(out, /--- #5/);
    assert.doesNotMatch(out, /--- #2 /);
  });
});

describe("router", () => {
  it("wakes a mentioned waiting member with every unread message, then marks it working", async () => {
    const { store, router, agents, add } = routerFixture();
    await add("builder");
    await router.post("human", "background, no mention");
    await router.post("coordinator", "@builder build it", "brief");
    assert.equal(agents.builder.wakes.length, 1);
    assert.match(agents.builder.wakes[0], /background, no mention/);
    assert.match(agents.builder.wakes[0], /@builder build it/);
    assert.equal(store.member("builder")!.state, "working");
    assert.equal(store.member("builder")!.lastSeenMessageId, 2);
  });

  it("queues mentions of a working member and delivers them after it settles, never mid-run", async () => {
    const { store, router, agents, add } = routerFixture();
    await add("builder");
    await router.post("coordinator", "@builder go");
    await router.post("verifier", "@builder question one");
    await router.post("human", "@builder question two");
    assert.equal(agents.builder.wakes.length, 1, "no delivery while working");
    await router.settled("builder");
    assert.equal(agents.builder.wakes.length, 2);
    assert.match(agents.builder.wakes[1], /question one[\s\S]*question two/);
    assert.doesNotMatch(agents.builder.wakes[1], /@builder go/);
    assert.equal(store.member("builder")!.state, "working");
    await router.settled("builder");
    assert.equal(store.member("builder")!.state, "waiting");
  });

  it("ignores self-mentions and killed members; @all wakes everyone else", async () => {
    const { store, router, agents, add } = routerFixture();
    await add("a");
    await add("b");
    await add("c");
    await router.post("a", "@a note to self");
    assert.equal(agents.a.wakes.length, 0);
    await router.kill("c");
    assert.ok(agents.c.stopped);
    await router.post("a", "@all status?");
    assert.equal(agents.a.wakes.length, 0);
    assert.equal(agents.b.wakes.length, 1);
    assert.equal(agents.c.wakes.length, 0);
    assert.equal(store.member("c")!.state, "killed");
  });

  it("caps active workers and drains the FIFO queue as slots free up", async () => {
    const { store, router, agents, add } = routerFixture({ maxActive: 2 });
    for (const n of ["w1", "w2", "w3", "w4"]) await add(n);
    await router.post("coordinator", "@w1 @w2 @w3 @w4 go");
    assert.deepEqual(["w1", "w2", "w3", "w4"].map((n) => agents[n].wakes.length), [1, 1, 0, 0]);
    assert.deepEqual(router.queued(), ["w3", "w4"]);
    await router.settled("w2");
    assert.deepEqual(["w3", "w4"].map((n) => agents[n].wakes.length), [1, 0]);
    assert.equal(store.member("w2")!.state, "waiting");
    await router.settled("w1");
    assert.equal(agents.w4.wakes.length, 1);
    assert.deepEqual(router.queued(), []);
  });

  it("does not count the coordinator against the cap", async () => {
    const { router, agents, add } = routerFixture({ maxActive: 1 });
    await add("coordinator");
    await add("w1");
    await router.post("human", "@w1 @coordinator hi");
    assert.equal(agents.w1.wakes.length, 1);
    assert.equal(agents.coordinator.wakes.length, 1);
  });

  it("wakes a stopped member and reports unexpected exits to the coordinator", async () => {
    const { store, router, agents, add } = routerFixture();
    await add("coordinator");
    await add("w1");
    await router.post("coordinator", "@w1 go");
    await router.exited("w1", "exit 1");
    assert.equal(store.member("w1")!.state, "stopped");
    await tick();
    assert.match(agents.coordinator.wakes.at(-1)!, /@w1 stopped unexpectedly: exit 1/);
    await router.post("human", "@w1 try again");
    assert.equal(agents.w1.wakes.length, 2);
    assert.equal(store.member("w1")!.state, "working");
  });

  it("stops waking a member past its wake limit and tells the coordinator once", async () => {
    const { router, agents, add } = routerFixture({ maxWakes: 2 });
    await add("coordinator");
    await add("w1");
    for (let i = 0; i < 4; i++) {
      await router.post("human", `@w1 ping ${i}`);
      await router.settled("w1");
    }
    assert.equal(agents.w1.wakes.length, 2);
    await tick();
    assert.equal(agents.coordinator.wakes.filter((t) => /wake limit/.test(t)).length, 1);
  });
});

describe("driver framing", () => {
  it("splits only on LF, keeps U+2028/U+2029 inside records, handles CRLF and split chunks", () => {
    const lines: string[] = [];
    const s = new LineSplitter();
    const rec = JSON.stringify({ text: "a\u2028b\u2029c" });
    const bytes = Buffer.from(`${rec}\r\n{"x":1}\n{"y":`);
    s.push(bytes.subarray(0, 5), (l) => lines.push(l));
    s.push(bytes.subarray(5), (l) => lines.push(l));
    s.push(Buffer.from("2}\n"), (l) => lines.push(l));
    assert.deepEqual(lines.map((l) => JSON.parse(l)), [{ text: "a\u2028b\u2029c" }, { x: 1 }, { y: 2 }]);
  });
  it("reassembles a UTF-8 character split across chunks", () => {
    const lines: string[] = [];
    const s = new LineSplitter();
    const b = Buffer.from('{"t":"æøå"}\n');
    s.push(b.subarray(0, 8), (l) => lines.push(l));
    s.push(b.subarray(8), (l) => lines.push(l));
    assert.deepEqual(JSON.parse(lines[0]), { t: "æøå" });
  });
});

describe("parseSwarmArgs", () => {
  it("parses subcommands, goals, flags, and env defaults", () => {
    assert.deepEqual(parseSwarmArgs("stop", {}), { action: "stop" });
    assert.deepEqual(parseSwarmArgs("", {}), { action: "help" });
    assert.deepEqual(parseSwarmArgs("fix the build --max-active 2 --port=8787", {}), { action: "start", goal: "fix the build", limits: { maxActive: 2 }, port: 8787 });
    assert.deepEqual(parseSwarmArgs("go", { PI_SWARM_MAX_WORKERS: "3", PI_SWARM_MAX_ACTIVE: "1" }), { action: "start", goal: "go", limits: { maxActive: 1, maxWorkers: 3 }, port: undefined });
    assert.throws(() => parseSwarmArgs("go --max-active 0", {}), /Invalid maxActive/);
    assert.throws(() => parseSwarmArgs("--max-active 2", {}), /goal/);
  });
});

describe("worktree", () => {
  it("adds, reports, refuses unmerged removal, and removes after merge", async () => {
    const root = gitRepo();
    await excludeDir(root, ".swarm/");
    await excludeDir(root, ".swarm/");
    assert.equal(readFileSync(join(root, ".git/info/exclude"), "utf8").split("\n").filter((l) => l === ".swarm/").length, 1);
    const path = join(root, ".swarm/s/worktrees/b");
    await addWorktree(root, path, "swarm/s/b", "main");
    assert.equal(g(root, "status", "--porcelain"), "", ".swarm/ is excluded");
    assert.ok((await worktreeStatus(root, path, "swarm/s/b", "main")).clean);
    writeFileSync(join(path, "new.txt"), "x\n");
    let s = await worktreeStatus(root, path, "swarm/s/b", "main");
    assert.deepEqual([s.dirty.length, s.clean], [1, false]);
    g(path, "add", ".");
    g(path, "commit", "-q", "-m", "work");
    s = await worktreeStatus(root, path, "swarm/s/b", "main");
    assert.deepEqual([s.dirty.length, s.unmergedCommits], [0, 1]);
    const refused = await removeWorktree(root, path, "swarm/s/b", "main");
    assert.equal(refused.removed, false);
    assert.ok(existsSync(path));
    g(root, "merge", "-q", "--no-edit", "swarm/s/b");
    const done = await removeWorktree(root, path, "swarm/s/b", "main");
    assert.equal(done.removed, true);
    assert.ok(!existsSync(path));
    assert.equal(g(root, "branch", "--list", "swarm/s/b"), "");
  });
});

function http(port: number, path: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, method: init.method ?? "GET", headers: init.headers }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode!, body }));
    });
    req.on("error", reject);
    req.end(init.body);
  });
}

describe("server", () => {
  const listeners = new Set<(t: string, d: unknown) => void>();
  const posts: string[] = [];
  const api: ServerApi = {
    html: () => "<!doctype html><title>ui</title>",
    state: () => ({ id: "s", board: [] }),
    transcript: (name) => (name === "builder" ? [{ type: "agent_settled" }] : null),
    humanPost: async (body) => {
      posts.push(body);
      const m = { id: posts.length, ts: "t", from: "human", mentions: [], kind: "message" as const, body };
      for (const l of listeners) l("board", m);
      return m;
    },
    workerName: (token) => (token === "wtok" ? "builder" : null),
    workerPost: async (name, body, kind) => ({ id: 99, ts: "t", from: name, mentions: [], kind, body }),
    workerRead: async () => ({ messages: [], members: [] }),
    subscribe: (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
  };
  let server: Awaited<ReturnType<typeof startServer>>;
  after(() => server?.close());

  it("binds 127.0.0.1 and enforces Host, token, and Origin", async () => {
    server = await startServer(api, { token: "tok" });
    const host = { host: `127.0.0.1:${server.port}` };
    assert.match(server.url, /^http:\/\/127\.0\.0\.1:\d+\/\?t=tok$/);
    assert.equal((await http(server.port, "/api/state", { headers: host })).status, 401);
    assert.equal((await http(server.port, "/api/state?t=tok", { headers: { host: "evil.example:80" } })).status, 421);
    assert.equal((await http(server.port, "/api/state?t=tok", { headers: host })).status, 200);
    assert.equal((await http(server.port, "/?t=tok", { headers: host })).status, 200);
    const cross = await http(server.port, "/api/board?t=tok", { method: "POST", headers: { ...host, origin: "https://evil.example", "content-type": "application/json" }, body: '{"body":"x"}' });
    assert.equal(cross.status, 403);
    assert.equal(posts.length, 0);
    const ok = await http(server.port, "/api/board", { method: "POST", headers: { ...host, origin: `http://127.0.0.1:${server.port}`, "x-swarm-token": "tok" }, body: '{"body":"hello @builder"}' });
    assert.equal(ok.status, 200);
    assert.deepEqual(posts, ["hello @builder"]);
    assert.equal((await http(server.port, "/api/board?t=tok", { method: "POST", headers: host, body: "{" })).status, 400);
    assert.equal((await http(server.port, "/api/workers/builder/transcript?t=tok", { headers: host })).status, 200);
    assert.equal((await http(server.port, "/api/workers/nobody/transcript?t=tok", { headers: host })).status, 404);
  });

  it("authenticates workers by their own token and never accepts the UI token there", async () => {
    const host = { host: `127.0.0.1:${server.port}` };
    assert.equal((await http(server.port, "/api/worker/board", { method: "POST", headers: { ...host, "x-swarm-token": "tok" }, body: '{"body":"x"}' })).status, 401);
    const r = await http(server.port, "/api/worker/board", { method: "POST", headers: { ...host, "x-swarm-token": "wtok" }, body: '{"body":"x","kind":"result"}' });
    assert.equal(JSON.parse(r.body).from, "builder");
  });

  it("streams a snapshot then live events over SSE", async () => {
    const events: string[] = [];
    await new Promise<void>((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port: server.port, path: "/api/events?t=tok", headers: { host: `127.0.0.1:${server.port}` } }, (res) => {
        assert.match(String(res.headers["content-type"]), /text\/event-stream/);
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          events.push(...[...chunk.matchAll(/^event: (\w+)$/gm)].map((m) => m[1]));
          if (events.includes("snapshot") && !events.includes("board")) void api.humanPost("live");
          if (events.includes("board")) {
            req.destroy();
            resolve();
          }
        });
      });
      req.on("error", (e: any) => (e.code === "ECONNRESET" ? resolve() : reject(e)));
      req.end();
    });
    assert.deepEqual(events.slice(0, 2), ["snapshot", "board"]);
  });
});

describe("swarm end to end (fake pi workers, temp git repo)", () => {
  it("briefs, peer-to-peer handoff, coordinator wake, kill with worktree cleanup, and stop report", async () => {
    const root = gitRepo();
    const scriptFile = join(tmp(), "script.json");
    const logFile = join(tmp(), "pi.log");
    writeFileSync(
      scriptFile,
      JSON.stringify({
        builder: [{ when: "@builder implement", post: "@verifier ready for review on my branch", kind: "result" }],
        verifier: [
          { when: "@verifier ready", post: "@coordinator verified the builder's work", kind: "result" },
          { when: "@verifier check", delayMs: 10 },
        ],
      }),
    );
    process.env.FAKE_PI_SCRIPT = scriptFile;
    process.env.FAKE_PI_LOG = logFile;
    const coordinator = new FakeAgent();
    const swarm = await Swarm.start({ goal: "ship the feature", cwd: root, pi: { command: process.execPath, args: [join(HERE, "fake-pi.mjs")] }, coordinator, coordinatorModel: "anthropic/claude-opus-5-5:high", maxActive: 2 });
    try {
      assert.match(swarm.url, /^http:\/\/127\.0\.0\.1:\d+\/\?t=/);
      assert.ok(existsSync(join(swarm.store.dir, "roster.json")));
      // The /swarm turn itself is the coordinator's first run; it settles after spawning workers.
      const builder = await swarm.add({ name: "builder", brief: "implement the parser", workspace: "worktree" });
      assert.equal(builder.member.branch, `swarm/${swarm.id}/builder`);
      assert.equal(builder.brief.kind, "brief");
      await swarm.add({ name: "verifier", brief: "wait until @builder hands over, then check" });
      await swarm.router.settled("coordinator");

      await until(() => coordinator.wakes.some((w) => w.includes("verified the builder's work")), "verifier → coordinator");
      await until(() => swarm.liveMembers().every((m) => m.state === "waiting"), "all workers waiting");

      const log = readJsonl<any>(logFile);
      const start = (n: string) => log.find((e) => e.event === "start" && e.name === n);
      assert.equal(start("builder").cwd, join(swarm.store.dir, "worktrees", "builder"));
      assert.ok(start("builder").argv.includes("--model") && start("builder").argv.includes("anthropic/claude-opus-5-5:high"));
      assert.match(start("verifier").argv.join(" "), /--append-system-prompt <swarm-worker>/);
      // Brief and handoff arrive as one or two wakes depending on timing; the handoff is always in the last one.
      const verifierPrompts = log.filter((e) => e.event === "prompt" && e.name === "verifier");
      assert.ok(verifierPrompts.length >= 1 && verifierPrompts.length <= 2);
      assert.match(verifierPrompts.at(-1).message, /ready for review/);
      assert.match(verifierPrompts[0].message, /wait until @builder hands over/);

      const board = swarm.store.messages();
      assert.deepEqual(board.filter((m) => m.from !== "system").map((m) => `${m.from}:${m.mentions.join(",")}`), ["coordinator:builder", "coordinator:verifier,builder", "builder:verifier", "verifier:coordinator"]);
      const transcript = swarm.store.transcript("builder") as any[];
      assert.ok(transcript.some((r) => r.type === "tool_execution_start" && r.toolName === "board_post"));
      // U+2028 inside a JSON string survived framing as one record.
      assert.ok(transcript.some((r) => r.type === "message_end" && r.message.role === "assistant" && r.message.content[0].text === "@builder done\u2028ok"));
      assert.ok(transcript.some((r) => r.type === "wake") && transcript.some((r) => r.type === "agent_settled"));

      // Human steering through the HTTP API uses the same router.
      const port = swarm.server!.port;
      const posted = await http(port, `/api/board?t=${swarm.uiToken}`, { method: "POST", headers: { host: `127.0.0.1:${port}`, "content-type": "application/json" }, body: JSON.stringify({ body: "@verifier check the docs too" }) });
      assert.equal(JSON.parse(posted.body).from, "human");
      await until(() => readJsonl<any>(logFile).filter((e) => e.event === "prompt" && e.name === "verifier").length === verifierPrompts.length + 1, "human wake");

      // Unmerged worktree: kill stops the worker but keeps the branch.
      const wt = join(swarm.store.dir, "worktrees", "builder");
      writeFileSync(join(wt, "parser.ts"), "export {};\n");
      g(wt, "add", ".");
      g(wt, "commit", "-q", "-m", "parser");
      const kept = await swarm.kill("builder");
      assert.deepEqual([kept.removed, kept.worktree!.unmergedCommits, kept.member.state], [false, 1, "killed"]);
      await assert.rejects(swarm.add({ name: "builder", brief: "again" }), /killed/);
      // After merging, a second kill cleans up.
      g(root, "merge", "-q", "--no-edit", `swarm/${swarm.id}/builder`);
      const cleaned = await swarm.kill("builder");
      assert.equal(cleaned.removed, true);
      assert.ok(!existsSync(wt));

      // A second, unmerged worktree is reported (and kept) by stop.
      const docs = await swarm.add({ name: "docs", brief: "write docs", workspace: "worktree" });
      writeFileSync(join(docs.member.cwd, "draft.md"), "wip\n");
      await until(() => swarm.store.member("docs")!.state === "waiting", "docs settles");
      const report = await swarm.stop();
      assert.deepEqual(report.kept.map((s) => s.branch), [`swarm/${swarm.id}/docs`]);
      assert.ok(report.stopped.includes("verifier"));
      assert.match(Swarm.describeStop(report, swarm.store.dir), /Worktrees kept[\s\S]*1 uncommitted change/);
      assert.ok(existsSync(docs.member.cwd));
      assert.equal(swarm.server, null);
      await assert.rejects(http(port, "/api/state"));
      const roster = JSON.parse(readFileSync(swarm.store.rosterFile, "utf8"));
      assert.ok(roster.members.every((m: any) => m.state === "stopped" || m.state === "killed"));
    } finally {
      await swarm.stop(false);
      delete process.env.FAKE_PI_SCRIPT;
      delete process.env.FAKE_PI_LOG;
    }
  });

  it("restarts a crashed worker with --continue when it is mentioned again", async () => {
    const root = gitRepo();
    const scriptFile = join(tmp(), "script.json");
    const logFile = join(tmp(), "pi.log");
    writeFileSync(scriptFile, JSON.stringify({ flaky: [{ when: "@flaky crash", exit: 3 }] }));
    process.env.FAKE_PI_SCRIPT = scriptFile;
    process.env.FAKE_PI_LOG = logFile;
    const coordinator = new FakeAgent();
    const swarm = await Swarm.start({ goal: "g", cwd: root, pi: { command: process.execPath, args: [join(HERE, "fake-pi.mjs")] }, coordinator });
    try {
      await swarm.router.settled("coordinator");
      await swarm.add({ name: "flaky", brief: "crash now" });
      await until(() => coordinator.wakes.some((w) => /@flaky stopped unexpectedly: exit 3/.test(w)), "crash report");
      assert.equal(swarm.store.member("flaky")!.state, "stopped");
      await swarm.post("human", "@flaky are you back?");
      await until(() => swarm.store.member("flaky")!.state === "waiting", "restart");
      const starts = readJsonl<any>(logFile).filter((e) => e.event === "start");
      assert.equal(starts.length, 2);
      assert.ok(starts[1].argv.includes("--continue"));
      assert.ok(!starts[0].argv.includes("--continue"));
    } finally {
      await swarm.stop(false);
      delete process.env.FAKE_PI_SCRIPT;
      delete process.env.FAKE_PI_LOG;
    }
  });
});
