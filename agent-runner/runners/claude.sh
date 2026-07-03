#!/usr/bin/env bash
# Runner: Claude Code. Uses /goal for existing repos, /bootstrap for repos the
# server just created via `create:true` (see server.mjs's FRESH env var).
# Install both skills in the repo or ~/.claude/skills.
# Args: $1 = repo dir, $2 = prompt file (goal one-liner or full plan)
set -euo pipefail
cd "$1"

SKILL="goal"
[ "${FRESH:-0}" = "1" ] && SKILL="bootstrap"

# claude-settings.json + guard-hook.sh: guardrails for this unattended run (no
# nuking the repo, no flipping an existing repo's visibility, no reading secrets;
# installing new interpreters/tools IS allowed, including via sudo for
# package-manager commands). guard-hook.sh's path is injected here rather than
# baked into claude-settings.json since it differs between the VPS
# (~/agent-runner/runners) and the Docker/Railway image (/app/agent-runner/runners).
# See README.md "Safety & cost".
RUNNER_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SETTINGS="$(jq --arg hook "$RUNNER_DIR/guard-hook.sh" \
  '.hooks.PreToolUse = [{"matcher":"Bash","hooks":[{"type":"command","command":$hook}]}]' \
  "$RUNNER_DIR/claude-settings.json")"

FLAGS=(--permission-mode dontAsk --settings "$SETTINGS")
[ -n "${MODEL:-}" ] && FLAGS+=(--model "$MODEL")
[ -n "${EFFORT:-}" ] && FLAGS+=(--effort "$EFFORT")

exec claude -p "/$SKILL $(cat "$2")" "${FLAGS[@]}"
