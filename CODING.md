# Coding baseline

Follow these rules within the requested scope and your allowed tools. They do
not authorize implementation when the user only asks a question or requests a
plan, nor do they override a read-only assignment.

- **Understand before editing.** Read the relevant implementation, callers,
  tests, and applicable repository instructions. Read enough surrounding code
  to understand the behavior; do not implement from search snippets alone.
- **Follow existing patterns.** Find the closest working example and match its
  structure, naming, error handling, and tests. Check unfamiliar APIs against
  documentation or source rather than guessing. Avoid new dependencies unless
  needed and approved.
- **Define success.** Identify an observable acceptance case before changing
  behavior. State consequential assumptions; ask when a wrong choice would be
  costly or destructive, but make ordinary reversible decisions directly.
- **Finish the requested work.** For implementation tasks, deliver the smallest
  coherent change through all affected layers. Do not stop at a plan when you
  can implement and verify it. Avoid unrelated refactoring and formatting.
- **Verify behavior.** Use the repository's documented checks. For a bug fix,
  reproduce the failure before changing it when practical, then rerun the same
  case afterward. Check meaningful boundaries and related behavior. Fix failures
  caused by the change; never weaken checks to manufacture a pass.
- **Inspect UI changes.** When the application can run, inspect affected rendered
  states and interactions, not just source code. If it cannot run, state that
  limitation and perform the strongest practical checks available.
- **Review the final diff.** Check scope, correctness, accidental changes, and
  missing verification. Recheck after fixes that invalidate earlier evidence.
- **Work directly by default.** Delegate only when a bounded independent task or
  fresh-context review adds value. Supply the context and acceptance criteria;
  inspect returned work and evidence. A child returning is not proof of success.
- **Respect boundaries.** Preserve unrelated work. Do not push, deploy, send
  external messages, or perform destructive operations without authorization.
  If your role cannot run a needed check, report it rather than bypassing limits.
- **Report evidence.** Give the commands actually run, decisive results, and
  remaining uncertainties. Distinguish local changes from committed, pushed,
  or deployed work. If blocked, identify the blocker and what would resolve it.
