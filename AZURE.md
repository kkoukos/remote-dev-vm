# Deploy to an Azure VM

This gets you the **full setup** — control plane + code-server + VS Code Remote
Tunnel + SSH — same as the generic "fresh Ubuntu VPS" path in the
[README](README.md), just on an Azure VM instead of DigitalOcean/Hetzner/etc.
Unlike [Railway](DEPLOY_RAILWAY.md) (control plane only, no VS Code access), a
real VM has systemd + sudo, so `setup-tunnel.sh` works here.

## 1. Prereqs

- An Azure subscription and the CLI: `brew install azure-cli && az login`.
- An SSH keypair (`~/.ssh/id_ed25519` — `ssh-keygen -t ed25519` if you don't have one).

## 2. Create the VM

```bash
RG=remote-dev-vm-rg
LOCATION=eastus
VM=remote-dev-vm

az group create --name $RG --location $LOCATION

az vm create \
  --resource-group $RG \
  --name $VM \
  --image Canonical:ubuntu-24_04-lts:server:latest \
  --size Standard_B2s \
  --admin-username dev \
  --ssh-key-values ~/.ssh/id_ed25519.pub \
  --public-ip-sku Standard \
  --os-disk-size-gb 64
```

- `Standard_B2s` (2 vCPU / 4GB) is enough for code-server + a couple concurrent
  jobs. Bump to `Standard_B4ms` (4 vCPU / 16GB) if you'll run
  `MAX_CONCURRENT_PER_TOKEN` above 2.
- `--public-ip-sku Standard` gives a **static** public IP — matters if you'll
  point a domain at it (Basic SKU IPs are dynamic and can change on restart).
- `--admin-username dev` matches `provision.sh`'s default `DEV_USER` — see the
  note in step 4 about why that's worth keeping.

Get the public IP once it's up:

```bash
IP=$(az vm show -d --resource-group $RG --name $VM --query publicIps -o tsv)
echo $IP
```

## 3. Networking — two firewalls, not one

Azure sits an NSG (network-level firewall) in front of the VM; `provision.sh`
also configures `ufw` (host-level firewall) inside it. **Both** have to allow a
port or it's blocked. Port 22 is open on the NSG by default from `az vm
create`; if you're setting `DOMAIN` (HTTPS via Caddy) in step 4, also open 80/443
on the NSG — `provision.sh` handles the `ufw` side itself:

```bash
az vm open-port --resource-group $RG --name $VM --port 80 --priority 1010
az vm open-port --resource-group $RG --name $VM --port 443 --priority 1020
```

If using a domain, point its DNS `A` record at `$IP` now (propagation takes a
few minutes, and Caddy needs it resolvable to issue a cert in step 4).

## 4. Provision

Azure doesn't allow direct root SSH login (unlike some VPS providers) — you get
a sudo-enabled admin user instead. Clone the repo on the VM and run
`provision.sh` via `sudo`:

```bash
ssh dev@$IP
git clone https://github.com/kkoukos/remote-dev-vm
cd remote-dev-vm
sudo bash -c 'DOMAIN=code.example.com bash provision.sh'   # DOMAIN optional
```

Since `--admin-username dev` already exists with your SSH key and passwordless
sudo (Azure's cloud-init sets this up), `provision.sh`'s "create dev user" step
is a harmless no-op — everything else (packages, code-server, Claude Code, ufw,
Caddy) runs as normal.

Then, as `dev`:

```bash
claude                    # or: claude setup-token → export CLAUDE_CODE_OAUTH_TOKEN=...
gh auth login && gh auth setup-git
git config --global user.name "Kostas" && git config --global user.email kostas@domicode.gr

mkdir -p ~/.claude/skills/goal ~/.claude/skills/bootstrap
cp ~/remote-dev-vm/skills/goal/SKILL.md ~/.claude/skills/goal/
cp ~/remote-dev-vm/skills/bootstrap/SKILL.md ~/.claude/skills/bootstrap/

cd ~/remote-dev-vm
bash setup-agent-runner.sh      # prints an admin token
bash setup-tunnel.sh            # GitHub device-flow login
```

## 5. Connect

- **VS Code**: Remote Explorer → Tunnels → `remote-dev-vm` (or whatever
  `TUNNEL_NAME` you set) — full marketplace, Live Share works from here.
- **Browser**: `https://code.example.com` if `DOMAIN` was set, otherwise
  `ssh -L 8080:127.0.0.1:8080 dev@$IP` then `http://localhost:8080`.
- **Agent API**: still `127.0.0.1:7777` on the box. To expose it externally,
  add to `/etc/caddy/Caddyfile` (needs `DOMAIN` set) and `sudo systemctl reload
caddy`:
  ```
  handle_path /agent/* {
      reverse_proxy 127.0.0.1:7777
  }
  ```
  No domain? `ssh -L 7777:127.0.0.1:7777 dev@$IP` instead.

## 6. From your laptop — vm-cli.mjs

```bash
./vm-cli.mjs connect dev@$IP --name azure
./vm-cli.mjs tokens add --name cowork --repos my-app,other-app
./vm-cli.mjs status
```

## Notes & costs

- **Stopping the VM** (`az vm deallocate`) stops compute billing but takes
  code-server, the tunnel, and the agent API offline until you `az vm start`
  it again. The Standard static IP keeps a small hourly charge even while
  deallocated — switch to Basic/dynamic if you don't need a stable IP and
  aren't using `DOMAIN`.
- **Disk**: repos + `node_modules` + build tools add up — 64GB leaves headroom
  over the 30GB default; resize later with `az disk update` if you outgrow it.
- Same safety notes as the main README apply: `provision.sh` gives `dev`
  passwordless sudo, and jobs run `--permission-mode dontAsk` — see
  "Safety & cost" there before pointing this at untrusted goals.
