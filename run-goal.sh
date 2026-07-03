#!/usr/bin/env bash
#
# run-goal.sh — kick off /goal detached, so it keeps running after you disconnect.
#
# Usage:
#   ./run-goal.sh ~/repos/my-app "add password reset flow with email token"
#
# Then close your laptop. Check on it later:
#   tmux ls                       # list running goals
#   tmux attach -t goal-...       # watch live (Ctrl-b d to detach)
#   tail -f ~/goal-logs/<name>.log

set -euo pipefail

if [ $# -lt 2 ]; then
  echo "usage: $0 <repo-dir> <feature goal...>" >&2
  exit 1
fi

REPO_DIR="$(realpath "$1")"; shift
GOAL="$*"
[ -d "$REPO_DIR/.git" ] || { echo "error: $REPO_DIR is not a git repo" >&2; exit 1; }

SESSION="goal-$(date +%Y%m%d-%H%M%S)"
LOG_DIR="$HOME/goal-logs"
LOG="$LOG_DIR/$SESSION.log"
mkdir -p "$LOG_DIR"

# Same guardrails as agent-runner/runners/claude.sh — see README.md "Safety & cost".
RUNNER_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/agent-runner/runners" && pwd)"
SETTINGS="$(jq --arg hook "$RUNNER_DIR/guard-hook.sh" \
  '.hooks.PreToolUse = [{"matcher":"Bash","hooks":[{"type":"command","command":$hook}]}]' \
  "$RUNNER_DIR/claude-settings.json")"

# --permission-mode dontAsk: fully unattended. Only use on a dedicated VM.
CMD=$(printf 'claude -p %q --permission-mode dontAsk --settings %q 2>&1 | tee %q' "/goal $GOAL" "$SETTINGS" "$LOG")

tmux new-session -d -s "$SESSION" -c "$REPO_DIR" "$CMD"

echo "Started '$SESSION' in $REPO_DIR"
echo "  watch:  tmux attach -t $SESSION"
echo "  log:    tail -f $LOG"
