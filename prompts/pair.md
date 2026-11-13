---
description: Pair-program a task (build or change code) with an implementer and an auditor in Herdr or Rex (panes, or Herdr core terminals over SSH)
argument-hint: "<task or plan>"
---
Use the `pair` skill: read its SKILL.md and follow it to run the pair-programming loop for the task below. This is pair programming: the implementer changes code and the auditor reviews it each round. To only review existing work without changing it, use `/pair-review` instead. Unless the task text overrides them, use the defaults: separate Pi workers started by the skill (new panes, or attachable Herdr core terminals when panes are unavailable; not subagents), implementer `claude-code/claude-opus-5-5`, auditor `openai/gpt-6.1-sol:xhigh`, and three rounds.

Task:

$ARGUMENTS
