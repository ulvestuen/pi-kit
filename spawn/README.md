# spawn — detached sub-agent jobs for pi, on tmux, exe.dev, or microsandbox

**spawn** launches sub-agents (child `pi` processes) through reusable backend
job machinery. The public `spawn_agent` tool starts *detached background jobs*
that keep running after the tool call — and the pi session — ends. The fleet,
critic, and orchestrator packages also reuse the same backends internally in a
synchronous wait/poll mode, so their sub-agent children no longer bypass spawn.
Spawn gives you a choice of **where** each sub-agent runs:

| Backend        | Where the job runs                             | Requires |
| -------------- | ---------------------------------------------- | -------- |
| `tmux`         | This machine, inside a live tmux window        | `tmux` on PATH |
| `exedev`       | An [exe.dev](https://exe.dev) cloud VM, off this machine entirely | exe.dev SSH access |
| `microsandbox` | A locally hosted [microsandbox](https://microsandbox.dev) microVM (hardware isolation) | `msb` on PATH |

The exe.dev and microsandbox backends are the alternatives to tmux for work
that should not run directly on your machine: untrusted or risky tasks
(microsandbox) and long-running cloud work that survives laptop sleep
(exe.dev).

## What you get

| Kind        | Name           | What it does                                                     |
| ----------- | -------------- | ----------------------------------------------------------------- |
| **Tool**    | `spawn_agent`  | Launch one detached sub-agent job on a chosen backend.           |
| **Tool**    | `spawn_jobs`   | Refresh and list jobs (status, exit code, age).                  |
| **Tool**    | `spawn_output` | Read the tail of a job's log, live or after it finished.         |
| **Tool**    | `spawn_kill`   | Stop a running job.                                              |
| **Command** | `/spawn`       | Show backend availability and the job table.                     |

Agents come from the same registry as fleet (`scout`, `implementer`,
`critic`, `planner`, plus your `~/.pi/agent/agents` and project `.pi/agents`
definitions).

## How a job runs

Each job is one `pi -p --no-session` invocation (plain-text print mode) with
the agent's system prompt, model, thinking level, and tool allowlist, and
the task text as the prompt. The job's run script writes the child's stdout
to a **log**, its stderr to a separate **err file** (so it can never corrupt
the output stream the parent parses), and its exit code to a **done
marker** — published only *after* the log is fully written and compacted, so
anyone who sees the marker sees the final output. Completed logs are capped at
10 MiB by default. Internal fleet/critic/orchestrator jobs use JSON event mode;
their durable logs omit quadratic `message_update` records plus duplicate
`turn_end`/`agent_end` records while preserving `message_end`, including the
final assistant response the parent parses. Public `spawn_agent` logs remain
plain text. A persistent registry (`<logDir>/jobs.json`) records retained jobs
so any later pi session can check on them. `spawn_output` shows the captured
stderr alongside the log tail for
jobs that did not end cleanly, and guard-rail failures (a cwd that does not
exist, a sandbox that could not install pi) explain themselves in the err
file instead of surfacing as a bare exit code. Status is derived, never
guessed:

- done marker present → `done` (exit 0) or `failed` (non-zero),
- no marker, runner alive → `running`,
- no marker, runner gone → `lost`,
- `killed` is stamped by `spawn_kill`.

At session start, maintenance refreshes status, removes terminal jobs older
than 7 days, keeps at most the newest 100 terminal jobs, and compacts retained
terminal logs. **Running jobs are never compacted or pruned.** Artifact removal
happens before a registry record is deleted; if local deletion or remote SSH
cleanup fails, the record remains so the next session can retry. Set any
retention limit to `0` to disable that individual limit.

There is no supervising parent process: public detached jobs have **no
timeout** — kill runaways with `spawn_kill`.

### tmux backend

The window *is* the runner: it executes the job's run script, which tees
pi's stdout into the log (stderr goes to the job's err file) and records
the exit code. Windows collect in the shared kit session (default
`pi-agents`, `tmux attach -t pi-agents`) and stay open after the job exits
(`remain-on-exit`) so you can scroll back.

A tmux window inherits the tmux *server's* environment, not the pi
session's, so the `envPassthrough` API keys are forwarded into the run
script by default (`tmuxForwardEnv: false` disables this; the run script
is owner-only, mode 0700).

### exe.dev backend

exe.dev's API is SSH: `ssh exe.dev new/ls/rm` manages VMs and
`ssh <vm>.exe.xyz` connects to one. The backend reuses a single VM
(`exedevVm`, default `pi-spawn`), creating it on first use — the default
exeuntu image ships with `pi` preinstalled. The run script is piped over
SSH into `~/.pi-spawn/<job>/` on the VM and started with `setsid nohup`,
so it survives the connection; status probes and log tails are one SSH
round trip each. A network failure keeps the last known status rather than
guessing.

Notes:

- You need working exe.dev SSH access first: run `ssh exe.dev` once
  interactively to register your key and accept the host key
  (fingerprint `SHA256:JJOP/lwiBGOMilfONPWZCXUrfK154cnJFXcqlsi6lPo`). The
  backend uses `BatchMode=yes` and never answers prompts.
- Public `spawn_agent` jobs run in the VM's `$HOME`, not your working tree.
  Write task briefs accordingly (e.g. "clone repo X, then ..."). Internal
  fleet/orchestrator runner jobs instead try to `cd` to the runner's `cwd` on
  the VM before starting; ensure that path exists remotely (or use the default
  tmux backend / microsandbox cwd mount for local-repo work).
- Model access on the VM: either attach exe.dev's LLM integration to the
  VM, configure keys on the VM yourself, or set `exedevForwardEnv: true`
  to forward the `envPassthrough` API keys into the job's run script.
- The backend **never deletes the VM** (it is billable and yours). Remove
  it with `ssh exe.dev rm pi-spawn` when you are done.

### microsandbox backend

The job directory is volume-mounted into the guest at `/job`, so the run
script, log, and done marker are the same files on both sides — the guest
writes them, the host reads them. The `msb run` process is started detached
on the host and its pid is the aliveness probe. Your working directory is
mounted read-write at `/workspace` (disable with `msbMountCwd: false` for
full isolation from the tree). The default `node` image installs pi on
first run via `npm install -g`; API keys from `envPassthrough` are
forwarded as export lines in the run script (never on a command line).
Finished sandboxes are removed automatically (`msbRemoveSandbox: false`
keeps them for debugging).

Requires a working [microsandbox](https://microsandbox.dev) install
(`curl -fsSL https://install.microsandbox.dev | sh`, then `msb doctor`):
Linux with KVM, macOS on Apple Silicon, or Windows 11.

## spawn vs fleet

- **fleet** (`fleet_run`): synchronous fan-out — you get all results back in
  the same tool call, with concurrency limits, timeouts, worktree isolation,
  JSONL parsing, and critic/orchestrator gating. Internally, each labeled
  sub-agent child is launched as a spawn job and waited on by
  `spawn/runner-adapter.ts`. Internal jobs record their parent session's
  pid; on session start, jobs whose recorded parent is gone are killed and
  stamped, while jobs of a still-live parent are left alone — the check
  matters because the spawned children are pi processes that load these same
  extensions, and a concurrently started session must not kill another
  session's in-flight sub-agents.
- **spawn** (`spawn_agent`): fire-and-forget — one job per call, results
  polled later (even from a different session), and the backend decides where
  the job runs. tmux is one of three runners.

## Installation

spawn lives in the `spawn/` subfolder of the
[pi-kit](https://github.com/ulvestuen/pi-kit) repository.

```bash
pi install https://github.com/ulvestuen/pi-kit
```

or for a quick test:

```bash
git clone https://github.com/ulvestuen/pi-kit.git
pi -e /absolute/path/to/pi-kit/spawn/index.ts
```

## Configuration

spawn works with zero configuration when tmux is installed. To change
defaults, create `~/.pi/agent/extensions/spawn/spawn.json` (see
`spawn.example.json`):

| Field                | Default          | Meaning                                                |
| -------------------- | ---------------- | ------------------------------------------------------- |
| `backend`            | `"tmux"`         | Default backend: `tmux`, `exedev`, or `microsandbox`.  |
| `logDir`             | `~/.pi/agent/spawn/jobs` | Job dirs (run script, log, done marker) + registry. |
| `piBinary`           | `"pi"`           | pi binary the run script invokes (must resolve where the job runs). |
| `outputTailBytes`    | `16384`          | Default `spawn_output` tail size.                       |
| `maxJobLogBytes`     | `10485760`       | Completed-log byte cap (10 MiB); `0` disables compaction. |
| `retentionDays`      | `7`              | Remove terminal jobs older than this; `0` disables age pruning. |
| `maxRetainedJobs`    | `100`            | Keep at most this many newest terminal jobs; `0` disables count pruning. |
| `injectSystemPrompt` | `true`           | Inject the short spawn note into the system prompt.     |
| `envPassthrough`     | common API keys  | Variables forwarded when a backend forwards env.        |
| `sshBinary`          | `"ssh"`          | ssh client for the exedev backend.                      |
| `tmuxSession`        | `"pi-agents"`    | tmux session collecting job windows.                    |
| `tmuxForwardEnv`     | `true`           | Forward `envPassthrough` keys into tmux run scripts (the window inherits the tmux server's env, not this session's). |
| `exedevVm`           | `"pi-spawn"`     | exe.dev VM that hosts jobs.                             |
| `exedevDomain`       | `"exe.xyz"`      | Domain suffix of VM SSH destinations.                   |
| `exedevAutoCreate`   | `true`           | Create the VM on first use when missing.                |
| `exedevForwardEnv`   | `false`          | Forward `envPassthrough` keys into exe.dev run scripts. |
| `msbBinary`          | `"msb"`          | microsandbox CLI binary.                                |
| `msbImage`           | `"node"`         | Guest image (needs node/npm so pi can install).         |
| `msbMountCwd`        | `true`           | Mount the job's cwd at `/workspace` in the guest.       |
| `msbForwardEnv`      | `true`           | Forward `envPassthrough` keys into the sandbox.         |
| `msbRemoveSandbox`   | `true`           | Remove the sandbox once the job is over.                |
| `msbCpus`            | (unset)          | Optional sandbox vCPU count.                            |
| `msbMemory`          | (unset)          | Optional sandbox memory limit, e.g. `"2G"`.             |

Environment overrides (used when no JSON config exists): `SPAWN_CONFIG_PATH`,
`SPAWN_BACKEND`, `SPAWN_LOG_DIR`, `SPAWN_PI_BINARY`, `SPAWN_OUTPUT_TAIL_BYTES`,
`SPAWN_MAX_JOB_LOG_BYTES`, `SPAWN_RETENTION_DAYS`,
`SPAWN_MAX_RETAINED_JOBS`, `SPAWN_INJECT_SYSTEM_PROMPT`,
`SPAWN_ENV_PASSTHROUGH` (comma-separated),
`SPAWN_SSH_BINARY`, `SPAWN_TMUX_SESSION`, `SPAWN_TMUX_FORWARD_ENV`,
`SPAWN_EXEDEV_VM`,
`SPAWN_EXEDEV_DOMAIN`, `SPAWN_EXEDEV_AUTO_CREATE`, `SPAWN_EXEDEV_FORWARD_ENV`,
`SPAWN_MSB_BINARY`, `SPAWN_MSB_IMAGE`, `SPAWN_MSB_MOUNT_CWD`,
`SPAWN_MSB_FORWARD_ENV`, `SPAWN_MSB_REMOVE_SANDBOX`, `SPAWN_MSB_CPUS`,
`SPAWN_MSB_MEMORY`.

## Running tests

```bash
npm test
```

Unit tests are network-free and process-free: backends take injected
exec/detach effects, so launch commands, status probes, run-script
generation, quoting, and the done-marker state machine are all tested with
fakes (plus real temp directories for the file-backed pieces).

## Files

- `index.ts` — pi extension wiring (the four `spawn_*` tools, `/spawn`, system prompt).
- `jobs.ts` — job model: statuses, done-marker resolution, the persistent job registry, backend/effect interfaces.
- `maintenance.ts` — terminal-job age/count retention and completed-log compaction orchestration.
- `agent-command.ts` — child-process command construction, JSON event filtering, log caps, and env-forwarding exports.
- `backends/local.ts` — shared helpers for backends whose markers live on the local filesystem (tmux directly, microsandbox through the volume mount).
- `backends/tmux.ts` — local tmux-window runner.
- `backends/exedev.ts` — exe.dev cloud VM runner (SSH lifecycle, remote markers).
- `backends/microsandbox.ts` — microsandbox microVM runner (mounted markers, detached `msb run`).
- `host.ts` — real Node effects: helper-process exec, detached spawn, pid probes.
- `runner-adapter.ts` — adapts spawn backends to fleet's synchronous `SpawnFn` contract; records jobs, polls logs/status, streams output, and kills/stamps jobs on abort.
- `config.ts` — configuration loading.
- `test.ts` — unit tests.

Like the other pi-kit extensions, spawn imports the fleet agent registry
(`../fleet/registry.ts`, `../fleet/host.ts`, `../fleet/tmux.ts`) via
workspace-relative paths; a standalone copy needs the `fleet/` folder
alongside it.
