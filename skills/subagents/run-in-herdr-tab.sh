#!/usr/bin/env bash
set -euo pipefail

if [[ "${HERDR_ENV:-}" != 1 ]]; then
  printf 'run-in-herdr-tab.sh must be run inside Herdr\n' >&2
  exit 1
fi
if [[ -z "${HERDR_WORKSPACE_ID:-}" ]]; then
  printf 'HERDR_WORKSPACE_ID is not set\n' >&2
  exit 1
fi

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
runner="$script_dir/run-subagent.mjs"
role="custom"
requested_cwd="$PWD"
timeout_seconds=600
args=("$@")
for ((i = 0; i < ${#args[@]}; i++)); do
  case "${args[i]}" in
    --role)
      i=$((i + 1))
      role="${args[i]:-missing}"
      ;;
    --cwd)
      i=$((i + 1))
      requested_cwd="${args[i]:-}"
      ;;
    --timeout)
      i=$((i + 1))
      timeout_seconds="${args[i]:-600}"
      ;;
  esac
done
if [[ ! "$timeout_seconds" =~ ^[0-9]+([.][0-9]+)?$ ]]; then
  timeout_seconds=600
fi

tab_id=""
tmp_dir=""
watchdog_pid=""
cleanup() {
  if [[ -n "$watchdog_pid" ]]; then
    kill "$watchdog_pid" >/dev/null 2>&1 || true
    wait "$watchdog_pid" 2>/dev/null || true
  fi
  if [[ -n "$tab_id" ]]; then
    herdr tab close "$tab_id" >/dev/null 2>&1 || true
  fi
  if [[ -n "$tmp_dir" ]]; then
    rm -rf -- "$tmp_dir"
  fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

tab_json="$(herdr tab create \
  --workspace "$HERDR_WORKSPACE_ID" \
  --cwd "$requested_cwd" \
  --label "subagent: $role" \
  --no-focus)"

parse_create_field() {
  node -e '
const fs = require("node:fs");
const value = JSON.parse(fs.readFileSync(0, "utf8"));
const result = process.argv[1] === "tab"
  ? value?.result?.tab?.tab_id
  : value?.result?.root_pane?.pane_id;
if (!result) process.exit(1);
process.stdout.write(result);
' "$1"
}

if ! tab_id="$(parse_create_field tab <<<"$tab_json")"; then
  printf 'herdr tab create returned no tab ID\n' >&2
  exit 1
fi
if ! pane_id="$(parse_create_field pane <<<"$tab_json")"; then
  printf 'herdr tab create returned no root pane ID\n' >&2
  exit 1
fi

tmp_dir="$(mktemp -d "${TMPDIR:-/tmp}/pi-herdr-subagent.XXXXXX")"
result_file="$tmp_dir/result"
status_file="$tmp_dir/status"
progress_file="$tmp_dir/progress"
tab_runner="$tmp_dir/run.sh"

{
  printf '#!/usr/bin/env bash\nset -euo pipefail\n'
  printf 'result_file=%q\n' "$result_file"
  printf 'status_file=%q\n' "$status_file"
  printf 'progress_file=%q\n' "$progress_file"
  printf 'runner=%q\n' "$runner"
  printf 'args=('
  printf ' %q' "$@"
  printf ' )\n'
  cat <<'BASH'
set +e
{
  node "$runner" --stream "${args[@]}" >"$result_file"
  printf '%s\n' "$?" >"$status_file.tmp"
} 2>&1 | tee "$progress_file" >&2
pipeline_status="${PIPESTATUS[0]}"
set -e
if [[ ! -f "$status_file.tmp" ]]; then
  printf '%s\n' "$pipeline_status" >"$status_file.tmp"
fi
mv "$status_file.tmp" "$status_file"
BASH
} >"$tab_runner"

# Herdr joins pane-run arguments and reparses them in the pane shell. Send one
# fully quoted command; the launcher itself contains a safely quoted args array.
printf -v pane_command 'bash %q' "$tab_runner"
herdr pane run "$pane_id" "$pane_command" >/dev/null

grace_seconds="${HERDR_STATUS_GRACE_SECONDS:-30}"
if [[ ! "$grace_seconds" =~ ^[0-9]+$ ]]; then
  grace_seconds=30
fi
timeout_integer="${timeout_seconds%%.*}"
timeout_ceiling=$((10#$timeout_integer))
if [[ "$timeout_seconds" == *.* && "${timeout_seconds#*.}" =~ [1-9] ]]; then
  timeout_ceiling=$((timeout_ceiling + 1))
fi
max_wait=$((timeout_ceiling + 10#$grace_seconds))
sleep "$max_wait" &
watchdog_pid=$!
while [[ ! -f "$status_file" ]]; do
  if ! kill -0 "$watchdog_pid" 2>/dev/null; then
    wait "$watchdog_pid" 2>/dev/null || true
    watchdog_pid=""
    printf 'sub-agent tab did not publish completion status within %ss\n' \
      "$max_wait" >&2
    exit 124
  fi
  sleep 0.1
done

status="$(cat "$status_file")"
if [[ "$status" == 0 ]]; then
  cat "$result_file"
  exit 0
fi

cat "$progress_file" >&2
exit "$status"
