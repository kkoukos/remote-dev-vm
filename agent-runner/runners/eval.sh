#!/usr/bin/env bash
# Runner: Claude Code, /eval — read-only post-merge evaluation of a merged PR.
# Same arg/env contract as claude.sh, but the job never touches the working tree:
# no worktree, no branch, no PR — it only comments on the PR (and opens an
# `agent-eval` issue for scores <= 2). Install skills/eval/SKILL.md in the repo
# or ~/.claude/skills first.
# Args: $1 = repo dir, $2 = prompt file (must name the merged PR number)
set -euo pipefail
cd "$1"

# Same guardrails as claude.sh (see its comment and README.md "Safety & cost") —
# guard-hook.sh's path is injected since it differs between the VPS and the
# Docker/Railway image. The read-only-toward-the-repo contract itself is enforced
# by the /eval skill's hard rules, on top of these deny rules.
RUNNER_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SETTINGS="$(jq --arg hook "$RUNNER_DIR/guard-hook.sh" \
  '.hooks.PreToolUse = [{"matcher":"Bash","hooks":[{"type":"command","command":$hook}]}]' \
  "$RUNNER_DIR/claude-settings.json")"

FLAGS=(--permission-mode dontAsk --settings "$SETTINGS")
[ -n "${MODEL:-}" ] && FLAGS+=(--model "$MODEL")
[ -n "${EFFORT:-}" ] && FLAGS+=(--effort "$EFFORT")

exec claude -p "/eval $(cat "$2")" "${FLAGS[@]}"
