#!/usr/bin/env bash
# PR Auto-Review Script
# Called from .github/workflows/pr-auto-review.yml
# Runs on a self-hosted runner with the `pr-review` label.
#
# Ported from SeriousGeese/DnD's battle-tested implementation. The (DnD-xxxxx)
# references throughout are issue IDs in that repo's tracker — they mark real
# incidents that shaped this design. They are kept as provenance; read the DnD
# repo's scripts/pr-review.sh history for the full forensics.
#
# Environment (set by workflow):
#   PR_NUMBER, PR_HEAD_REF, PR_BASE_REF, PR_TITLE, PR_BODY, PR_AUTHOR
#   HEAD_SHA, BASE_SHA, REPO, WORK_DIR
#   OPENROUTER_API_KEY, OPENROUTER_MODEL, OPENROUTER_FALLBACK_MODEL (optional)
#   AUTOMERGE_AUTHORS (comma-separated logins; "*" = everyone)
#   GH_TOKEN, GITHUB_WORKSPACE, GITHUB_OUTPUT, GITHUB_RUN_ID
#   GH_CLI (optional — default: "gh")
#   RUNNER_HOST, RUNNER_NAME (optional — for comment metadata)
#
# Exit codes: 0 = merged / reviewed / comment-only; 1 = action required
# (review failed, sync conflict, CI failures) — the red check is the merge
# block. Bypass instructions are included in the PR comment.

set -euo pipefail

# gh CLI: allow override via env var (workflow sets the right path per runner)
GH_CLI="${GH_CLI:-gh}"

# ── Configuration ──────────────────────────────────────────────────────────
: "${PR_NUMBER:?}" "${PR_HEAD_REF:?}" "${PR_BASE_REF:?}" "${PR_AUTHOR:?}"
: "${REPO:?}" "${WORK_DIR:?}"
: "${GH_TOKEN:?}"

# LLM chain: OpenRouter primary (paid) → OpenRouter free fallback.
: "${OPENROUTER_ENDPOINT:=https://openrouter.ai/api/v1/chat/completions}"
: "${OPENROUTER_MODEL:=deepseek/deepseek-chat}"
: "${OPENROUTER_FALLBACK_MODEL:=nvidia/nemotron-3-super-120b-a12b:free}"
OPENROUTER_API_KEY="${OPENROUTER_API_KEY:-}"

# Authors whose PRs get auto-fix pushes and auto-merge. Everyone else gets a
# review comment only (no pushes to their branch, no merge). "*" opens it up.
# NOTE: do NOT add dependabot[bot] here — .github/workflows/auto-merge.yml
# (LLM-free, GitHub-hosted) owns Dependabot and `automerge`-labeled PRs; the
# two merge paths are kept disjoint on purpose.
: "${AUTOMERGE_AUTHORS:=strickdd}"

# Labels that forbid an automated merge outright, regardless of author, review
# verdict or CI state. Comma-separated; matched case-insensitively.
#
# WHY (DnD-0g0ok follow-up): draft status is NOT a durable hold. Any concurrent
# session or human can flip a PR out of draft with `gh pr ready`, and the bot
# will then happily merge work a human deliberately parked. A label is the
# durable signal — it survives ready/draft toggles and is visible in the PR UI.
: "${DO_NOT_MERGE_LABELS:=do-not-merge,hold,blocked}"

# EVERY $GH_CLI call must pass --repo "$REPO" (DnD-m3uj3). Without it, gh infers
# the repository from the git remote of the CURRENT WORKING DIRECTORY — and this
# workflow deliberately runs no actions/checkout, so the step's default cwd
# ($GITHUB_WORKSPACE) is not a git repo at all. Any gh call made before the first
# `cd` therefore exits non-zero, while the identical call after cd succeeds.
# In the DnD repo that silently disabled auto-merge repo-wide: the do-not-merge
# label lookup fails closed by design, so it held every PR on a phantom label.

BOT_NAME="Strickdd Bot"
BOT_EMAIL="strickdd@gmail.com"
WORK_DIR="${WORK_DIR}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
find_python_bin() {
  local candidate
  for candidate in "${PYTHON_BIN:-}" python3.11 python3 python; do
    [ -n "$candidate" ] || continue
    command -v "$candidate" >/dev/null 2>&1 || continue
    "$candidate" -c 'import sys' >/dev/null 2>&1 || continue
    printf '%s\n' "$candidate"
    return 0
  done
  printf '%s\n' python3
}

PYTHON_BIN="$(find_python_bin)"
PYTHON_NEEDS_WIN_PATHS=0
if "$PYTHON_BIN" -c 'import os, sys; sys.exit(0 if os.name == "nt" else 1)' >/dev/null 2>&1; then
  PYTHON_NEEDS_WIN_PATHS=1
fi

python_path() {
  if [ "$PYTHON_NEEDS_WIN_PATHS" = "1" ] && command -v cygpath >/dev/null 2>&1; then
    cygpath -w "$1"
  else
    printf '%s\n' "$1"
  fi
}
PROMPT_FILE="${SCRIPT_DIR}/review-prompt.md"
MAX_ITERATIONS=3
MAX_DIFF_LINES=5000
POLL_INTERVAL=30  # seconds between CI status checks
POLL_TIMEOUT=1800  # 30 min total timeout for CI
# Grace period for a SHA to register its first check run. Unlike the DnD repo,
# ci.yml here has NO paths-ignore — every PR is CI-relevant, so zero check runs
# is only ever "CI has not registered yet" (or a failed dispatch), never
# "docs-only, nothing to wait for". wait_for_ci fails closed accordingly.
ZERO_CHECKS_GRACE=120

STARTED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
COMMENT_FILE="/tmp/pr-review-comment-${PR_NUMBER}.md"
RESPONSE_FILE="/tmp/pr-review-response-${PR_NUMBER}.json"
FIXES_FILE="/tmp/pr-review-fixes-${PR_NUMBER}.json"
# Markdown bullet lists accumulated by apply_fixes (which runs in a command
# substitution subshell, so shell variables can't carry this state out) and
# surfaced in the final PR comment — the owner must be able to see what the
# bot changed or dropped without digging through runner logs (DnD-pchr6).
APPLIED_FIXES_FILE="/tmp/pr-review-applied-${PR_NUMBER}.md"
DROPPED_FIXES_FILE="/tmp/pr-review-dropped-${PR_NUMBER}.md"
: > "$APPLIED_FIXES_FILE"
: > "$DROPPED_FIXES_FILE"
CONVERGE_ATTEMPTS="[]"
FIXES_PUSHED=false

# Sentinel that has_do_not_merge_label() emits instead of a label name when the
# labels could not be read at all. Callers must treat it as a hold (fail closed)
# AND as an infrastructure fault worth shouting about — a real hold is one human
# parking one PR; this one silently holds every PR in the repo (DnD-m3uj3).
LABEL_LOOKUP_FAILED='<label lookup failed>'
# The hold in force for this run: a real label name, $LABEL_LOOKUP_FAILED, or "".
# Recorded by the callers so the PR comment reports the same answer the merge
# decision actually used, rather than re-querying and quietly disagreeing with it.
HOLD_LABEL=""

# Which LLM tier actually produced the review (set by review_llm)
LLM_USED_TIER="none"
LLM_USED_MODEL="none"
LLM_USED_ENDPOINT="none"
# Review-call telemetry (set by review_llm; surfaced in the PR comment's
# metadata YAML). A review that "passed" in 3 seconds on 40 prompt tokens is
# a rubber stamp — these make that visible per PR instead of only in runner
# logs (DnD-gbw3s).
LLM_PROMPT_TOKENS=0
LLM_COMPLETION_TOKENS=0
LLM_CALL_SECONDS=0

# ── Helper functions ───────────────────────────────────────────────────────

log()  { echo >&2 "[pr-review] $*"; }
die()  { log "FATAL: $*"; exit 1; }

# jq parses every merge-affecting decision in this script (check-run counts,
# LLM review JSON, converge metadata). Without it those parses degrade into
# their fallbacks — which read as "zero check runs" and can steer the merge
# logic — so refuse to start at all rather than limp (DnD-4drs9).
command -v jq >/dev/null 2>&1 || die "jq not found on PATH — install jq on this runner"

# GitHub workflow annotation — surfaces in the run summary and the Actions UI
# rather than only in the log body, which nobody reads on a green run. Goes to
# STDOUT (where the runner parses ::commands::), so it must only ever be called
# from a context whose stdout is not captured by a command substitution.
annotate() { printf '::%s::%s\n' "$1" "$2"; }

cleanup() {
  if [ -d "$WORK_DIR" ]; then
    rm -rf "$WORK_DIR" 2>/dev/null || true
    log "Cleaned up working directory: ${WORK_DIR}"
  fi
  rm -f "$RESPONSE_FILE" "$FIXES_FILE" "$APPLIED_FIXES_FILE" "$DROPPED_FIXES_FILE" 2>/dev/null || true
}
trap cleanup EXIT TERM INT

is_automerge_author() {
  local entry
  IFS=',' read -ra _allowed <<< "$AUTOMERGE_AUTHORS"
  for entry in "${_allowed[@]}"; do
    entry="${entry#"${entry%%[![:space:]]*}"}"  # trim leading whitespace
    entry="${entry%"${entry##*[![:space:]]}"}"  # trim trailing whitespace
    if [ "$entry" = "*" ] || [ "$entry" = "$PR_AUTHOR" ]; then
      return 0
    fi
  done
  return 1
}

# Returns 0 (block the merge) when the PR carries any DO_NOT_MERGE_LABELS label.
#
# FAILS CLOSED. If the labels cannot be read — API error, rate limit, network —
# this blocks the merge rather than assuming there is no hold. A transient failure
# costs one deferred merge that the next run retries; guessing the other way merges
# work a human parked, which is the failure this whole guard exists to prevent.
# The blocked label name is echoed on stdout so callers can name it in the log.
has_do_not_merge_label() {
  local labels rc=0 entry lower_labels lower_entry err_file
  # Keep stderr instead of discarding it: swallowing the real gh error is what
  # made this failure take a full batch of PRs to diagnose (DnD-m3uj3).
  err_file="$(mktemp "/tmp/pr-review-labels-${PR_NUMBER}-XXXXXX")"
  labels="$($GH_CLI pr view "$PR_NUMBER" --repo "$REPO" --json labels \
    --jq '[.labels[].name] | join(",")' 2>"$err_file")" || rc=$?
  # An empty string is a legitimate "no labels" answer, so distinguish it from a
  # failed call by exit code rather than by emptiness.
  if [ "$rc" -ne 0 ]; then
    log "label lookup FAILED (rc=${rc}): $(tr '\n' ' ' < "$err_file" | cut -c1-300)"
    rm -f "$err_file"
    echo "$LABEL_LOOKUP_FAILED"
    return 0
  fi
  rm -f "$err_file"
  lower_labels=",$(printf '%s' "$labels" | tr '[:upper:]' '[:lower:]'),"
  IFS=',' read -ra _blocking <<< "$DO_NOT_MERGE_LABELS"
  for entry in "${_blocking[@]}"; do
    entry="${entry#"${entry%%[![:space:]]*}"}"
    entry="${entry%"${entry##*[![:space:]]}"}"
    [ -z "$entry" ] && continue
    lower_entry="$(printf '%s' "$entry" | tr '[:upper:]' '[:lower:]')"
    case "$lower_labels" in
      *",${lower_entry},"*) echo "$entry"; return 0 ;;
    esac
  done
  return 1
}

# This pipeline's own branch pushes (base-sync merges, auto-review fixes) are
# made with GITHUB_TOKEN, and GitHub fires NO workflows for GITHUB_TOKEN
# events — the pushed SHA never gets pull_request-triggered CI on its own, so
# ci.yml must be dispatched explicitly on the PR head ref (ci.yml carries a
# workflow_dispatch trigger for exactly this call; DnD-4drs9). This is NOT
# best-effort — wait_for_ci() fails closed when the dispatched checks never
# appear, so a failed dispatch here blocks the merge rather than letting it
# through.
dispatch_ci() {
  local dispatch_out
  if dispatch_out="$($GH_CLI workflow run ci.yml --repo "$REPO" --ref "$PR_HEAD_REF" 2>&1)"; then
    log "  Dispatched CI on ${PR_HEAD_REF} (bot pushes don't fire pull_request triggers)"
  else
    # Most common cause: the branch's ci.yml predates the workflow_dispatch
    # trigger (422) — the dispatch API validates the workflow file at the
    # given ref. The §3 base-sync heals that for the main path; a stale
    # branch hitting this via the §2 short-circuit needs main merged in.
    log "  WARNING: could not dispatch CI on ${PR_HEAD_REF} — the zero-checks grace will fail closed and block the merge"
    log "  dispatch error: $(printf '%s' "$dispatch_out" | head -c 300)"
  fi
}

# The PR's CURRENT remote tip. The event's HEAD_SHA goes stale the moment
# anything is pushed — including our own fix/sync commits — and a re-run of a
# pull_request-triggered job replays the ORIGINAL payload, so HEAD_SHA can
# point at an author commit with green CI while the real tip is an unverified
# bot commit. Every merge decision must poll the live tip, never the event
# SHA. Fails (non-zero) when the tip cannot be read — callers must fail
# closed, not fall back to HEAD_SHA.
resolve_live_tip() {
  local tip
  tip="$($GH_CLI pr view "$PR_NUMBER" --repo "$REPO" --json headRefOid --jq '.headRefOid' 2>&1)" || {
    log "  could not resolve live branch tip: $(printf '%s' "$tip" | head -c 200)"
    return 1
  }
  [ -n "$tip" ] || return 1
  echo "$tip"
}

# Re-dispatch the review of ONE PR whose last run was cancelled by concurrency
# (DnD-9fb3r). None of the workflow's pull_request trigger types re-fire by
# themselves, so a cancelled review leaves its PR green-but-unreviewed until a
# human notices. Each finishing review hands off to at most one stranded PR,
# draining any backlog one link at a time; a PR drops out of the candidate set
# as soon as it gets a non-cancelled run, so the chain terminates.
#
# The dispatch MUST use `--ref <the PR's head branch>`, never `--ref main`
# (DnD-0g0ok). Stranded-ness is defined per headBranch, and a workflow_dispatch
# run's headBranch is the ref it was dispatched on — a `--ref main` re-review
# can never clear the branch it was dispatched FOR, which once produced a
# 67-run infinite re-dispatch loop in the DnD repo.
#
# Best-effort throughout: a failure here must never turn a completed review into
# a failed run.
dispatch_stranded_review() {
  local stranded_branches branch pr

  # Latest run per branch, keeping only branches whose most recent one was
  # cancelled. An older cancelled run that has since been superseded by a real
  # review is not stranded.
  stranded_branches="$($GH_CLI run list --repo "$REPO" --workflow=pr-auto-review.yml --limit 80 \
    --json headBranch,conclusion,status,createdAt \
    --jq 'group_by(.headBranch)
          | map(sort_by(.createdAt) | last)
          | map(select(.status == "completed" and .conclusion == "cancelled"))
          | .[].headBranch' 2>/dev/null)" || return 0
  [ -n "$stranded_branches" ] || return 0

  while IFS= read -r branch; do
    [ -n "$branch" ] || continue
    # Never re-dispatch the PR this run just reviewed.
    [ "$branch" = "$PR_HEAD_REF" ] && continue
    # Skip branches with no open non-draft PR — merged, closed, or still draft.
    pr="$($GH_CLI pr list --repo "$REPO" --state open --head "$branch" --json number,isDraft \
      --jq 'map(select(.isDraft | not)) | .[0].number // empty' 2>/dev/null)" || continue
    [ -n "$pr" ] || continue

    # On the PR's own head ref, so the run's headBranch is the stranded branch
    # and a successful re-review clears its stranded state.
    if $GH_CLI workflow run pr-auto-review.yml --ref "$branch" -f pr_number="$pr" --repo "$REPO" 2>&1; then
      log "Re-dispatched auto-review for stranded PR #${pr} (${branch}) — its last run was cancelled (DnD-9fb3r)"
      return 0
    fi
    # Dispatch on this branch failed (fork branch, or a head ref whose workflow
    # file predates the workflow_dispatch trigger). Try the next candidate —
    # NEVER fall back to `--ref main`, which cannot clear stranded state and
    # re-creates the DnD-0g0ok loop.
    log "WARNING: could not re-dispatch auto-review for stranded PR #${pr} on ref ${branch} — skipping it (fork branch, missing workflow_dispatch trigger on that ref, or missing 'actions: write')"
  done <<< "$stranded_branches"

  return 0
}

# Squash-merge the PR and clean up the remote branch. `gh pr merge
# --delete-branch` exits nonzero when its local-branch cleanup fails (we run
# inside a worktree that is on a different branch) even though the merge
# itself landed. So: merge without --delete-branch, verify the PR state on any
# failure, then delete the remote branch explicitly.
merge_pr() {
  local merged=false

  # Last line of defence, deliberately INSIDE merge_pr rather than at the call
  # sites: there are two of them today and a third would silently miss the check.
  # Re-read at merge time, not at review start — a human may add the label while
  # the review is still running, which is exactly when they would notice the bot
  # is about to take something they wanted held.
  local blocking_label
  if blocking_label="$(has_do_not_merge_label)"; then
    HOLD_LABEL="$blocking_label"
    if [ "$blocking_label" = "$LABEL_LOOKUP_FAILED" ]; then
      annotate error "PR #${PR_NUMBER} was not auto-merged: its labels could not be read, so the do-not-merge guard failed closed. This is an infrastructure fault affecting every PR, not a property of this one (DnD-m3uj3)."
      log "MERGE BLOCKED: PR #${PR_NUMBER} — label lookup failed, failing closed."
    else
      log "MERGE BLOCKED: PR #${PR_NUMBER} carries the '${blocking_label}' label — leaving it open for a human."
    fi
    return 1
  fi

  if $GH_CLI pr merge "$PR_NUMBER" --repo "$REPO" --squash 2>&1; then
    merged=true
  else
    local state
    state="$($GH_CLI pr view "$PR_NUMBER" --repo "$REPO" --json state --jq .state 2>/dev/null || echo "")"
    if [ "$state" = "MERGED" ]; then
      log "gh pr merge exited nonzero but the PR is merged — treating as success"
      merged=true
    fi
  fi
  if [ "$merged" = "true" ]; then
    close_linked_issues
    $GH_CLI api -X DELETE "repos/${REPO}/git/refs/heads/${PR_HEAD_REF}" >/dev/null 2>&1 \
      || log "Note: could not delete remote branch ${PR_HEAD_REF} (may already be gone)"
    return 0
  fi
  return 1
}

# Close the issues this PR links with a closing keyword ("Closes #62").
#
# GitHub records the linkage (closingIssuesReferences is populated) but does
# NOT fire its native close-on-merge when the merge is performed with
# GITHUB_TOKEN — which is exactly how this bot merges (gh pr merge above, run
# under secrets.GITHUB_TOKEN). So every auto-review merge used to leave its
# linked issues open. Read the linkage back from the API and close each one
# explicitly, mirroring what a human-performed merge would have done.
#
# Best-effort by design: the merge has already landed by the time this runs, so
# a failure here is logged, never fatal — an un-closed issue is a lesser evil
# than a merged PR the bot reports as failed. Only OPEN issues in THIS repo are
# touched (cross-repo references, if any, are left to their own repos).
close_linked_issues() {
  local owner="${REPO%%/*}" name="${REPO##*/}"
  local issues issue

  issues="$($GH_CLI api graphql \
    -f query='query($owner:String!,$name:String!,$pr:Int!){repository(owner:$owner,name:$name){pullRequest(number:$pr){closingIssuesReferences(first:50){nodes{number state repository{nameWithOwner}}}}}}' \
    -F owner="$owner" -F name="$name" -F pr="$PR_NUMBER" \
    --jq ".data.repository.pullRequest.closingIssuesReferences.nodes[]
          | select(.state == \"OPEN\" and .repository.nameWithOwner == \"${REPO}\")
          | .number" 2>/dev/null)" || {
    log "Note: could not read linked issues for PR #${PR_NUMBER} — skipping auto-close"
    return 0
  }

  while IFS= read -r issue; do
    [ -n "$issue" ] || continue
    if $GH_CLI issue close "$issue" --repo "$REPO" \
        --comment "Closed by #${PR_NUMBER}, squash-merged to \`${PR_BASE_REF}\`. Auto-closed by the PromptCI review bot: a GITHUB_TOKEN merge does not trigger GitHub's native linked-issue close." >/dev/null 2>&1; then
      log "Closed linked issue #${issue} (PR #${PR_NUMBER})"
    else
      log "Note: could not close linked issue #${issue} (may already be closed or gone)"
    fi
  done <<< "$issues"
  return 0
}

# Call one LLM endpoint. Writes the raw API response body to stdout.
# Fails (nonzero) on network error, non-200 status, or empty content.
call_llm() {
  local endpoint="$1" model="$2" api_key="$3" system_prompt="$4" user_content="$5"
  local json_mode="${6:-false}"
  local http_code body_file user_file payload_file
  body_file="$(mktemp "/tmp/pr-review-llm-body-${PR_NUMBER}-XXXXXX")"
  user_file="$(mktemp "/tmp/pr-review-llm-user-${PR_NUMBER}-XXXXXX")"
  payload_file="$(mktemp "/tmp/pr-review-llm-payload-${PR_NUMBER}-XXXXXX")"
  printf '%s' "$user_content" > "$user_file"

  # --rawfile reads from disk instead of receiving user_content as a shell
  # argument — Linux caps individual execve args at 128KB (MAX_ARG_STRLEN) and
  # large diffs (e.g. 143KB) exceed that, causing "Argument list too long".
  # Payload is also written to a file so curl uses -d @file, same reason.
  # response_format json_object is left off for the OpenRouter tiers —
  # DeepSeek via OpenRouter returns empty content with it.
  jq -n \
    --arg model "$model" \
    --arg system "$system_prompt" \
    --rawfile user "$user_file" \
    --argjson json_mode "$json_mode" \
    '{
      model: $model,
      messages: [
        {role: "system", content: $system},
        {role: "user", content: $user}
      ],
      temperature: 0.1,
      max_tokens: 16384
    } + (if $json_mode then {response_format: {type: "json_object"}} else {} end)' \
  > "$payload_file" || { rm -f "$body_file" "$user_file" "$payload_file"; return 1; }
  rm -f "$user_file"

  local -a curl_args=(-s --connect-timeout 15 --max-time 600 -o "$body_file" -w '%{http_code}')
  if [ -n "$api_key" ]; then
    curl_args+=(-H "Authorization: Bearer ${api_key}")
  fi

  if ! http_code="$(curl "${curl_args[@]}" "$endpoint" -H "Content-Type: application/json" -d "@${payload_file}")"; then
    log "    curl failed (network error or timeout)"
    rm -f "$body_file" "$payload_file"
    return 1
  fi
  rm -f "$payload_file"

  if [ "$http_code" != "200" ]; then
    log "    HTTP ${http_code} — $(head -c 300 "$body_file" | tr '\n' ' ')"
    rm -f "$body_file"
    return 1
  fi

  # Reject responses with missing/empty message content (e.g. provider error
  # bodies that still return 200) — these must not count as a completed review.
  if ! "$PYTHON_BIN" -c "
import sys, json
try:
    d = json.load(open(sys.argv[1]))
    c = d['choices'][0]['message']['content']
except Exception:
    sys.exit(1)
sys.exit(0 if c and c.strip() else 1)
" "$(python_path "$body_file")"; then
    log "    Response has no usable message content"
    rm -f "$body_file"
    return 1
  fi

  cat "$body_file"
  rm -f "$body_file"
}

# Run the review through the fallback chain. On success, writes the parsed
# fixes JSON (guaranteed to have a "fixes" key) to $FIXES_FILE and sets
# LLM_USED_*. Fails only when every tier fails.
review_llm() {
  local system_prompt="$1" user_content="$2"
  local tier name endpoint model key json_mode json

  # tier format: name|endpoint|model|api_key|json_mode
  local -a tiers=(
    "openrouter|${OPENROUTER_ENDPOINT}|${OPENROUTER_MODEL}|${OPENROUTER_API_KEY}|false"
    "openrouter-free|${OPENROUTER_ENDPOINT}|${OPENROUTER_FALLBACK_MODEL}|${OPENROUTER_API_KEY}|false"
  )

  for tier in "${tiers[@]}"; do
    IFS='|' read -r name endpoint model key json_mode <<< "$tier"
    case "$name" in
      openrouter*)
        if [ -z "$key" ]; then
          log "  Tier '${name}' (${model}): skipped — OPENROUTER_API_KEY not set"
          continue
        fi
        ;;
    esac

    log "  Tier '${name}': ${model} @ ${endpoint}"
    local call_started="$SECONDS"
    if ! call_llm "$endpoint" "$model" "$key" "$system_prompt" "$user_content" "$json_mode" > "$RESPONSE_FILE"; then
      log "  Tier '${name}' failed — trying next tier"
      continue
    fi
    local call_seconds=$((SECONDS - call_started))

    json="$("$PYTHON_BIN" "$(python_path "$SCRIPT_DIR/extract-fixes.py")" "$(python_path "$RESPONSE_FILE")" 2>/dev/null || echo '{}')"
    if echo "$json" | jq -e 'has("fixes")' >/dev/null 2>&1 && [ -n "$json" ] && [ "$json" != "{}" ]; then
      # Structural validity beyond "JSON with a fixes key" (DnD-gbw3s): a
      # review that returns fixes:[] AND cannot even summarize what the PR
      # does did not read the diff — treat it as no review and fall through
      # to the next tier rather than rubber-stamping the merge gate.
      local summary_text
      summary_text="$(echo "$json" | jq -r '.summary // ""' 2>/dev/null | tr -d '[:space:]')"
      if [ -z "$summary_text" ]; then
        log "  Tier '${name}' returned review JSON with an empty summary — not a credible review, trying next tier"
        continue
      fi
      printf '%s' "$json" > "$FIXES_FILE"
      LLM_USED_TIER="$name"
      LLM_USED_MODEL="$model"
      LLM_USED_ENDPOINT="$endpoint"
      LLM_CALL_SECONDS="$call_seconds"
      local response_tool_path
      response_tool_path="$(python_path "$RESPONSE_FILE")"
      LLM_PROMPT_TOKENS="$(jq -r '.usage.prompt_tokens // 0' "$response_tool_path" 2>/dev/null || echo 0)"
      LLM_COMPLETION_TOKENS="$(jq -r '.usage.completion_tokens // 0' "$response_tool_path" 2>/dev/null || echo 0)"
      log "  Tier '${name}' produced a valid review (${call_seconds}s, ${LLM_PROMPT_TOKENS} prompt / ${LLM_COMPLETION_TOKENS} completion tokens)"
      return 0
    fi

    log "  Tier '${name}' returned 200 but no parseable review JSON — trying next tier"
    "$PYTHON_BIN" -c "
import sys, json
try:
    d = json.load(open(sys.argv[1]))
    print(d['choices'][0]['message']['content'][:300])
except Exception:
    pass
" "$(python_path "$RESPONSE_FILE")" 2>/dev/null | while IFS= read -r line; do log "    | ${line}"; done
  done

  return 1
}

# Transient registry failures on the runner (socket timeouts, DNS, resets)
# are NOT a defect in the PR under review — but a bare install failure here
# would be reported as a failed quality gate, which discards the LLM's fixes
# and can merge the PR unreviewed (DnD-1sux0). Retry on network-shaped errors,
# and hand the caller a distinct `infra_fail` status so a persistent registry
# outage BLOCKS (and re-reviews) instead of masquerading as a clean review.
PNPM_NETWORK_ERR_RE='Socket timeout|ETIMEDOUT|ECONNRESET|EAI_AGAIN|ENOTFOUND|ECONNREFUSED|ERR_PNPM_FETCH|ERR_PNPM_META_FETCH_FAIL|network request .* failed|request to .* failed|registry error|50[234] '
PNPM_INSTALL_OUTPUT=""

# Runs `pnpm install --frozen-lockfile` with an outer retry that only fires on
# network-shaped errors. Sets PNPM_INSTALL_OUTPUT to the last attempt's output.
# Returns: 0 = installed, 1 = NON-network failure (e.g. lockfile out of sync —
# a real PR problem the review should surface), 2 = network error that
# persisted across every retry (infra).
pnpm_install_resilient() {
  local attempt max=3 out
  for attempt in $(seq 1 "$max"); do
    if out="$(pnpm install --frozen-lockfile 2>&1)"; then
      PNPM_INSTALL_OUTPUT="$out"
      return 0
    fi
    PNPM_INSTALL_OUTPUT="$out"
    if ! grep -qiE "$PNPM_NETWORK_ERR_RE" <<< "$out"; then
      return 1  # real, non-network failure — don't waste retries on it
    fi
    log "  [pnpm install] network error (attempt ${attempt}/${max}) — cleaning partial install and backing off..."
    rm -rf node_modules 2>/dev/null || true
    [ "$attempt" -lt "$max" ] && sleep $((attempt * 10))
  done
  return 2
}

run_quality_gates() {
  local result="pass"
  local output=""

  log "Running quality gates..."
  cd "$WORK_DIR"

  # Fresh worktree has no node_modules — every gate below needs them
  if [ ! -d node_modules ]; then
    log "  [pnpm install] installing dependencies..."
    pnpm_install_resilient
    local install_rc=$?
    if [ "$install_rc" -eq 2 ]; then
      log "  [pnpm install] FAILED — persistent network/registry error (infra, not the PR)"
      echo "=== PNPM INSTALL NETWORK FAILURE (infra) ==="
      echo "$PNPM_INSTALL_OUTPUT" | tail -20
      echo "=== END ==="
      echo "infra_fail"
      return
    elif [ "$install_rc" -ne 0 ]; then
      log "  [pnpm install] FAILED — non-network (e.g. lockfile out of sync with package.json)"
      echo "=== PNPM INSTALL FAILURE ==="
      echo "$PNPM_INSTALL_OUTPUT" | tail -20
      echo "=== END ==="
      echo "fail"
      return
    fi
  fi

  # First, try auto-fix for lint issues
  log "  [lint --fix] ..."
  pnpm lint --fix 2>/dev/null || true
  git add -A 2>/dev/null || true

  # TypeScript type check (also builds @promptci/core — typecheck depends on it)
  log "  [typecheck] ..."
  if ! output="$(pnpm typecheck 2>&1)"; then
    result="fail"
    log "  [typecheck] FAILED"
    echo "=== TYPECHECK FAILURE ==="
    echo "$output" | tail -40
    echo "=== END ==="
    echo "$result"
    return
  else
    log "  [typecheck] PASS"
  fi

  # Lint
  log "  [lint] ..."
  if ! output="$(pnpm lint 2>&1)"; then
    result="fail"
    log "  [lint] FAILED"
    echo "=== LINT FAILURE ==="
    echo "$output" | tail -40
    echo "=== END ==="
    echo "$result"
    return
  else
    log "  [lint] PASS"
  fi

  # Build BEFORE test — cli-e2e tests execute the built CLI (see ci.yml, which
  # orders Build before Test for the same reason).
  log "  [build] ..."
  if ! output="$(pnpm build 2>&1)"; then
    result="fail"
    log "  [build] FAILED"
    echo "=== BUILD FAILURE ==="
    echo "$output" | tail -40
    echo "=== END ==="
    echo "$result"
    return
  else
    log "  [build] PASS"
  fi

  # Tests
  log "  [test] ..."
  if ! output="$(pnpm test 2>&1)"; then
    result="fail"
    log "  [test] FAILED"
    echo "=== TEST FAILURE ==="
    echo "$output" | tail -40
    echo "=== END ==="
    echo "$result"
    return
  else
    log "  [test] PASS"
  fi

  echo "pass"
}

# ── Version-pin guard (DnD-iu4qj) ─────────────────────────────────────────────
# Masks version-ish tokens so two strings can be compared "modulo versions":
#   - GitHub Action pins:      uses: actions/checkout@v7   -> @__VER__
#   - node-version keys:       node-version: '22'          -> node-version: '__VER__'
#   - bare semver-ish tokens:  1.2.3, v14.2.0, ^8.0.0      -> __VER__
normalize_versions() {
  sed -E \
    -e 's/@v?[0-9]+(\.[0-9]+)*/@__VER__/g' \
    -e "s/(node-version[\"': =]+)v?[0-9]+(\.[0-9]+)*/\1__VER__/g" \
    -e 's/[~^]?v?[0-9]+\.[0-9]+(\.[0-9]+)?([-+][0-9A-Za-z.-]+)?/__VER__/g'
}

# Returns 0 (= reject) when a fix is a pure version-pin change, i.e. the
# old/new strings are IDENTICAL once version tokens are masked. The review
# prompt forbids version changes and a model violated it anyway in the DnD
# repo, silently downgrading actions/checkout@v7 to @v4 — versions newer than
# a model's training data look like typos to it, so this cannot be left to
# the prompt. Mixed fixes (code change + version change together) still
# apply; the guard targets the "correcting" of pins, which is only ever the
# whole fix. Lockfiles are rejected outright — hand-editing them is never a
# legitimate review fix. NOTE: this repo pins Actions to full commit SHAs
# (see ci.yml); a SHA swap is not caught by the version mask, but any fix
# touching only a workflow `uses:` line deserves suspicion anyway.
is_version_pin_change() {
  local path="$1" old="$2" new="$3"
  case "$(basename "$path")" in
    pnpm-lock.yaml|package-lock.json|yarn.lock) return 0 ;;
  esac
  [ "$old" = "$new" ] && return 1
  local norm_old norm_new
  norm_old="$(normalize_versions <<< "$old")"
  norm_new="$(normalize_versions <<< "$new")"
  [ "$norm_old" = "$norm_new" ]
}

apply_fixes() {
  local json="$1"
  local count=0

  while read -r fix; do
    local path old_string new_string desc
    path="$(echo "$fix" | jq -r '.path')"
    old_string="$(echo "$fix" | jq -r '.old_string')"
    new_string="$(echo "$fix" | jq -r '.new_string')"
    desc="$(echo "$fix" | jq -r '.description')"

    if [ -z "$path" ]; then
      log "  Skipping fix with no path"
      printf -- '- (no file path given) — %s\n' "$desc" >> "$DROPPED_FIXES_FILE"
      continue
    fi

    full_path="${WORK_DIR}/${path}"

    # Guard against LLM returning null/None as string values
    if [ "$old_string" = "null" ] || [ "$new_string" = "null" ]; then
      log "  SKIPPED ${path} (LLM returned null value): ${desc}"
      printf -- '- **%s** (LLM returned null value) — %s\n' "$path" "$desc" >> "$DROPPED_FIXES_FILE"
      continue
    fi

    # Version-pin guard (DnD-iu4qj): never apply a fix that only changes
    # version pins — see is_version_pin_change above for the incident.
    if is_version_pin_change "$path" "$old_string" "$new_string"; then
      log "  REJECTED ${path} (version-pin change — rule 5 is mechanical now): ${desc}"
      printf -- '- **%s** (REJECTED: version-pin-only change; versions newer than the model'"'"'s training data are not errors) — %s\n' "$path" "$desc" >> "$DROPPED_FIXES_FILE"
      continue
    fi

    if [ "$old_string" = "" ] && [ -n "$new_string" ]; then
      # New file
      mkdir -p "$(dirname "$full_path")"
      echo "$new_string" > "$full_path"
      log "  Created ${path}: ${desc}"
      printf -- '- **%s** (created) — %s\n' "$path" "$desc" >> "$APPLIED_FIXES_FILE"
      count=$((count + 1))
    elif [ -n "$old_string" ] && [ -n "$new_string" ]; then
      # Find and replace — with fuzzy matching fallback
      if [ -f "$full_path" ]; then
        # Pass arguments via stdin as JSON to avoid shell quoting issues
        if "$PYTHON_BIN" -c "
import sys, json, re

args = json.loads(sys.stdin.read())
path = args['path']
old = args['old_string']
new = args['new_string']
desc = args.get('description', '')

with open(path, 'r') as f:
    content = f.read()

# Strategy 1: exact match
if old in content:
    content = content.replace(old, new, 1)
    with open(path, 'w') as f:
        f.write(content)
    sys.exit(0)

# Strategy 2: whitespace-normalized match
old_norm = re.sub(r'\s+', ' ', old.strip())
content_norm = re.sub(r'\s+', ' ', content)
if old_norm in content_norm:
    content = content.replace(old, new, 1)
    with open(path, 'w') as f:
        f.write(content)
    sys.exit(0)

# Strategy 3: leading/trailing line match
old_lines = old.strip().split('\n')
content_lines = content.split('\n')
first_line = old_lines[0].strip()
last_line = old_lines[-1].strip()
for i in range(len(content_lines)):
    if content_lines[i].strip() == first_line:
        end = min(i + len(old_lines), len(content_lines))
        region = '\n'.join(content_lines[i:end])
        if content_lines[end-1].strip() == last_line:
            content_lines[i:end] = new.split('\n')
            with open(path, 'w') as f:
                f.write('\n'.join(content_lines))
            sys.exit(0)

sys.exit(1)
        " <<< "$(jq -n --arg p "$(python_path "$full_path")" --arg o "$old_string" --arg n "$new_string" --arg d "$desc" '{path:$p, old_string:$o, new_string:$n, description:$d}')" 2>/dev/null; then
          log "  Fixed ${path}: ${desc}"
          printf -- '- **%s** — %s\n' "$path" "$desc" >> "$APPLIED_FIXES_FILE"
          count=$((count + 1))
        else
          log "  SKIPPED ${path} (pattern not found): ${desc}"
          printf -- '- **%s** (pattern not found) — %s\n' "$path" "$desc" >> "$DROPPED_FIXES_FILE"
        fi
      else
        log "  SKIPPED ${path} (file not found)"
        printf -- '- **%s** (file not found) — %s\n' "$path" "$desc" >> "$DROPPED_FIXES_FILE"
      fi
    fi
  done < <(echo "$json" | jq -c '.fixes[]' 2>/dev/null)

  echo "$count"
}

check_ci_status() {
  local sha="${1:-$HEAD_SHA}"
  >&2 log "  Checking CI for SHA: ${sha}"
  local api_result api_exit=0
  api_result="$($GH_CLI api "repos/${REPO}/commits/${sha}/check-runs" 2>&1)" || api_exit=$?
  if [ "$api_exit" -ne 0 ] || [ -z "$api_result" ]; then
    >&2 log "  CI API call failed (exit=${api_exit})"
    >&2 log "  Response: $(echo "$api_result" | head -c 200)"
    # api_failed distinguishes "the API told us there are zero checks" from
    # "we could not ask" — the latter must never count toward the zero-checks
    # grace, or 120s of GitHub flakiness reads as a mergeable PR.
    echo '{"total":0,"completed":0,"success":0,"failures":0,"neutral":0,"all_completed":false,"all_success":false,"api_failed":true}'
    return
  fi
  # No alternative operators in here. jq accepts one as an object-construction
  # value only from 1.8.0 on; under jq 1.7.1 — what ubuntu-latest ships — a
  # `total: (…) or-else 0` form is a SYNTAX error, so nothing compiles at all.
  # The failure is logged, not swallowed — and the fallback carries api_failed
  # so the zero-checks grace never counts an unparseable poll (see wait_for_ci).
  #
  # `skipped` counts as NON-BLOCKING in all_success (alongside neutral): the
  # enable-automerge job in auto-merge.yml has a job-level `if`, so every
  # non-Dependabot/non-labeled PR gets a check run with conclusion=skipped on
  # its head SHA. Treating skipped as not-success made all_success permanently
  # false — failures=0, so wait_for_ci looped "N checks, waiting" for the full
  # 1800s on EVERY such PR (hit live on PR #78's first keyed re-review). Merge
  # safety is unaffected: the `main` ruleset independently requires the `ci`
  # check to be green at merge time, so a red-or-absent ci still never merges.
  local parsed jq_exit=0
  parsed="$(echo "$api_result" | jq '
    {
      total: ([.check_runs[] | select(.name | startswith("🤖 Auto-Review") | not)] | length),
      completed: ([.check_runs[] | select((.name | startswith("🤖 Auto-Review") | not) and .status == "completed")] | length),
      success: ([.check_runs[] | select((.name | startswith("🤖 Auto-Review") | not) and .conclusion == "success")] | length),
      failures: ([.check_runs[] | select((.name | startswith("🤖 Auto-Review") | not) and .conclusion == "failure")] | length),
      neutral: ([.check_runs[] | select((.name | startswith("🤖 Auto-Review") | not) and .conclusion == "neutral")] | length),
      all_completed: (
        ([.check_runs[] | select(.name | startswith("🤖 Auto-Review") | not)] | length) > 0 and
        ([.check_runs[] | select((.name | startswith("🤖 Auto-Review") | not) and .status != "completed")] | length) == 0
      ),
      all_success: (
        ([.check_runs[] | select(.name | startswith("🤖 Auto-Review") | not)] | length) > 0 and
        ([.check_runs[] | select((.name | startswith("🤖 Auto-Review") | not) and .conclusion != "success" and .conclusion != "neutral" and .conclusion != "skipped")] | length) == 0
      )
    }
  ' 2>&1)" || jq_exit=$?
  if [ "$jq_exit" -ne 0 ] || [ -z "$parsed" ]; then
    >&2 log "  check-runs jq parse FAILED (exit=${jq_exit}): $(printf '%s' "$parsed" | head -c 200)"
    echo '{"total":0,"completed":0,"success":0,"failures":0,"neutral":0,"all_completed":false,"all_success":false,"api_failed":true}'
    return
  fi
  echo "$parsed"
}

wait_for_ci() {
  local sha="$1"
  # "true" when $sha reached the branch via this pipeline's own GITHUB_TOKEN
  # push. GitHub fires NO workflows for GITHUB_TOKEN events, so a bot-pushed
  # SHA never gets pull_request-triggered CI on its own. For those SHAs this
  # function dispatches ci.yml explicitly, and "zero check runs" means the
  # dispatch failed: fail closed (return 4), never "no CI applies". Without
  # this, every base-sync push produces a checkless SHA that could merge with
  # zero CI (DnD-4drs9: ~30 code PRs merged that way in one day).
  local bot_pushed="${2:-false}"
  local waited=0
  local zero_checks_elapsed=0
  local ci_dispatched=false

  while [ "$waited" -lt "$POLL_TIMEOUT" ]; do
    local raw_status
    raw_status="$(check_ci_status "$sha")"

    # Convert JSON nulls to safe defaults using jq
    local all_completed all_success total failures api_failed
    all_completed="$(echo "$raw_status" | jq -r 'if .all_completed then "true" else "false" end' 2>/dev/null || echo "false")"
    all_success="$(echo "$raw_status" | jq -r 'if .all_success then "true" else "false" end' 2>/dev/null || echo "false")"
    total="$(echo "$raw_status" | jq -r 'if .total then .total else 0 end' 2>/dev/null || echo "0")"
    failures="$(echo "$raw_status" | jq -r 'if .failures then .failures else 0 end' 2>/dev/null || echo "0")"
    api_failed="$(echo "$raw_status" | jq -r 'if .api_failed then "true" else "false" end' 2>/dev/null || echo "false")"

    if [ "$api_failed" = "true" ]; then
      # "Could not ask" is not "zero checks": don't dispatch off it and don't
      # let it accumulate toward the zero-checks grace. Keep polling; if the
      # API never recovers the loop exits at POLL_TIMEOUT → blocked.
      log "  CI: check-runs lookup failing — not counting toward the zero-checks grace (${waited}s elapsed)"
    elif [ "$total" -eq 0 ]; then
      # ci.yml here has NO paths-ignore, so CI applies to EVERY PR and zero
      # check runs always means "not registered yet" — a 2nd commit pushed as
      # the review started, a run cancelled by ci.yml's cancel-in-progress, or
      # a bot-pushed SHA whose CI never fires naturally. Dispatch to heal the
      # cancelled/bot-pushed cases, then fail closed after the grace. There is
      # NO docs-only shortcut in this repo (in the DnD original, misreading
      # zero checks as docs-only merged a code PR over red CI — DnD-7k9o0).
      if [ "$ci_dispatched" = "false" ]; then
        dispatch_ci
        ci_dispatched=true
        # Restart the grace clock so the dispatched run gets the FULL grace
        # to register its first check run.
        zero_checks_elapsed=0
      fi
      zero_checks_elapsed=$((zero_checks_elapsed + POLL_INTERVAL))
      if [ "$zero_checks_elapsed" -ge "$ZERO_CHECKS_GRACE" ]; then
        log "  CI: no check runs registered after ${zero_checks_elapsed}s even after an explicit dispatch — failing closed (bot_pushed=${bot_pushed})"
        return 4
      fi
      log "  CI: no check runs yet (waited ${waited}s) — maybe CI hasn't started"
    elif [ "$all_completed" = "true" ] && [ "$all_success" = "true" ]; then
      log "  CI: ALL CHECKS PASSED"
      return 0
    elif [ "$all_completed" = "true" ] && [ "$failures" -gt 0 ]; then
      log "  CI: FAILURES DETECTED ($failures failures)"
      return 1
    else
      log "  CI: ${total} checks, waiting (${waited}s elapsed)"
    fi

    # Check if next interval would exceed timeout
    if [ $((waited + POLL_INTERVAL)) -ge "$POLL_TIMEOUT" ]; then
      log "  CI: TIMEOUT after ${POLL_TIMEOUT}s"
      return 2
    fi

    sleep "$POLL_INTERVAL"
    waited=$((waited + POLL_INTERVAL))
  done

  log "  CI: TIMEOUT after ${POLL_TIMEOUT}s"
  return 2
}

generate_comment() {
  local summary="$1"
  local result="$2"
  local iterations="$3"
  local merge_sha="${4:-}"
  local completed_at
  local duration

  completed_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  duration=$(( $(date -u -d "$completed_at" +%s) - $(date -u -d "$STARTED_AT" +%s) ))

  cat > "$COMMENT_FILE" <<COMMENTEOF
## 🤖 PR Auto-Review Summary

${summary}

<details><summary>ℹ️ Review Metadata</summary>

\`\`\`yaml
review:
  host: ${RUNNER_HOST:-artemis}
  runner_name: ${RUNNER_NAME:-artemis-promptci-pr-review}
  llm_tier: ${LLM_USED_TIER}
  model: ${LLM_USED_MODEL}
  model_endpoint: ${LLM_USED_ENDPOINT}
  llm_call_seconds: ${LLM_CALL_SECONDS}
  llm_prompt_tokens: ${LLM_PROMPT_TOKENS}
  llm_completion_tokens: ${LLM_COMPLETION_TOKENS}
  automerge_eligible: $(is_automerge_author && echo true || echo false)
  do_not_merge_label: ${HOLD_LABEL:-none}
  started_at: ${STARTED_AT}
  completed_at: ${completed_at}
  duration_seconds: ${duration}
  converge_iterations: ${iterations}
  converge_attempts:
$(echo "$CONVERGE_ATTEMPTS" | jq -r '.[] | "    - check: \(.check)\n      status: \(.result)\n      fix: \(.fix_applied // false)"' 2>/dev/null || echo "    - check: review
      status: completed
      fix: unknown")
  pr_number: ${PR_NUMBER}
  pr_author: ${PR_AUTHOR}
  pr_base_ref: ${PR_BASE_REF}
  pr_head_ref: ${PR_HEAD_REF}
  pr_base_sha: ${BASE_SHA}
  pr_head_sha: ${HEAD_SHA}
  push_sha: $(git -C "$WORK_DIR" rev-parse HEAD 2>/dev/null || echo "none")
  merge_sha: ${merge_sha:-none}
  result: ${result}
\`\`\`
</details>
COMMENTEOF

  # A hold has to be visible in the COMMENT, not just the run log (DnD-m3uj3).
  # "Reviewed but not merged" and "held" look identical from the PR page, so a
  # held PR reads as a reviewer that simply had nothing to merge.
  if [ "$HOLD_LABEL" = "$LABEL_LOOKUP_FAILED" ]; then
    cat >> "$COMMENT_FILE" <<HOLDEOF

### ⛔ Auto-merge held — this PR's labels could not be read

The reviewer could not fetch this PR's labels, so it could not rule out a
\`${DO_NOT_MERGE_LABELS}\` hold and **failed closed**: the review ran, the merge did not.
This is an infrastructure fault that holds **every** PR, not something about this one.

- **Merge manually once CI is green:** \`gh pr merge ${PR_NUMBER} --squash --delete-branch\`
- **Diagnose:** \`gh run view ${GITHUB_RUN_ID:-<run-id>} --log | grep 'label lookup FAILED'\` — the gh error and exit code are logged there.
HOLDEOF
  elif [ -n "$HOLD_LABEL" ]; then
    cat >> "$COMMENT_FILE" <<HOLDEOF

### ⏸️ Auto-merge held by the \`${HOLD_LABEL}\` label

The review ran, but the merge is deliberately blocked. Remove the label to let
the next review merge this PR.
HOLDEOF
  fi

  # Any non-success result fails the workflow (red check) so the PR is not
  # silently mergeable-looking. Explain how to proceed or bypass.
  if [ "$result" = "blocked" ] || [ "$result" = "review_failed" ]; then
    cat >> "$COMMENT_FILE" <<BYPASSEOF

### ⛔ Action required — auto-merge did not happen

- **Retry the review:** \`gh run rerun ${GITHUB_RUN_ID:-<run-id>} --failed\` or push a new commit to this branch.
- **Bypass and merge manually:** \`gh pr merge ${PR_NUMBER} --squash --delete-branch\` (use when the reviewer is down or out of credits and CI is otherwise green).
BYPASSEOF
  fi

  echo "$COMMENT_FILE"
}

finish() {
  local summary="$1" result="$2" iterations="$3" merge_sha="${4:-}"

  # Give a held run its own result rather than letting it report as a clean
  # "reviewed"/"commented" (DnD-m3uj3). A deliberate label hold stays green — a
  # human parked it on purpose. A hold caused by a FAILED lookup goes red: the
  # run did not do its job, and a green check on every PR is exactly how that
  # outage stays invisible.
  case "$result" in
    reviewed|commented)
      if [ "$HOLD_LABEL" = "$LABEL_LOOKUP_FAILED" ]; then
        result="held_label_lookup_failed"
      elif [ -n "$HOLD_LABEL" ]; then
        result="held_do_not_merge_label"
      fi
      ;;
  esac

  generate_comment "$summary" "$result" "$iterations" "$merge_sha" >/dev/null
  # $GITHUB_OUTPUT may be absent on some self-hosted runner configurations; make
  # these writes non-fatal so a missing file doesn't mask the real review result.
  echo "result=${result}" >> "$GITHUB_OUTPUT" 2>/dev/null || true
  echo "comment_path=${COMMENT_FILE}" >> "$GITHUB_OUTPUT" 2>/dev/null || true
  log "=== PR Auto-Review Complete: #${PR_NUMBER} → ${result} ==="
  # Hand off to a PR whose review was dropped. Runs on EVERY terminal result —
  # a blocked or failed review still frees the slot, and a stranded PR should
  # not have to wait for the next healthy one.
  dispatch_stranded_review
  case "$result" in
    blocked|review_failed|held_label_lookup_failed) exit 1 ;;
    *) exit 0 ;;
  esac
}

# ── Main logic ─────────────────────────────────────────────────────────────

main() {
  local iterations=0
  local result="reviewed"
  local merge_sha=""
  local summary=""
  local review_summary=""
  local qg_last="none"
  local qg_failure_context=""
  local automerge_eligible=false

  if is_automerge_author; then
    automerge_eligible=true
  fi

  # Informational only — merge_pr re-checks at merge time and is the real gate.
  # Logged up front so a run that reviews but never merges is self-explanatory
  # rather than looking like the bot silently lost interest.
  if HOLD_LABEL="$(has_do_not_merge_label)"; then
    if [ "$HOLD_LABEL" = "$LABEL_LOOKUP_FAILED" ]; then
      log "HOLD: could not read this PR's labels — failing closed, so this run will review but will NOT merge."
      # Only shout when it actually cost a merge. A non-allowlisted author was
      # never going to be auto-merged, so a hold changes nothing for them.
      if [ "$automerge_eligible" = "true" ]; then
        annotate error "Auto-merge is failing closed: the do-not-merge label lookup returned an error for PR #${PR_NUMBER}. If this appears on every PR, auto-merge is down repo-wide (DnD-m3uj3)."
      fi
    else
      log "HOLD: PR carries the '${HOLD_LABEL}' label — this run will review but will NOT merge."
    fi
    automerge_eligible=false
  else
    HOLD_LABEL=""
  fi

  log "=== PR Auto-Review Start: #${PR_NUMBER} ==="
  log "Repo: ${REPO}"
  log "Branch: ${PR_HEAD_REF} → ${PR_BASE_REF}"
  log "Author: ${PR_AUTHOR} (auto-merge eligible: ${automerge_eligible})"
  log "LLM chain: ${OPENROUTER_MODEL} → ${OPENROUTER_FALLBACK_MODEL} @ ${OPENROUTER_ENDPOINT}"

  # ── 1. Set up working directory ────────────────────────────────────────
  # The workflow clones the PR branch into WORK_DIR — just cd in and configure.
  log "Setting up working directory at ${WORK_DIR}..."
  if [ ! -d "$WORK_DIR" ]; then
    die "WORK_DIR ${WORK_DIR} does not exist — the checkout step should have created it"
  fi

  cd "$WORK_DIR"
  git config user.name "$BOT_NAME"
  git config user.email "$BOT_EMAIL"

  # Ensure we have the base branch ref for diff/merge operations
  git fetch origin "$PR_BASE_REF" 2>&1 | tail -3 || log "Warning: could not fetch base ref ${PR_BASE_REF} from origin"

  log "Working directory ready: ${WORK_DIR} ($(git rev-parse HEAD))"

  # ── 2. Bot-commit short-circuit ────────────────────────────────────────
  # If the latest PR commit is our own fix/sync push, don't re-review — just
  # wait for CI and merge (eligible authors only; that's the only way a bot
  # commit lands on the branch anyway).
  #
  # Keyed on commit MESSAGE, not author name. The author-name approach broke
  # in the DnD repo when the user's git identity matched BOT_NAME, causing
  # every user PR to skip review entirely. The pipeline's automated commits
  # use exactly two prefixes — check those instead.
  local pr_latest_message
  pr_latest_message="$($GH_CLI pr view "$PR_NUMBER" --repo "$REPO" --json commits --jq '.commits[-1].messageHeadline // ""' 2>/dev/null || echo "")"
  log "PR latest commit message: ${pr_latest_message}"
  local is_bot_commit=false
  if [[ "$pr_latest_message" == "fix(auto-review):"* ]] || [[ "$pr_latest_message" == "chore: merge"* ]]; then
    is_bot_commit=true
  fi
  if [ "$is_bot_commit" = "true" ] && [ "$automerge_eligible" = "true" ]; then
    # Poll the LIVE tip, never the event's HEAD_SHA: a re-run of a
    # pull_request-triggered job replays the original payload, so HEAD_SHA
    # can be a stale author commit with green CI while the actual tip is
    # this unverified bot commit.
    local live_tip
    if ! live_tip="$(resolve_live_tip)"; then
      finish "⚠️ Could not read the live branch tip — not merging without verifying CI on it. Re-run this review." "blocked" 0
    fi
    log "Last commit is from bot — skipping review, waiting on CI for live tip ${live_tip}"
    local ci_exit=0
    # A bot commit at the branch tip was pushed with GITHUB_TOKEN (that is the
    # only way one lands there), so its CI never fires on its own — pass
    # bot_pushed=true so wait_for_ci dispatches it and fails closed on zero
    # checks.
    wait_for_ci "$live_tip" true || ci_exit=$?
    if [ "$ci_exit" -eq 0 ]; then
      log "CI all green — merging PR #${PR_NUMBER}"
      if merge_pr; then
        merge_sha="$($GH_CLI pr view "$PR_NUMBER" --repo "$REPO" --json mergeCommit --jq '.mergeCommit.oid' 2>/dev/null || echo "$HEAD_SHA")"
        finish "✅ Previous auto-review fixes passed CI. PR merged." "merged" 0 "$merge_sha"
      else
        finish "⚠️ CI passed but merge failed (may already be merged, or needs manual intervention)." "blocked" 0
      fi
    elif [ "$ci_exit" -eq 1 ]; then
      finish "⚠️ CI checks failing after auto-review fixes. Needs investigation." "blocked" 0
    elif [ "$ci_exit" -eq 4 ]; then
      finish "🚨 CI never started for the bot-pushed SHA even after an explicit workflow dispatch — failing closed, not merging. Most likely cause: this branch was cut before ci.yml gained its workflow_dispatch trigger, so the dispatch 422s — merge main into the branch and re-review. Otherwise check the Actions runners, then re-run this review." "blocked" 0
    else
      finish "⏰ CI polling timed out after ${POLL_TIMEOUT}s. Manual check recommended." "blocked" 0
    fi
  fi

  # ── 3. Sync with base branch (eligible authors only) ──────────────────
  # Merge (not rebase): a rebase rewrites the PR's commits and cannot be
  # pushed back without force, which we never do on shared branches.
  local synced_with_base=false
  if [ "$automerge_eligible" = "true" ]; then
    local behind_count
    behind_count="$(git rev-list --count "HEAD..origin/${PR_BASE_REF}" 2>/dev/null || echo 0)"
    if [ "$behind_count" -gt 0 ]; then
      log "Branch is ${behind_count} commits behind ${PR_BASE_REF} — merging it in..."
      if git merge "origin/${PR_BASE_REF}" -m "chore: merge ${PR_BASE_REF} into ${PR_HEAD_REF} (auto-review sync)" 2>&1; then
        synced_with_base=true
        log "Merge successful"
      else
        git merge --abort 2>/dev/null || true
        finish "⚠️ Merge conflicts with \`${PR_BASE_REF}\` — manual conflict resolution needed." "blocked" 0
      fi
    else
      log "Branch is up to date with ${PR_BASE_REF}"
    fi
  fi

  # ── 4. Read the review prompt ──────────────────────────────────────────
  if [ -f "$PROMPT_FILE" ]; then
    SYSTEM_PROMPT="$(cat "$PROMPT_FILE")"
    log "Loaded review prompt from ${PROMPT_FILE}"
  else
    SYSTEM_PROMPT="You are an expert TypeScript code reviewer. Review the PR diff, find issues, and provide fixes as a JSON object with a 'fixes' array. Each fix has: path, old_string, new_string, description."
    log "No prompt file found — using default prompt"
  fi

  # ── 5. Converge loop: review → fix → check ────────────────────────────
  local review_failed=false
  local infra_failed=false
  while [ "$iterations" -lt "$MAX_ITERATIONS" ]; do
    iterations=$((iterations + 1))
    log "=== Review iteration ${iterations}/${MAX_ITERATIONS} ==="

    # Get the diff
    local diff_content
    if [ "$iterations" -eq 1 ]; then
      diff_content="$(git diff "origin/${PR_BASE_REF}...HEAD" 2>/dev/null || true)"
    else
      # Re-review the PR diff plus the still-uncommitted fixes from the
      # previous iteration. (HEAD~1..HEAD would diff the sync merge's
      # mainline side — code from the base branch that is not ours to review.)
      diff_content="$(git diff "origin/${PR_BASE_REF}...HEAD" 2>/dev/null || true)
$(git diff HEAD 2>/dev/null || true)"
    fi

    if [ -z "$diff_content" ]; then
      log "No diff to review"
      CONVERGE_ATTEMPTS="$(echo "$CONVERGE_ATTEMPTS" | jq '. += [{"check":"review","result":"no_changes"}]' 2>/dev/null || echo '[{"check":"review","result":"no_changes"}]')"
      break
    fi

    # Limit diff size to avoid token overflow. Herestring, NOT a pipe:
    # `echo big-diff | head` dies of SIGPIPE under pipefail once head exits.
    local diff_truncated
    diff_truncated="$(head -n "$MAX_DIFF_LINES" <<< "$diff_content")"

    log "Calling LLM (diff: $(wc -l <<< "$diff_truncated") lines)..."
    # Include full file content for changed files so the LLM can generate accurate patches
    local file_context=""
    while IFS= read -r f; do
      [ -z "$f" ] && continue
      if [ -f "$f" ]; then
        local file_size
        file_size=$(wc -l < "$f" 2>/dev/null || echo "0")
        if [ "$file_size" -le 300 ]; then
          file_context="${file_context}

### FILE: ${f}
$(cat "$f")"
        else
          file_context="${file_context}

### FILE: ${f} (${file_size} lines, showing first 300):
$(head -300 "$f")"
        fi
      fi
    done < <(git diff --name-only "origin/${PR_BASE_REF}...HEAD" 2>/dev/null | head -10)

    local user_content="PR Title: ${PR_TITLE}

PR Description:
${PR_BODY:-none}

Files changed:
$(git diff --stat "origin/${PR_BASE_REF}...HEAD" 2>/dev/null || true)

Current file contents:
${file_context}

Diff:
${diff_truncated}"

    if [ -n "$qg_failure_context" ]; then
      user_content="${user_content}

The previous fix attempt failed these quality gates — fix the failures:
${qg_failure_context}"
    fi

    if ! review_llm "$SYSTEM_PROMPT" "$user_content"; then
      log "All LLM tiers failed — review cannot complete"
      CONVERGE_ATTEMPTS="$(echo "$CONVERGE_ATTEMPTS" | jq '. += [{"check":"llm","result":"all_tiers_failed"}]' 2>/dev/null || true)"
      review_failed=true
      break
    fi

    local json_fixes
    json_fixes="$(cat "$FIXES_FILE")"
    if [ "$iterations" -eq 1 ]; then
      review_summary="$(echo "$json_fixes" | jq -r '.summary // empty' 2>/dev/null || true)"
    fi

    local fix_count=0
    local has_fixes
    has_fixes="$(echo "$json_fixes" | jq -r '.fixes | length' 2>/dev/null || echo "0")"

    if [ "$has_fixes" -eq 0 ]; then
      log "Review complete — no fixes needed"
      CONVERGE_ATTEMPTS="$(echo "$CONVERGE_ATTEMPTS" | jq '. += [{"check":"review","result":"no_fixes_needed"}]' 2>/dev/null || echo '[{"check":"review","result":"no_fixes_needed"}]')"
      break
    fi

    # Comment-only mode when fixes won't be applied: report findings, never
    # touch the author's branch. Two reasons: a blocking label, or a
    # non-allowlisted author. Distinguish them so the message is honest.
    if [ "$automerge_eligible" != "true" ]; then
      local skip_reason
      if [ -n "$HOLD_LABEL" ]; then
        skip_reason="blocked by the '${HOLD_LABEL}' label"
        log "The '${HOLD_LABEL}' label blocks auto-fix — reporting ${has_fixes} suggested fixes without applying"
      else
        skip_reason="author not in auto-merge allowlist"
        log "Author '${PR_AUTHOR}' is not in AUTOMERGE_AUTHORS — reporting ${has_fixes} suggested fixes without applying"
      fi
      local suggestions
      suggestions="$(echo "$json_fixes" | jq -r '.fixes[] | "- **\(.path)** — \(.description)"' 2>/dev/null || echo "- (could not render suggestions)")"
      summary="${review_summary:-Review complete.}

**${has_fixes} suggested fix(es)** (not applied — ${skip_reason}):

${suggestions}"
      CONVERGE_ATTEMPTS="$(echo "$CONVERGE_ATTEMPTS" | jq '. += [{"check":"review","result":"suggestions_only"}]' 2>/dev/null || true)"
      finish "$summary" "commented" "$iterations"
    fi

    fix_count="$(apply_fixes "$json_fixes")"
    log "Applied ${fix_count} fixes"

    if [ "$fix_count" -eq 0 ]; then
      log "No fixes could be applied — breaking converge loop"
      CONVERGE_ATTEMPTS="$(echo "$CONVERGE_ATTEMPTS" | jq '. += [{"check":"review","result":"no_fixes_applied"}]' 2>/dev/null || echo '[{"check":"review","result":"no_fixes_applied"}]')"
      break
    fi

    # The LLM may request a dependency re-install (e.g. its fix touched
    # package.json). pnpm is lockfile-driven either way.
    local req_install
    req_install="$(echo "$json_fixes" | jq -r '(.require_npm_ci // false) or (.require_npm_install // false)' 2>/dev/null || echo "false")"
    if [ "$req_install" = "true" ]; then
      log "Running pnpm install (requested by LLM)..."
      pnpm install 2>&1 | tail -5
    fi

    CONVERGE_ATTEMPTS="$(echo "$CONVERGE_ATTEMPTS" | jq '. += [{"check":"review","result":"fixes_applied"}]' 2>/dev/null || echo '[{"check":"review","result":"fixes_applied"}]')"

    # Run quality gates. Stdout is the failure dump followed by a final
    # pass/fail status line — split them, or the status compares below can
    # never match "fail" and broken fixes get committed.
    local qg_output
    qg_output="$(run_quality_gates || true)"
    qg_last="$(printf '%s\n' "$qg_output" | tail -n 1)"
    qg_failure_context="$(printf '%s\n' "$qg_output" | sed '$d' | tail -n 60)"
    if [ -n "$qg_failure_context" ]; then
      printf '%s\n' "$qg_failure_context" >&2
    fi

    if [ "$qg_last" = "pass" ]; then
      log "All quality gates passed!"
      CONVERGE_ATTEMPTS="$(echo "$CONVERGE_ATTEMPTS" | jq '. += [{"check":"gates","result":"pass"}]' 2>/dev/null || true)"
      break
    elif [ "$qg_last" = "infra_fail" ]; then
      # Environmental failure (persistent registry outage), not a code defect
      # and not something a re-review can fix. Do NOT keep iterating and do
      # NOT let this fall through to the "merge original" path — that would
      # merge the PR with the review effectively skipped. Break and block below.
      log "Quality gates could not run — infrastructure failure (registry/network). Blocking, not merging over an unrun review."
      infra_failed=true
      CONVERGE_ATTEMPTS="$(echo "$CONVERGE_ATTEMPTS" | jq '. += [{"check":"gates","result":"infra_fail"}]' 2>/dev/null || true)"
      break
    else
      log "Quality gates failed on iteration ${iterations}"
      CONVERGE_ATTEMPTS="$(echo "$CONVERGE_ATTEMPTS" | jq '. += [{"check":"gates","result":"fail"}]' 2>/dev/null || true)"

      if [ "$iterations" -ge "$MAX_ITERATIONS" ]; then
        log "Max iterations reached — giving up on converge"
      fi
      # Continue to next iteration to try fixing failures
    fi
  done

  # Infra failure short-circuit: the gates never actually evaluated the PR, so
  # we cannot conclude anything. Discard any uncommitted fixes and block (fail
  # safe) — finish() re-dispatches a stranded PR, so this re-reviews later
  # instead of merging unreviewed (DnD-1sux0).
  if [ "$infra_failed" = "true" ]; then
    git checkout -- . 2>/dev/null || true
    git clean -fd 2>/dev/null || true
    finish "🚧 Quality gates could not run — the runner hit a persistent registry/network error, so this PR was NOT reviewed. Blocking rather than merging over an unrun review; a re-review will run automatically. If it recurs, check the runner's network/registry access." "blocked" "$iterations"
  fi

  # Review never completed → block the merge and say so. The sync merge (if
  # any) is intentionally not pushed either; nothing lands without a review.
  if [ "$review_failed" = "true" ]; then
    finish "⚠️ LLM review failed on every tier (OpenRouter primary + free fallback). No fixes applied, merge blocked." "review_failed" "$iterations"
  fi

  # ── 6. Commit and push fixes / sync merge ──────────────────────────────
  if [ -n "$(git status --porcelain 2>/dev/null)" ]; then
    if [ "$qg_last" = "fail" ]; then
      log "Quality gates still failing — discarding non-converged fixes (not pushing broken code)"
      git checkout -- . 2>/dev/null || true
      git clean -fd 2>/dev/null || true
      CONVERGE_ATTEMPTS="$(echo "$CONVERGE_ATTEMPTS" | jq '. += [{"check":"push","result":"fixes_discarded_gates_failing"}]' 2>/dev/null || true)"
    else
      log "Committing fixes..."
      git add -A
      git commit -m "fix(auto-review): code review fixes for PR #${PR_NUMBER}

Auto-generated fixes from AI code review using ${LLM_USED_MODEL}."
    fi
  fi

  local ahead_count
  ahead_count="$(git rev-list --count "origin/${PR_HEAD_REF}..HEAD" 2>/dev/null || echo 0)"
  if [ "$ahead_count" -gt 0 ] && [ "$automerge_eligible" = "true" ]; then
    log "Pushing ${ahead_count} commit(s) (fixes and/or base sync) to ${PR_HEAD_REF}..."
    # --no-verify: the review push only moves code refs; any client-side hooks
    # in the fresh clone are pure overhead here.
    if git push --no-verify origin "HEAD:${PR_HEAD_REF}" 2>&1; then
      FIXES_PUSHED=true
      log "Pushed to ${PR_HEAD_REF}"
    else
      # Non-fast-forward = someone pushed concurrently. Never force; the new
      # synchronize event will trigger a fresh review of their commit.
      log "Push rejected (concurrent push to branch?) — the next auto-review run will pick it up"
      finish "⚠️ Could not push auto-review commits (concurrent push to the branch). A new review will run on the latest commit." "blocked" "$iterations"
    fi
  fi

  # ── 7. Wait for CI ─────────────────────────────────────────────────────
  # Non-eligible authors in comment-only mode: no fixes were pushed and the
  # review found nothing wrong — just mark the review as passed and exit.
  # We must not wait for CI (that risks cancellation from concurrent branch
  # updates) and must not attempt a merge (comment-only contract).
  if ! $FIXES_PUSHED && [ "$automerge_eligible" != "true" ]; then
    local clean_note="${review_summary:+

**Review notes:** ${review_summary}}"
    finish "✅ Code review passed — no issues found.${clean_note}" "commented" "$iterations"
  fi

  local push_sha
  # Whether the SHA we are about to poll needs an explicit CI dispatch (see
  # wait_for_ci): true when it isn't the author's own event SHA — the only
  # commit whose CI is known to have fired naturally.
  local poll_bot_pushed="$FIXES_PUSHED"
  if $FIXES_PUSHED; then
    push_sha="$(git rev-parse HEAD 2>/dev/null || echo "$HEAD_SHA")"
    log "Verifying push on remote..."
    sleep 5
    local remote_sha
    remote_sha="$($GH_CLI pr view "$PR_NUMBER" --repo "$REPO" --json headRefOid --jq '.headRefOid' 2>/dev/null || echo "")"
    if [ -n "$remote_sha" ]; then
      log "Remote head SHA: ${remote_sha}"
      if [ "$remote_sha" != "$push_sha" ]; then
        # Someone pushed on top of (or past) our commit in the window since
        # the push. Don't adopt their SHA as ours and start dispatching CI at
        # it — their push fires its own synchronize event and a fresh review.
        log "Remote tip moved past our push (concurrent push) — deferring to the new review run"
        finish "⚠️ The branch moved while this review was finishing (concurrent push). The new review run will pick it up." "blocked" "$iterations"
      fi
    fi
  else
    # No push this run — but do NOT assume the tip is the event's HEAD_SHA. A
    # re-run replays the original payload, and a transient failure in the §2
    # bot-commit classifier can land a bot-tipped branch here: polling the
    # stale (green) author SHA would merge the unverified tip. Poll the live
    # tip, fail closed if it cannot be read, and require a dispatch when the
    # tip is not the author's event commit.
    if ! push_sha="$(resolve_live_tip)"; then
      finish "⚠️ Could not read the live branch tip — not merging without verifying CI on it. Re-run this review." "blocked" "$iterations"
    fi
    if [ "$push_sha" != "$HEAD_SHA" ]; then
      log "Nothing pushed this run, but the live tip ${push_sha:0:12} differs from the event SHA ${HEAD_SHA:0:12} — treating it as bot-pushed for CI purposes"
      poll_bot_pushed=true
    else
      log "Nothing pushed — checking CI for original HEAD_SHA: ${push_sha:0:12}"
    fi
  fi

  local review_note="${review_summary:+

**Review notes:** ${review_summary}}"

  # Surface what the review actually did (DnD-pchr6): enumerate applied fixes
  # (with the commit they shipped in) and findings that were silently dropped,
  # instead of a bare "Review complete" that hides the bot's changes.
  local fixes_note=""
  if [ -s "$APPLIED_FIXES_FILE" ]; then
    local applied_count
    applied_count="$(grep -c '^- ' "$APPLIED_FIXES_FILE" 2>/dev/null || echo 0)"
    # qg_last=fail means section 6 reset the tree — the applied fixes were
    # discarded even if a sync-merge commit was still pushed (FIXES_PUSHED).
    if [ "$qg_last" != "fail" ] && $FIXES_PUSHED; then
      fixes_note="

**${applied_count} fix(es) applied and pushed** (\`${push_sha:0:12}\`):

$(cat "$APPLIED_FIXES_FILE")"
    else
      fixes_note="

**${applied_count} fix(es) were applied locally but discarded** (quality gates did not converge after ${MAX_ITERATIONS} iterations) — these findings may still need manual attention:

$(cat "$APPLIED_FIXES_FILE")"
    fi
  fi
  if [ -s "$DROPPED_FIXES_FILE" ]; then
    local dropped_count
    dropped_count="$(grep -c '^- ' "$DROPPED_FIXES_FILE" 2>/dev/null || echo 0)"
    fixes_note="${fixes_note}

**${dropped_count} finding(s) could not be auto-applied:**

$(cat "$DROPPED_FIXES_FILE")"
  fi
  review_note="${review_note}${fixes_note}"

  log "Checking CI status..."
  local ci_exit=0
  # poll_bot_pushed means $push_sha did not come from the author's own push —
  # its CI never fires naturally, so wait_for_ci must dispatch it and treat
  # persistent zero checks as a fault.
  wait_for_ci "$push_sha" "$poll_bot_pushed" || ci_exit=$?
  if [ "$ci_exit" -eq 0 ]; then
    if [ "$qg_last" = "fail" ]; then
      # Gates failed locally but CI is green on the un-fixed SHA — the LLM's
      # fixes were the problem, not the PR. Merge the PR as-is.
      log "Local converge failed but CI is green on PR head — merging original code"
    fi
    log "CI all green — merging PR #${PR_NUMBER}"
    if merge_pr; then
      merge_sha="$($GH_CLI pr view "$PR_NUMBER" --repo "$REPO" --json mergeCommit --jq '.mergeCommit.oid' 2>/dev/null || echo "$push_sha")"
      finish "✅ Review complete, CI green. PR merged.${review_note}" "merged" "$iterations" "$merge_sha"
    else
      finish "✅ CI passed but merge failed (may already be merged, or needs manual intervention).${review_note}" "blocked" "$iterations"
    fi
  elif [ "$ci_exit" -eq 1 ]; then
    finish "⚠️ CI checks have failures. Manual intervention needed.${review_note}" "blocked" "$iterations"
  elif [ "$ci_exit" -eq 4 ]; then
    finish "🚨 CI never started for the polled SHA even after an explicit workflow dispatch — failing closed, not merging. Most likely cause: this branch was cut before ci.yml gained its workflow_dispatch trigger, so the dispatch 422s — merge main into the branch and re-review. Otherwise check the Actions runners, then re-run this review.${review_note}" "blocked" "$iterations"
  else
    finish "⏰ CI check polling timed out after ${POLL_TIMEOUT}s. Manual check recommended.${review_note}" "blocked" "$iterations"
  fi
}

main "$@"
