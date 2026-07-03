#!/usr/bin/env bash
# setup-tunnel.sh — VS Code Remote Tunnel (run as the dev user).
#
# Lets your LOCAL VS Code attach to this VM (Remote Explorer → Tunnels), with the
# full MS marketplace — including Live Share. Also reachable at vscode.dev from
# any browser. This is the path to Live Share; code-server can't run it.

set -euo pipefail

case "$(uname -m)" in
  x86_64)  OS_ID="cli-alpine-x64" ;;
  aarch64) OS_ID="cli-alpine-arm64" ;;
  *) echo "unsupported arch: $(uname -m)"; exit 1 ;;
esac

if ! command -v code >/dev/null; then
  echo "==> Installing VS Code CLI"
  curl -fsSL "https://code.visualstudio.com/sha/download?build=stable&os=$OS_ID" -o /tmp/vscode_cli.tar.gz
  sudo tar -xzf /tmp/vscode_cli.tar.gz -C /usr/local/bin code
  rm /tmp/vscode_cli.tar.gz
fi

echo "==> Log in (GitHub device flow — follow the printed URL)"
code tunnel user login --provider github

echo "==> Installing tunnel as a service (survives reboots)"
sudo loginctl enable-linger "$(whoami)"   # keep user services running when logged out
code tunnel service install --accept-server-license-terms --name "${TUNNEL_NAME:-claude-vm}"

echo
echo "================================================================"
echo " Tunnel up. Connect from your laptop:"
echo "   VS Code → Remote Explorer → Tunnels → ${TUNNEL_NAME:-claude-vm}"
echo "   or browser: https://vscode.dev/tunnel/${TUNNEL_NAME:-claude-vm}"
echo
echo " Live Share: once attached from local VS Code, install the"
echo " Live Share extension and start a session from that window —"
echo " it's hosted on the VM, so it keeps running."
echo "================================================================"
