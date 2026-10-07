---
name: subagents
description: Delegates focused work through the Pi subagent extension with live progress. Use for fresh-context exploration, planning, scoped implementation, independent review, or command-backed verification.
---

# Subagents

```text
parent → subagent tool → fresh SDK sessions → final answers + evidence
                             ↓
                   live Pi progress panel
```

Use the `subagent` tool supplied by pi-kit's **subagents extension**, not bash
or terminal tabs. If the tool is unavailable, ask the user to enable the
extension; there is no shell fallback and no Herdr requirement.

| Role | Purpose | Tools |
| --- | --- | --- |
| `scout` | Explore one question with `path:line` evidence | read, grep, find, ls |
| `planner` | Break a goal into tasks and acceptance criteria | read, grep, find, ls |
| `implementer` | Implement and verify one scoped task | read, bash, edit, write |
| `critic` | Independently review against explicit criteria | read, grep, find, ls |
| `auditor` | Verify with exact command evidence | read, bash, grep, find, ls |

Call the tool with a batch of self-contained briefs:

```json
{
  "tasks": [
    { "role": "scout", "task": "Locate retry logic. Cite files and line numbers." },
    { "role": "critic", "task": "Review src/retry.ts for duplicate-request risks. Do not edit." }
  ],
  "concurrency": 2,
  "timeout": 600
}
```

Each task may specify `cwd` (including an existing worktree) and
`model` (`provider/model-id`). Defaults: parent's cwd, model, authentication,
and thinking level; at most two running children, four when explicitly
requested; 600 seconds per child. Batches contain at most eight tasks.
If the parent uses a virtual/router model, specify a physical model for each
task; router definitions cannot be inherited through Pi's extension API.

Children have fresh conversations, role-restricted tools, and no extensions
or skills. They still read repository instructions and share filesystem/OS
permissions. The auditor's shell policy is instruction-based, not a sandbox.

- Include goal, scope, relevant paths, acceptance criteria, and required
  evidence in each brief. Children cannot see the parent conversation.
- Parallelize only independent work. For overlapping edits set
  `concurrency: 1`; use separate worktrees for parallel edits.
- Avoid delegation for trivial work. Inspect each result's status and verify
  claims before relying on them. Failures and cancellations are not answers.
- Use `/subagents` for status, `/subagents cancel` to stop children, and
  `/subagents clear` to dismiss the panel. Escape also cancels the parent run.
