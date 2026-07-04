#!/usr/bin/env bash
# setup-agent-runner.sh — install the control plane (run as the dev user, with sudo rights).
#
# Installs: ~/agent-runner (server + runners + poller), a token store (see
# tokens-cli.mjs — no single shared secret), systemd service for the API +
# 1-min timer for the GitHub issue poller.
#
# Usage:  bash setup-agent-runner.sh
# Then:   edit ~/agent-runner/.env to set REPOS="owner/repo1 owner/repo2"
#         mint a token per caller: node ~/agent-runner/tokens-cli.mjs add --name cowork --repos "*"

set -euo pipefail
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/agent-runner"
DEST="$HOME/agent-runner"
DATA="${AGENT_RUNNER_DATA:-$HOME/agent-runner-data}"
ME="$(whoami)"

command -v node >/dev/null || { echo "node not found — run provision.sh first"; exit 1; }
command -v jq >/dev/null || sudo apt-get install -y jq

echo "==> Installing to $DEST"
mkdir -p "$DEST"
cp -r "$SRC_DIR/." "$DEST/"
chmod +x "$DEST"/runners/*.sh "$DEST/issue-poller.sh" "$DEST/tokens-cli.mjs" "$DEST/set-env.mjs"

if [ ! -f "$DEST/.env" ]; then
  cat > "$DEST/.env" <<EOF
PORT=7777
# Where job repos live; POST /jobs "repo" is a bare name resolved under this dir.
REPOS_DIR=$HOME/repos
# Repos the issue poller watches (space-separated owner/repo). Empty = poller idle.
REPOS=
# Default runner for issue-queue jobs: claude | codex | opencode
RUNNER=claude
# Token the issue poller itself uses to call the local API (minted below).
AGENT_RUNNER_TOKEN=
EOF
fi
chmod 600 "$DEST/.env"

mkdir -p "$DATA"
MINTED=0
if [ ! -f "$DATA/tokens.json" ]; then
  echo "==> Minting tokens"
  POLLER_TOKEN=$(node "$DEST/tokens-cli.mjs" add --name issue-poller --repos '*' | tail -n1)
  ADMIN_TOKEN=$(node "$DEST/tokens-cli.mjs" add --name admin --repos '*' | tail -n1)
  sed -i "s|^AGENT_RUNNER_TOKEN=.*|AGENT_RUNNER_TOKEN=$POLLER_TOKEN|" "$DEST/.env"
  MINTED=1
fi

echo "==> systemd units"
sudo tee /etc/systemd/system/agent-runner.service >/dev/null <<EOF
[Unit]
Description=Agent Runner API
After=network.target

[Service]
User=$ME
EnvironmentFile=$DEST/.env
ExecStart=$(command -v node) $DEST/server.mjs
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF

sudo tee /etc/systemd/system/agent-issue-poller.service >/dev/null <<EOF
[Unit]
Description=Agent Runner GitHub issue poller

[Service]
Type=oneshot
User=$ME
EnvironmentFile=$DEST/.env
ExecStart=/usr/bin/bash $DEST/issue-poller.sh
EOF

sudo tee /etc/systemd/system/agent-issue-poller.timer >/dev/null <<EOF
[Unit]
Description=Run agent issue poller every minute

[Timer]
OnBootSec=60
OnUnitActiveSec=60

[Install]
WantedBy=timers.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now agent-runner.service agent-issue-poller.timer

# Self-updater: a SEPARATE systemd timer that git-pulls this repo and redeploys
# the control plane. Kept out of agent-runner.service on purpose so it can
# recover the box even when the server is crash-looping on a bad commit. Opt out
# with SELF_UPDATE=0.
if [ "${SELF_UPDATE:-1}" != "0" ]; then
  echo "==> Installing self-updater (separate systemd timer)"
  SELF_UPDATE_REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)" \
  SELF_UPDATE_DEST="$DEST" \
  AGENT_RUNNER_DATA="$DATA" \
    bash "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/setup-self-update.sh"
fi

echo
echo "================================================================"
echo " agent-runner is up on 127.0.0.1:7777"
echo
if [ "$MINTED" = "1" ]; then
  echo " Admin token (repos: *) — save this now, it will not be shown again:"
  echo " $ADMIN_TOKEN"
  echo
  echo " Mint one per caller instead of reusing this — each is independently"
  echo " revocable and can be scoped to specific repos:"
  echo "   node $DEST/tokens-cli.mjs add --name cowork --repos my-app,other-app"
  echo "   node $DEST/tokens-cli.mjs list"
  echo "   node $DEST/tokens-cli.mjs revoke --name cowork"
else
  echo " Tokens already exist — see: node $DEST/tokens-cli.mjs list"
fi
echo
echo " Try it (repo is a bare name resolved under \$REPOS_DIR):"
echo "   curl -H \"Authorization: Bearer <token>\" \\"
echo "        -X POST http://127.0.0.1:7777/jobs \\"
echo "        -d '{\"repo\":\"my-app\",\"goal\":\"add health endpoint\"}'"
echo
echo " 0->1 from nothing — creates the GitHub repo, then scaffolds + builds:"
echo "   curl -H \"Authorization: Bearer <token>\" \\"
echo "        -X POST http://127.0.0.1:7777/jobs \\"
echo "        -d '{\"repo\":\"new-app\",\"create\":true,\"goal\":\"a CLI that ...\"}'"
echo
echo " Issue queue: set REPOS in $DEST/.env, then issues labeled"
echo " 'agent-goal' in those repos are picked up within a minute."
echo
echo " Self-updating: this box now polls its own repo and redeploys on push."
echo " Merge a PR into main and it pulls + restarts within ~2 min."
echo "   systemctl start agent-selfupdate.service   # force a check now"
echo "   tail -f $DATA/self-update.log"
echo "================================================================"
