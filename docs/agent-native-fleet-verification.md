# Agent-native fleet verification evidence

**Task:** t15 — executable verification evidence for agent-types and fleet
**Date:** 2026-07-11
**Branch:** `feature/agent-native-orchestration`

This document contains exact commands, exit codes, and concise unedited output
summaries so a read-only critic can verify the evidence independently.

---

## 1. agent-types TypeScript no-emit check

**Command:**
```
cd agent-types && npx tsc --noEmit
```

**Exit code:** 0

**Output:** (empty — no type errors)

---

## 2. agent-types unit tests

**Command:**
```
cd agent-types && npx tsx --test test.ts
```

**Exit code:** 0

**Output summary:**
```
ℹ tests 35
ℹ suites 15
ℹ pass 35
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 209.256
```

**Test suites:**
- RunId (1 test)
- ArtifactRef (2 tests)
- AgentTask (2 tests)
- AgentResult (3 tests)
- BackendCapabilities (1 test)
- KillResult (4 tests, including "optional fields are truly optional")
- RunEvent (1 test)
- ToolCallSummary (1 test)
- schema versioning (3 tests)
- structured artifact handoff (3 tests)
- RunId identity (2 tests)
- BackendCapabilities per-backend contracts (3 tests)
- KillResult protocol (3 tests)
- **JSON round-trip** (4 tests) — AgentTask, AgentResult, BackendCapabilities, KillResult
- **legacy consumer compatibility** (2 tests) — legacy shape, v0 data round-trip

---

## 3. fleet TypeScript no-emit check

**Command:**
```
cd fleet && npx tsc --noEmit
```

**Exit code:** 0

**Output:** (empty — no type errors)

---

## 4. fleet unit tests

**Command:**
```
cd fleet && npx tsx --test test.ts
```

**Exit code:** 0

**Output summary:**
```
ℹ tests 65
ℹ suites 13
ℹ pass 65
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 291.4635
```

**Test suites:**
- parseAgentDefinition (11 tests)
- mergeRegistries (3 tests)
- buildPiArgs (2 tests)
- parsePiJsonOutput (3 tests)
- capOutput (3 tests)
- worktree helpers (2 tests)
- runTasks (15 tests)
- tmux mirror (11 tests)
- **agent-native: RunId propagation** (5 tests — ok, backward-compat, abort, **timeout**, error paths)
- **agent-native: parentBranch worktree** (2 tests — success + **failure preserving runId**)
- **agent-native: inputArtifacts and outputArtifacts** (2 tests)
- **agent-native: backward compatibility** (4 tests — plain spec, worktree defaults, legacy fields, **legacy destructuring**)
- **agent-native: buildWorktreeArgs parentBranch** (2 tests)

---

## 5. Structured identity/artifact and legacy behavior test coverage

### Structured run identity (RunId)
| Test | File | What it covers |
|---|---|---|
| propagates runId from TaskSpec to TaskResult | fleet/test.ts | Happy path RunId round-trip |
| runId is undefined when TaskSpec omits it | fleet/test.ts | Backward compat for old callers |
| propagates runId through abort path | fleet/test.ts | RunId survives external abort |
| propagates runId through **timeout** path | fleet/test.ts | RunId survives per-task timeout |
| propagates runId through **error** path | fleet/test.ts | RunId survives child failure |
| preserves runId when **parentBranch worktree fails** | fleet/test.ts | RunId on early error exit |

### Structured artifacts
| Test | File | What it covers |
|---|---|---|
| AgentTask carries inputArtifacts from prerequisite tasks | agent-types/test.ts | Input artifact chain |
| AgentResult records output artifacts and tool calls | agent-types/test.ts | Output artifacts + tool calls |
| AgentResult without usage has usage undefined | agent-types/test.ts | Optional usage field |
| TaskSpec.inputArtifacts accepted without error | fleet/test.ts | Runner accepts artifacts |
| TaskResult without agent-native fields has them as undefined | fleet/test.ts | No populating from child |

### JSON serialization (IPC contract)
| Test | File | What it covers |
|---|---|---|
| AgentTask JSON round-trip | agent-types/test.ts | Serialize/deserialize all fields |
| AgentResult JSON round-trip | agent-types/test.ts | Serialize/deserialize all fields |
| BackendCapabilities JSON round-trip | agent-types/test.ts | Serialize/deserialize |
| KillResult JSON round-trip | agent-types/test.ts | Serialize/deserialize with optional fields |

### Legacy TaskSpec/TaskResult behavior
| Test | File | What it covers |
|---|---|---|
| plain TaskSpec produces valid TaskResult | fleet/test.ts | Old callers still work |
| worktree isolation without parentBranch defaults to HEAD | fleet/test.ts | Default worktree path |
| all results retain legacy fields | fleet/test.ts | agent, status, output, truncated, durationMs |
| legacy TaskResult destructuring still works | fleet/test.ts | Old consumer pattern |
| legacy TaskResult shape has all original required fields | agent-types/test.ts | Old shape verification |
| v0 AgentTask round-trips through JSON | agent-types/test.ts | No-version data survives IPC |

---

## 6. ADR alignment check

The implementation matches `docs/agent-native-architecture.md` section 13
(File / test changes):

- `agent-types/src/types.ts` — RunId, ArtifactRef, AgentTask, AgentResult,
  BackendCapabilities, KillResult, ToolCallSummary, RunEvent ✓
- `agent-types/src/index.ts` — re-exports ✓
- `agent-types/test.ts` — round-trip, version check, migration validation,
  JSON serialization, legacy compatibility ✓
- `fleet/runner.ts` — RunId, inputArtifacts, parentBranch on TaskSpec;
  runId, outputArtifacts, toolCalls, usage on TaskResult ✓
- `fleet/index.ts` — tool schema gains optional runId, inputArtifacts,
  parentRunIds, parentBranch ✓
- `fleet/test.ts` — RunId propagation, parentBranch worktree, backward
  compat, timeout/error paths, legacy destructuring ✓

All changes are additive: no existing tests were removed or modified.
Old callers see new optional fields as `undefined`.

---

## 7. Files touched

| File | Change type |
|---|---|
| `agent-types/test.ts` | Added: JSON round-trip suite (4 tests), legacy consumer compat suite (2 tests), KillResult optional fields test |
| `fleet/test.ts` | Added: RunId timeout/error path tests, parentBranch failure test, legacy destructuring test |
| `docs/agent-native-fleet-verification.md` | New — this document |

No changes to: `agent-types/src/types.ts`, `agent-types/src/index.ts`,
`fleet/runner.ts`, `fleet/index.ts`, `fleet/registry.ts`, `fleet/registry.ts`,
`fleet/package.json`, `fleet/tsconfig.json`, `agent-types/package.json`,
`agent-types/tsconfig.json`, `package.json`, or any lockfile.
