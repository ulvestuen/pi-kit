import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { classify, main, metrics, parseSession, redact } from "./hansei.mjs";

const user = (text, at) => ({ type: "message", timestamp: at, message: { role: "user", content: [{ type: "text", text }] } });
const assistant = ({ calls = 1, stop = "toolUse", cost = 0.5, text } = {}) => ({
  type: "message",
  message: {
    role: "assistant",
    model: "m1",
    stopReason: stop,
    usage: { totalTokens: 1000, cost: { total: cost } },
    content: [
      { type: "thinking", thinking: "x" },
      ...(text ? [{ type: "text", text }] : []),
      ...Array.from({ length: calls }, () => ({ type: "toolCall", name: "bash" })),
    ],
  },
});
const toolResult = (isError) => ({ type: "message", message: { role: "toolResult", toolName: "bash", isError, content: [] } });
const jsonl = (cwd, start, entries) => [{ type: "session", cwd, timestamp: start }, ...entries].map((e) => JSON.stringify(e)).join("\n") + "\n";

describe("hansei classify", () => {
  it("separates nudges, stamps, repeats, corrections, shipping, and noise", () => {
    const cases = {
      nudge: ["continue", "contiue for max another 25 rounds", "go on with 11", "please do", "what is next?"],
      stamp: ["yes", "yes to all", "approved", "y"],
      repeat: ["send it again", "do it again", "test the kagi search again"],
      correction: [
        "no, it does not work, please fix it",
        "but I thought the private key was for decrypting",
        "what was done here? I cant see any improvements in the live site",
        "it can´t be that, this looks really boring",
      ],
      ship: ["add all, commit and push", "babysit CI until it is green", "rerun deployment"],
      noise: ["hi", "clear", "/implement"],
      task: ["implement a dark mode toggle", "what is direnv?"],
    };
    for (const [kind, texts] of Object.entries(cases)) for (const text of texts) assert.equal(classify(text).kind, kind, text);
  });

  it("recognizes skill and workflow-template invocations", () => {
    assert.deepEqual(classify('<skill name="pdca" location="/x">\n# PDCA'), { kind: "skill", skill: "pdca" });
    assert.deepEqual(classify("Run a **multi-agent orchestration** on the following goal"), { kind: "template", skill: "multi-agent orchestration" });
  });
});

describe("hansei sessions", () => {
  it("counts prompts, tool calls and errors, cost, and in-session repeats", () => {
    const s = parseSession(
      jsonl("/home/u/Code/quizzly", "2026-10-01T10:00:00Z", [
        user("fix the login bug on mobile", "2026-10-01T10:00:01Z"),
        assistant({ calls: 3 }),
        toolResult(false),
        toolResult(true),
        assistant({ calls: 0, stop: "error" }),
        user("continue"),
        user("Fix the login bug on mobile please!"),
        user("hi"),
        "not json",
      ]).replace('"not json"', "not json"),
    );
    assert.equal(s.project, "quizzly");
    assert.deepEqual(s.prompts.map((p) => p.kind), ["task", "nudge", "repeat", "noise"]);
    assert.equal(s.toolCalls, 3);
    assert.equal(s.toolErrors, 1);
    assert.equal(s.modelErrors, 1);
    assert.equal(s.cost, 1);

    const m = metrics([s]);
    assert.equal(m.prompts, 3, "noise is not counted as a prompt");
    assert.equal(m.rates.nudge, 33.3);
    assert.equal(m.rates.toolError, 33.3);
  });
});

describe("hansei question context", () => {
  it("separates rubber stamps of question batches from approvals and real answers", () => {
    const batch = "Q1 — Battery too? ➡️ Yes.\nQ2 — Menu bar only? ➡️ Yes.\nQ3 — Skip updates? See https://x.test/?a=1 ➡️ Yes.";
    const s = parseSession(
      jsonl("/c/app", "2026-10-01T00:00:00Z", [
        assistant({ text: batch }),
        user("yes to all"),
        assistant({ text: batch }),
        user("Q2 no, keep the dock icon. yes to the rest"),
        assistant({ text: "May I run `npm install`?" }),
        user("yes"),
        assistant({ calls: 2 }),
        user("yes"),
      ]),
    );
    assert.deepEqual(s.prompts.map((p) => p.kind), ["stamp", "answer", "approval", "approval"]);
    const m = metrics([s]);
    assert.equal(m.rates.stamp, 25);
    assert.equal(m.rates.batchInput, 50);
  });
});

describe("hansei redact", () => {
  it("masks secrets, emails, long hex, and the home directory", () => {
    const text = redact(
      "KAGI_API_KEY=abc123 Authorization: Bearer abcdefghijklmnop1234 ghp_abcdefghijklmnopqrstu mail a@b.co key " + "ab".repeat(32) + " /home/u/x",
      "/home/u",
    );
    assert.doesNotMatch(text, /abc123|abcdefghijklmnop1234|ghp_|a@b\.co|abab|\/home\/u/);
    assert.match(text, /KAGI_API_KEY=\[redacted\]/);
    assert.match(text, /~\/x/);
  });
});

describe("hansei CLI", () => {
  it("reports by project, filters by date and project, and compares before vs after", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "hansei test-"));
    try {
      const write = (folder, name, content) => {
        mkdirSync(path.join(dir, folder), { recursive: true });
        writeFileSync(path.join(dir, folder, name), content);
      };
      write("--a--", "1.jsonl", jsonl("/c/alpha", "2026-09-01T00:00:00Z", [user("build the thing"), assistant(), user("continue"), user("continue")]));
      write("--a--", "2.jsonl", jsonl("/c/alpha", "2026-10-20T00:00:00Z", [user("build another thing"), assistant({ text: "A? B? C?" }), user("yes to all")]));
      write("--b--", "3.jsonl", jsonl("/c/beta", "2026-10-21T00:00:00Z", [user("no, it does not work, token sk-abcdefghijklmnopqrstuvwx")]));
      write("--b--", "notes.txt", "ignored");

      const out = [];
      const log = (l) => out.push(l);
      const now = new Date("2026-10-28T00:00:00Z");
      assert.equal(main(["--dir", dir], { log, now }), 0);
      const report = out.join("\n");
      assert.match(report, /sessions\s+3/);
      assert.match(report, /alpha\s+2\s+5\s+2\s+1\s+0\s+0/);
      assert.match(report, /# Recent corrections\n\n- 2026-10-21 beta: no, it does not work, token \[redacted\]/);
      assert.doesNotMatch(report, /sk-abc/);

      out.length = 0;
      assert.equal(main(["--dir", dir, "--since", "14d", "--project", "alp", "--json"], { log, now }), 0);
      const m = JSON.parse(out[0]);
      assert.equal(m.sessions, 1);
      assert.equal(m.counts.stamp, 1);
      assert.doesNotMatch(out[0], /build another thing/, "JSON has no prompt text");

      out.length = 0;
      assert.equal(main(["--dir", dir, "--split", "2026-10-01"], { log, now }), 0);
      assert.match(out[0], /nudges \(continue…\) per 100 prompts\s+66\.7\s+0/);
      assert.match(out[0], /too few to conclude/);

      assert.equal(main(["--dir", path.join(dir, "missing")], { log, now }), 1);
      assert.throws(() => main(["--since", "yesterday"], { log, now }), /invalid date/);
      assert.throws(() => main(["--bogus"], { log, now }), /unknown argument/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
