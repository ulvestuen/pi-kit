# Multi-Agent Orchestration for pi-kit — Design

Status: **Implemented** (phases 1–4 shipped as [`fleet/`](../fleet/),
[`planner/`](../planner/), [`critic/`](../critic/), and
[`orchestrator/`](../orchestrator/); phase 5 remains optional future work)

This document designs a set of pi extensions that together provide an
**orchestrator**, a **planner**, an **advisor/critic**, and a **fleet of
implementation sub-agents**. The guiding principle is the same one pi-kit
already follows: small standalone modules, each useful on its own, with larger
features composed *from* them rather than built as a monolith. The design also
specifies how the pieces interoperate with the existing
[`lykkja`](../lykkja/README.md) Plan-Do-Check-Act loop extension — lykkja is
deliberately reused, unchanged, as the quality gate and stopping rule of the
orchestration loop.

---

## 1. Goals and non-goals

### Goals

- **Fan-out**: dispatch independent implementation tasks to sub-agents that run
  concurrently, each with an isolated context window and (optionally) an
  isolated working tree.
- **Structured planning**: represent a plan as *data* (a task DAG with per-task
  acceptance criteria), not just prose, so scheduling and progress tracking are
  mechanical.
- **Independent review**: score results with a critic agent that has fresh
  context, instead of relying on the working agent grading its own homework.
- **Disciplined iteration**: wrap the whole run in a lykkja PDCA loop so the
  orchestrator iterates until an explicit, measurable bar is met — or stops at
  a hard cap.
- **Standalone modules**: every extension is independently installable and
  useful alone; the orchestrator is a thin composition layer, not the owner of
  the other pieces.

### Non-goals

- No long-lived daemon agents or background services (unlike `threema`'s
  webhook, everything here is request-scoped).
- No cross-machine distribution — sub-agents are local child processes.
- No changes to pi core; everything uses the public `ExtensionAPI`.
- No replacement of lykkja — it is composed with, not forked.

---

## 2. Foundations this design builds on

### pi-kit conventions (kept for every new extension)

Each extension is a workspace with the same shape the existing four use:

| File | Role |
|---|---|
| `index.ts` | Thin wiring: default-exports `function (pi: ExtensionAPI)`; registers tools/commands/hooks |
| `<core>.ts` | Pure, dependency-free engine (like `lykkja/loop.ts`) — the reusable module |
| `config.ts` | JSON config at `~/.pi/agent/extensions/<name>/<name>.json`, env-var fallbacks, clear validation errors |
| `test.ts` | Network-free unit tests, run with `tsx --test` |
| `README.md` | Standalone install/config/usage docs |
| `package.json` | Own `pi` manifest (`extensions`, optionally `skills`) so the package installs standalone |

### pi `ExtensionAPI` surface used

- `pi.registerTool(defineTool({...}))`, `pi.registerCommand(name, {...})`
- `pi.on(...)` lifecycle events (`before_agent_start`, `session_start`, …)
- `pi.appendEntry(customType, data)` + `ctx.sessionManager.getEntries()` for
  restart-safe state (the lykkja pattern)
- `pi.sendUserMessage(text, opts?)` for self-prompting
- `pi.events.on/emit` — the shared bus for loose extension-to-extension signals
- `ctx.ui` (notify, `setStatus`), `ctx.hasUI`, `ctx.signal`, `ctx.mode`

### lykkja (reused as-is)

The pure engine `lykkja/loop.ts` exports the types and functions this design
leans on: `Criterion { name, threshold }`, `CriterionScore { name, score,
weakness? }`, `LoopState`, `Decision { verdict: "FINAL" | "ITERATING" |
"STOPPED", … }`, plus `createLoop`, `recordCheckpoint`, `normalizeCriteria`,
`summarizeLoop`. The module is dependency-free by design ("so it can be reused
by the extension, commands, and tools"), which makes it the natural shared
vocabulary for acceptance criteria and scoring across all four new extensions.

### Prior art

pi-mono ships a `subagent` example extension (markdown agent definitions,
one child `pi` process per sub-agent, parallel mode with concurrency caps,
model-visible output capped with full results in tool `details`). We build our
own runner rather than adopting it — we want worktree isolation, a structured
result contract, and event-bus progress — but its mechanics validate the
approach and inform defaults (concurrency 4, output caps).

---

## 3. Architecture overview

Four new extensions, one role each:

```
┌─────────────────────────────────────────────────────────────┐
│  orchestrator/  (pi-orchestrator)  — thin composition layer │
│  /orchestrate <goal>; scheduler.ts drives the run           │
└───────┬───────────────┬───────────────┬─────────────────────┘
        │ plan.ts       │ runner.ts     │ review.ts     loop.ts
        ▼               ▼               ▼               ▼
┌──────────────┐ ┌──────────────┐ ┌──────────────┐ ┌──────────────┐
│  planner/    │ │  fleet/      │ │  critic/     │ │  lykkja/     │
│  plan as a   │ │  sub-agent   │ │  independent │ │  PDCA loop,  │
│  task DAG    │ │  runtime     │ │  reviewer    │ │  stop rule   │
└──────────────┘ └──────────────┘ └──────┬───────┘ └──────────────┘
                                         │ dispatches critic agents
                                         ▼
                                  fleet/runner.ts
```

**Composition rules.** Extensions compose through exactly four sanctioned
mechanisms, and never by importing each other's `index.ts`:

1. **Pure-core imports** — an extension may import another package's pure
   engine module (`plan.ts`, `runner.ts`, `review.ts`, `loop.ts`). These
   modules have no pi/Node-API dependencies (the fleet runner takes an
   injectable spawn function), so importing them creates no load-order or
   runtime coupling.
2. **`pi.events` bus** — runtime signals (`fleet:task_start`,
   `planner:task_status`, …) for extensions that want to *observe* each other
   without depending on each other.
3. **Custom session entries** — persisted state (`fleet-state`,
   `planner-state`, `lykkja-state`) readable by anyone via
   `ctx.sessionManager.getEntries()`; this is already lykkja's de facto read
   hook.
4. **Model-level composition** — tools, skills, and prompts. The orchestrator
   can instruct the model to call `lykkja_start`; a skill can reference another
   skill.

Each layer degrades gracefully: fleet alone gives you parallel sub-agents;
planner alone gives you structured plans; critic alone gives you independent
review of anything; the orchestrator only lights up when its dependencies are
installed (it checks for their tools/pure modules and reports what's missing).

---

## 4. `fleet/` (pi-fleet) — sub-agent runtime primitive

The foundational capability: run N sub-agents as child `pi` processes, each
with its own context window, role prompt, model, and tool restrictions.

### 4.1 Agent definitions — `registry.ts` (pure)

Agents are markdown files with YAML frontmatter; the body is the system prompt.

```markdown
---
name: implementer
description: Implements one well-scoped task to completion, tests included.
model: claude-sonnet-5          # optional; defaults to parent's model
thinkingLevel: medium           # optional
tools: read, bash, edit, write  # optional allowlist; omit = parent's tools
---
You implement exactly one task. You receive the task description, its
acceptance criteria, and relevant file paths. Work only within scope...
```

Discovery locations, later wins on name collision:

1. Kit-shipped defaults: `fleet/agents/{scout,implementer,critic,planner}.md`
2. User: `~/.pi/agent/agents/*.md`
3. Project: `.pi/agents/*.md`

`registry.ts` is pure: it parses frontmatter and validates definitions from
`(path, content)` pairs handed to it; the file-system walk lives in `index.ts`.

```ts
export interface AgentDefinition {
  name: string;
  description: string;
  systemPrompt: string;
  model?: string;
  thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
  tools?: string[];
  source: string; // file path, for /fleet listing and error messages
}

export function parseAgentDefinition(path: string, content: string): AgentDefinition;
export function mergeRegistries(...layers: AgentDefinition[][]): Map<string, AgentDefinition>;
```

### 4.2 Runner — `runner.ts` (pure with injected effects)

The runner owns process lifecycle, concurrency, timeouts, output handling, and
isolation. It never imports pi or `node:child_process` directly — a spawn
function is injected, so `test.ts` can drive it with a fake `pi` and the
orchestrator can reuse it in any context.

```ts
export interface TaskSpec {
  agent: string;                       // registry name
  task: string;                        // the prompt/task text
  cwd?: string;                        // defaults to parent cwd
  isolation?: "none" | "worktree";     // default "none"
  timeoutMs?: number;                  // default from config (e.g. 10 min)
}

export interface TaskResult {
  agent: string;
  status: "ok" | "error" | "timeout" | "aborted";
  output: string;        // final assistant message (model-visible, capped)
  fullOutputPath?: string; // where the untruncated transcript/output landed
  truncated: boolean;
  durationMs: number;
  exitCode?: number;
}

export interface RunnerOptions {
  spawn: SpawnFn;                    // injected
  maxConcurrent?: number;            // default 4
  outputCapBytes?: number;           // default 50 KB model-visible
  signal?: AbortSignal;              // wire to ctx.signal
  onEvent?: (e: RunnerEvent) => void; // task_start / task_update / task_end
}

export async function runTasks(
  registry: Map<string, AgentDefinition>,
  tasks: TaskSpec[],
  options: RunnerOptions,
): Promise<TaskResult[]>;
```

Mechanics:

- **Child invocation**: each task spawns `pi` in non-interactive mode (print /
  `--mode json`) with the agent's system prompt, model, and tool allowlist
  passed via flags, and the task text as the prompt. Structured output (JSON
  mode) is parsed into `TaskResult`; the exact flag set is confirmed against
  the pinned pi version during Phase 1 and wrapped in one small
  `buildPiArgs(def, spec)` function so version drift is contained.
- **Concurrency pool**: FIFO queue, `maxConcurrent` slots (default 4, hard cap
  in config). Batch size itself is capped (default 8) to keep result payloads
  sane.
- **Worktree isolation**: with `isolation: "worktree"`, the runner creates
  `git worktree add` under a scratch dir on a task branch, runs the child
  there, and reports the branch/worktree path in `TaskResult`. Merging is
  **not** the runner's job (see §8) — it only guarantees parallel writers
  can't trample each other or the parent's tree.
- **Output discipline**: model-visible `output` is capped; the full transcript
  is written to a scratch file referenced by `fullOutputPath` and included in
  the tool result's `details` for UI expansion.
- **Cancellation**: `signal` aborts queued tasks immediately and kills running
  children (SIGTERM, then SIGKILL after a grace period).
- **Live visibility** (`tmux.ts`, pure with injected effects): the spawn
  function handed to the runner can be wrapped so every labeled sub-agent
  child gets its own window in a shared tmux session (default `pi-agents`),
  streaming a human-readable rendering of its JSONL output. fleet, critic,
  and orchestrator all enable this by default via `host.ts`'s
  `createHostSpawn`; execution is unaffected and everything degrades to
  plain runs when tmux is absent or fails.

### 4.3 Wiring — `index.ts`

- Tool **`fleet_run`**: `{ tasks: [{ agent, task, isolation? }, ...] }` (a
  single-element array is the single-task case). Returns per-task results;
  emits `fleet:task_start|update|end` on `pi.events`; streams progress via the
  tool's `onUpdate`.
- Command **`/fleet`**: lists discovered agents (name, description, source) and
  current pool status.
- **Persistence**: `appendEntry("fleet-state", …)` records dispatched batches
  so a restarted session can report what was in flight (children do not survive
  the parent; on `session_start` any stale "running" entries are marked
  `aborted`).
- **System prompt** (`before_agent_start`, config-gated like lykkja): one short
  paragraph advertising delegation and when to use it.
- Config: `maxConcurrent`, `maxBatch`, `defaultTimeoutMs`, `outputCapBytes`,
  `piBinary` (default `"pi"`), `injectSystemPrompt`, `tmux`, `tmuxSession`,
  `tmuxCloseWindows`.

---

## 5. `planner/` (pi-planner) — plans as data

Turns "make a plan" from prose into a queryable artifact: a validated task DAG
with per-task acceptance criteria.

### 5.1 Plan model — `plan.ts` (pure)

```ts
import type { Criterion, CriterionInput } from "pi-lykkja/loop.ts"; // dependency-free

export type TaskStatus =
  | "pending"   // dependencies not yet met
  | "ready"     // dispatchable
  | "running"
  | "review"    // done, awaiting critic verdict
  | "done"
  | "failed";

export interface PlanTask {
  id: string;
  title: string;
  description: string;       // full brief handed to the sub-agent
  dependsOn: string[];       // task ids
  agent?: string;            // fleet agent name; default "implementer"
  criteria: Criterion[];     // lykkja-shaped acceptance criteria
  status: TaskStatus;
  attempts: number;
}

export interface Plan {
  goal: string;
  tasks: PlanTask[];
  createdAt: number;
  updatedAt: number;
}

export function createPlan(goal: string, tasks: PlanTaskInput[]): Plan; // validates DAG, throws on cycles/dangling deps
export function readySet(plan: Plan): PlanTask[];       // pending→ready resolution
export function setTaskStatus(plan: Plan, id: string, status: TaskStatus): Plan;
export function summarizePlan(plan: Plan): PlanSummary; // counts, critical path, blockers
```

Criteria reuse lykkja's `normalizeCriteria` so every task's acceptance bar is,
by construction, something lykkja and the critic can score.

### 5.2 Wiring — `index.ts`

- Tools **`plan_create`** (goal + task list) and **`plan_update`** (status
  changes, task edits, appending follow-up tasks).
- Command **`/plan`**: dashboard (DAG progress, ready set, blockers).
- Persistence: `appendEntry("planner-state", plan)`; restore on
  `session_start`; status-bar line (`planner` key).
- Events: `planner:plan_created`, `planner:task_status`.
- **Skill `plan-decomposition`**: how to split a goal into small,
  independently-verifiable, parallelizable tasks with strict per-task criteria;
  cross-references lykkja's `success-criteria` skill instead of restating it.

Planner alone (without fleet/orchestrator) is already useful: it gives any
session a structured, persistent plan the model maintains via tools.

---

## 6. `critic/` (pi-critic) — independent advisor/reviewer

The critic exists because self-scoring is the weakest link in a self-checking
loop. lykkja's `honest-verification` skill mitigates grade inflation; the
critic removes the conflict of interest entirely by having **a different agent
with fresh context** do the CHECK.

### 6.1 Review model — `review.ts` (pure)

```ts
import type { Criterion, CriterionScore } from "pi-lykkja/loop.ts";

export interface ReviewRequest {
  subject: string;            // what is being reviewed (diff, file list, artifact, task result)
  context?: string;           // task brief, constraints
  criteria: Criterion[];      // the rubric — same objects the planner attached to the task
  scaleMax: number;
}

export interface ReviewResult {
  scores: CriterionScore[];   // lykkja-shaped: score + weakness per criterion
  passed: boolean;
  weaknesses: string[];       // prioritized, actionable
  raw: string;                // critic's full prose for the details view
}

export function buildCriticPrompt(req: ReviewRequest): string;       // rubric → strict scoring instructions
export function parseCriticOutput(text: string, req: ReviewRequest): ReviewResult; // tolerant JSON-block extraction, validation, clamping
```

`parseCriticOutput` is where robustness lives: it extracts a fenced JSON block
from the critic's reply, validates every criterion is scored, clamps scores,
and fails loudly (a review that can't be parsed is a `failed` review, never a
silent pass).

### 6.2 Wiring — `index.ts`

- Tool **`critic_review`**: `{ subject, context?, criteria }` → dispatches the
  shipped read-only `critic` agent definition through **`fleet/runner.ts`**
  (pure-module import) and returns the parsed `ReviewResult`. The critic agent
  gets read/grep/ls-style tools only — it can inspect the repo but not modify
  it.
- Tool **`critic_advise`**: same transport, different prompt — pre-implementation
  design feedback on a plan or approach (the "advisor" half of the role),
  returning prioritized concerns rather than scores.
- **Skill `advisory-review`**: when to seek review, how to hand the critic
  enough context, and how to act on weakness lists.
- Config: critic model override (a strong model here pays for itself),
  `scaleMax`, timeout.

Standalone value: `critic_review` is a useful "second pair of eyes" tool in any
session, entirely outside orchestration — including as the CHECK step of a
plain lykkja loop (see §9).

---

## 7. `orchestrator/` (pi-orchestrator) — thin composition layer

The orchestrator owns *control flow only*. Planning intelligence lives in the
model + planner skill; execution lives in fleet; judgment lives in critic;
the stopping rule lives in lykkja.

### 7.1 Scheduler — `scheduler.ts` (pure)

A deterministic, fully unit-testable state machine (the `loop.ts` of this
extension):

```ts
export interface SchedulerPolicy {
  maxConcurrent: number;   // forwarded to the fleet runner
  maxAttempts: number;     // per-task re-dispatch cap after failed review (default 2)
}

export interface DispatchDecision {
  dispatch: PlanTask[];                 // ready tasks to send to fleet now
  reviews: PlanTask[];                  // completed tasks awaiting critic
  terminal: "running" | "complete" | "blocked"; // blocked = failed task blocks the DAG
}

export function nextActions(plan: Plan, policy: SchedulerPolicy): DispatchDecision;
export function applyTaskResult(plan: Plan, id: string, result: TaskResult): Plan;
export function applyReview(plan: Plan, id: string, review: ReviewResult, policy: SchedulerPolicy): Plan;
  // pass → done; fail & attempts < max → ready again (critic weaknesses appended to the brief); else failed
```

### 7.2 Control flow — `index.ts`

`/orchestrate <goal>` (plus `/orchestrate status|stop`) seeds the run via
`pi.sendUserMessage`, lykkja-style. One run proceeds:

1. **Open the goal loop** — the model calls `lykkja_start` with goal-level
   criteria (the skill instructs how to derive them; typically "all plan tasks
   done", "end-to-end verification passes", plus goal-specific bars).
2. **Plan** — the model produces the decomposition via `plan_create`
   (guided by the `plan-decomposition` skill), assigning each task an agent and
   criteria.
3. **Dispatch wave** — `orchestrate_step` computes `nextActions(...)` and runs
   the ready set through the fleet runner in parallel.
4. **Review** — each completed task goes through `critic_review` against *its
   own* criteria; failures are re-dispatched with the critic's weaknesses
   appended to the task brief, up to `maxAttempts`.
5. **Checkpoint** — after each wave the model calls `lykkja_checkpoint` with
   the wave summary as PLAN/DO and **critic-derived** goal-level scores as
   CHECK. lykkja's verdict is the ACT:
   - `ITERATING` → next wave (or plan repair: the model may `plan_update` to
     add follow-up tasks targeting the weakest criterion);
   - `FINAL` → done, summarize;
   - `STOPPED` → hard stop with an honest failure report — the
     `maxIterations` cap is the runaway guard for the entire orchestration.

Like lykkja, forward motion is driven by **self-prompting through tool
results**: every `orchestrate_step` result ends with an explicit
"AUTOMATED NEXT STEP" prompt, so the run needs no user turns between waves.

The orchestrator imports only pure cores (`plan.ts`, `scheduler.ts`,
`runner.ts`, `review.ts`, `loop.ts`) and otherwise composes at the model level
(instructing calls to `lykkja_*`, `plan_*` tools). If a dependency isn't
installed, `/orchestrate` says which piece is missing instead of failing
mid-run.

---

## 8. Playing in tandem with lykkja

lykkja stays unchanged and is composed at three distinct levels:

**Goal level — lykkja as the orchestrator's stopping rule.** The orchestration
run *is* a lykkja loop: `lykkja_start` opens it, every dispatch wave is one
PDCA pass, and `FINAL`/`ITERATING`/`STOPPED` decides continue-vs-stop. This
respects lykkja's one-loop-per-session constraint: the orchestrator's session
owns exactly one loop, the goal loop. Nothing about lykkja's state entry
(`lykkja-state`), dashboard, or status line needs to change.

**Task level — hierarchical loops for free.** Each sub-agent is a separate
`pi` process and therefore a separate session with its own entry log. If
lykkja is installed globally (it is, via this kit), an `implementer` agent can
run its own task-level PDCA loop against its task's criteria — nested loops
with zero state conflict, because "one loop per session" is per *child*
session. Agent definitions opt in simply by referencing the `pdca-loop` skill
in their system prompt.

**CHECK level — the critic upgrades lykkja's weakest phase.** The critic emits
`CriterionScore[]` in lykkja's exact shape, so external review drops straight
into `lykkja_checkpoint`. This composition is valuable *outside* orchestration
too: any plain lykkja loop can use `critic_review` as its CHECK step and feed
the result to the checkpoint — independent scoring instead of self-report,
with `honest-verification` as the fallback when the critic isn't installed.

**Optional future lykkja enhancement (non-breaking, not required).** A small
exported helper in `loop.ts` such as
`checkpointFromReview(plan: string, changes: string, review: ReviewResult): CheckpointInput`
would make the critic→checkpoint handoff one call. Everything above works
without it.

### Worktree merge strategy (orchestrator × parallel writers)

Parallel implementers with `isolation: "worktree"` each land on a task branch.
The orchestrator's review step happens **per branch** (critic inspects the
worktree); only reviewed-passing branches are merged back, serially, in DAG
order, by the orchestrator session itself (which can resolve trivial conflicts
or spawn a dedicated `integrator` fleet task for messy ones). Merge conflicts
mark the task `review`-failed with the conflict as the weakness, feeding the
normal retry path. For small runs, `isolation: "none"` with
non-overlapping file scopes (a planner skill concern) stays the simple default.

---

## 9. Packaging and distribution

Root `package.json` gains the new workspaces and manifest entries:

```json
"workspaces": ["threema", "lykkja", "exa", "kagi",
               "fleet", "planner", "critic", "orchestrator"],
"pi": {
  "extensions": ["./threema", "./lykkja", "./exa", "./kagi",
                 "./fleet", "./planner", "./critic", "./orchestrator"],
  "skills": ["./lykkja/skills", "./planner/skills", "./critic/skills",
             "./orchestrator/skills"]
}
```

Each package carries its own `pi` manifest (like `pi-lykkja` does) so any
subset installs standalone: `pi install <repo>` for the kit, or copy one
folder into `~/.pi/agent/extensions/<name>/`. Cross-package pure-core imports
(`planner` → `lykkja/loop.ts`, `critic`/`orchestrator` → `fleet/runner.ts`)
are workspace-relative imports of dependency-free modules; a standalone copy
of a dependent package vendors those single files or declares the sibling
package a dependency — decided per package in its README.

---

## 10. Failure semantics

| Failure | Behavior |
|---|---|
| Task timeout / child crash | `TaskResult.status = "timeout" \| "error"`; scheduler treats it as a failed attempt → retry up to `maxAttempts`, then task `failed` |
| Partial wave failure | Completed tasks proceed to review; the DAG naturally holds back dependents of failed tasks; `terminal: "blocked"` surfaces the blocker in the checkpoint (scored low → lykkja `ITERATING` drives plan repair, or `STOPPED` ends honestly) |
| Critic output unparseable | Review = failed with "unscorable output" weakness; one automatic critic re-run before counting an attempt |
| Critic disagreement (scores vs. sub-agent claim) | The critic wins by construction — it is the only source of CHECK scores; sub-agent self-reports are informational (`details`) only |
| lykkja `STOPPED` | Orchestrator halts, reports per-task state, remaining weaknesses, and branches left unmerged; nothing is silently discarded |
| Session restart mid-run | Children don't survive the parent. On `session_start`: fleet marks in-flight entries `aborted`, planner state restores, and the plan's `running` tasks reset to `ready` — the next `orchestrate_step` resumes the run idempotently |
| User abort (`ctx.signal`) | Runner kills children (SIGTERM→SIGKILL), queue drains, state entries record the abort |

---

## 11. Testing strategy

All unit tests are network-free and process-free, `tsx --test`, mirroring
`lykkja/test.ts`:

- **fleet**: `registry.ts` frontmatter parsing/precedence; `runner.ts` with a
  fake spawn — concurrency limits observed, timeouts fire, output capping,
  abort propagation, worktree arg construction.
- **planner**: DAG validation (cycles, dangling deps), ready-set computation,
  status transitions, summaries.
- **critic**: prompt construction; `parseCriticOutput` against well-formed,
  malformed, and partially-scored outputs; clamping.
- **orchestrator**: `nextActions`/`applyReview` state machine — wave
  composition, retry-with-feedback, `blocked`/`complete` terminals; a scripted
  end-to-end simulation (fake runner + fake critic) driving a 5-task DAG to
  `FINAL`.

Manual smoke: `pi -e fleet/index.ts` (`/fleet`, one `fleet_run` task), then
`pi -e orchestrator/index.ts` with all four installed on a toy goal in a
sandbox repo.

---

## 12. Phased roadmap (each phase ships standalone value)

1. **Phase 1 — `fleet/`**: registry + runner + `fleet_run` + `/fleet`.
   Deliverable: parallel sub-agents usable from any session. Riskiest phase
   (child-process contract with pi's non-interactive mode); done first.
2. **Phase 2 — `planner/`**: plan model + tools + `/plan` +
   `plan-decomposition` skill. Deliverable: persistent structured plans.
3. **Phase 3 — `critic/`**: review model + `critic_review`/`critic_advise` +
   `advisory-review` skill. Deliverable: independent review, including as the
   CHECK step of plain lykkja loops.
4. **Phase 4 — `orchestrator/`**: scheduler + `/orchestrate` + skills, wiring
   the goal-level lykkja loop. Deliverable: the full pipeline.
5. **Phase 5 (optional)** — lykkja `checkpointFromReview` helper, worktree
   `integrator` agent, tuning (caps, models, concurrency) from real use.

---

## 13. Risks and open questions

- **Child-process contract**: pi's non-interactive flag set (JSON mode, system
  prompt/tool/model overrides) must be pinned and verified in Phase 1;
  contained behind `buildPiArgs`.
- **Cost/latency**: every sub-agent and critic call is a full model
  conversation. Mitigations: small models for scouts/critics where acceptable
  (per-agent `model:`), batch caps, and the planner skill pushing for few,
  chunky tasks over many tiny ones.
- **Output-cap tuning**: 50 KB per task is a starting point; real runs will
  tell whether summaries-plus-`details` beats raw caps.
- **Scheduler authority vs. model authority**: this design keeps hard control
  flow (waves, retries, stops) in deterministic code and leaves judgment
  (decomposition, scoring, plan repair) to models. If experience shows the
  orchestrator model wants more freedom (e.g. dynamic re-planning mid-wave),
  loosen deliberately, not by default.
- **Criteria quality**: the whole loop is only as good as the criteria; this is
  inherited from lykkja and mitigated the same way (`success-criteria` skill,
  planner skill requiring per-task criteria).
