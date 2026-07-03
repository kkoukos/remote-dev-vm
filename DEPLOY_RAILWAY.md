# Deploy to Railway

Runs the **agent-runner control plane + job runners** in one Railway container, with all
state on a volume. You get `https://<app>.up.railway.app/jobs` instead of a VPS — no
provisioning, no Caddy, no systemd.

What you *don't* get vs. the VPS setup: code-server, VS Code tunnels, SSH access to a
full dev box, and `run-goal.sh`/tmux. This is the HTTP API + GitHub issue queue only.
For the full experience, use `provision.sh` on Ubuntu (see [README](README.md)).

## 1. Prereqs

- A Railway account, and either the dashboard or the CLI
  (`npm i -g @railway/cli && railway login`).
- **`CLAUDE_CODE_OAUTH_TOKEN`** — on your laptop, run `claude setup-token` and copy it.
- **`GH_TOKEN`** — a GitHub PAT. Prefer a fine-grained token scoped to *only* the repos
  jobs will touch, with Contents + Pull requests (+ Issues if you'll use the issue
  queue) read/write. Jobs run unattended with this token — scope it tight.

## 2. Deploy

The repo ships a [Dockerfile](Dockerfile) — Railway picks it up automatically.

- **Dashboard:** New Project → Deploy from GitHub repo → select this repo.
- **CLI:** from the repo root: `railway init && railway up`.

The first deploy will boot but is useless until steps 3–4 are done.

## 3. Attach a volume at `/data`

Everything stateful lives under `/data` (the Dockerfile sets
`AGENT_RUNNER_DATA=/data/agent-runner-data` and `REPOS_DIR=/data/repos`): token store,
job logs, audit log, cloned repos. **Without a volume, every redeploy wipes your tokens
and repos.**

- **Dashboard:** right-click the service → Attach Volume → mount path `/data`.
- **CLI:** `railway volume add --mount-path /data`.

## 4. Variables

Service → Variables:

| Variable | Required | Value |
|---|---|---|
| `CLAUDE_CODE_OAUTH_TOKEN` | yes | from `claude setup-token` |
| `GH_TOKEN` | yes | the PAT from step 1 |
| `GIT_USER_NAME` / `GIT_USER_EMAIL` | recommended | commit identity for job commits |
| `MAX_CONCURRENT_PER_TOKEN` | no | default 5 — consider lowering (see Notes) |
| `REPOS` + `AGENT_RUNNER_TOKEN` | no | only for the issue queue, step 6 |

`HOST=0.0.0.0`, `AGENT_RUNNER_DATA`, and `REPOS_DIR` are baked into the Dockerfile.
`PORT` is injected by Railway; the server reads it (falls back to 7777).

## 5. Expose it and mint a token

Generate a domain: service → Settings → Networking → Generate Domain (pick the port the
deploy logs show it listening on). Optionally set the health check path to `/health`
(unauthenticated liveness endpoint).

Then mint your admin token inside the running container:

```bash
railway ssh
node /app/agent-runner/tokens-cli.mjs add --name admin --repos '*'
```

Copy the plaintext — it's shown once. Tokens are re-read on every request, so no
restart is needed. Mint one scoped token per caller as usual (`--repos "my-app"`).

Smoke test:

```bash
curl https://<app>.up.railway.app/health
curl -H "Authorization: Bearer $TOKEN" -X POST https://<app>.up.railway.app/jobs \
  -d '{"repo":"my-app","gitUrl":"https://github.com/you/my-app.git","goal":"add a /ping endpoint"}'
```

**Path note:** there is no `/agent` prefix here — that was the Caddy route on the VPS.
On Railway the API is at the root: `/jobs`, `/jobs/:id`, `/jobs/:id/log`, `/health`.
Use HTTPS `gitUrl`s (the container has no SSH keys; git auth goes through `GH_TOKEN`).

## 6. Optional: GitHub issue queue

Set two more variables and redeploy:

- `REPOS` — space-separated `owner/repo` list to watch (e.g. `you/app1 you/app2`)
- `AGENT_RUNNER_TOKEN` — a token you minted in step 5 (mint a dedicated one:
  `tokens-cli.mjs add --name issue-poller --repos '*'`)

The container's start command then runs `issue-poller.sh` in a 60-second loop alongside
the server. Issues labeled `agent-goal` on those repos become jobs, same as on the VPS.

## Notes & limits

- **A redeploy restarts the container and kills in-flight jobs** — their status can be
  left stale as `running`. Deploy config changes when the queue is idle.
- **Size it for jobs, not the server.** The server is tiny, but each job is a full
  headless Claude Code session (plus git/gh subprocesses). Give the service a few GB of
  RAM and keep `MAX_CONCURRENT_PER_TOKEN` low (1–2) on small instances.
- **Containment:** jobs run `--permission-mode dontAsk`. On Railway the blast radius is
  the container plus whatever `GH_TOKEN` and `CLAUDE_CODE_OAUTH_TOKEN` can reach — no
  sudo, no host — which is tighter than the VPS default, but the PAT scope *is* the
  security boundary. Don't hand it `repo`-wide classic-PAT access you don't need.
- **Billing:** headless `claude -p` bills the Agent SDK credit pool (Pro/Max, since
  June 2026), separate from Railway's compute charges.
- `vm-cli.mjs` is SSH-based and doesn't apply here — use `railway ssh` +
  `tokens-cli.mjs` directly, and Railway variables instead of `configure`.
