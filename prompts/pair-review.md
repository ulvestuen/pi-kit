---
description: Pair-review existing changes with two read-only reviewers in Herdr or Rex panes
argument-hint: "[diff, branch, commit, or PR to review]"
---
Use the `pair-review` skill: read its SKILL.md and follow it to run the read-only pair review for the target below. This is a review, not pair programming: no worker edits files. Unless the text overrides them, use the defaults: separate Pi workers in new panes (not subagents), lead reviewer `claude-code/claude-opus-5-5`, peer reviewer `openai-codex/gpt-6.1-sol`, and one cross-check round. If the target is empty, use the skill's default target.

Review target (optional):

$ARGUMENTS
