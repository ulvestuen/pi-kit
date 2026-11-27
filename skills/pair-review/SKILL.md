---
name: pair-review
description: Runs an independent two-reviewer check of a Git diff without editing it. Use when asked for a pair review, two independent reviewers, or a consolidated verdict from both.
---

# Pair review

Open the `pair-review` preset with `swarm_workflow`. For a PR, resolve the user's intended base and head to local Git refs first; review the changes from their merge base rather than substituting the current checkout.
