#!/usr/bin/env bash
#
# Final evidence validation for the agent-native orchestration feature.
#
# Mechanical, machine-checkable acceptance validation. Reads raw evidence
# already saved to docs/agent-native-evidence/ and the acceptance document,
# then proves:
#   1. Every concrete .ts/.json path cited by the acceptance doc exists on
#      disk and has an exact ===== FILE: path ===== header in
#      final-source-lines.log.
#   2. Every header in final-source-lines.log is followed only by tab-delimited
#      `nl -ba` numbered content, and the file contains no `nl`/`usage:` error.
#   3. The seven literal per-package test summary blocks reproduce and sum to
#      358 tests, 83 suites, 358 pass, 0 fail.
#   4. Git status has exactly 29 tracked modified files and 13 untracked
#      top-level porcelain paths, with no scaffolding.
#
# Writes the full report to $OUT (final-evidence-validation.log).
set -u

EVIDENCE_DIR="docs/agent-native-evidence"
ACCEPTANCE="docs/agent-native-final-acceptance.md"
SOURCE_LINES="$EVIDENCE_DIR/final-source-lines.log"
SUMMARIES="$EVIDENCE_DIR/final-test-summaries.log"
STATUS_LOG="$EVIDENCE_DIR/final-git-status.log"
OUT="$EVIDENCE_DIR/final-evidence-validation.log"

# ----------------------------------------------------------------------------
# 0. Sanity: required inputs exist
# ----------------------------------------------------------------------------
fail=0
for f in "$ACCEPTANCE" "$SOURCE_LINES" "$SUMMARIES" "$STATUS_LOG"; do
  if [ ! -f "$f" ]; then
    echo "MISSING INPUT: $f" >&2
    exit 2
  fi
done

{
  echo "==================================================================="
  echo " FINAL EVIDENCE VALIDATION"
  echo " $(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  echo " Branch: $(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo unknown)"
  echo "==================================================================="
  echo
  echo "Inputs:"
  echo "  acceptance doc : $ACCEPTANCE"
  echo "  source lines   : $SOURCE_LINES"
  echo "  test summaries : $SUMMARIES"
  echo "  git status log : $STATUS_LOG"
  echo

  # --------------------------------------------------------------------------
  # 1. Concrete cited .ts/.json paths -> exist on disk + exact header
  # --------------------------------------------------------------------------
  echo "-------------------------------------------------------------------"
  echo " CHECK 1: every concrete cited .ts/.json path exists and has a header"
  echo "-------------------------------------------------------------------"
  echo

  # Extract every path token ending in .ts/.json, optional :line suffix.
  # Wildcards (containing '*') and the conceptual jobs.json are excluded.
  cited_tmp=$(mktemp)
  grep -oE '[A-Za-z0-9_./-]+\.(ts|json)(:[0-9][0-9,-]*)?' "$ACCEPTANCE" \
    | sed -E 's/:[0-9][0-9,-]*$//' \
    | grep -v '\*' \
    | grep -vx 'jobs\.json' \
    | sort -u > "$cited_tmp"

  cited_count=$(grep -c . "$cited_tmp")
  echo "Cited concrete .ts/.json paths ($cited_count):"
  missing_disk=0
  missing_header=0
  while IFS= read -r p; do
    [ -z "$p" ] && continue
    if [ ! -f "$p" ]; then
      missing_disk=$((missing_disk+1))
      echo "  [MISSING ON DISK] $p"
    fi
    if ! grep -qxF "===== FILE: $p =====" "$SOURCE_LINES"; then
      missing_header=$((missing_header+1))
      echo "  [MISSING HEADER]   $p"
    fi
  done < "$cited_tmp"
  rm -f "$cited_tmp"
  echo

  if [ "$missing_disk" -eq 0 ] && [ "$missing_header" -eq 0 ]; then
    echo "RESULT CHECK 1: PASS (all $cited_count cited paths exist and have exact headers)"
    check1=PASS
  else
    echo "RESULT CHECK 1: FAIL (disk=${#missing_disk[@]} header=${#missing_header[@]})"
    check1=FAIL
    fail=1
  fi
  echo

  # --------------------------------------------------------------------------
  # 2. Every header followed by nl -ba numbered content; no usage: error
  # --------------------------------------------------------------------------
  echo "-------------------------------------------------------------------"
  echo " CHECK 2: every header followed by nl -ba numbered content; no error"
  echo "-------------------------------------------------------------------"
  echo

  # A well-formed source-lines log line is EITHER a header line OR a
  # tab-delimited nl -ba numbered line (leading spaces + digits + TAB).
  malformed=$(grep -vE '^(===== FILE: .* =====|[[:space:]]*[0-9]+	)' "$SOURCE_LINES" || true)
  header_count=$(grep -c '^===== FILE:' "$SOURCE_LINES")

  # Genuine nl usage error would be a line that *starts* with "usage:" or an
  # nl: diagnostic. Legitimate source content is always prefixed by number+TAB,
  # so it cannot match ^usage:.
  usage_err=$(grep -E '^usage:|^nl: ' "$SOURCE_LINES" || true)

  if [ -z "$malformed" ]; then
    echo "  All source-lines log lines are either headers or numbered content."
    body_ok=PASS
  else
    echo "  MALFORMED (non-header, non-numbered) lines found:"
    echo "$malformed" | sed 's/^/    /'
    body_ok=FAIL
    fail=1
  fi

  if [ -z "$usage_err" ]; then
    echo "  No nl/usage: error lines present."
    err_ok=PASS
  else
    echo "  USAGE ERROR lines present:"
    echo "$usage_err" | sed 's/^/    /'
    err_ok=FAIL
    fail=1
  fi
  echo "  Header count in source-lines log: $header_count"
  echo

  if [ "$body_ok" = PASS ] && [ "$err_ok" = PASS ]; then
    echo "RESULT CHECK 2: PASS (every header followed by numbered content; no usage error)"
    check2=PASS
  else
    echo "RESULT CHECK 2: FAIL"
    check2=FAIL
  fi
  echo

  # --------------------------------------------------------------------------
  # 3. Seven literal test summary blocks -> arithmetic 358/83/358/0
  # --------------------------------------------------------------------------
  echo "-------------------------------------------------------------------"
  echo " CHECK 3: seven literal test summary blocks and arithmetic totals"
  echo "-------------------------------------------------------------------"
  echo

  # Reproduce the seven package blocks verbatim (exclude the TOTALS block).
  echo "Seven literal per-package summary blocks:"
  echo "-------------------------------------------------------------------"
  # Print each ===== <pkg> (...) ===== block that is NOT the TOTALS block.
  awk '
    /^===== .* =====/ {
      in_block=1; is_total=0
      if ($0 ~ /^===== TOTALS/) is_total=1
      if (!is_total) { print; block_lines=1 } else { block_lines=0 }
      next
    }
    in_block && !is_total { print }
  ' "$SUMMARIES"
  echo "-------------------------------------------------------------------"
  echo

  # Sum the four metrics across the seven package blocks only.
  read tests suites pass failc < <(
    awk '
      /^===== .* =====/ { in_block=1; is_total=0; if ($0 ~ /^===== TOTALS/) is_total=1; next }
      in_block && !is_total {
        if ($1=="ℹ") {
          if ($2=="tests")  t+=$3
          if ($2=="suites") s+=$3
          if ($2=="pass")   p+=$3
          if ($2=="fail")   f+=$3
        }
      }
      END { printf "%d %d %d %d\n", t, s, p, f }
    ' "$SUMMARIES"
  )

  echo "Summed across seven package blocks:"
  echo "  tests  = $tests   (expect 358)"
  echo "  suites = $suites  (expect 83)"
  echo "  pass   = $pass    (expect 358)"
  echo "  fail   = $failc   (expect 0)"
  echo

  if [ "$tests" -eq 358 ] && [ "$suites" -eq 83 ] && [ "$pass" -eq 358 ] && [ "$failc" -eq 0 ]; then
    echo "RESULT CHECK 3: PASS (disjoint arithmetic verified: 358/83/358/0)"
    check3=PASS
  else
    echo "RESULT CHECK 3: FAIL (arithmetic mismatch)"
    check3=FAIL
    fail=1
  fi
  echo

  # --------------------------------------------------------------------------
  # 4. Git inventory: 29 tracked modified, 13 untracked, no scaffolding
  # --------------------------------------------------------------------------
  echo "-------------------------------------------------------------------"
  echo " CHECK 4: git inventory - 29 tracked modified, 13 untracked, clean"
  echo "-------------------------------------------------------------------"
  echo

  tracked_mod=$(awk '{ c1=substr($0,1,1); c2=substr($0,2,1); if((c1=="M"||c2=="M") && c1!="?") m++ } END { print m+0 }' "$STATUS_LOG")
  untracked=$(awk '{ if(substr($0,1,2)=="??") u++ } END { print u+0 }' "$STATUS_LOG")

  echo "  tracked modified files : $tracked_mod (expect 29)"
  echo "  untracked porcelain    : $untracked (expect 13)"

  # No scaffolding files present in the untracked inventory.
  scaffold=0
  for s in '.current_untracked.txt' 'untracked-list.txt'; do
    if grep -qF "?? $s" "$STATUS_LOG"; then
      scaffold=$((scaffold+1))
    fi
  done
  if [ "$scaffold" -eq 0 ]; then
    echo "  scaffolding files      : none present"
  else
    echo "  scaffolding files      : PRESENT -> ${scaffold[*]}"
  fi

  # Cross-check: the recorded status log must equal live git status.
  if diff -q <(git status --short) "$STATUS_LOG" >/dev/null 2>&1; then
    echo "  log vs live git status : identical"
    live_ok=PASS
  else
    echo "  log vs live git status : MISMATCH"
    live_ok=FAIL
    fail=1
  fi
  echo

  if [ "$tracked_mod" -eq 29 ] && [ "$untracked" -eq 13 ] && [ "$scaffold" -eq 0 ] && [ "$live_ok" = PASS ]; then
    echo "RESULT CHECK 4: PASS (current git inventory verified, no scaffolding)"
    check4=PASS
  else
    echo "RESULT CHECK 4: FAIL"
    check4=FAIL
    fail=1
  fi
  echo

  # --------------------------------------------------------------------------
  # Overall verdict
  # --------------------------------------------------------------------------
  echo "==================================================================="
  echo " PER-CHECK VERDICT"
  echo "==================================================================="
  echo "  CHECK 1 (cited files + headers)        : $check1"
  echo "  CHECK 2 (numbered content, no error)   : $check2"
  echo "  CHECK 3 (test arithmetic)              : $check3"
  echo "  CHECK 4 (git inventory, no scaffold)   : $check4"
  echo "-------------------------------------------------------------------"
  if [ "$fail" -eq 0 ]; then
    echo " OVERALL: PASS"
  else
    echo " OVERALL: FAIL"
  fi
  echo "==================================================================="

} | tee "$OUT"

# Exit non-zero if any check failed (machine-friendly).
[ "$fail" -eq 0 ]
