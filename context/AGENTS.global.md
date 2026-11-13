# Long-running work

These rules apply in every project. Project `AGENTS.md` files add their own
facts and checks.

## Keep going on multi-item work

- When the user asks for several items (a roadmap, an A3 plan, a list of
  issues), work through all of them. After one item is finished, verified, and
  shipped where shipping was asked for, start the next item without asking.
- Keep progress in the A3 or plan file in the repository (`a3/<slug>.md`), so
  any later session can resume from it rather than from chat history.
- Do not end your turn while work you started is still running, such as pair
  workers, CI runs, or deploys. Keep waiting (`pair.mjs wait`, `gh run watch`)
  instead of posting a progress update and stopping.
- Stop and hand back only when every item is done, on a blocker you cannot
  resolve, or on a decision only the user can make. Say which one it is.

## Usage limits and paid credits

- When a model or worker hits a plan usage limit, or a request is charged to
  paid usage credits instead of the plan, stop and ask the user how to
  continue.
- Never enable or knowingly use paid usage credits, and never switch to another
  model or provider to get around a limit, without the user's explicit approval
  in this session.

## Threema updates (only when available)

- If a `threema_send` tool is available, send a short message after each
  shipped item (what shipped, CI result, what is next) and keep working without
  waiting for a reply.
- Also send one when you stop for a limit, blocker, or decision, saying what
  you need from the user.
- If no `threema_send` tool is available, send nothing; the A3 or plan file is
  the record.
