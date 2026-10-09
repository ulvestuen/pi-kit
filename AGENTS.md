# Working in pi-kit

Read [CODING.md](./CODING.md) for the shared coding baseline. This file adds
repository facts; it is not installed as global policy by the Pi package.

## Layout and constraints

- This is a native-ESM npm workspace, targeting Node.js 22.19+ and Pi 1.1.0+
  (`@earendil-works` packages). Use the lockfile; do not substitute old 0.x SDK
  examples or change dependencies without a reason.
- `subagents/index.ts` registers the tool, commands, and progress UI;
  `subagents/runner.ts` owns SDK child sessions. Role Markdown files are the
  source for role descriptions, instructions, and tool allowlists.
- `threema/` owns messaging, configuration, encryption, and the inbound webhook.
  Do not send real messages or use production credentials for tests.
- `skills/` contains independently usable skills and small Node scripts. Keep
  skill scripts dependency-free and follow `skills/TEMPLATE.md` when adding one.
- Match the nearest existing module and test. There is no build step, generated
  API layer, or repository-wide formatting task. Avoid unrelated reformatting.
- Extensions must describe their own tools. Do not add companion skills that
  merely repeat tool parameters or essential usage rules.

## Verification

Run from the repository root:

```sh
npm ci                         # setup when dependencies are missing/out of date
npm test                       # skill scripts and both workspace test suites
npm run typecheck -w subagents  # after changes to the subagents TypeScript
git diff --check
```

For focused iteration use `node --test skills/<name>/<test-file>.mjs`,
`npm test -w subagents`, or `npm test -w threema`. Run the full suite after
code changes. `npm run verify` is an alias for `npm test`, not an extra check.
Tests use temporary data and fixture providers; they do not require live
service credentials. Passing fixture tests does not establish LLM coding quality.

`node skills/doctor.mjs` reports environment-variable presence without values;
it does not check OAuth sessions or prove a service is reachable. Never print
credentials, private keys, or full secret configuration while debugging.

## Subagent boundaries

Preserve fresh history, explicit tool permissions, cancellation, bounded
concurrency, and parent-delegated authentication. Keep normal Pi prompt
assembly and append role instructions. Do not copy the parent's whole prompt
or load all its extensions/skills. Project trust must not spread to another
working directory. SDK children share process and filesystem permissions;
tool restrictions and prompt rules are not an OS sandbox.
