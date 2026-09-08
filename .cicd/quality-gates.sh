#!/usr/bin/env bash
# Quality gates for the shared PR-review engine (SeriousGeese/CICD).
#
# This file is READ FROM THE PR HEAD, not from a pinned CICD ref — deliberately.
# It is product code: a PR that changes how this project builds must be
# reviewable as part of that PR. Everything else the reviewer runs comes from a
# trusted ref precisely because it must NOT be PR-authored.
#
# It is also the seam that lets one engine serve an npm repo and two pnpm ones.
# The engine used to hard-code `npm ci` plus npm's network-error regex; all of
# that package-manager knowledge lives here now, next to the gates that need it.
#
# Contract:
#   install   0 = installed | 1 = real failure (lockfile drift) | 2 = network/infra
#   run       0 = all gates pass | 1 = a gate failed | 2 = network/infra
#
# On `run` exit 1 the failure context on STDOUT is fed back to the LLM verbatim
# as the next iteration's input, so it must be the tool's own output rather than
# a summary of it.
#
# `2` is not a nicety. It is what stops a registry outage looking like a code
# defect: on infra the engine BLOCKS instead of discarding the review's fixes and
# merging a PR whose gates never actually ran. That failure mode merged 3 of 40
# PRs over an unrun review in the upstream repo before it was found (DnD-1sux0),
# which is why the third exit code exists at all.
set -uo pipefail

# Network-shaped pnpm failures. Matched to decide whether a retry is worth it and
# whether the result is infra (2) or a defect in the PR (1) — never to decide
# whether the gates passed.
PNPM_NETWORK_ERR_RE='Socket timeout|ETIMEDOUT|ECONNRESET|EAI_AGAIN|ENOTFOUND|ECONNREFUSED|ERR_PNPM_FETCH|ERR_PNPM_META_FETCH_FAIL|network request .* failed|request to .* failed|registry error|50[234] '

pnpm_install_resilient() {
  local attempt max=3 out
  for attempt in $(seq 1 "$max"); do
    if out="$(pnpm install --frozen-lockfile 2>&1)"; then
      return 0
    fi
    if ! grep -qiE "$PNPM_NETWORK_ERR_RE" <<< "$out"; then
      # A real failure — most often a lockfile out of sync with package.json,
      # which IS a defect in the PR and one the review should surface. Retrying
      # it just burns three minutes to reach the same answer.
      echo "=== pnpm install FAILED (not a network error) ==="
      echo "$out" | tail -20
      return 1
    fi
    echo "  [pnpm install] network error (attempt ${attempt}/${max}) — cleaning partial install and backing off..." >&2
    rm -rf node_modules 2>/dev/null || true
    [ "$attempt" -lt "$max" ] && sleep $((attempt * 10))
  done
  echo "=== pnpm install FAILED — persistent network/registry error (infra, not this PR) ==="
  echo "${out:-}" | tail -20
  return 2
}

# Run one gate; on failure print the tool's own output and stop the run.
gate() {
  local label="$1"; shift
  local out rc=0
  echo "  [${label}] ..." >&2
  out="$("$@" 2>&1)" || rc=$?
  if [ "$rc" -ne 0 ]; then
    echo "=== ${label} FAILURE ==="
    echo "$out" | tail -40
    echo "=== END ==="
    return 1
  fi
  echo "  [${label}] PASS" >&2
  return 0
}

verb="${1:-run}"
case "$verb" in
  install)
    pnpm_install_resilient
    exit $?
    ;;

  run)
    # A fresh worktree has no node_modules and every gate below needs them. The
    # install failure codes pass straight through: 1 stays a PR defect, 2 stays
    # infra.
    if [ ! -d node_modules ]; then
      pnpm_install_resilient || exit $?
    fi

    # Auto-fix first, then check. Best-effort: a lint tool that cannot even run
    # is reported by the `lint` gate below, not swallowed here.
    pnpm lint --fix >/dev/null 2>&1 || true
    git add -A 2>/dev/null || true

    # typecheck also builds @promptci/core, which typecheck depends on.
    gate typecheck pnpm typecheck || exit 1
    gate lint pnpm lint || exit 1
    # Build BEFORE test: the cli-e2e tests execute the built CLI. ci.yml orders
    # these the same way, for the same reason.
    gate build pnpm build || exit 1
    gate test pnpm test || exit 1
    exit 0
    ;;

  *)
    echo "quality-gates.sh: unknown verb '${verb}' (expected: install|run)" >&2
    exit 1
    ;;
esac
