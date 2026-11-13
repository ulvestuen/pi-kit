// Test fake for Herdr over SSH: herdr-core `hc` works, the desktop app CLI is missing or cannot see the caller.
// Shared by the pair, pair-review, and pair-work tests; never touches real terminals.

/**
 * `answer(prompt)` plays the worker: it writes the report the prompt's turn file names.
 * `app`: "missing" (spawn ENOENT), "no-window" (herdr-app ls fails), or "hidden" (the caller has no pane).
 * `busy`: after each send, how many `hc get` checks report the *other* workers as still working (finishing a turn).
 */
export function fakeHerdrCore({ answer, self = "t0", app = "missing", git = true, busy = 0 }) {
  const calls = [];
  const terminals = new Map([[self, { state: "live", status: { state: "working" }, labels: {} }]]);
  let n = 0;
  const busyLeft = new Map();
  const exec = async (cmd, args) => {
    calls.push([cmd, ...args]);
    if (cmd === "git") return git ? "## main\n" : Promise.reject(new Error("git status --short --branch: fatal: not a git repository"));
    if (cmd === "herdr-app") {
      if (app === "missing") throw new Error(`herdr-app ${args.join(" ")}: spawn herdr-app ENOENT`);
      if (app === "no-window") throw Object.assign(new Error("herdr-app ls: no Herdr window is running"), { stdout: "" });
      if (app === "hidden" && args[0] === "ls") return JSON.stringify({ spaces: [{ tabs: [{ terminals: [{ terminal: "t99", pane: "p99" }] }] }] });
      throw new Error(`unexpected herdr-app ${args.join(" ")}`);
    }
    if (cmd !== "hc") throw new Error(`unexpected command ${cmd}`);
    const [sub, ...rest] = args;
    const known = (id) => terminals.get(id) ?? Promise.reject(Object.assign(new Error(`hc ${sub} ${id}: not_found`), { stdout: "" }));
    if (sub === "run") {
      const split = rest.indexOf("--");
      const flags = rest.slice(0, split);
      const argv = rest.slice(split + 1);
      const value = (name) => flags[flags.indexOf(name) + 1];
      const labels = Object.fromEntries(flags.flatMap((f, i) => (f === "--label" ? [flags[i + 1].split("=")] : [])));
      const address = `t${++n}`;
      const t = { state: "live", status: { state: "working" }, labels, name: value("--name"), cwd: value("--cwd"), argv, flags };
      terminals.set(address, t);
      answer(argv.at(-1));
      t.status = { state: "done" };
      return JSON.stringify({ address, name: t.name, cwd: t.cwd, argv, labels, state: "live" });
    }
    if (sub === "get") {
      const t = await known(rest[0]);
      if (busyLeft.get(rest[0]) > 0) {
        busyLeft.set(rest[0], busyLeft.get(rest[0]) - 1);
        return JSON.stringify({ address: rest[0], state: t.state, status: { state: "working" }, labels: t.labels });
      }
      return JSON.stringify({ address: rest[0], state: t.state, status: t.state === "live" ? t.status : null, labels: t.labels });
    }
    if (sub === "wait") return JSON.stringify({ terminal: rest[0], ended: true, reason: "status", status: "done", turn: 1, children: [] });
    if (sub === "send") {
      const t = await known(rest[0]);
      t.status = { state: "working" };
      answer(rest.at(-1));
      t.status = { state: "done" };
      for (const id of terminals.keys()) if (id !== rest[0] && id !== self) busyLeft.set(id, busy);
      return "{}";
    }
    if (sub === "read") return "worker screen\n";
    if (sub === "kill") {
      (await known(rest[0])).state = "finished";
      return "{}";
    }
    if (sub === "rm") {
      await known(rest[0]);
      terminals.delete(rest[0]);
      return "{}";
    }
    if (sub === "label") return "{}";
    throw new Error(`unexpected hc ${sub}`);
  };
  /** Each run's `hc send` must be preceded by a status check showing the worker is not working. */
  const sendsAfterIdleCheck = () =>
    calls.every((c, i) => {
      if (c[0] !== "hc" || c[1] !== "send") return true;
      const lastGet = calls.slice(0, i).findLastIndex((p) => p[0] === "hc" && p[1] === "get" && p[2] === c[2]);
      return lastGet >= 0;
    });
  return { exec, calls, terminals, sendsAfterIdleCheck };
}

/** A worker that writes the report named in the turn file its prompt points to. */
export function reportWriter(readFileSync, writeFileSync, DONE, verdictFor = () => "") {
  return (prompt) => {
    const turn = /read (\S+\.turn\.md)/.exec(prompt ?? "")?.[1];
    if (!turn) return;
    const report = readFileSync(turn, "utf8").match(/write your report as Markdown to:\n\n(\S+)/)[1];
    writeFileSync(report, `report for ${turn}\n${verdictFor(turn)}${DONE}\n`);
  };
}
