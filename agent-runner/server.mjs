#!/usr/bin/env node
// agent-runner — tiny zero-dependency job server.
// Accepts plans/goals over HTTP, executes them with a pluggable runner
// (claude, codex, opencode, ...), tracks status + logs.
//
// Env: AGENT_RUNNER_DATA (~/agent-runner-data), PORT (7777), HOST (127.0.0.1), REPOS_DIR (~/repos)
//
// Auth: named, per-caller bearer tokens (see tokens-cli.mjs), each scoped to a
// set of repo names ("*" for all). There is no single shared secret — mint one
// token per caller (Cowork, phone, CI, the issue poller) so any of them can be
// revoked individually without rotating the rest.
//
// API (all require: Authorization: Bearer <token>):
//   POST /jobs   {"repo": "my-app", "goal": "...", "runner": "claude",
//                 "gitUrl": "...", "create": false, "visibility": "private",
//                 "owner": "", "model": "", "effort": ""}
//                repo is a BARE NAME (no slashes/paths) resolved under REPOS_DIR —
//                this keeps a job from ever targeting an arbitrary filesystem path.
//                goal can be a one-liner or a full multi-line plan (markdown).
//                gitUrl (optional): clone if repo dir doesn't exist.
//                create (optional): if the repo dir doesn't exist, run
//                  `gh repo create` instead of cloning — 0->1, brand-new product.
//                  Mutually exclusive with gitUrl. visibility/owner apply here.
//                model/effort (optional): passed through to the runner
//                  (e.g. claude.sh forwards them as `--model` / `--effort`).
//   GET  /jobs                 recent jobs visible to this token
//   GET  /jobs/:id             status, prUrl (if found in log), log tail
//   GET  /jobs/:id/log         full log (text)
//   POST /jobs/:id/cancel      SIGTERM the job's process group
//   GET  /health               no auth, liveness
//
// A token only sees/controls jobs against repos it's scoped for. Every job
// start/cancel and every rejected auth attempt is appended to audit.log.

import http from "node:http";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { loadTokens, findToken, canAccessRepo } from "./lib/tokens.mjs";

const PORT = Number(process.env.PORT || 7777);
const DATA = process.env.AGENT_RUNNER_DATA || path.join(os.homedir(), "agent-runner-data");
const RUNNERS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "runners");
const JOBS_DIR = path.join(DATA, "jobs");
const TOKENS_FILE = path.join(DATA, "tokens.json");
const AUDIT_FILE = path.join(DATA, "audit.log");
const MAX_CONCURRENT_PER_TOKEN = Number(process.env.MAX_CONCURRENT_PER_TOKEN || 5);

fs.mkdirSync(JOBS_DIR, { recursive: true });

const expand = (p) => (p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : p);
const REPOS_DIR = expand(process.env.REPOS_DIR || "~/repos");

const metaPath = (id) => path.join(JOBS_DIR, id, "meta.json");
const readMeta = (id) => JSON.parse(fs.readFileSync(metaPath(id), "utf8"));
const writeMeta = (id, meta) => fs.writeFileSync(metaPath(id), JSON.stringify(meta, null, 2));

function audit(entry) {
  try {
    fs.appendFileSync(AUDIT_FILE, JSON.stringify({ time: new Date().toISOString(), ...entry }) + "\n", { mode: 0o600 });
  } catch {}
}

function findPrUrl(id) {
  try {
    const log = fs.readFileSync(path.join(JOBS_DIR, id, "job.log"), "utf8");
    const m = log.match(/https:\/\/github\.com\/[^\s"'`)\]]+\/pull\/\d+/g);
    return m ? m[m.length - 1] : null;
  } catch {
    return null;
  }
}

function allJobs() {
  return fs
    .readdirSync(JOBS_DIR)
    .filter((d) => fs.existsSync(metaPath(d)))
    .map(readMeta);
}

function repoBusy(repoName) {
  return allJobs().some((m) => m.status === "running" && m.repoName === repoName);
}

function countRunning(tokenName) {
  return allJobs().filter((m) => m.status === "running" && m.tokenName === tokenName).length;
}

function startJob(body, identity) {
  const { repo, goal, runner = "claude", gitUrl, create, visibility = "private", owner, model, effort } = body || {};
  if (!repo || !goal) throw new Error("repo and goal are required");
  if (!/^[a-z0-9-]+$/.test(runner)) throw new Error("invalid runner name");
  const runnerScript = path.join(RUNNERS_DIR, `${runner}.sh`);
  if (!fs.existsSync(runnerScript)) throw new Error(`unknown runner: ${runner}`);

  // repo must be a bare name — no "/", no "..", no absolute paths — so a job
  // can never be pointed at a directory outside REPOS_DIR.
  if (!/^[a-zA-Z0-9._-]+$/.test(repo)) throw new Error("repo must be a bare name (letters, digits, . _ -), not a path");
  if (!canAccessRepo(identity, repo)) throw new Error(`token "${identity.name}" is not scoped for repo "${repo}"`);
  if (create && gitUrl) throw new Error("pass either create or gitUrl, not both");
  if (owner && !/^[a-zA-Z0-9-]+$/.test(owner)) throw new Error("invalid owner");
  const visFlag = { private: "--private", public: "--public", internal: "--internal" }[visibility];
  if (!visFlag) throw new Error('visibility must be "private", "public", or "internal"');

  if (repoBusy(repo)) throw new Error(`repo "${repo}" already has a job running — wait for it to finish`);
  if (countRunning(identity.name) >= MAX_CONCURRENT_PER_TOKEN) {
    throw new Error(`token "${identity.name}" already has ${MAX_CONCURRENT_PER_TOKEN} jobs running`);
  }

  const repoDir = path.join(REPOS_DIR, repo);
  const id = `${new Date().toISOString().replace(/[:.]/g, "-")}-${crypto.randomBytes(3).toString("hex")}`;
  const dir = path.join(JOBS_DIR, id);
  fs.mkdirSync(dir, { recursive: true });
  const promptFile = path.join(dir, "prompt.md");
  const logFile = path.join(dir, "job.log");
  fs.writeFileSync(promptFile, goal);
  const logFd = fs.openSync(logFile, "a");

  // If the repo dir doesn't exist: `create` makes a brand-new GitHub repo
  // (0->1), otherwise `gitUrl` clones an existing one. Either way FRESH=1 iff
  // we just created it, so the runner can pick a "scaffold from nothing" vs.
  // "add a feature" skill. All inputs travel via env vars, never string-
  // interpolated into the script, so job fields can't break out into shell.
  const script = `
set -e
if [ ! -d "$REPO" ]; then
  if [ "$CREATE" = "1" ]; then
    mkdir -p "$REPOS_DIR" && cd "$REPOS_DIR"
    FULLNAME="$REPO_NAME"
    [ -n "$GH_OWNER" ] && FULLNAME="$GH_OWNER/$REPO_NAME"
    gh repo create "$FULLNAME" "$VIS_FLAG" --clone || exit 1
  elif [ -n "$GIT_URL" ]; then
    git clone "$GIT_URL" "$REPO" || exit 1
  else
    echo "repo does not exist; pass gitUrl to clone or create:true to create it" >&2
    exit 1
  fi
  export FRESH=1
else
  export FRESH=0
fi
cd "$REPO" && exec "$RUNNER" "$REPO" "$PROMPT_FILE"
`;

  const child = spawn("bash", ["-lc", script], {
    detached: true,
    stdio: ["ignore", logFd, logFd],
    env: {
      ...process.env,
      REPO: repoDir,
      REPOS_DIR,
      REPO_NAME: repo,
      GIT_URL: gitUrl || "",
      CREATE: create ? "1" : "",
      GH_OWNER: owner || "",
      VIS_FLAG: visFlag,
      RUNNER: runnerScript,
      PROMPT_FILE: promptFile,
      MODEL: model || "",
      EFFORT: effort || "",
    },
  });
  fs.closeSync(logFd);

  const meta = {
    id,
    repo: repoDir,
    repoName: repo,
    runner,
    tokenName: identity.name,
    status: "running",
    pid: child.pid,
    createdAt: new Date().toISOString(),
    goalPreview: goal.split("\n")[0].slice(0, 120),
  };
  writeMeta(id, meta);
  audit({ action: "job.start", id, repo, runner, tokenName: identity.name, model: model || null, effort: effort || null, create: !!create });

  child.on("exit", (code, signal) => {
    const m = readMeta(id);
    m.status = code === 0 ? "done" : "failed";
    m.exitCode = code;
    m.signal = signal;
    m.endedAt = new Date().toISOString();
    writeMeta(id, m);
  });
  child.unref();
  return meta;
}

function listJobs(identity) {
  return allJobs()
    .filter((m) => canAccessRepo(identity, m.repoName))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, 50);
}

const json = (res, code, obj) => {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(obj, null, 2));
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  if (req.method === "GET" && url.pathname === "/health") return json(res, 200, { ok: true });

  const tokens = loadTokens(TOKENS_FILE);
  const bearer = (req.headers.authorization || "").replace(/^Bearer /, "");
  const identity = findToken(tokens, bearer);
  if (!identity) {
    audit({ action: "auth.reject", path: url.pathname, ip: req.socket.remoteAddress });
    return json(res, 401, { error: "unauthorized" });
  }

  try {
    if (req.method === "POST" && url.pathname === "/jobs") {
      let body = "";
      for await (const chunk of req) {
        body += chunk;
        if (body.length > 1e6) throw new Error("body too large");
      }
      return json(res, 201, startJob(JSON.parse(body), identity));
    }

    if (req.method === "GET" && url.pathname === "/jobs") return json(res, 200, listJobs(identity));

    const m = url.pathname.match(/^\/jobs\/([^/]+)(\/log|\/cancel)?$/);
    if (m) {
      const [, id, sub] = m;
      if (!fs.existsSync(metaPath(id))) return json(res, 404, { error: "not found" });
      // Repo-scoped tokens can't see or touch jobs outside their scope — 404,
      // not 403, so scope also hides whether the job exists at all.
      if (!canAccessRepo(identity, readMeta(id).repoName)) return json(res, 404, { error: "not found" });
      const logFile = path.join(JOBS_DIR, id, "job.log");

      if (req.method === "GET" && !sub) {
        const meta = readMeta(id);
        meta.prUrl = findPrUrl(id);
        try {
          meta.logTail = fs.readFileSync(logFile, "utf8").split("\n").slice(-30).join("\n");
        } catch {}
        return json(res, 200, meta);
      }
      if (req.method === "GET" && sub === "/log") {
        res.writeHead(200, { "content-type": "text/plain" });
        return fs.createReadStream(logFile).pipe(res);
      }
      if (req.method === "POST" && sub === "/cancel") {
        const meta = readMeta(id);
        if (meta.status === "running" && meta.pid) {
          try {
            process.kill(-meta.pid, "SIGTERM"); // whole process group
          } catch {}
          meta.status = "cancelled";
          meta.endedAt = new Date().toISOString();
          writeMeta(id, meta);
          audit({ action: "job.cancel", id, tokenName: identity.name });
        }
        return json(res, 200, meta);
      }
    }
    return json(res, 404, { error: "not found" });
  } catch (e) {
    return json(res, 400, { error: e.message });
  }
});

const HOST = process.env.HOST || "127.0.0.1"; // 0.0.0.0 for PaaS (Railway etc.) where a proxy fronts the container
server.listen(PORT, HOST, () => console.log(`agent-runner listening on ${HOST}:${PORT}`));
