#!/usr/bin/env bash
# Create/refresh the GitHub labels the CI automation depends on.
#
# Idempotent: `gh label create --force` updates an existing label instead of
# failing. Run once per repo (and after any label rename) from a checkout with
# gh authenticated against the repo:
#
#   bash scripts/setup-labels.sh
#
# These back the issue templates (.github/ISSUE_TEMPLATE/) and Dependabot
# (.github/dependabot.yml). Automation reads two families:
#  - merge control: scripts/pr-review.sh treats do-not-merge/hold/blocked as a
#    hard hold (review + comment only, never merge or push fixes), and
#    .github/workflows/auto-merge.yml respects them too; `automerge` opts a
#    non-Dependabot PR into the LLM-free auto-merge path.
#  - type/changelog: .github/release.yml maps them into release notes.
set -euo pipefail

GH_CLI="${GH_CLI:-gh}"
REPO="${REPO:-$($GH_CLI repo view --json nameWithOwner --jq .nameWithOwner)}"

label() {
  local name="$1" color="$2" desc="$3"
  $GH_CLI label create "$name" --repo "$REPO" --color "$color" --description "$desc" --force
}

echo "Applying labels to $REPO..."

# ── Merge control ────────────────────────────────────────────────────────────
label "do-not-merge" "B60205" "Do not merge — maintainer hold on all merges"
label "hold"         "B60205" "Temporarily hold — do not merge yet"
label "blocked"      "B60205" "Blocked on something external — do not merge"
label "automerge"    "0E8A16" "auto-merge.yml: squash-merge automatically once required checks pass"

# ── Type / changelog categories ──────────────────────────────────────────────
label "breaking-change" "D93F0B" "Backwards-incompatible change"
label "breaking"        "D93F0B" "Backwards-incompatible change"
label "enhancement"     "A2EEEF" "New feature or improvement"
label "feature"         "A2EEEF" "New feature or improvement"
label "bug"             "D73A4A" "Something isn't working"
label "fix"             "D73A4A" "Bug fix"
label "detector"        "5319E7" "Scanner detector work"
label "scanner"         "5319E7" "Scanner engine work"
label "security"        "EE0701" "Security-relevant change"
label "performance"     "FBCA04" "Performance improvement"
label "documentation"   "0075CA" "Docs only"
label "docs"            "0075CA" "Docs only"
label "dependencies"    "0366D6" "Dependency updates (Dependabot applies this)"
label "javascript"      "F1E05A" "JavaScript/TypeScript ecosystem (Dependabot applies this)"
label "chore"           "FEF2C0" "Maintenance / housekeeping"
label "maintenance"     "FEF2C0" "Maintenance / housekeeping"
label "ci"              "BFD4F2" "CI / automation change"

# ── Triage & detector accuracy (see .github/ISSUE_TEMPLATE/) ─────────────────
label "needs-triage"    "E4E669" "Awaiting maintainer triage — applied by every issue template"
label "false-positive"  "C2E0C6" "Detector flagged something that isn't a real problem"
label "false-negative"  "C2E0C6" "Detector missed a real problem"
label "needs-repro"     "E4E669" "Cannot reproduce yet — more detail needed from the reporter"
label "needs-fixture"   "E4E669" "Confirmed, but needs a test fixture before it can be fixed"

# ── Area routing ─────────────────────────────────────────────────────────────
label "area:core"       "1D76DB" "packages/core — scanner, detectors, scoring, reporting"
label "area:cli"        "1D76DB" "packages/cli — Commander CLI"
label "area:action"     "1D76DB" "action.yml — GitHub Action packaging"

# ── Community (OSS) ──────────────────────────────────────────────────────────
label "good first issue" "7057FF" "Well-scoped and approachable for a first contribution"
label "help wanted"      "008672" "Maintainers would welcome outside help here"
label "question"         "D876E3" "A question rather than a defect — may move to Discussions"
label "wontfix"          "FFFFFF" "Working as intended, or out of scope"
label "duplicate"        "CFD3D7" "Already tracked in another issue"

echo "Done."
