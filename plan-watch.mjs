#!/usr/bin/env node
// plan-watch.mjs — local, read-only tracker for agent-runner plans & jobs.
//
// Runs on YOUR laptop, not the VM. Talks to the agent-runner HTTP API (the
// same endpoints Cowork/curl use) with a bearer token, and renders a live
// command-line view of a running plan and the individual agents building it.
// Purely observational — it only ever GETs; it never starts, cancels, or
// mutates anything.
//
// It deliberately does NOT persist your token (same stance as vm-cli.mjs,
// which stores host aliases but "never tokens or secrets"). Pass the endpoint
// and token per run, or via env:
//
//   export AGENT_URL=https://code.example.com/agent      # include the /agent path prefix
//   export AGENT_TOKEN=...                                # a bearer token scoped to the repo
//
// Usage:
//   ./plan-watch.mjs plan <planId>              live plan tree, refreshes until every subplan is terminal
//   ./plan-watch.mjs plan <planId> --once       one snapshot, no loop (good for scripts / non-TTY)
//   ./plan-watch.mjs logs <jobId>               follow one agent's build log (Ctrl-C to stop)
//   ./plan-watch.mjs logs <jobId> --once        dump the log once and exit
//   ./plan-watch.mjs jobs                        list recent jobs visible to this token
//   ./plan-watch.mjs job  <jobId>               one-shot status + last log lines for a job
//
// Options: --url <base> --token <tok> --interval <seconds> (default 5)
//
// Tip: run `plan <planId>` in one pane and `logs <jobId>` in another — the
// plan view prints the exact `logs` command for each dispatched subplan.

import process from "node:process";

// ---- args ---------------------------------------------------------------

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) out[key] = true;
      else {
        out[key] = next;
        i++;
      }
    } else out._.push(a);
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const [cmd, target] = args._;

function fail(msg) {
  console.error(`error: ${msg}`);
  process.exit(1);
}

if (typeof fetch === "undefined") fail("this needs Node 18+ (global fetch is missing)");

const BASE = String(args.url || process.env.AGENT_URL || "").replace(/\/+$/, "");
const TOKEN = args.token || process.env.AGENT_TOKEN || "";
const INTERVAL = Math.max(1, Number(args.interval || 5)) * 1000;

function requireConfig() {
  if (!BASE) fail("no endpoint — pass --url https://host/agent or set AGENT_URL");
  if (!TOKEN) fail("no token — pass --token <tok> or set AGENT_TOKEN");
}

// ---- http ---------------------------------------------------------------

async function api(pathname, { raw = false } = {}) {
  let res;
  try {
    res = await fetch(`${BASE}${pathname}`, { headers: { authorization: `Bearer ${TOKEN}` } });
  } catch (e) {
    throw new Error(`cannot reach ${BASE} — ${e.message}`);
  }
  if (res.status === 401) throw new Error("401 unauthorized — check the token");
  if (res.status === 404) throw new Error("404 not found — wrong id, or the token isn't scoped for this repo");
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}: ${(await res.text()).slice(0, 200)}`);
  return raw ? res.text() : res.json();
}

// ---- terminal helpers ----------------------------------------------------

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code, s) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : String(s));
const dim = (s) => c("2", s);
const bold = (s) => c("1", s);
const red = (s) => c("31", s);
const green = (s) => c("32", s);
const yellow = (s) => c("33", s);
const cyan = (s) => c("36", s);

const clearScreen = () => process.stdout.write("\x1b[2J\x1b[3J\x1b[H");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// dispatched == the job is running (or queued behind the concurrency cap).
const STATUS = {
  pending: { glyph: "○", paint: dim, label: "pending" },
  dispatched: { glyph: "◐", paint: cyan, label: "running" },
  done: { glyph: "●", paint: green, label: "done" },
  failed: { glyph: "✗", paint: red, label: "failed" },
  blocked: { glyph: "⊘", paint: red, label: "blocked" },
};
const TERMINAL = new Set(["done", "failed", "blocked"]);

function statusBadge(status) {
  const s = STATUS[status] || { glyph: "?", paint: (x) => x, label: status };
  return s.paint(`${s.glyph} ${s.label.padEnd(7)}`);
}

// ---- plan view ----------------------------------------------------------

function renderPlan(state) {
  const subplans = state.subplans || {};
  const entries = Object.entries(subplans);

  // dependsOn is a single slug → a tree/forest. Build children lists.
  const childrenOf = {};
  const roots = [];
  for (const [slug, sp] of entries) {
    if (sp.dependsOn && subplans[sp.dependsOn]) (childrenOf[sp.dependsOn] ||= []).push(slug);
    else roots.push(slug);
  }

  const counts = {};
  for (const [, sp] of entries) counts[sp.status] = (counts[sp.status] || 0) + 1;
  const summary = ["done", "dispatched", "pending", "failed", "blocked"]
    .filter((k) => counts[k])
    .map((k) => (STATUS[k]?.paint || ((x) => x))(`${counts[k]} ${STATUS[k]?.label || k}`))
    .join("  ");

  const lines = [];
  lines.push(bold(`plan ${state.planId}`) + dim(`  ·  repo ${state.repo}`));
  lines.push(summary || dim("(no subplans)"));
  lines.push("");

  const emit = (slug, depth) => {
    const sp = subplans[slug];
    const indent = depth ? dim("  ".repeat(depth - 1) + "└ ") : "";
    let line = `${indent}${statusBadge(sp.status)}  ${bold(slug)}`;
    if (sp.branch) line += dim(`  ${sp.branch}${sp.baseBranch ? ` → ${sp.baseBranch}` : ""}`);
    if (sp.prUrl) line += `  ${green(sp.prUrl)}`;
    lines.push(line);
    if (sp.jobId && sp.status !== "pending") {
      lines.push(dim(`${"  ".repeat(depth || 0)}    logs: ./plan-watch.mjs logs ${sp.jobId}`));
    }
    if (sp.lastError) lines.push(yellow(`${"  ".repeat(depth || 0)}    retrying: ${sp.lastError}`));
    for (const child of childrenOf[slug] || []) emit(child, depth + 1);
  };
  for (const r of roots) emit(r, 0);

  return { text: lines.join("\n"), allTerminal: entries.length > 0 && entries.every(([, sp]) => TERMINAL.has(sp.status)) };
}

async function cmdPlan(planId) {
  requireConfig();
  if (!planId) fail("usage: plan-watch.mjs plan <planId>");
  const once = !!args.once || !process.stdout.isTTY;
  for (;;) {
    let state;
    try {
      state = await api(`/plans/${encodeURIComponent(planId)}`);
    } catch (e) {
      fail(e.message);
    }
    const { text, allTerminal } = renderPlan(state);
    if (!once) clearScreen();
    process.stdout.write(text + "\n");
    if (once) return;
    if (allTerminal) {
      process.stdout.write("\n" + dim("all subplans terminal — done watching.") + "\n");
      return;
    }
    process.stdout.write(dim(`\nrefreshing every ${INTERVAL / 1000}s · Ctrl-C to stop`) + "\n");
    await sleep(INTERVAL);
  }
}

// ---- log follow ---------------------------------------------------------

async function cmdLogs(jobId) {
  requireConfig();
  if (!jobId) fail("usage: plan-watch.mjs logs <jobId>");
  const once = !!args.once;
  let seen = 0;
  for (;;) {
    let text;
    try {
      text = await api(`/jobs/${encodeURIComponent(jobId)}/log`, { raw: true });
    } catch (e) {
      fail(e.message);
    }
    if (text.length < seen) seen = 0; // log was replaced/rotated — reprint
    if (text.length > seen) {
      process.stdout.write(text.slice(seen));
      seen = text.length;
    }
    if (once) return;
    // Stop once the job itself is finished and the log has stopped growing.
    let meta = {};
    try {
      meta = await api(`/jobs/${encodeURIComponent(jobId)}`);
    } catch {}
    if (meta.status && meta.status !== "running") {
      // one more pass already happened above; report the terminal status.
      const paint = meta.status === "done" ? green : red;
      process.stdout.write("\n" + paint(`── job ${meta.status}`) + (meta.prUrl ? `  ${green(meta.prUrl)}` : "") + "\n");
      return;
    }
    await sleep(Math.min(INTERVAL, 3000));
  }
}

// ---- job list / one-shot job -------------------------------------------

async function cmdJobs() {
  requireConfig();
  const jobs = await api(`/jobs`);
  if (!Array.isArray(jobs) || jobs.length === 0) return console.log(dim("no jobs visible to this token"));
  for (const j of jobs) {
    const paint =
      j.status === "done" ? green : j.status === "running" ? cyan : j.status === "failed" || j.status === "cancelled" ? red : dim;
    const bits = [
      paint((j.status || "?").padEnd(9)),
      bold((j.repoName || j.repo || "?").padEnd(16)),
      j.branch ? dim(j.branch.padEnd(18)) : "".padEnd(18),
      dim(j.id),
    ];
    console.log(bits.join(" ") + (j.goalPreview ? `\n  ${dim(j.goalPreview)}` : ""));
  }
}

async function cmdJob(jobId) {
  requireConfig();
  if (!jobId) fail("usage: plan-watch.mjs job <jobId>");
  const m = await api(`/jobs/${encodeURIComponent(jobId)}`);
  const paint = m.status === "done" ? green : m.status === "running" ? cyan : red;
  console.log(bold(m.id));
  console.log(`  status  ${paint(m.status)}${m.exitCode != null ? dim(`  (exit ${m.exitCode})`) : ""}`);
  console.log(`  repo    ${m.repoName || m.repo}${m.branch ? dim(`  ${m.branch} → ${m.baseBranch || "?"}`) : ""}`);
  if (m.planId) console.log(`  plan    ${dim(m.planId)}`);
  if (m.prUrl) console.log(`  pr      ${green(m.prUrl)}`);
  if (m.logTail) console.log(dim("  ── last lines ──\n") + m.logTail.replace(/^/gm, "  "));
}

// ---- dispatch -----------------------------------------------------------

function usage() {
  console.log(
    [
      "plan-watch — read-only tracker for agent-runner plans & jobs",
      "",
      "  plan-watch.mjs plan <planId>     live plan tree (refreshes until all subplans finish)",
      "  plan-watch.mjs logs <jobId>      follow one agent's build log",
      "  plan-watch.mjs jobs              list recent jobs",
      "  plan-watch.mjs job  <jobId>      one-shot job status + last log lines",
      "",
      "  --url <base>   API base incl. /agent prefix   (or AGENT_URL)",
      "  --token <tok>  bearer token                   (or AGENT_TOKEN)",
      "  --interval <s> poll interval, default 5       --once  single snapshot",
    ].join("\n")
  );
}

process.on("SIGINT", () => {
  process.stdout.write("\n");
  process.exit(0);
});

const commands = { plan: () => cmdPlan(target), logs: () => cmdLogs(target), jobs: cmdJobs, job: () => cmdJob(target) };

if (!cmd || cmd === "help" || args.help) {
  usage();
  process.exit(0);
}
if (!commands[cmd]) fail(`unknown command "${cmd}" — run with --help`);

commands[cmd]().catch((e) => fail(e.message));
