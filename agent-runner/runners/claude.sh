#!/usr/bin/env bash
# Runner: Claude Code. Uses /goal for existing repos, /bootstrap for repos the
# server just created via `create:true` (see server.mjs's FRESH env var).
# Install both skills in the repo or ~/.claude/skills.
# Args: $1 = repo dir, $2 = prompt file (goal one-liner or full plan)
set -euo pipefail
cd "$1"

SKILL="goal"
[ "${FRESH:-0}" = "1" ] && SKILL="bootstrap"

FLAGS=(--permission-mode dontAsk)
[ -n "${MODEL:-}" ] && FLAGS+=(--model "$MODEL")
[ -n "${EFFORT:-}" ] && FLAGS+=(--effort "$EFFORT")

exec claude -p "/$SKILL $(cat "$2")" "${FLAGS[@]}"
