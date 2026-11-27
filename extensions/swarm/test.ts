import { after, describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs, { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { LineSplitter } from "./driver.ts";
import { nativeWorker } from "./native.ts";
import { formatUnread, parseMentions, Router, validName, type AgentHandle } from "./router.ts";
import { startServer, type ServerApi } from "./server.ts";
import { Mutex, readJsonl, SwarmStore } from "./store.ts";
import { parseSwarmArgs, Swarm } from "./swarm.ts";
import { workflowRequest, type Preset, type Selection } from "./workflow.ts";
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
    const mcp = { method: "POST", headers: { ...host, "x-swarm-token": "tok" }, body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' };
    assert.equal((await http(server.port, "/api/worker/mcp", mcp)).status, 401, "UI token cannot use worker MCP");
    assert.equal((await http(server.port, "/api/worker/mcp?t=wtok", { ...mcp, headers: host })).status, 401, "worker tokens are header-only");
    assert.equal((await http(server.port, "/api/state", { headers: { ...host, "x-swarm-token": "wtok" } })).status, 401, "worker cannot see UI state or transcripts");
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

describe("native swarm", { skip: process.platform === "win32" }, () => {
  async function setup(t: import("node:test").TestContext, extra: NodeJS.ProcessEnv = {}) {
    const cwd = gitRepo();
    const log = join(cwd, ".git", "native.log");
    const script = join(cwd, ".git", "rules.json");
    const fixtureEnv = { SWARM_CLAUDE_BIN: join(HERE, "fake-native.mjs"),
      SWARM_CODEX_BIN: join(HERE, "fake-native.mjs"), SWARM_AGY_BIN: join(HERE, "fake-agy.mjs"),
      FAKE_NATIVE_LOG: log, FAKE_NATIVE_SCRIPT: script, FAKE_AGY_LOG: log, ...extra };
    const previous = new Map(Object.keys(fixtureEnv).map((key) => [key, process.env[key]]));
    Object.assign(process.env, fixtureEnv);
    t.after(() => { for (const [key, value] of previous) value === undefined ? delete process.env[key] : process.env[key] = value; });
    writeFileSync(script, JSON.stringify({ claude: [{ when: "inspect first", post: "@codex verify the README" }] }));
    const swarm = await Swarm.start({ goal: "Verify the parser", cwd, pi: { command: process.execPath, args: [join(HERE, "fake-pi.mjs")] }, coordinator: new FakeAgent() });
    t.after(async () => { await swarm.stop(); rmSync(cwd, { recursive: true, force: true }); });
    return { swarm, entries: () => readJsonl<any>(log) };
  }

  it("launches Claude and Codex from Swarm and routes a handoff to the exact Codex session", async (t) => {
    const { swarm, entries } = await setup(t);
    const { member: checker } = await swarm.add({ name: "codex", harness: "codex", workspace: "worktree", brief: "Wait for the reviewer", model: "gpt-5.4", effort: "high" });
    await until(() => swarm.store.member("codex")?.state === "waiting", "Codex first turn");
    const { member: reviewer } = await swarm.add({ name: "claude", harness: "claude", workspace: "worktree", brief: "inspect first", model: "claude-sonnet-4-6", effort: "high" });
    await until(() => swarm.store.member("codex")?.wakes === 2 && swarm.store.member("codex")?.state === "waiting", "Codex handoff turn");
    const launches = entries().filter((e) => e.event === "launch");
    const [codexFirst, codexSecond] = launches.filter((e) => e.harness === "codex");
    const claude = launches.find((e) => e.harness === "claude");
    assert.equal(claude.cwd, reviewer.cwd);
    assert.ok(claude.args.includes("--dangerously-skip-permissions"));
    assert.ok(!claude.args.includes("--restricted") && !claude.args.includes("--tools"));
    assert.equal(codexFirst.cwd, checker.cwd);
    assert.equal(codexFirst.resume, null);
    assert.equal(codexSecond.resume, codexFirst.session);
    assert.notEqual(codexSecond.resume, claude.session);
    assert.match(codexSecond.prompt, /@codex verify the README/);
    assert.ok([codexFirst, codexSecond].every((e) => e.args.includes("--dangerously-bypass-approvals-and-sandbox") && !e.args.includes("--sandbox")));
    assert.match(codexSecond.args.join(" "), /--model gpt-5\.4 resume/);
    assert.ok(launches.every((e) => !e.hasTokenInInput && !e.args.some((a: string) => /--last|--continue/.test(a))));
  });

  it("auto-approves ACP requests without dashboard input and stops a busy native process", async (t) => {
    const { swarm, entries } = await setup(t);
    const { member } = await swarm.add({ name: "agy", harness: "agy", workspace: "worktree", brief: "Check the README", model: "gemini-test", effort: "high" });
    await until(() => swarm.store.member("agy")?.state === "waiting", "first auto-approved ACP turn");
    await swarm.post("human", "@agy check again with only permanent choice");
    await until(() => swarm.store.member("agy")?.wakes === 2 && swarm.store.member("agy")?.state === "waiting", "second auto-approved ACP turn");
    assert.deepEqual(swarm.store.messages().filter((m) => m.from === "agy").map((m) => m.body), ["Read approved once", "Read approved always"]);
    assert.deepEqual(entries().filter((e) => e.method === "decision").map((e) => e.outcome.optionId), ["single", "persistent"]);
    const [opened, resumed] = entries().filter((e) => ["session/new", "session/resume"].includes(e.method));
    assert.equal(resumed.id, "session-7ad6");
    assert.equal(opened.requestedCwd, member.cwd);
    assert.equal(resumed.cwd, member.cwd);
    assert.ok([opened, resumed].every((e) => e.args.includes("--dangerously-skip-permissions") && e.args.includes("--sandbox=false")));
    assert.equal(opened.tokenInEnv, false);
    const prompts = entries().filter((e) => e.method === "session/prompt");
    assert.match(prompts[0].text, /<swarm-worker>/);
    assert.doesNotMatch(prompts[1].text, /<swarm-worker>/);
    assert.ok(prompts.every((e) => e.model === "gemini-test" && e.effort === "high"));
    await swarm.post("human", "@agy hold after approval");
    await until(() => entries().filter((e) => e.method === "decision").length === 3, "third ACP turn approved");
    await swarm.kill("agy");
    assert.throws(() => process.kill(entries().filter((e) => e.method === "session/resume").at(-1).pid, 0), { code: "ESRCH" });
  });

  it("rejects unavailable ACP models before prompting and does not replay a failed resume", async (t) => {
    const { swarm, entries } = await setup(t, { FAKE_AGY_LOST: "1" });
    await swarm.add({ name: "wrong", harness: "agy", brief: "Should not run", model: "not-a-model" });
    await until(() => swarm.store.member("wrong")?.state === "failed", "model selection failure");
    assert.equal(swarm.store.member("wrong")?.failure, "unsupported-cli");
    assert.equal(entries().filter((e) => e.method === "session/prompt").length, 0);
    await swarm.add({ name: "agy", harness: "agy", brief: "Check the README" });
    await until(() => swarm.store.member("agy")?.state === "waiting", "ACP first turn");
    await swarm.post("human", "@agy check again");
    await until(() => swarm.store.member("agy")?.state === "failed", "lost ACP session");
    assert.equal(swarm.store.member("agy")?.failure, "lost-session");
    assert.deepEqual(entries().map((e) => e.method), ["session/new", "session/new", "session/prompt", "decision", "session/resume"]);
  });
});

describe("native transport (fixture CLI only)", { skip: process.platform === "win32" }, () => {
  async function fixture(t: import("node:test").TestContext, rules: object[], timeoutMs?: number) {
    const cwd = tmp();
    const script = join(cwd, "rules.json");
    const log = join(cwd, "native.log");
    writeFileSync(script, JSON.stringify({ builder: rules }));
    let authorized = true;
    const records: any[] = [];
    const posts: { from: string; body: string }[] = [];
    const server = await startServer({
      html: () => "", state: () => ({}), transcript: () => null, subscribe: () => () => {},
      humanPost: async () => { throw new Error("Not part of this fixture"); },
      workerName: (token) => authorized && token === "fixture-worker-token" ? "builder" : null,
      workerRead: async () => ({ messages: posts }),
      workerPost: async (name, body, kind) => {
        posts.push({ from: name, body });
        return { id: posts.length, ts: "t", from: name, mentions: [], kind, body };
      },
    }, { token: "fixture-ui-token" });
    // Exercise the retained transport against the fixture executable, never the real native CLI.
    const worker = nativeWorker({ harness: "claude", cli: { command: process.execPath, args: [join(HERE, "fake-native.mjs")] }, cwd,
      model: "claude-sonnet-4-6", effort: "high", timeoutMs, rules: "You are the builder.",
      env: { PI_SWARM_NAME: "builder", PI_SWARM_TOKEN: "fixture-worker-token", FAKE_NATIVE_SCRIPT: script, FAKE_NATIVE_LOG: log },
      boardUrl: `http://127.0.0.1:${server.port}/api/worker/mcp`, onRecord: (r) => records.push(r), revokeBoard: () => { authorized = false; } });
    t.after(async () => { await worker.stop(); await server.close(); rmSync(cwd, { recursive: true, force: true }); });
    return { worker, cwd, records, posts, log: () => readJsonl<any>(log) };
  }

  it("posts through authenticated MCP and resumes the exact session without replay", async (t) => {
    const { worker, cwd, posts, log } = await fixture(t, [{ when: "start", post: "@reviewer inspect the parser" }, { when: "recheck", read: true }, { when: "lost", fail: "lost-session" }]);
    assert.deepEqual(await worker.deliver("start"), { type: "completed", text: "builder finished café\u2028✓" });
    assert.equal((await worker.deliver("recheck")).type, "completed");
    assert.match(JSON.stringify(await worker.deliver("lost")), /lost-session/);
    const launches = log().filter((e) => e.event === "launch");
    const [first, recheck] = launches;
    assert.equal(first.cwd, fs.realpathSync(cwd));
    assert.deepEqual(launches.map((e) => e.resume), [null, first.session, first.session]);
    assert.equal(recheck.prompt, "recheck");
    assert.match(first.args.join(" "), /--output-format stream-json.*--model claude-sonnet-4-6 --effort high/);
    assert.ok(launches.every((e) => !e.hasTokenInInput && !e.args.some((a: string) => /--last|--continue/.test(a))));
    assert.deepEqual(posts, [{ from: "builder", body: "@reviewer inspect the parser" }]);
    assert.deepEqual(log().find((e) => e.event === "read").messages, posts);
  });

  for (const [error, failure] of [["auth", "auth"], ["permission", "permission"], ["malformed", "protocol"], ["wrong-session", "lost-session"]]) {
    it(`reports ${error} without retrying`, async (t) => {
      const { worker, log } = await fixture(t, [{ when: "trigger", fail: error }]);
      if (error === "wrong-session") assert.equal((await worker.deliver("start")).type, "completed");
      const result = await worker.deliver("trigger");
      assert.equal(result.type === "failed" && result.failure, failure);
      assert.equal(log().filter((e) => e.event === "launch").length, error === "wrong-session" ? 2 : 1);
    });
  }

  it("cancels the turn and its helper, revoking board access before signalling", async (t) => {
    const { worker, log, records, posts } = await fixture(t, [{ when: "hold", linger: true, helper: true }]);
    const turn = worker.deliver("hold");
    await until(() => log().some((e) => e.event === "ready-to-cancel"), "fixture ready to cancel");
    await worker.stop();
    assert.deepEqual(await turn, { type: "cancelled" });
    assert.equal(log().find((e) => e.event === "late")?.status, 401);
    const helperPid = log().find((e) => e.event === "ready-to-cancel").helperPid;
    assert.ok(helperPid);
    assert.throws(() => process.kill(helperPid, 0), { code: "ESRCH" });
    assert.ok(!JSON.stringify(records).includes("late transcript"));
    assert.deepEqual(posts, []);
  });

  it("times out a hung fixture turn", async (t) => {
    const { worker, log } = await fixture(t, [{ when: "hold", linger: true }], 1_000);
    assert.match(JSON.stringify(await worker.deliver("hold")), /"failure":"timeout"/);
    assert.equal(log().find((e) => e.event === "late")?.status, 401);
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

describe("structured swarm presets", () => {
  const report = (report: string, verdict?: string) => JSON.stringify({ report, verdict });
  const pi = { harness: "pi", model: "fixture/model" } as const;
  const selection = (a: string, b: string): Selection => ({ rounds: 1, roles: { [a]: pi, [b]: pi } });

  async function run(t: import("node:test").TestContext, source: string, preset: Preset, target: string, picks: Selection, rules: object, managedPiTurnTimeoutMs?: number, extraEnv?: NodeJS.ProcessEnv) {
    const script = join(tmp("pair-fixture-"), "rules.json");
    const log = script + ".log";
    writeFileSync(script, JSON.stringify(rules));
    const env = { SWARM_CLAUDE_BIN: join(HERE, "fake-native.mjs"), SWARM_CODEX_BIN: join(HERE, "fake-native.mjs"), SWARM_AGY_BIN: join(HERE, "fake-agy.mjs"), FAKE_NATIVE_SCRIPT: script, FAKE_NATIVE_LOG: log, FAKE_PI_SCRIPT: script, FAKE_PI_LOG: log, ...extraEnv };
    const previous = new Map(Object.keys(env).map((key) => [key, process.env[key]]));
    Object.assign(process.env, env);
    const saved: Selection[] = [];
    const swarm = await Swarm.start({ goal: preset, cwd: source, pi: { command: process.execPath, args: [join(HERE, "fake-pi.mjs")] }, coordinator: new FakeAgent(),
      managedPiTurnTimeoutMs, workflow: { preset, target, source, selection: picks, save: (value) => saved.push(value) } });
    t.after(async () => {
      try { await swarm.stop(); } finally {
        rmSync(swarm.root, { recursive: true, force: true });
        rmSync(dirname(script), { recursive: true, force: true });
        rmSync(source, { recursive: true, force: true });
        for (const [key, value] of previous) value === undefined ? delete process.env[key] : process.env[key] = value;
      }
    });
    const http = async (path: string, body?: object): Promise<any> => {
      const res = await fetch(`${swarm.apiBase}${path}`, { headers: { "x-swarm-token": swarm.uiToken, "content-type": "application/json" },
        ...(body ? { method: "POST", body: JSON.stringify(body) } : {}) });
      assert.equal(res.status, 200);
      return res.json();
    };
    return { swarm, saved, log: () => readJsonl<any>(log), http, state: () => swarm.workflow!.snapshot(),
      action: (action: string, override = picks) => http("/api/workflow", { action, selection: override, target }) };
  }

  it("prefills slash-command roles without carrying model or effort across harness changes", () => {
    const result = workflowRequest("pair-review", "main...HEAD -- --lead-harness claude --lead-model claude-sonnet-4-6 --lead-effort high --rounds 2", {
      rounds: 1, roles: { lead: { ...pi, effort: "xhigh" }, peer: { harness: "codex", model: "gpt-5.4" } },
    });
    assert.deepEqual(result, { target: "main...HEAD", selection: { rounds: 2, roles: {
      lead: { harness: "claude", model: "claude-sonnet-4-6", effort: "high" }, peer: { harness: "codex", model: "gpt-5.4", effort: undefined },
    } } });
    assert.deepEqual(workflowRequest("pair-review", "HEAD -- --lead-harness agy", result.selection).selection.roles.lead,
      { harness: "agy", model: undefined, effort: undefined });
  });

  it("pins staged, unstaged and untracked review inputs and releases first reports only after both finish", async (t) => {
    const source = gitRepo();
    writeFileSync(join(source, "README.md"), "staged line\n");
    g(source, "add", "README.md");
    writeFileSync(join(source, "README.md"), "unstaged line\n");
    writeFileSync(join(source, "new.txt"), "untracked evidence\n");
    const before = g(source, "status", "--porcelain");
    const ignoreBefore = readFileSync(join(source, ".git/info/exclude"), "utf8");
    const f = await run(t, source, "pair-review", "working tree", selection("lead", "peer"), {
      lead: [{ when: "Phase: Independent review", text: report("Private lead finding"), readPath: "tree/README.md" },
        { when: "Phase: Cross-check", text: report("Lead confirmed peer finding.") }, { when: "Phase: Final review", text: report("Consolidated changes.", "changes requested") }],
      peer: [{ when: "Phase: Independent review", text: report("Private peer finding"), readPath: "tree/new.txt", delayMs: 1_500 },
        { when: "Phase: Cross-check", text: report("Peer confirmed lead finding.") }],
    });
    assert.equal((await f.action("check")).phase, "Workers are ready");
    assert.deepEqual(f.log(), []);
    assert.equal((await f.action("start")).status, "running");
    await until(() => f.swarm.store.member("lead")?.state === "waiting" && f.log().some((e) => e.name === "lead" && e.event === "file"), "first lead report");
    const during = await f.http("/api/state");
    assert.deepEqual(during.workflow.reports, []);
    assert.deepEqual(during.board, []);
    assert.doesNotMatch(JSON.stringify(await f.http("/api/workers/lead/transcript")), /Private lead finding/);
    await until(() => f.state().status === "complete", "review verdict");
    const launches = f.log().filter((e) => e.event === "start");
    assert.equal(new Set(launches.map((e) => e.cwd)).size, 1);
    assert.ok(launches[0].cwd !== source);
    assert.ok(launches.every(({ argv }) => argv[argv.indexOf("--tools") + 1] === "task_read,task_ls"));
    const prompts = f.log().flatMap((e) => typeof (e.prompt ?? e.message) === "string" ? [{ name: e.name, text: e.prompt ?? e.message }] : []);
    const independent = prompts.filter((e) => e.text.includes("Phase: Independent review"));
    assert.equal(independent.length, 2);
    assert.ok(independent.every((e) => !e.text.includes("Private")));
    assert.match(prompts.find((e) => e.name === "peer" && e.text.includes("Phase: Cross-check"))!.text, /Private lead finding/);
    assert.equal(f.log().find((e) => e.event === "file" && e.name === "lead").text, "unstaged line\n");
    assert.equal(f.log().find((e) => e.event === "file" && e.name === "peer").text, "untracked evidence\n");
    const patch = readFileSync(join(launches[0].cwd, "review.patch"), "utf8");
    assert.match(patch, /Staged changes:[\s\S]*\+staged line[\s\S]*Unstaged changes:[\s\S]*\+unstaged line/);
    const reconnected = await f.http("/api/state");
    assert.equal(reconnected.workflow.verdict, "changes requested");
    assert.equal(reconnected.workflow.reports.length, 5);
    assert.deepEqual(JSON.parse(readFileSync(join(f.swarm.store.dir, "workflow.json"), "utf8")), reconnected.workflow);
    assert.equal(g(source, "status", "--porcelain"), before);
    assert.equal(readFileSync(join(source, ".git/info/exclude"), "utf8"), ignoreBefore);
    assert.equal(f.saved.length, 1);
  });

  it("pins a three-dot review to the merge base and committed tip, not the live checkout", async (t) => {
    const source = gitRepo();
    const base = g(source, "rev-parse", "HEAD");
    g(source, "switch", "-c", "topic");
    writeFileSync(join(source, "README.md"), "topic commit\n");
    g(source, "commit", "-qam", "Topic change");
    const tip = g(source, "rev-parse", "HEAD");
    g(source, "switch", "main");
    writeFileSync(join(source, "README.md"), "diverged main\n");
    g(source, "commit", "-qam", "Main change");
    writeFileSync(join(source, "README.md"), "unstaged edit\n");
    const f = await run(t, source, "pair-review", "main...topic", selection("lead", "peer"), {
      lead: [{ when: "Phase: Independent review.", readPath: "tree/README.md", text: report("Review the topic commit") },
        { when: "Phase: Cross-check.", text: report("No disagreements") }, { when: "Phase: Final review.", text: report("No findings", "approve") }],
      peer: [{ when: "Phase: Independent review.", text: report("No defects") }, { when: "Phase: Cross-check.", text: report("Confirmed") }],
    });
    const started = await f.action("start");
    assert.equal(started.status, "running", started.problem);
    assert.equal(started.snapshot, `${base}..${tip}`);
    await until(() => f.log().some((event) => event.event === "file"), "reviewer read the pinned file");
    assert.equal(f.log().find((e) => e.event === "file").text, "topic commit\n");
    const patch = readFileSync(join(f.swarm.store.dir, "review", "review.patch"), "utf8");
    assert.match(patch, /^-hi\n\+topic commit$/m);
    assert.doesNotMatch(patch, /diverged main|unstaged edit/);
  });

  it("does not dispatch a review when untracked file bytes change between copies", async (t) => {
    const source = fs.realpathSync(gitRepo());
    const first = join(source, "a.txt");
    const second = join(source, "b.txt");
    writeFileSync(first, "old A");
    writeFileSync(second, "old B");
    const f = await run(t, source, "pair-review", "working tree", selection("lead", "peer"), {});
    const copy = fs.copyFileSync;
    const hook = t.mock.method(fs, "copyFileSync", (...[src, dest, mode]: Parameters<typeof copy>) => {
      copy(src, dest, mode);
      if (src === first) {
        // The old A/new B pair never existed in the source checkout.
        writeFileSync(first, "new A");
        writeFileSync(second, "new B");
      }
    });
    syncBuiltinESMExports();
    let state;
    try { state = await f.action("start"); }
    finally { hook.mock.restore(); syncBuiltinESMExports(); }
    assert.equal(readFileSync(second, "utf8"), "new B", "the copy hook changed both source files");
    assert.equal(state.status, "setup");
    assert.match(state.problem, /working tree changed during capture/i);
    assert.deepEqual(f.log(), []);
    assert.deepEqual(f.swarm.liveMembers(), []);
  });

  it("confines reviewer file tools to the pinned workspace", { skip: process.platform === "win32" }, async (t) => {
    const source = fs.realpathSync(gitRepo());
    const liveFile = join(source, "README.md");
    writeFileSync(liveFile, "LIVE CHECKOUT CONTENT\n");
    const read = (path: string) => ["task_read", { path }];
    const ls = (path: string) => ["task_ls", { path }];
    const calls = [read(liveFile), ls(source)];
    const rules = {
      lead: [{ when: "Phase: Independent review.", calls, text: report("Inspected pinned files") },
        { when: "Phase: Cross-check.", text: report("No disagreements") }, { when: "Phase: Final review.", text: report("Pinned verdict", "approve") }],
      peer: [{ when: "Phase: Independent review.", text: report("No defects") }, { when: "Phase: Cross-check.", text: report("Confirmed") }],
    };
    const f = await run(t, source, "pair-review", "HEAD", selection("lead", "peer"), rules);
    const snapshot = join(f.swarm.store.dir, "review");
    calls.push(read(relative(snapshot, liveFile)), read("tree/nested/link/README.md"), ls("tree/nested/link"), read("tree/README.md"), ls("tree"));
    writeFileSync(process.env.FAKE_PI_SCRIPT!, JSON.stringify(rules));
    const write = fs.writeFileSync;
    const hook = t.mock.method(fs, "writeFileSync", (...[file, data, options]: Parameters<typeof write>) => {
      write(file, data, options);
      if (file === join(snapshot, "review.patch")) {
        mkdirSync(join(snapshot, "tree/nested"));
        symlinkSync(source, join(snapshot, "tree/nested/link"), "dir");
      }
    });
    syncBuiltinESMExports();
    let state;
    try { state = await f.action("start"); }
    finally { hook.mock.restore(); syncBuiltinESMExports(); }
    assert.equal(state.status, "running", state.problem);
    await until(() => f.state().status === "complete", "scoped review");
    const tools = f.log().filter((e) => e.event === "tool");
    assert.deepEqual(tools.map((e) => e.isError), [true, true, true, true, true, false, false]);
    assert.equal(tools[5].text, "hi\n");
    assert.match(tools[6].text, /README\.md/);
    assert.ok(tools.slice(0, 5).every((e) => /Swarm permission denied/.test(e.text)));
    assert.doesNotMatch(JSON.stringify(tools), /LIVE CHECKOUT CONTENT/);
  });

  it("does not launch on invalid readiness or cancelled setup", async (t) => {
    const picks = selection("doer", "verifier");
    const f = await run(t, tmp(), "pair-work", "Produce a sample", picks, {});
    const bad = { ...picks, roles: { ...picks.roles, verifier: { harness: "pi" as const } } };
    assert.match((await f.action("start", bad)).problem, /available Pi provider\/model for verifier/);
    assert.equal((await f.action("cancel")).status, "cancelled");
    assert.deepEqual(f.log(), []);
    assert.deepEqual(f.swarm.liveMembers(), []);
    assert.deepEqual(f.saved, []);
  });

  it("makes the auditor inspect the actual implementation and runs the correction round", async (t) => {
    const source = gitRepo();
    const f = await run(t, source, "pair", "Fix README", selection("implementer", "auditor"), {
      implementer: [{ when: "Phase: Implement.", writePath: "README.md", writeText: "first draft\n", text: report("Draft ready") },
        { when: "Phase: Address audit", calls: [["task_edit", { path: "README.md", edits: [{ oldText: "first draft", newText: "corrected" }] }]], text: report("Correction ready") }],
      auditor: [{ when: "Phase: Orient", text: report("Audit README") },
        { when: "Phase: Audit.", readPath: "README.md", text: report("Fix wording", "changes requested") }],
    });
    await f.action("start");
    await until(() => f.state().status === "complete", "pair corrections");
    assert.equal(readFileSync(join(source, "README.md"), "utf8"), "corrected\n");
    assert.equal(f.log().find((e) => e.event === "file").text, "first draft\n");
    const tools = (name: string) => { const a = f.log().find((e) => e.name === name && e.event === "start").argv; return a[a.indexOf("--tools") + 1]; };
    assert.equal(tools("auditor"), "task_read,task_ls");
    assert.equal(tools("implementer"), "task_read,task_ls,task_edit,task_write");
    assert.deepEqual(f.state().reports.map((r) => r.phase), ["Implement", "Orient", "Audit", "Address audit"]);
  });

  it("shows the scoped Pi auditor staged and unstaged changes and untracked paths", async (t) => {
    const source = gitRepo();
    writeFileSync(join(source, "retired.txt"), "deleted evidence\n");
    g(source, "add", "retired.txt");
    g(source, "commit", "-qm", "Add retired file");
    g(source, "rm", "retired.txt");
    writeFileSync(join(source, "README.md"), "unstaged evidence\n");
    const f = await run(t, source, "pair", "Update documentation", selection("implementer", "auditor"), {
      implementer: [{ when: "Phase: Implement", writePath: "draft notes.md", writeText: "untracked evidence\n", text: report("Draft ready") },
        { when: "Phase: Address audit", text: report("Done") }],
      auditor: [{ when: "Phase: Orient", text: report("Check the docs") },
        { when: "Phase: Audit.", readPath: "draft notes.md", text: report("Checked the patch and draft", "approve") }],
    });
    await f.action("start");
    await until(() => f.state().status === "complete", "Pi audit");
    const audit = f.log().find((e) => e.event === "prompt" && e.message.includes("Phase: Audit."));
    assert.match(audit.message, /Staged changes:[\s\S]*diff --git a\/retired\.txt b\/retired\.txt[\s\S]*\n-deleted evidence\n/);
    assert.match(audit.message, /Unstaged changes:[\s\S]*\n\+unstaged evidence\n/);
    assert.match(audit.message, /Untracked paths.*\["draft notes\.md"\]/);
    assert.equal(f.log().find((e) => e.event === "file").text, "untracked evidence\n");
  });

  it("stops before auditing if Git evidence exceeds the inline limit", async (t) => {
    const source = gitRepo();
    writeFileSync(join(source, "README.md"), "x".repeat(70_000) + "\n");
    const f = await run(t, source, "pair", "Review the draft", selection("implementer", "auditor"), {
      implementer: [{ when: "Phase: Implement", text: report("Draft ready") }],
      auditor: [{ when: "Phase: Orient", text: report("Read the full diff") }],
    });
    await f.action("start");
    await until(() => f.state().status !== "running", "oversized audit");
    assert.equal(f.state().status, "failed");
    assert.match(f.state().problem!, /exceeds 64 KiB/);
    assert.ok(!f.log().some((e) => e.event === "prompt" && e.message.includes("Phase: Audit.")));
  });

  for (const kind of ["binary change", "submodule change", "assume-unchanged", "skip-worktree", "invalid UTF-8"]) {
    it(`stops before an audit verdict on ${kind}`, async (t) => {
      const source = gitRepo();
      if (kind === "binary change") {
        writeFileSync(join(source, "asset.bin"), Buffer.from([0, 1, 2, 3]));
        g(source, "add", "asset.bin");
        g(source, "commit", "-qm", "Add a binary asset");
        g(source, "rm", "asset.bin");
      } else if (kind === "submodule change") {
        const submodule = gitRepo();
        t.after(() => rmSync(submodule, { recursive: true, force: true }));
        g(source, "-c", "protocol.file.allow=always", "submodule", "add", "-q", "--", submodule, "vendor/sub");
        g(source, "config", "submodule.vendor/sub.ignore", "all");
        g(source, "config", "diff.submodule", "log");
        g(source, "commit", "-qam", "Add the submodule");
        writeFileSync(join(source, "vendor/sub/README.md"), "Hidden submodule edit\n");
        assert.equal(g(source, "diff", "--"), "", "normal git diff obeys the local ignore rule");
      } else if (kind === "invalid UTF-8") {
        writeFileSync(join(source, ".gitattributes"), "*.bin diff\n");
        writeFileSync(join(source, "asset.bin"), Buffer.from([0x80, 0x0a]));
        g(source, "add", ".gitattributes", "asset.bin");
        g(source, "commit", "-qm", "Add forced-text binary");
        writeFileSync(join(source, "asset.bin"), Buffer.from([0x81, 0x0a]));
        assert.match(g(source, "diff", "--binary", "--"), /-�\n\+�/, "lossy decoding would erase the difference");
      } else {
        g(source, "update-index", `--${kind}`, "README.md");
        writeFileSync(join(source, "README.md"), "Hidden tracked edit\n");
        assert.equal(g(source, "diff", "--"), "", "Git diff misses the hidden tracked edit");
      }
      const f = await run(t, source, "pair", "Check edits", selection("implementer", "auditor"), {
        implementer: [{ when: "Phase: Implement", text: report("Draft ready") }, { when: "Phase: Address audit", text: report("Done") }],
        auditor: [{ when: "Phase: Orient", text: report("Review the changes") }, { when: "Phase: Audit.", text: report("Looks fine", "approve") }],
      });
      assert.equal((await f.action("start")).status, "running");
      await until(() => f.state().status !== "running", "audit evidence check");
      assert.equal(f.state().status, "failed");
      assert.match(f.state().problem!, new RegExp(kind, "i"));
      assert.equal(f.state().verdict, undefined);
      assert.ok(!f.log().some((e) => e.event === "prompt" && e.message.includes("Phase: Audit.")));
    });
  }

  it("blocks managed Pi writes to coordinator state and linked files outside the task", { skip: process.platform === "win32" }, async (t) => {
    const source = tmp();
    const outside = join(source, "outside.txt");
    writeFileSync(outside, "original\n");
    const write = (path: string) => ["task_write", { path, content: "changed\n" }];
    const edit = (path: string) => ["task_edit", { path, edits: [{ oldText: "original", newText: "changed" }] }];
    const calls = [write(outside), write("../work-sibling/escaped.txt"), edit(outside), edit("hard-link.txt"),
      write("linked-directory/new/deep.txt"), write("dangling-link.txt"), write(".git/config"), write("nested/in-scope.txt")];
    const f = await run(t, source, "pair-work", "Create sample.txt", selection("doer", "verifier"), {
      verifier: [{ when: "Phase: Plan", text: report("Check the artifact") }],
      doer: [{ when: "Phase: Do.", calls, text: report("This report must not count") }],
    });
    const work = join(f.swarm.store.dir, "work");
    mkdirSync(work);
    linkSync(outside, join(work, "hard-link.txt"));
    symlinkSync(source, join(work, "linked-directory"), "dir");
    symlinkSync(join(source, "missing.txt"), join(work, "dangling-link.txt"));
    await f.action("start");
    await until(() => f.state().status === "blocked", "guarded Pi write denial");
    assert.equal(f.swarm.store.member("doer")?.failure, "permission");
    assert.equal(readFileSync(outside, "utf8"), "original\n");
    assert.equal(readFileSync(join(work, "nested/in-scope.txt"), "utf8"), "changed\n");
    for (const path of [join(f.swarm.store.dir, "work-sibling"), join(source, "new"), join(source, "missing.txt"), join(work, ".git")]) {
      assert.equal(existsSync(path), false, path);
    }
    assert.deepEqual(f.log().filter((e) => e.event === "tool").map((e) => e.isError), [true, true, true, true, true, true, true, false]);
    assert.deepEqual(f.state().reports.map((r) => r.phase), ["Plan"]);
  });

  it("plans before any deliverable, verifies it outside Git, and reports exhaustion without acceptance", async (t) => {
    const f = await run(t, tmp(), "pair-work", "Create sample.txt", selection("doer", "verifier"), {
      doer: [{ when: "Phase: Do.", writePath: "sample.txt", writeText: "first sample", text: report("sample.txt ready") },
        { when: "Phase: Address verification", writePath: "sample.txt", writeText: "second sample", text: report("Revised sample.txt") }],
      verifier: [{ when: "Phase: Plan", text: report("Check the literal file contents") },
        { when: "Phase: Verify", readPath: "sample.txt", text: report("No matching sample", "changes requested") }],
    });
    await f.action("start");
    await until(() => f.state().status === "exhausted", "round exhaustion");
    assert.deepEqual(f.log().filter((e) => e.event === "prompt").map((e) => e.name), ["verifier", "doer", "verifier", "doer"]);
    assert.equal(f.log().find((e) => e.event === "file").text, "first sample");
    assert.equal(readFileSync(join(f.state().artifact!, "sample.txt"), "utf8"), "second sample");
    assert.equal(f.state().verdict, "changes requested");
  });

  it("stops pair work on acceptance even with rounds remaining", async (t) => {
    const f = await run(t, tmp(), "pair-work", "Create sample.txt", { ...selection("doer", "verifier"), rounds: 3 }, {
      doer: [{ when: "Phase: Do.", writePath: "sample.txt", writeText: "accepted sample", text: report("sample.txt ready") }],
      verifier: [{ when: "Phase: Plan", retry: true, text: report("Check the literal file contents") },
        { when: "Phase: Verify", readPath: "sample.txt", text: report("Sample matches", "accept") }],
    });
    await f.action("start");
    await until(() => f.state().status === "complete", "acceptance");
    assert.equal(f.state().round, 1);
    assert.equal(f.state().verdict, "accept");
    assert.equal(f.log().filter((e) => e.event === "prompt").length, 3);
  });

  const nativeOnly = { skip: process.platform === "win32" };

  it("keeps the chosen harness when its executable is missing", nativeOnly, async (t) => {
    const source = tmp();
    const picks: Selection = { rounds: 1, roles: { doer: { harness: "codex" }, verifier: pi } };
    const f = await run(t, source, "pair-work", "Create sample.txt", picks, {}, undefined,
      { SWARM_CODEX_BIN: join(source, "missing-codex") });
    for (const action of ["check", "start"]) {
      const state = await f.action(action);
      assert.equal(state.status, "setup");
      assert.match(state.problem, /@doer: codex \[missing-binary\]/);
      assert.equal(state.selection.roles.doer.harness, "codex");
    }
    assert.deepEqual(f.log(), []);
    assert.deepEqual(f.swarm.liveMembers(), []);
    assert.deepEqual(f.saved, []);
  });

  function nativeFixtureEnv(t: import("node:test").TestContext) {
    const home = tmp("pair-fixture-home-");
    t.after(() => rmSync(home, { recursive: true, force: true }));
    const fixture = join(HERE, "fake-pair-native.mjs");
    return { HOME: home,
      SWARM_CLAUDE_BIN: fixture, SWARM_CODEX_BIN: fixture, SWARM_AGY_BIN: fixture };
  }

  it("runs Claude shell writes without a workspace boundary and resumes a separate Codex audit session", nativeOnly, async (t) => {
    const source = gitRepo();
    const env = nativeFixtureEnv(t);
    const outside = join(env.HOME, "outside.txt");
    writeFileSync(outside, "outside the task\n");
    const f = await run(t, source, "pair", `Update the README and the requested companion file.\nOutside: ${outside}`, {
      rounds: 1, roles: { implementer: { harness: "claude" }, auditor: { harness: "codex" } },
    }, {}, undefined, env);
    assert.equal((await f.action("check")).phase, "Workers are ready");
    assert.deepEqual(f.swarm.liveMembers(), []);
    assert.equal((await f.action("start")).status, "running");
    await until(() => f.state().status !== "running", "native pair verdict");
    assert.equal(f.state().status, "complete", f.state().problem);
    assert.equal(f.state().verdict, "approve");
    assert.equal(readFileSync(join(source, "README.md"), "utf8"), "implemented in checkout\n");
    assert.equal(readFileSync(outside, "utf8"), "wrote outside\n");
  });

  it("runs both agy pair roles without dashboard approval", nativeOnly, async (t) => {
    const f = await run(t, tmp(), "pair-work", "Create sample.txt", {
      rounds: 1, roles: { doer: { harness: "agy" }, verifier: { harness: "agy" } },
    }, {}, undefined, nativeFixtureEnv(t));
    assert.equal((await f.action("start")).status, "running");
    await until(() => f.state().status !== "running", "agy verdict");
    assert.equal(f.state().status, "complete", f.state().problem);
    assert.equal(f.state().verdict, "accept");
    assert.equal(readFileSync(join(f.state().artifact!, "sample.txt"), "utf8"), "delivered in task directory\n");
  });

  for (const [outcome, failure] of [[{ stopReason: "error" }, "exit"], [{ linger: true }, "timeout"]] as const) {
    it(`stops before verification when Pi reports ${failure} after emitting valid report text`, async (t) => {
      const f = await run(t, tmp(), "pair-work", "Create sample.txt", selection("doer", "verifier"), {
        verifier: [{ when: "Phase: Plan", text: report("Check the artifact") }, { when: "Phase: Verify", text: report("Accept", "accept") }],
        doer: [{ when: "Phase: Do.", ...outcome, text: report("This report must not count") }],
      }, failure === "timeout" ? 1_200 : undefined);
      await f.action("start");
      await until(() => f.state().status !== "running", "Pi turn outcome", 4_000);
      assert.equal(f.state().status, "failed");
      assert.equal(f.swarm.store.member("doer")?.failure, failure);
      assert.deepEqual(f.state().reports.map((r) => r.phase), ["Plan"]);
      assert.deepEqual(f.log().filter((e) => e.event === "prompt").map((e) => e.name), ["verifier", "doer"]);
      if (failure === "timeout") assert.ok(f.log().some((e) => e.name === "doer" && e.event === "linger"), "deadline fired after the acknowledged turn had emitted its report");
      assert.throws(() => process.kill(f.log().find((e) => e.event === "start" && e.name === "doer").pid, 0), { code: "ESRCH" });
    });
  }

  it("does not advance when an independent reviewer returns malformed output", async (t) => {
    const source = gitRepo();
    const f = await run(t, source, "pair-review", "HEAD", selection("lead", "peer"), {
      lead: [{ when: "Independent review", text: report("Unreleased lead report") }],
      peer: [{ when: "Independent review", text: "I am done without a valid report." }],
    });
    await f.action("start");
    await until(() => f.state().status === "failed", "invalid report failure");
    assert.match(f.state().problem!, /@peer did not return a valid Independent review report/);
    assert.equal(f.state().reports.length, 0);
    assert.equal(f.state().verdict, undefined);
    const prompts = f.log().filter((e) => e.event === "prompt");
    assert.ok(prompts.some((e) => e.name === "peer"));
    assert.ok(prompts.every((e) => e.message.includes("Phase: Independent review.")));
  });
});
