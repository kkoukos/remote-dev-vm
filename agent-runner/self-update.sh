#!/usr/bin/env bash
#
# self-update.sh — pull-based GitOps self-updater for the control plane.
#
# Runs as its OWN systemd oneshot + timer (agent-selfupdate.*), deliberately
# SEPARATE from agent-runner.service. That separation is the whole point: if a
# freshly-deployed commit crashes the main server, agent-runner.service just
# crash-loops (Restart=always) — but this updater keeps firing on its timer,
# independent of the server's health. Push a fix and the next cycle pulls it and
# restarts the server, so the box self-heals. A webhook receiver living inside
# the server could not do this: it would be down together with the server.
#
# Each run: fetch the source checkout, and if origin/<branch> is a fast-forward
# ahead of HEAD, pull it, redeploy the code into the install dir (preserving
# .env), restart the main service, and health-check it.
#
# Config (env; sensible defaults so it also works when run by hand). The systemd
# unit written by setup-self-update.sh bakes in the values detected at install:
#   SELF_UPDATE_REPO_DIR   source git checkout to pull      (default ~/remote-dev-vm)
#   SELF_UPDATE_BRANCH     branch to track                  (default main)
#   SELF_UPDATE_DEST       install dir to deploy into       (default ~/agent-runner)
#   SELF_UPDATE_SERVICE    systemd service to restart       (default agent-runner.service)
#   SELF_UPDATE_REMOTE     git remote to fetch              (default origin)
#   AGENT_RUNNER_DATA      where the log is written         (default ~/agent-runner-data)
#
# Manual use:  bash ~/agent-runner/self-update.sh            # one deploy cycle now
#              systemctl start agent-selfupdate.service      # same, via systemd
#
# The entire script is wrapped in a `{ ...; exit 0; }` group so bash parses it
# fully before executing anything. That makes the redeploy step — which may
# overwrite THIS file with a newer version from the repo — safe: the running
# shell never re-reads the file it is executing.
{
set -uo pipefail

REPO_DIR="${SELF_UPDATE_REPO_DIR:-$HOME/remote-dev-vm}"
BRANCH="${SELF_UPDATE_BRANCH:-main}"
DEST="${SELF_UPDATE_DEST:-$HOME/agent-runner}"
SERVICE="${SELF_UPDATE_SERVICE:-agent-runner.service}"
REMOTE="${SELF_UPDATE_REMOTE:-origin}"
DATA="${AGENT_RUNNER_DATA:-$HOME/agent-runner-data}"
LOG="$DATA/self-update.log"

mkdir -p "$DATA"

log() { printf '%s  %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" | tee -a "$LOG"; }
die() { log "ERROR: $*"; exit 1; }

# Only one updater at a time (manual run vs. timer, or a slow deploy overlapping
# the next tick). flock is best-effort — skip cleanly if it isn't available.
LOCK="$DATA/self-update.lock"
if command -v flock >/dev/null 2>&1; then
  exec 9>"$LOCK"
  flock -n 9 || { log "another self-update run holds the lock — skipping"; exit 0; }
fi

[ -d "$REPO_DIR/.git" ] || die "SELF_UPDATE_REPO_DIR '$REPO_DIR' is not a git checkout"
cd "$REPO_DIR" || die "cannot cd into '$REPO_DIR'"

# Never clobber uncommitted local work on the box — bail if the tree is dirty.
if ! git diff --quiet || ! git diff --cached --quiet; then
  die "working tree at '$REPO_DIR' has uncommitted changes — refusing to update"
fi

log "fetching $REMOTE/$BRANCH in $REPO_DIR"
git fetch --quiet "$REMOTE" "$BRANCH" || die "git fetch failed"

LOCAL="$(git rev-parse HEAD)"
REMOTE_REF="$(git rev-parse "$REMOTE/$BRANCH")" || die "cannot resolve $REMOTE/$BRANCH"

if [ "$LOCAL" = "$REMOTE_REF" ]; then
  log "already up to date at ${LOCAL:0:12} — nothing to deploy"
  exit 0
fi

# Fast-forward only. If HEAD isn't an ancestor of the remote tip, the checkout
# has diverged (or is ahead) — don't rewrite history or force anything, just
# report and wait for a clean forward move.
if ! git merge-base --is-ancestor "$LOCAL" "$REMOTE_REF"; then
  die "local ${LOCAL:0:12} is not behind $REMOTE/$BRANCH (${REMOTE_REF:0:12}) — not a fast-forward, skipping"
fi

log "updating ${LOCAL:0:12} -> ${REMOTE_REF:0:12} on $BRANCH"
git checkout --quiet "$BRANCH" || die "cannot checkout $BRANCH"
git merge --ff-only --quiet "$REMOTE_REF" || die "fast-forward merge failed"

# Redeploy the code into the install dir. cp -r overlays files (including this
# very script — safe, see the brace-group note above) without touching .env,
# which lives only in the install dir, or the data dir, which is elsewhere.
log "deploying $REPO_DIR/agent-runner -> $DEST"
mkdir -p "$DEST"
cp -r "$REPO_DIR/agent-runner/." "$DEST/" || die "deploy copy failed"
chmod +x "$DEST"/runners/*.sh "$DEST/issue-poller.sh" "$DEST/tokens-cli.mjs" \
         "$DEST/set-env.mjs" "$DEST/self-update.sh" 2>/dev/null || true

log "restarting $SERVICE"
if ! sudo systemctl restart "$SERVICE"; then
  log "ERROR: failed to restart $SERVICE — new code is deployed but the service did not restart"
  exit 1
fi

# Health-check the restarted server. A failure here is expected and survivable:
# the new commit may have broken the server. We log loudly but do NOT roll back —
# rolling back would move HEAD behind the remote again and the next tick would
# just re-pull and re-crash on the same bad commit. Instead the server stays
# crash-looping while THIS updater keeps running; push a fix and the next cycle
# deploys it. That is exactly the self-heal loop this design buys.
PORT="$( { grep -E '^PORT=' "$DEST/.env" 2>/dev/null || true; } | tail -n1 | cut -d= -f2)"
PORT="${PORT:-7777}"
HEALTH_URL="http://127.0.0.1:${PORT}/health"
healthy=""
for _ in 1 2 3 4 5 6 7 8 9 10; do
  if curl -fsS --max-time 3 "$HEALTH_URL" >/dev/null 2>&1; then healthy=1; break; fi
  sleep 2
done

if [ -n "$healthy" ]; then
  log "deployed ${REMOTE_REF:0:12} — $SERVICE healthy at $HEALTH_URL"
  exit 0
fi

log "WARNING: deployed ${REMOTE_REF:0:12} but $SERVICE is NOT healthy at $HEALTH_URL"
log "WARNING: the new commit may have broken the server; push a fix and the next self-update cycle will deploy it"
exit 1
}
