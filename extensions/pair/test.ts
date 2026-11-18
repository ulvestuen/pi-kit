import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  describeSelection,
  fromThreema,
  joinSpec,
  loadPicks,
  matchModel,
  modelList,
  preselect,
  runFlags,
  sameModelWarning,
  savePicks,
  shellArg,
  splitSpec,
  thinkingChoices,
  WORKFLOWS,
  type Selection,
} from "./lib.ts";
import { PairPicker } from "./picker.ts";
import { visibleWidth } from "@earendil-works/pi-tui";

const MODELS = [
  "claude-code/claude-opus-5-5",
  "anthropic/claude-opus-5-5",
  "anthropic/claude-sonnet-5",
  "openai/gpt-6.1-sol",
  "opencode/gpt-6.1-sol",
];

const theme = { fg: (_c: string, text: string) => text, bold: (text: string) => text };
const KEY = { up: "\x1b[A", down: "\x1b[B", right: "\x1b[C", left: "\x1b[D", enter: "\r", escape: "\x1b", backspace: "\x7f" };
const tick = () => new Promise((r) => setImmediate(r));

describe("specs", () => {
  it("splits a known thinking suffix and keeps other colons", () => {
    assert.deepEqual(splitSpec("openai/gpt-6.1-sol:xhigh"), { model: "openai/gpt-6.1-sol", thinking: "xhigh" });
    assert.deepEqual(splitSpec("ollama/qwen3:32b"), { model: "ollama/qwen3:32b", thinking: "default" });
  });
  it("joins without a suffix for the default level", () => {
    assert.equal(joinSpec({ model: "a/b", thinking: "default" }), "a/b");
    assert.equal(joinSpec({ model: "a/b", thinking: "high" }), "a/b:high");
  });
  it("matches what a request named to a listed model", () => {
    assert.deepEqual(matchModel("sonnet:high", MODELS), { model: "anthropic/claude-sonnet-5", thinking: "high" });
    assert.deepEqual(matchModel("claude-opus-5-5", MODELS), { model: "claude-code/claude-opus-5-5", thinking: "default" });
    assert.deepEqual(matchModel("anthropic/claude-opus-5-5", MODELS).model, "anthropic/claude-opus-5-5");
    assert.deepEqual(matchModel("mystery/model", MODELS).model, "mystery/model");
  });
});

describe("modelList", () => {
  const m = (provider: string, id: string) => ({ provider, id });
  it("uses scoped models when scoping is configured", () => {
    assert.deepEqual(modelList([m("a", "x")], [m("a", "x"), m("b", "y")]), ["a/x"]);
  });
  it("falls back to every available model, without duplicates", () => {
    assert.deepEqual(modelList([], [m("a", "x"), m("a", "x"), m("b", "y")]), ["a/x", "b/y"]);
  });
});

describe("preselect", () => {
  it("uses today's defaults on the first run", () => {
    const { selection, sources } = preselect("pair", {});
    assert.equal(joinSpec(selection.roles.implementer), "claude-code/claude-opus-5-5");
    assert.equal(joinSpec(selection.roles.auditor), "openai/gpt-6.1-sol:xhigh");
    assert.equal(selection.rounds, 3);
    assert.equal(sources.implementer, "default");
    assert.equal(preselect("pair-review", {}).selection.rounds, 1);
  });
  it("prefers the request, then the last pick for that workflow", () => {
    const saved = { pair: { roles: { implementer: "anthropic/claude-sonnet-5:high" }, rounds: 2 }, "pair-work": { roles: { doer: "x/y" } } };
    const { selection, sources } = preselect("pair", { saved, requested: { models: { auditor: "opencode/gpt-6.1-sol" } }, models: MODELS });
    assert.equal(joinSpec(selection.roles.implementer), "anthropic/claude-sonnet-5:high");
    assert.equal(joinSpec(selection.roles.auditor), "opencode/gpt-6.1-sol");
    assert.equal(selection.rounds, 2);
    assert.deepEqual([sources.implementer, sources.auditor, sources.rounds], ["last pick", "request", "last pick"]);
    assert.equal(preselect("pair", { saved, requested: { rounds: 5 } }).selection.rounds, 5);
  });
  it("ignores invalid saved rounds", () => {
    assert.equal(preselect("pair", { saved: { pair: { rounds: 0 } } }).selection.rounds, 3);
  });
});

describe("saved picks", () => {
  it("round-trips per workflow and keeps other workflows", () => {
    const file = join(mkdtempSync(join(tmpdir(), "pair-picker-")), "sub", "picks.json");
    assert.deepEqual(loadPicks(file), {});
    savePicks(file, preselect("pair-work", {}).selection);
    const pair: Selection = { workflow: "pair", roles: { implementer: { model: "a/b", thinking: "high" }, auditor: { model: "c/d", thinking: "default" } }, rounds: 4 };
    savePicks(file, pair);
    const all = loadPicks(file);
    assert.deepEqual(all.pair, { roles: { implementer: "a/b:high", auditor: "c/d" }, rounds: 4 });
    assert.ok(all["pair-work"]);
  });
  it("treats a corrupt file as empty", () => {
    const file = join(mkdtempSync(join(tmpdir(), "pair-picker-")), "picks.json");
    writeFileSync(file, "{not json");
    assert.deepEqual(loadPicks(file), {});
  });
});

describe("flags and warnings", () => {
  const selection: Selection = { workflow: "pair-review", roles: { lead: { model: "a/b", thinking: "high" }, peer: { model: "a/b", thinking: "default" } }, rounds: 2 };
  it("builds run flags in role order", () => {
    assert.deepEqual(runFlags(selection), ["--lead-model", "a/b:high", "--peer-model", "a/b", "--rounds", "2"]);
    assert.equal(describeSelection(selection), "lead a/b:high, peer a/b, 2 rounds");
  });
  it("warns when both roles use the same model", () => {
    assert.match(sameModelWarning(selection) ?? "", /Both roles use a\/b/);
    assert.equal(sameModelWarning(preselect("pair", {}).selection), null);
  });
  it("quotes only values that need it", () => {
    assert.equal(shellArg("openai/gpt-6.1-sol:xhigh"), "openai/gpt-6.1-sol:xhigh");
    assert.equal(shellArg("a b'c"), `'a b'\\''c'`);
  });
  it("offers default plus the supported levels", () => {
    assert.deepEqual(thinkingChoices(["off"]), ["default", "off"]);
    assert.equal(thinkingChoices(undefined).length, 8);
  });
});

describe("fromThreema", () => {
  const user = (content: unknown) => ({ type: "message", message: { role: "user", content } });
  it("is true when the last user message came from Threema", () => {
    assert.equal(fromThreema([user("hi"), user([{ type: "text", text: "[Threema message from ABCD1234]: pair on x" }])]), true);
    assert.equal(fromThreema([user("[Threema message from X]: a"), user("now at the desk")]), false);
    assert.equal(fromThreema([]), false);
  });
});

describe("PairPicker", () => {
  const make = (overrides: Partial<ConstructorParameters<typeof PairPicker>[1]> = {}) => {
    let result: Selection | null | undefined;
    const picker = new PairPicker(theme, {
      selection: preselect("pair", {}).selection,
      models: MODELS,
      levelsFor: (model) => (model.startsWith("anthropic/") ? ["off", "low", "medium", "high"] : undefined),
      done: (value) => (result = value),
      ...overrides,
    });
    return { picker, result: () => result };
  };
  const press = (picker: PairPicker, ...keys: string[]) => keys.forEach((key) => picker.handleInput(key));

  it("starts on Start: enter confirms the preselection", async () => {
    const { picker, result } = make();
    press(picker, KEY.enter);
    await tick();
    assert.equal(joinSpec(result()!.roles.auditor), "openai/gpt-6.1-sol:xhigh");
  });

  it("escape cancels", () => {
    const { picker, result } = make();
    press(picker, KEY.escape);
    assert.equal(result(), null);
  });

  it("searches and picks a model, changes thinking and rounds", async () => {
    const { picker, result } = make();
    // rows: impl model, impl thinking, aud model, aud thinking, rounds, start (cursor)
    press(picker, KEY.down, KEY.enter); // wrap to implementer model, open search
    press(picker, ..."sonnet");
    const screen = picker.render(80).join("\n");
    assert.match(screen, /anthropic\/claude-sonnet-5/);
    assert.doesNotMatch(screen, /openai/);
    press(picker, KEY.enter); // choose sonnet
    press(picker, KEY.down, KEY.right, KEY.right); // thinking default → off → low
    press(picker, KEY.down, KEY.down, KEY.down, KEY.left); // rounds 3 → 2
    press(picker, KEY.down, KEY.enter);
    await tick();
    const chosen = result()!;
    assert.deepEqual(chosen.roles.implementer, { model: "anthropic/claude-sonnet-5", thinking: "low" });
    assert.equal(chosen.rounds, 2);
  });

  it("resets thinking the new model does not support", () => {
    const { picker } = make();
    press(picker, KEY.down, KEY.down, KEY.down, KEY.enter); // auditor model (xhigh)
    press(picker, ..."anthropic/claude-sonnet", KEY.enter);
    assert.equal(picker.current().roles.auditor.thinking, "default");
  });

  it("drops the source label once a value is changed", () => {
    const { picker } = make({ sources: { implementer: "default", auditor: "default", rounds: "default" } });
    press(picker, KEY.down, KEY.enter, ..."sonnet", KEY.enter);
    const line = picker.render(100).find((l) => l.includes("Implementer model"))!;
    assert.doesNotMatch(line, /\(default\)/);
  });

  it("uses typed text as given when nothing matches", () => {
    const { picker } = make();
    press(picker, KEY.down, KEY.enter, ..."local/thing", KEY.enter);
    assert.equal(picker.current().roles.implementer.model, "local/thing");
  });

  it("shows the same-model warning", () => {
    const { picker } = make();
    press(picker, KEY.down, KEY.down, KEY.down, KEY.enter, ..."claude-code", KEY.enter);
    assert.match(picker.render(100).join("\n"), /Both roles use claude-code\/claude-opus-5-5/);
  });

  it("stays open with the reason when the check fails", async () => {
    let calls = 0;
    const { picker, result } = make({ check: async () => (calls++ ? null : "Auditor: openai/gpt-6.1-sol is not ready (no key)") });
    press(picker, KEY.enter);
    await tick();
    assert.equal(result(), undefined);
    assert.match(picker.render(120).join("\n"), /not ready \(no key\)/);
    press(picker, KEY.enter);
    await tick();
    assert.ok(result());
  });

  it("renders inside the given width", () => {
    const { picker } = make({ task: "a long task ".repeat(20) });
    for (const line of picker.render(60)) assert.ok(visibleWidth(line) <= 60, line);
  });

  it("covers every workflow's roles", () => {
    for (const info of Object.values(WORKFLOWS)) {
      const picker = new PairPicker(theme, { selection: preselect(info.id, {}).selection, models: MODELS, done: () => {} });
      const screen = picker.render(100).join("\n");
      for (const role of info.roles) assert.match(screen, new RegExp(role.label));
    }
  });
});
