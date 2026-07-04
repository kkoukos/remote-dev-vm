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
//                 "owner": "", "model": "", "effort": "",
//                 "branch": "", "baseBranch": "", "planId": ""}
//                repo is a BARE NAME (no slashes/paths) resolved under REPOS_DIR —
//                this keeps a job from ever targeting an arbitrary filesystem path.
//                goal can be a one-liner or a full multi-line plan (markdown).
//                gitUrl (optional): clone if repo dir doesn't exist.
//                create (optional): if the repo dir doesn't exist, run
//                  `gh repo create` instead of cloning — 0->1, brand-new product.
//                  Mutually exclusive with gitUrl. visibility/owner apply here.
//                model/effort (optional): passed through to the runner
//                  (e.g. claude.sh forwards them as `--model` / `--effort`).
//                branch (optional): switches this job into worktree-isolated
//                  mode — a fresh git worktree is created at
//                  REPOS_DIR/.worktrees/<repo>/<branch> on a new branch, so
//                  this job runs alongside others on the same repo instead of
//                  being serialized behind them. Requires the repo to already
//                  exist on this VM (mutually exclusive with create/gitUrl —
//                  the very first job against a brand-new repo is always a
//                  plain job). baseBranch (optional, only with branch): ref to
//                  branch from — defaults to the repo's default branch.
//                planId (optional): free-form label recorded on the job,
//                  used by /plans to group the jobs it dispatches.
//   GET  /jobs                 recent jobs visible to this token
//   GET  /jobs/:id             status, prUrl (if found in log), log tail
//   GET  /jobs/:id/log         full log (text)
//   POST /jobs/:id/cancel      SIGTERM the job's process group
//   POST /plans  {"repo": "my-app", "planId": "", "subplans": [
//                  {"slug": "a", "goal": "...", "dependsOn": null},
//                  {"slug": "b", "goal": "...", "dependsOn": "a"}]}
//                Each subplan accepts the same optional per-job fields as
//                POST /jobs (runner/model/effort/visibility/owner, plus
//                gitUrl/create on at most one subplan) — everything except
//                repo/branch/baseBranch/planId, which the plan controls.
//                Registers a TREE of subplans — each depends on at most one
//                other slug (a forest, not a general DAG: a stacked branch
//                can only have one base, so a subplan needing two parents'
//                work must be expressed as a chain, not a multi-parent edge).
//                If the repo doesn't exist yet, exactly one subplan must set
//                create/gitUrl, and every other subplan implicitly depends on
//                it (rewritten server-side if not already declared).
//                Dispatches whichever subplans are immediately ready (no
//                unmet dependency) as part of this call, then keeps
//                dispatching dependents on its own on a timer as their
//                parents' jobs finish — the caller does not need to stay
//                connected. Returns the plan state (see GET /plans/:id).
//   GET  /plans/:id   current status of every subplan (pending / dispatched /
//                done / failed / blocked), its jobId/branch/baseBranch/prUrl
//                once known. Also nudges a dispatch pass before responding.
//   GET  /repos/:repo/context   read-only: contents of CLAUDE.md/README.md/
//                package.json (etc — a fixed allowlist, repo-root only, no
//                path traversal surface) plus a tracked-file listing, or
//                {"exists":false} if the repo isn't on this VM yet. Lets a
//                caller with no local clone (phone, Cowork) gather context
//                before drafting a plan, over the same authenticated channel
//                used for everything else.
//   GET  /health               no auth, liveness
//   GET  /ping                 no auth, liveness (returns "pong")
//
// A token only sees/controls jobs against repos it's scoped for. Every job
// start/cancel and every rejected auth attempt is appended to audit.log.

import http from "node:http";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { loadTokens, findToken, canAccessRepo } from "./lib/tokens.mjs";

const execFileP = promisify(execFile);

const PORT = Number(process.env.PORT || 7777);
const DATA = process.env.AGENT_RUNNER_DATA || path.join(os.homedir(), "agent-runner-data");
const RUNNERS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "runners");
const JOBS_DIR = path.join(DATA, "jobs");
const PLANS_DIR = path.join(DATA, "plans");
const TOKENS_FILE = path.join(DATA, "tokens.json");
const AUDIT_FILE = path.join(DATA, "audit.log");
const MAX_CONCURRENT_PER_TOKEN = Number(process.env.MAX_CONCURRENT_PER_TOKEN || 5);
const PLAN_TICK_INTERVAL_MS = Number(process.env.PLAN_TICK_INTERVAL_MS || 20_000);

fs.mkdirSync(JOBS_DIR, { recursive: true });
fs.mkdirSync(PLANS_DIR, { recursive: true });

const expand = (p) => (p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : p);
const REPOS_DIR = expand(process.env.REPOS_DIR || "~/repos");

const metaPath = (id) => path.join(JOBS_DIR, id, "meta.json");
const exitCodePath = (id) => path.join(JOBS_DIR, id, "exit_code");
const readMeta = (id) => JSON.parse(fs.readFileSync(metaPath(id), "utf8"));
const writeMeta = (id, meta) => fs.writeFileSync(metaPath(id), JSON.stringify(meta, null, 2));

const planPath = (id) => path.join(PLANS_DIR, `${id}.json`);
const readPlan = (id) => JSON.parse(fs.readFileSync(planPath(id), "utf8"));
const writePlan = (id, plan) => fs.writeFileSync(planPath(id), JSON.stringify(plan, null, 2));
const listPlanIds = () =>
  fs
    .readdirSync(PLANS_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.slice(0, -5));

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

// ---- git worktree isolation --------------------------------------------
//
// `branch` on a job switches it into worktree mode: instead of running in
// the repo's one shared working tree (serialized via repoBusy), it gets its
// own checkout at REPOS_DIR/.worktrees/<repo>/<branch> on a fresh branch, so
// independent jobs on the same repo can run concurrently. `git worktree
// add`/`remove` mutate metadata shared with the primary checkout
// (.git/worktrees/), so calls on the same repo are serialized through this
// mutex even though the (slow) agent runs after prep do not need to be.
const repoLocks = new Map(); // repoName -> Promise (tail of the chain)
function withRepoLock(repoName, fn) {
  const prev = repoLocks.get(repoName) || Promise.resolve();
  const run = prev.then(fn, fn); // run fn even if the previous job's prep failed
  repoLocks.set(repoName, run.catch(() => {})); // don't let one failure poison the chain
  return run; // the caller still sees its own fn's rejection
}

async function isValidRef(name) {
  try {
    await execFileP("git", ["check-ref-format", "--branch", name]);
    return true;
  } catch {
    return false;
  }
}

async function resolveDefaultBranch(repoDir) {
  try {
    const { stdout } = await execFileP("git", ["-C", repoDir, "symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
    return stdout.trim().replace(/^origin\//, "");
  } catch {
    for (const name of ["main", "master"]) {
      try {
        await execFileP("git", ["-C", repoDir, "show-ref", "--verify", "--quiet", `refs/remotes/origin/${name}`]);
        return name;
      } catch {}
    }
    throw new Error("could not resolve the repo's default branch (no origin/HEAD, no origin/main, no origin/master)");
  }
}

// Runs before the job is spawned so a bad baseBranch or an already-existing
// branch comes back as an immediate 400, not a job that starts and fails
// silently inside the background script.
async function prepWorktree({ repoDir, repo, branch, baseBranch }) {
  return withRepoLock(repo, async () => {
    if (!fs.existsSync(repoDir)) {
      throw new Error(`repo "${repo}" does not exist on this VM yet — branch requires an existing repo (run a plain job with gitUrl/create first)`);
    }
    const base = baseBranch || (await resolveDefaultBranch(repoDir));
    await execFileP("git", ["-C", repoDir, "fetch", "origin", base]);
    const worktreeDir = path.join(REPOS_DIR, ".worktrees", repo, branch);
    await execFileP("git", ["-C", repoDir, "worktree", "add", worktreeDir, "-b", branch, `origin/${base}`]);
    return { worktreeDir, baseBranch: base };
  });
}

// Best-effort — never fatal. Never deletes the branch itself (the PR still
// needs it), only the local checkout, to reclaim disk.
async function removeWorktree({ repoDir, repo, worktreeDir }) {
  return withRepoLock(repo, async () => {
    try {
      await execFileP("git", ["-C", repoDir, "worktree", "remove", "--force", worktreeDir]);
    } catch {}
  });
}

// Shared by the in-process child.on("exit") handler (the fast path, when
// agent-runner is still the process that spawned the job) and
// reconcileJobs() below (the fallback path, when it isn't).
function finalizeJob(meta, { exitCode, signal = null }) {
  meta.status = exitCode === 0 ? "done" : "failed";
  meta.exitCode = exitCode;
  meta.signal = signal;
  meta.endedAt = new Date().toISOString();
  writeMeta(meta.id, meta);
  if (meta.branch) {
    removeWorktree({ repoDir: meta.repo, repo: meta.repoName, worktreeDir: meta.worktreeDir }).catch(() => {});
  }
}

// A job is spawned `detached` so it survives agent-runner restarting, but
// the code that normally finalizes it (child.on("exit")) lives in the
// process that spawned it — if THAT process restarts mid-job (a bad deploy,
// a crash, systemd's Restart=always), nothing is left to catch the real
// exit event, and the job would stay "running" in meta.json forever, which
// would in turn wedge repoBusy() for plain jobs and permanently block any
// plan subplan waiting on it. This reconciles every "running" job against
// the $EXIT_CODE_FILE its bash wrapper writes on real exit (see startJob):
// if present, finalize from it; if the pid is simply gone with no exit code
// ever recorded (killed abnormally, crashed before the wrapper could write
// it), finalize as failed. Runs once at startup and on every tick after.
function reconcileJobs() {
  for (const m of allJobs()) {
    if (m.status !== "running") continue;
    let code = null;
    try {
      const raw = fs.readFileSync(exitCodePath(m.id), "utf8").trim();
      if (raw !== "") code = parseInt(raw, 10);
    } catch {}
    if (code !== null && !Number.isNaN(code)) {
      finalizeJob(m, { exitCode: code });
      continue;
    }
    let alive = false;
    try {
      process.kill(m.pid, 0);
      alive = true;
    } catch {}
    if (!alive) {
      finalizeJob(
        { ...m, note: "process is gone and no exit code was ever recorded — likely killed abnormally, or agent-runner restarted before the job could finish" },
        { exitCode: null }
      );
    }
  }
}

async function startJob(body, identity) {
  const {
    repo,
    goal,
    runner = "claude",
    gitUrl,
    create,
    visibility = "private",
    owner,
    model,
    effort,
    branch,
    baseBranch,
    planId,
  } = body || {};
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

  if (branch !== undefined) {
    if (!(await isValidRef(branch))) throw new Error(`invalid branch name: ${JSON.stringify(branch)}`);
    if (create || gitUrl) throw new Error("branch is mutually exclusive with create/gitUrl — worktree jobs require the repo to already exist");
  }
  if (baseBranch !== undefined) {
    if (!branch) throw new Error("baseBranch requires branch");
    if (!(await isValidRef(baseBranch))) throw new Error(`invalid baseBranch name: ${JSON.stringify(baseBranch)}`);
  }
  if (planId !== undefined && !/^[a-zA-Z0-9._-]+$/.test(planId)) throw new Error("invalid planId");

  // Plain (non-worktree) jobs still serialize on the one shared working
  // tree. Worktree jobs skip this — they never touch it, only shared git
  // metadata, which is serialized separately via withRepoLock.
  if (!branch && repoBusy(repo)) throw new Error(`repo "${repo}" already has a job running — wait for it to finish`);
  if (countRunning(identity.name) >= MAX_CONCURRENT_PER_TOKEN) {
    throw new Error(`token "${identity.name}" already has ${MAX_CONCURRENT_PER_TOKEN} jobs running`);
  }

  const repoDir = path.join(REPOS_DIR, repo);
  let workDir = repoDir;
  let resolvedBaseBranch = "";
  if (branch) {
    const prep = await prepWorktree({ repoDir, repo, branch, baseBranch });
    workDir = prep.worktreeDir;
    resolvedBaseBranch = prep.baseBranch;
  }

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
  // For worktree jobs, $REPO already exists (prepWorktree created it), so
  // this branch never triggers and FRESH is always 0.
  //
  // The runner is NOT exec'd (which would replace bash and give up the
  // chance to run anything after it) — instead its exit code is captured
  // and written to $EXIT_CODE_FILE. This is what lets reconcileJobs() below
  // finalize a job whose in-process child.on("exit") handler never got to
  // fire — e.g. because agent-runner itself was restarted while the job was
  // still running — by reading that file back on a later tick instead of
  // relying on a live handle to the (long gone) parent process.
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
cd "$REPO"
set +e
"$RUNNER" "$REPO" "$PROMPT_FILE"
CODE=$?
echo "$CODE" > "$EXIT_CODE_FILE"
exit "$CODE"
`;

  const child = spawn("bash", ["-lc", script], {
    detached: true,
    stdio: ["ignore", logFd, logFd],
    env: {
      ...process.env,
      REPO: workDir,
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
      BASE_BRANCH: resolvedBaseBranch,
      EXIT_CODE_FILE: exitCodePath(id),
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
    ...(branch ? { branch, baseBranch: resolvedBaseBranch, worktreeDir: workDir } : {}),
    ...(planId ? { planId } : {}),
  };
  writeMeta(id, meta);
  audit({
    action: "job.start",
    id,
    repo,
    runner,
    tokenName: identity.name,
    model: model || null,
    effort: effort || null,
    create: !!create,
    branch: branch || null,
    planId: planId || null,
  });

  child.on("exit", (code, signal) => finalizeJob(readMeta(id), { exitCode: code, signal }));
  child.unref();
  return meta;
}

function listJobs(identity) {
  return allJobs()
    .filter((m) => canAccessRepo(identity, m.repoName))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, 50);
}

// ---- plans: subplan trees dispatched over time -------------------------
//
// A plan is a TREE of subplans (each dependsOn at most one other slug — a
// stacked branch only has one base, so a subplan needing two parents' work
// must be expressed as a chain, not a multi-parent edge). Dispatch state is
// persisted to disk and re-derived from job meta on every tick, so it
// survives an agent-runner restart with no special resume step — the same
// reason allJobs() re-scans JOBS_DIR instead of caching.

const validSlug = (s) => typeof s === "string" && /^[a-z0-9-]+$/.test(s);

async function registerPlan(body, identity) {
  const { repo, subplans, planId: reqPlanId } = body || {};
  if (!repo || !Array.isArray(subplans) || subplans.length === 0) {
    throw new Error("repo and a non-empty subplans array are required");
  }
  if (!/^[a-zA-Z0-9._-]+$/.test(repo)) throw new Error("repo must be a bare name (letters, digits, . _ -), not a path");
  if (!canAccessRepo(identity, repo)) throw new Error(`token "${identity.name}" is not scoped for repo "${repo}"`);

  const slugs = new Set();
  let creatorSlug = null;
  for (const sp of subplans) {
    if (!validSlug(sp.slug)) throw new Error(`invalid subplan slug: ${JSON.stringify(sp.slug)}`);
    if (slugs.has(sp.slug)) throw new Error(`duplicate subplan slug: "${sp.slug}"`);
    slugs.add(sp.slug);
    if (!sp.goal || typeof sp.goal !== "string") throw new Error(`subplan "${sp.slug}" is missing goal`);
    if (sp.dependsOn !== undefined && sp.dependsOn !== null) {
      if (Array.isArray(sp.dependsOn)) {
        throw new Error(
          `subplan "${sp.slug}": dependsOn must be a single slug, not an array — subplans form a tree, not a DAG; linearize diamonds into a chain`
        );
      }
      if (typeof sp.dependsOn !== "string") throw new Error(`subplan "${sp.slug}": invalid dependsOn`);
    }
    if (sp.create || sp.gitUrl) {
      if (creatorSlug) throw new Error(`only one subplan may set create/gitUrl (both "${creatorSlug}" and "${sp.slug}" do)`);
      creatorSlug = sp.slug;
    }
  }
  for (const sp of subplans) {
    if (sp.dependsOn && !slugs.has(sp.dependsOn)) {
      throw new Error(`subplan "${sp.slug}" dependsOn unknown slug "${sp.dependsOn}"`);
    }
  }

  const bySlug = Object.fromEntries(subplans.map((sp) => [sp.slug, sp]));

  // cycle check over the declared edges, before any server-side rewriting
  for (const sp of subplans) {
    const seen = new Set();
    let cur = sp.slug;
    while (bySlug[cur]?.dependsOn) {
      cur = bySlug[cur].dependsOn;
      if (seen.has(cur)) throw new Error(`dependency cycle detected involving "${sp.slug}"`);
      seen.add(cur);
    }
  }

  const repoDir = path.join(REPOS_DIR, repo);
  const repoExists = fs.existsSync(repoDir);
  if (!repoExists && !creatorSlug) {
    throw new Error(`repo "${repo}" does not exist on this VM — exactly one subplan must set create or gitUrl`);
  }
  if (repoExists && creatorSlug) {
    throw new Error(`repo "${repo}" already exists — the create/gitUrl subplan ("${creatorSlug}") would collide with it`);
  }

  // Brand-new product: every other subplan must (transitively) depend on the
  // creator. Root subplans (no declared dependsOn) are auto-attached to it;
  // subplans with an explicit chain must already resolve to it — rewriting
  // an explicit non-root edge could silently produce a graph the caller
  // didn't intend, so that case is a hard error instead.
  if (creatorSlug) {
    for (const sp of subplans) {
      if (sp.slug === creatorSlug) continue;
      if (sp.dependsOn === null || sp.dependsOn === undefined) {
        sp.dependsOn = creatorSlug;
        continue;
      }
      let cur = sp.slug;
      let reachesCreator = false;
      while (bySlug[cur]?.dependsOn) {
        cur = bySlug[cur].dependsOn;
        if (cur === creatorSlug) {
          reachesCreator = true;
          break;
        }
      }
      if (!reachesCreator) {
        throw new Error(`subplan "${sp.slug}"'s dependency chain must terminate at the create/gitUrl subplan "${creatorSlug}" (repo doesn't exist yet)`);
      }
    }
  }

  const planId = reqPlanId || `${new Date().toISOString().replace(/[:.]/g, "-")}-${crypto.randomBytes(3).toString("hex")}`;
  if (fs.existsSync(planPath(planId))) throw new Error(`planId "${planId}" already exists`);

  const plan = {
    planId,
    repo,
    tokenName: identity.name,
    createdAt: new Date().toISOString(),
    subplans: Object.fromEntries(
      subplans.map((sp) => [
        sp.slug,
        {
          goal: sp.goal,
          dependsOn: sp.dependsOn || null,
          status: "pending",
          gitUrl: sp.gitUrl || null,
          create: !!sp.create,
          runner: sp.runner || undefined,
          visibility: sp.visibility || undefined,
          owner: sp.owner || undefined,
          model: sp.model || undefined,
          effort: sp.effort || undefined,
        },
      ])
    ),
  };
  writePlan(planId, plan);
  await tickPlan(planId);
  return readPlan(planId);
}

// One dispatch pass: advance dispatched subplans whose jobs finished, then
// dispatch pending subplans whose (single) dependency is now done. Iterates
// to a fixed point (bounded by subplan count) so a chain that unblocks two
// levels in one tick dispatches both, not just the first. A dispatch
// *attempt* failing (capacity limit, a transient git race) leaves the
// subplan "pending" with lastError recorded for visibility — it's retried
// on the next tick rather than permanently failed, since most such errors
// are transient. Only an actual job failure blocks dependents.
async function tickPlan(planId) {
  let plan;
  try {
    plan = readPlan(planId);
  } catch {
    return;
  }

  let changed = true;
  let iterations = 0;
  const maxIterations = Object.keys(plan.subplans).length + 1;
  while (changed && iterations++ < maxIterations) {
    changed = false;
    for (const [slug, sp] of Object.entries(plan.subplans)) {
      if (sp.status === "dispatched") {
        let jobMeta;
        try {
          jobMeta = readMeta(sp.jobId);
        } catch {
          continue;
        }
        if (jobMeta.status === "done") {
          sp.status = "done";
          changed = true;
        } else if (jobMeta.status === "failed" || jobMeta.status === "cancelled") {
          sp.status = "failed";
          changed = true;
        }
      } else if (sp.status === "pending") {
        const dep = sp.dependsOn ? plan.subplans[sp.dependsOn] : null;
        if (dep && (dep.status === "failed" || dep.status === "blocked")) {
          sp.status = "blocked";
          changed = true;
        } else if (!dep || dep.status === "done") {
          try {
            const jobMeta = await startJob(
              {
                repo: plan.repo,
                goal: sp.goal,
                runner: sp.runner,
                planId,
                branch: sp.create || sp.gitUrl ? undefined : `feat/${slug}`,
                baseBranch: dep ? dep.branch || undefined : undefined,
                gitUrl: sp.gitUrl || undefined,
                create: sp.create || undefined,
                visibility: sp.visibility,
                owner: sp.owner,
                model: sp.model,
                effort: sp.effort,
              },
              // Repo access was already checked at registration time; this
              // dispatch happens on the plan's behalf, not a per-request token.
              { name: plan.tokenName, repos: ["*"] }
            );
            sp.status = "dispatched";
            sp.jobId = jobMeta.id;
            sp.branch = jobMeta.branch || null;
            sp.baseBranch = jobMeta.baseBranch || null;
            delete sp.lastError;
            changed = true;
          } catch (e) {
            sp.lastError = e.message;
          }
        }
      }
    }
  }
  writePlan(planId, plan);
}

async function getPlanState(planId, identity) {
  if (!fs.existsSync(planPath(planId))) return null;
  const plan = readPlan(planId);
  // Repo-scoped tokens can't see plans outside their scope — treated as
  // not-found, same pattern as GET /jobs/:id.
  if (!canAccessRepo(identity, plan.repo)) return null;
  await tickPlan(planId);
  const fresh = readPlan(planId);
  return {
    planId: fresh.planId,
    repo: fresh.repo,
    subplans: Object.fromEntries(
      Object.entries(fresh.subplans).map(([slug, sp]) => [slug, { ...sp, prUrl: sp.jobId ? findPrUrl(sp.jobId) : null }])
    ),
  };
}

// ---- repo context: for callers with no local clone (phone, Cowork) -----

const CONTEXT_FILES = ["CLAUDE.md", "README.md", "package.json", "pyproject.toml", "go.mod", "Cargo.toml"];
const CONTEXT_FILE_MAX = 8 * 1024;

async function getRepoContext(repo, identity) {
  if (!/^[a-zA-Z0-9._-]+$/.test(repo)) throw new Error("repo must be a bare name (letters, digits, . _ -), not a path");
  if (!canAccessRepo(identity, repo)) throw new Error(`token "${identity.name}" is not scoped for repo "${repo}"`);
  const repoDir = path.join(REPOS_DIR, repo);
  if (!fs.existsSync(repoDir)) return { repo, exists: false };

  const files = {};
  for (const name of CONTEXT_FILES) {
    const p = path.join(repoDir, name);
    if (fs.existsSync(p) && fs.statSync(p).isFile()) {
      files[name] = fs.readFileSync(p, "utf8").slice(0, CONTEXT_FILE_MAX);
    }
  }
  let tree = [];
  try {
    const { stdout } = await execFileP("git", ["-C", repoDir, "ls-files"], { encoding: "utf8" });
    tree = stdout.split("\n").filter(Boolean).slice(0, 200);
  } catch {}
  return { repo, exists: true, files, tree };
}

const json = (res, code, obj) => {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(obj, null, 2));
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  if (req.method === "GET" && url.pathname === "/health") return json(res, 200, { ok: true });
  if (req.method === "GET" && url.pathname === "/ping") {
    res.writeHead(200, { "content-type": "text/plain" });
    return res.end("pong");
  }

  const tokens = loadTokens(TOKENS_FILE);
  const bearer = (req.headers.authorization || "").replace(/^Bearer /, "");
  const identity = findToken(tokens, bearer);
  if (!identity) {
    audit({ action: "auth.reject", path: url.pathname, ip: req.socket.remoteAddress });
    return json(res, 401, { error: "unauthorized" });
  }

  try {
    // Cheap enough to run on every request — matches the rest of this file's
    // "re-derive from disk, don't cache" style — and means a manual GET
    // reflects a job's real status immediately rather than waiting for the
    // next timer tick.
    reconcileJobs();

    if (req.method === "POST" && url.pathname === "/jobs") {
      let body = "";
      for await (const chunk of req) {
        body += chunk;
        if (body.length > 1e6) throw new Error("body too large");
      }
      return json(res, 201, await startJob(JSON.parse(body), identity));
    }

    if (req.method === "GET" && url.pathname === "/jobs") return json(res, 200, listJobs(identity));

    if (req.method === "POST" && url.pathname === "/plans") {
      let body = "";
      for await (const chunk of req) {
        body += chunk;
        if (body.length > 1e6) throw new Error("body too large");
      }
      return json(res, 201, await registerPlan(JSON.parse(body), identity));
    }

    const pm = url.pathname.match(/^\/plans\/([^/]+)$/);
    if (req.method === "GET" && pm) {
      const state = await getPlanState(pm[1], identity);
      if (!state) return json(res, 404, { error: "not found" });
      return json(res, 200, state);
    }

    const cm = url.pathname.match(/^\/repos\/([^/]+)\/context$/);
    if (req.method === "GET" && cm) {
      return json(res, 200, await getRepoContext(cm[1], identity));
    }

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

// Reconcile once at startup so jobs that finished (or died) during any gap
// before this process came up are finalized before anything else runs.
reconcileJobs();

// Keeps dispatching dependent subplans even if no client ever polls
// GET /plans/:id again — this is what lets a /plan session end right after
// registering and still have the rest of the tree run to completion.
// reconcileJobs() runs first on every tick too, since a job still "running"
// at restart time only finishes later — tickPlan needs its up-to-date
// status to know a dependent subplan is now dispatchable.
setInterval(() => {
  reconcileJobs();
  for (const id of listPlanIds()) {
    tickPlan(id).catch(() => {});
  }
}, PLAN_TICK_INTERVAL_MS);

const HOST = process.env.HOST || "127.0.0.1"; // 0.0.0.0 for PaaS (Railway etc.) where a proxy fronts the container
server.listen(PORT, HOST, () => console.log(`agent-runner listening on ${HOST}:${PORT}`));
