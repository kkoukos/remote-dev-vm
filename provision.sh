#!/usr/bin/env bash
#
# provision.sh — turn a fresh Ubuntu 24.04 VPS into a 24/7 Claude Code dev box.
#
# What it installs:
#   - dev user (sudo) with your SSH keys
#   - git, tmux, build tools, Node.js 22, GitHub CLI (gh)
#   - code-server (VS Code in the browser) as a systemd service
#   - Claude Code (native installer)
#   - Caddy reverse proxy with automatic HTTPS (only if DOMAIN is set)
#
# Usage (as root on the fresh VPS):
#   DEV_USER=dev DOMAIN=code.example.com bash provision.sh
#
# Env vars (all optional):
#   DEV_USER              linux user to create           (default: dev)
#   DOMAIN                domain pointed at this VPS -> enables HTTPS via Caddy
#   CODE_SERVER_PASSWORD  browser login password         (default: generated)

set -euo pipefail

DEV_USER="${DEV_USER:-dev}"
DOMAIN="${DOMAIN:-}"
CODE_SERVER_PASSWORD="${CODE_SERVER_PASSWORD:-$(head -c 32 /dev/urandom | base64 | tr -dc 'a-zA-Z0-9' | head -c 24)}"

[ "$(id -u)" -eq 0 ] || { echo "Run as root."; exit 1; }

echo "==> Base packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y git tmux curl wget unzip build-essential ca-certificates gnupg ufw

echo "==> GitHub CLI"
mkdir -p /etc/apt/keyrings
wget -qO- https://cli.github.com/packages/githubcli-archive-keyring.gpg > /etc/apt/keyrings/githubcli-archive-keyring.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
  > /etc/apt/sources.list.d/github-cli.list
apt-get update -y && apt-get install -y gh

echo "==> Node.js 22"
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt-get install -y nodejs

echo "==> User: $DEV_USER"
if ! id "$DEV_USER" &>/dev/null; then
  adduser --disabled-password --gecos "" "$DEV_USER"
  usermod -aG sudo "$DEV_USER"
  echo "$DEV_USER ALL=(ALL) NOPASSWD:ALL" > "/etc/sudoers.d/$DEV_USER"
fi
# Reuse root's SSH keys so you can `ssh dev@vps`
if [ -f /root/.ssh/authorized_keys ]; then
  mkdir -p "/home/$DEV_USER/.ssh"
  cp /root/.ssh/authorized_keys "/home/$DEV_USER/.ssh/"
  chown -R "$DEV_USER:$DEV_USER" "/home/$DEV_USER/.ssh"
  chmod 700 "/home/$DEV_USER/.ssh" && chmod 600 "/home/$DEV_USER/.ssh/authorized_keys"
fi

echo "==> code-server"
curl -fsSL https://code-server.dev/install.sh | sh
mkdir -p "/home/$DEV_USER/.config/code-server"
cat > "/home/$DEV_USER/.config/code-server/config.yaml" <<EOF
bind-addr: 127.0.0.1:8080
auth: password
password: $CODE_SERVER_PASSWORD
cert: false
EOF
chown -R "$DEV_USER:$DEV_USER" "/home/$DEV_USER/.config"
systemctl enable --now "code-server@$DEV_USER"

echo "==> Claude Code (native installer)"
su - "$DEV_USER" -c 'curl -fsSL https://claude.ai/install.sh | bash'

echo "==> Firewall (ufw)"
ufw allow OpenSSH
if [ -n "$DOMAIN" ]; then
  echo "==> Caddy (HTTPS for $DOMAIN)"
  apt-get install -y debian-keyring debian-archive-keyring apt-transport-https
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /etc/apt/keyrings/caddy.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy.list
  sed -i 's|signed-by=[^]]*|signed-by=/etc/apt/keyrings/caddy.gpg|' /etc/apt/sources.list.d/caddy.list
  apt-get update -y && apt-get install -y caddy
  cat > /etc/caddy/Caddyfile <<EOF
$DOMAIN {
    reverse_proxy 127.0.0.1:8080
}
EOF
  systemctl reload caddy
  ufw allow 80/tcp && ufw allow 443/tcp
fi
ufw --force enable

echo
echo "================================================================"
echo " DONE. Next steps (as $DEV_USER):"
echo
echo "  1. ssh $DEV_USER@<vps-ip>"
echo "  2. claude            # log in interactively once, OR:"
echo "     claude setup-token   # 1-year token; add to ~/.bashrc as"
echo "     export CLAUDE_CODE_OAUTH_TOKEN=<token>"
echo "  3. gh auth login     # GitHub auth (pick HTTPS + browser)"
echo "  4. git clone your repo, copy the goal skill in (see README)"
echo
if [ -n "$DOMAIN" ]; then
  echo "  VS Code in browser:  https://$DOMAIN"
else
  echo "  VS Code in browser (no domain set — use an SSH tunnel):"
  echo "    ssh -L 8080:127.0.0.1:8080 $DEV_USER@<vps-ip>"
  echo "    then open http://localhost:8080"
fi
echo "  code-server password: $CODE_SERVER_PASSWORD"
echo "================================================================"
