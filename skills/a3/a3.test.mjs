import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { lintA3, main, markdownToHtml, parseA3, renderA3, SECTIONS, summarize, template } from "./a3.mjs";

const FRONT = (status) => `---\ntitle: Nightly quiz ingest stalls\nstatus: ${status}\nowner: idar\nupdated: 2026-10-27\n---\n`;

function a3({ status = "open", goal = "- [ ] A quiz is created at 06:00 for 3 days", plan = "- [x] C1: raise timeout\n- [ ] C1: deploy", result = "pending" } = {}) {
  return `${FRONT(status)}
## Background
Players see no new quiz in the morning.

## Current condition
No rows since 2026-10-20; \`aws logs tail /aws/lambda/ingest\` shows:
> Task timed out after 30.00 seconds

## Goal
${goal}

## Root cause analysis
1. Why no quiz? The Lambda times out (confirmed by log).
   1. Why? The model call takes 40 s.

## Countermeasures
### C1: Raise Lambda timeout to 120 s
- Addresses: model call exceeds the 30 s timeout
- Prediction: the 06:00 run completes and inserts one quiz
- Check: \`aws logs tail\` shows "inserted quiz"; row count +1
- Result: ${result}

## Implementation plan
${plan}

## Follow-up
${status === "open" ? "" : "Predicted completion; observed completion in 41 s. Standardize: alarm on timeouts."}
`;
}

describe("a3 template", () => {
  it("contains every section in A3 order and is lint-clean apart from analysis warnings", () => {
    const text = template("Example", "2026-01-01");
    const parsed = parseA3(text);
    assert.deepEqual(parsed.order, SECTIONS);
    assert.equal(parsed.meta.status, "open");
    const { errors, warnings } = lintA3(text);
    assert.deepEqual(errors, []);
    assert.ok(warnings.some((w) => /Current condition is empty/.test(w)));
  });
});

describe("a3 lint", () => {
  it("accepts a well-formed open A3", () => {
    assert.deepEqual(lintA3(a3()), { errors: [], warnings: [] });
  });

  it("requires a prediction, a check, and a known result on every countermeasure", () => {
    const text = a3().replace(/- Prediction:.*\n/, "").replace("Result: pending", "Result: maybe");
    const { errors } = lintA3(text);
    assert.ok(errors.some((e) => /C1.*missing Prediction/.test(e)));
    assert.ok(errors.some((e) => /C1.*Result must start with/.test(e)));
  });

  it("refuses countermeasures without evidence-based analysis", () => {
    const text = a3().replace(/No rows[\s\S]*?seconds\n/, "It seems broken.\n");
    assert.ok(lintA3(text).errors.some((e) => /cites no evidence/.test(e)));
  });

  it("only allows done when goals, steps, and checks are closed and Follow-up exists", () => {
    const { errors } = lintA3(a3({ status: "done" }));
    assert.ok(errors.some((e) => /goal not met/.test(e)));
    assert.ok(errors.some((e) => /plan step open: C1: deploy/.test(e)));
    assert.ok(errors.some((e) => /C1.*still pending/.test(e)));

    const closed = a3({
      status: "done",
      goal: "- [x] A quiz is created at 06:00 for 3 days",
      plan: "- [x] C1: raise timeout\n- [x] C1: deploy",
      result: "confirmed — run finished in 41 s, 1 row inserted",
    });
    assert.deepEqual(lintA3(closed).errors, []);
  });

  it("reports missing front matter and sections and ignores headings inside comments or code", () => {
    const { errors } = lintA3("## Background\n<!--\n## Goal\n-->\n```\n## Goal\n```\n");
    assert.ok(errors.includes("missing front matter (--- title / status ---)"));
    assert.ok(errors.includes('missing section "## Goal"'));
  });
});

describe("a3 status", () => {
  it("points at the next step of the loop", () => {
    assert.equal(summarize(template("x")).next, "go and see: document the current condition");
    assert.equal(summarize(a3()).next, "do: C1: deploy");
    assert.equal(summarize(a3({ plan: "- [x] C1: deploy" })).next, "check: C1: Raise Lambda timeout to 120 s");
    assert.match(summarize(a3({ plan: "- [x] C1: deploy", result: "refuted — still times out" })).next, /goal not met, revise/);
    const s = summarize(a3({ result: "confirmed" }));
    assert.deepEqual(s.countermeasures, { confirmed: 1, refuted: 0, pending: 0 });
    assert.deepEqual(s.goals, { met: 0, total: 1 });
  });
});

describe("a3 render", () => {
  it("lays out a two-column sheet with countermeasure cards and status", () => {
    const html = renderA3(a3({ result: "refuted — still 40 s" }));
    assert.match(html, /<title>A3 · Nightly quiz ingest stalls<\/title>/);
    const [left, right] = html.split('<div class="col">').slice(1);
    for (const name of SECTIONS.slice(0, 4)) assert.ok(left.includes(name), name);
    for (const name of SECTIONS.slice(4)) assert.ok(right.includes(name) && !left.includes(name), name);
    assert.match(html, /<article class="cm r-refuted">/);
    assert.match(html, /<dt>Prediction<\/dt>/);
    assert.match(html, /<blockquote>/);
    assert.match(html, /<code>aws logs tail \/aws\/lambda\/ingest<\/code>/);
    assert.match(html, /@page\{size:A3 landscape/);
    assert.doesNotMatch(html, /mermaid\.esm/);
  });

  it("escapes HTML and neutralizes script URLs", () => {
    const html = markdownToHtml('<img src=x onerror=alert(1)> [x](javascript:alert(1)) `<b>`');
    assert.doesNotMatch(html, /<img|javascript:/);
    assert.match(html, /&lt;img/);
    assert.match(html, /<code>&lt;b&gt;<\/code>/);
  });

  it("renders nested task lists, tables, and Mermaid blocks", () => {
    const html = markdownToHtml("- [x] done\n  - [ ] child\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n\n```mermaid\nflowchart LR\n  a --> b\n```");
    assert.match(html, /<li class="done"><input type="checkbox" disabled checked> done<ul class="tasks"><li class="todo">/);
    assert.match(html, /<td>1<\/td><td>2<\/td>/);
    assert.match(html, /<pre class="mermaid">flowchart LR\n  a --&gt; b<\/pre>/);
    assert.match(markdownToHtml("- log:\n  > timed out"), /<li>log:<blockquote><p>timed out<\/p><\/blockquote><\/li>/);
  });
});

describe("a3 CLI", () => {
  it("creates, lints, reports, and renders A3 files", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "a3 test-"));
    const lines = [];
    const io = { log: (l) => lines.push(l), error: (l) => lines.push(l) };
    try {
      const a3dir = path.join(dir, "a3");
      assert.equal(main(["new", "quiz-ingest", "--title", "Quiz ingest", "--dir", a3dir], io), 0);
      const file = path.join(a3dir, "quiz-ingest.md");
      assert.match(readFileSync(file, "utf8"), /^---\ntitle: Quiz ingest\nstatus: open/);
      assert.match(readFileSync(path.join(a3dir, ".gitignore"), "utf8"), /\*\.html/);
      assert.throws(() => main(["new", "quiz-ingest", "--dir", a3dir], io), /already exists/);
      assert.throws(() => main(["new", "Bad Slug", "--dir", a3dir], io), /lowercase slug/);

      assert.equal(main(["lint", file], io), 0);
      writeFileSync(file, a3({ status: "done" }));
      assert.equal(main(["lint", file], io), 1);

      lines.length = 0;
      assert.equal(main(["status", a3dir, "--json"], io), 0);
      assert.equal(JSON.parse(lines[0])[0].status, "done");

      assert.equal(main(["render", file], io), 0);
      assert.ok(existsSync(path.join(a3dir, "quiz-ingest.html")));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
