#!/usr/bin/env bash
# Runner: OpenCode (template — verify flags against your installed version).
# Args: $1 = repo dir, $2 = prompt file
set -euo pipefail
cd "$1"

# FRESH=1 means server.mjs just created this repo via `create:true` — nothing
# to protect yet, so the first push goes straight to main.
if [ "${FRESH:-0}" = "1" ]; then
  TASK="Build this product from scratch in this brand-new, empty repo: $(cat "$2")

Scaffold the project (pick an appropriate stack if none is specified), add a README,
.gitignore, and basic CI, implement a working first version, write tests, and run them.
This repo has no commits yet — make your initial commit(s) directly to main/master.
Treat any further requests after that as normal feature work: branch, commit, push,
and open a GitHub PR with 'gh pr create'. Never merge a PR. Never force-push."
else
  TASK="$(cat "$2")

When implementation is complete: create a feature branch, commit with clear messages,
push, and open a GitHub PR with 'gh pr create' including a summary and testing notes.
Never merge the PR. Never push to main."
fi

# --model here is a common convention across CLIs, not confirmed for OpenCode —
# check `opencode run --help` and adjust the flag name if needed.
MODEL_FLAGS=()
[ -n "${MODEL:-}" ] && MODEL_FLAGS+=(--model "$MODEL")

exec opencode run "${MODEL_FLAGS[@]}" "$TASK"
