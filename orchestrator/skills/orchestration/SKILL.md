---
name: orchestration
description: Create or revise a planner task DAG and execute it deterministically with orchestrate_run.
---

# Orchestration

1. Create or revise a self-contained task DAG with `plan_create` and `plan_update`. Include strict task checks and goal-level `finalChecks`.
2. Only when `planReview` is enabled, optionally call `critic_advise` once and revise material decomposition concerns.
3. Call `orchestrate_run`. Do not implement tasks yourself and do not add wave checkpoints.

The default per-task controller bounds whole pipelines, dynamically starts newly ready dependents, retries from bounded feedback, and runs final checks exactly once. Independent review follows `reviewMode`; evidence is opt-in. PDCA is used only when `controlMode: "pdca"` was explicitly selected for compatibility.
