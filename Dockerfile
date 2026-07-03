# agent-runner on a PaaS (Railway etc.) — see DEPLOY_RAILWAY.md.
# Control plane + runners only: no code-server / tunnels / sudo here.
FROM node:22-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
      git curl ca-certificates jq \
 && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
      -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
 && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
      > /etc/apt/sources.list.d/github-cli.list \
 && apt-get update && apt-get install -y --no-install-recommends gh \
 && rm -rf /var/lib/apt/lists/*

RUN npm install -g @anthropic-ai/claude-code

WORKDIR /app
COPY agent-runner/ ./agent-runner/
COPY skills/ ./skills/
RUN mkdir -p /root/.claude/skills \
 && cp -r skills/goal skills/bootstrap /root/.claude/skills/

# /data is the mounted volume: tokens, job logs, audit log, cloned repos
ENV HOST=0.0.0.0 \
    AGENT_RUNNER_DATA=/data/agent-runner-data \
    REPOS_DIR=/data/repos

# gh auth setup-git routes git clone/push over HTTPS through GH_TOKEN.
# The issue-poller loop only starts once REPOS + AGENT_RUNNER_TOKEN are set
# (mint the token first — see DEPLOY_RAILWAY.md step 5).
CMD if [ -n "$GH_TOKEN" ]; then gh auth setup-git >/dev/null 2>&1 || true; fi; \
    git config --global user.name  "${GIT_USER_NAME:-agent-runner}"; \
    git config --global user.email "${GIT_USER_EMAIL:-agent-runner@localhost}"; \
    mkdir -p "$REPOS_DIR"; \
    if [ -n "$REPOS" ] && [ -n "$AGENT_RUNNER_TOKEN" ]; then \
      (while true; do bash /app/agent-runner/issue-poller.sh || true; sleep 60; done) & \
    fi; \
    exec node /app/agent-runner/server.mjs
