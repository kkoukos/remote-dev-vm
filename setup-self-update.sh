#!/usr/bin/env bash
# setup-self-update.sh — install the pull-based self-updater (run as the dev user).
#
# Installs a systemd oneshot + timer (agent-selfupdate.service/.timer) that runs
# agent-runner/self-update.sh on a schedule. This lives DELIBERATELY SEPARATE
# from agent-runner.service: the updater keeps polling git and can redeploy even
# when the main server is crash-looping on a bad commit, so pushing a fix
# self-heals the box. See agent-runner/self-update.sh for the full rationale.
#
# setup-agent-runner.sh calls this automatically. Run it standalone to (re)install
# just the updater, or to change the branch / interval:
#   SELF_UPDATE_INTERVAL=300 SELF_UPDATE_BRANCH=main bash setup-self-update.sh
#
# Env:
#   SELF_UPDATE_REPO_DIR   source checkout to pull       (default: this repo's root)
#   SELF_UPDATE_BRANCH     branch to track               (default: main)
#   SELF_UPDATE_DEST       install dir                   (default: ~/agent-runner)
#   SELF_UPDATE_SERVICE    service to restart on update  (default: agent-runner.service)
#   SELF_UPDATE_INTERVAL   seconds between checks         (default: 120)

set -euo pipefail

REPO_DIR="${SELF_UPDATE_REPO_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"
BRANCH="${SELF_UPDATE_BRANCH:-main}"
DEST="${SELF_UPDATE_DEST:-$HOME/agent-runner}"
SERVICE="${SELF_UPDATE_SERVICE:-agent-runner.service}"
INTERVAL="${SELF_UPDATE_INTERVAL:-120}"
DATA="${AGENT_RUNNER_DATA:-$HOME/agent-runner-data}"
ME="$(whoami)"

[ -d "$REPO_DIR/.git" ] || { echo "error: SELF_UPDATE_REPO_DIR '$REPO_DIR' is not a git checkout" >&2; exit 1; }

echo "==> Installing self-updater into $DEST"
mkdir -p "$DEST"
cp "$REPO_DIR/agent-runner/self-update.sh" "$DEST/self-update.sh"
chmod +x "$DEST/self-update.sh"

echo "==> systemd units (agent-selfupdate.service + .timer)"
sudo tee /etc/systemd/system/agent-selfupdate.service >/dev/null <<EOF
[Unit]
Description=Agent Runner self-updater (git pull + redeploy + restart)
# Intentionally independent of $SERVICE: this must run even when the main
# server is failing, so a fix commit can be pulled and deployed to recover it.

[Service]
Type=oneshot
User=$ME
Environment=SELF_UPDATE_REPO_DIR=$REPO_DIR
Environment=SELF_UPDATE_BRANCH=$BRANCH
Environment=SELF_UPDATE_DEST=$DEST
Environment=SELF_UPDATE_SERVICE=$SERVICE
Environment=AGENT_RUNNER_DATA=$DATA
ExecStart=/usr/bin/bash $DEST/self-update.sh
EOF

sudo tee /etc/systemd/system/agent-selfupdate.timer >/dev/null <<EOF
[Unit]
Description=Run agent self-updater every ${INTERVAL}s

[Timer]
OnBootSec=$INTERVAL
OnUnitActiveSec=$INTERVAL

[Install]
WantedBy=timers.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now agent-selfupdate.timer

echo
echo "================================================================"
echo " self-updater installed — checks $BRANCH every ${INTERVAL}s"
echo "   source checkout : $REPO_DIR"
echo "   deploys into    : $DEST"
echo "   restarts        : $SERVICE"
echo
echo " Merge + push to '$BRANCH' and within ${INTERVAL}s the box pulls,"
echo " redeploys, and restarts the server — self-updating from this repo."
echo
echo "   systemctl start agent-selfupdate.service    # force a check now"
echo "   systemctl list-timers agent-selfupdate.timer"
echo "   journalctl -u agent-selfupdate.service -f   # or tail $DATA/self-update.log"
echo "================================================================"
