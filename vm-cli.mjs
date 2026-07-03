#!/usr/bin/env node
// vm-cli.mjs — local setup CLI for a hosted claude-vm instance.
//
// Runs on YOUR laptop, not the VM. Talks to an already-provisioned box
// (provision.sh + setup-agent-runner.sh already ran there) over plain ssh —
// no HTTP admin surface, no new open port, just the SSH access you already
// used to provision it. Lets you set REPOS_DIR / REPOS / RUNNER and
// mint/list/revoke API tokens without SSHing in and hand-editing
// ~/agent-runner/.env yourself.
//
// Usage:
//   ./vm-cli.mjs connect dev@vps.example.com --name prod   # save + select a host
//   ./vm-cli.mjs configure                                 # interactive wizard
//   ./vm-cli.mjs tokens add --name cowork --repos my-app,other-app
//   ./vm-cli.mjs tokens list
//   ./vm-cli.mjs tokens revoke --name cowork
//   ./vm-cli.mjs status
//   ./vm-cli.mjs hosts / use <name>
//
// State (saved hosts, current default) lives in ~/.claude-vm/cli.json —
// just host aliases, never tokens or secrets.

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import readline from "node:readline";

const CONFIG_DIR = path.join(os.homedir(), ".claude-vm");
const CONFIG_FILE = path.join(CONFIG_DIR, "cli.json");

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
  } catch {
    return { current: null, hosts: {} };
  }
}

function saveConfig(cfg) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
}

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
    } else {
      out._.push(a);
    }
  }
  return out;
}

// Single-quote a value for safe embedding in the ONE command string we hand
// to ssh — sshd re-parses that string with a remote shell, so this is the
// only thing standing between a repo/token name and a broken-out command.
function shQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

function fail(msg) {
  console.error(`error: ${msg}`);
  process.exit(1);
}

function resolveHost(args, cfg) {
  const alias = args.host;
  if (alias) {
    const h = cfg.hosts[alias];
    if (!h) fail(`no saved host named "${alias}" — run: vm-cli.mjs connect user@host --name ${alias}`);
    return h;
  }
  if (cfg.current) return cfg.hosts[cfg.current];
  fail("no host configured — run: vm-cli.mjs connect user@host");
}

// Runs ONE already-quoted command string on the remote host over ssh.
function sshExec(host, remoteCommand, { input, silent } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn("ssh", [host, remoteCommand], {
      stdio: [input !== undefined ? "pipe" : "ignore", silent ? "pipe" : "inherit", silent ? "pipe" : "inherit"],
    });
    let stdout = "", stderr = "";
    if (silent) {
      child.stdout.on("data", (d) => (stdout += d));
      child.stderr.on("data", (d) => (stderr += d));
    }
    if (input !== undefined) {
      child.stdin.write(input);
      child.stdin.end();
    }
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code !== 0 && !silent) return reject(new Error(`ssh exited ${code}`));
      resolve({ code, stdout, stderr });
    });
  });
}

function prompt(rl, question, defaultValue = "") {
  return new Promise((resolve) => {
    rl.question(defaultValue ? `${question} [${defaultValue}]: ` : `${question}: `, (answer) => {
      resolve(answer.trim() || defaultValue);
    });
  });
}

async function cmdConnect(args, cfg) {
  const host = args._[0];
  if (!host) fail("usage: vm-cli.mjs connect <user@host> [--name <alias>]");
  const name = args.name || host.split("@")[1]?.split(".")[0] || host;
  console.error(`==> checking ${host}`);
  const check = await sshExec(host, "test -f ~/agent-runner/server.mjs && echo ok || echo missing", { silent: true });
  if (!check.stdout.includes("ok")) {
    fail(`connected, but ~/agent-runner isn't installed there yet — run setup-agent-runner.sh on the VM first`);
  }
  cfg.hosts[name] = host;
  cfg.current = name;
  saveConfig(cfg);
  console.error(`==> saved as "${name}" and set as current host`);
}

async function cmdUse(args, cfg) {
  const name = args._[0];
  if (!name || !cfg.hosts[name]) {
    fail(`usage: vm-cli.mjs use <name>  (known: ${Object.keys(cfg.hosts).join(", ") || "none — run connect first"})`);
  }
  cfg.current = name;
  saveConfig(cfg);
  console.error(`current host: ${name} (${cfg.hosts[name]})`);
}

function cmdHosts(cfg) {
  if (!Object.keys(cfg.hosts).length) return console.log("(no hosts saved — run: vm-cli.mjs connect user@host)");
  for (const [name, host] of Object.entries(cfg.hosts)) {
    console.log(`${name === cfg.current ? "*" : " "} ${name}\t${host}`);
  }
}

async function fetchEnv(host) {
  const res = await sshExec(host, "cat ~/agent-runner/.env 2>/dev/null || true", { silent: true });
  const env = {};
  for (const line of res.stdout.split("\n")) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m) env[m[1]] = m[2];
  }
  return env;
}

async function cmdConfigure(args, cfg) {
  const host = resolveHost(args, cfg);
  const current = await fetchEnv(host);

  let repoDir = args["repos-dir"];
  let repos = args.repos;
  let runner = args.runner;

  if (repoDir === undefined || repos === undefined || runner === undefined) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    if (repoDir === undefined) repoDir = await prompt(rl, "REPOS_DIR (where job repos live)", current.REPOS_DIR || "~/repos");
    if (repos === undefined) {
      repos = await prompt(rl, "REPOS to watch for the issue-queue (space-separated owner/repo, blank = none)", current.REPOS || "");
    }
    if (runner === undefined) runner = await prompt(rl, "default RUNNER (claude | codex | opencode)", current.RUNNER || "claude");
    rl.close();
  }

  const updates = `REPOS_DIR=${repoDir}\nREPOS=${repos}\nRUNNER=${runner}\n`;
  console.error(`==> pushing config to ${host}`);
  await sshExec(host, "node ~/agent-runner/set-env.mjs", { input: updates });
  console.error("==> restarting agent-runner");
  await sshExec(host, "sudo systemctl restart agent-runner");
  console.error("done.");
}

async function cmdTokens(args, cfg) {
  const host = resolveHost(args, cfg);
  const sub = args._[0];
  if (sub === "add") {
    if (!args.name) fail("usage: vm-cli.mjs tokens add --name <name> [--repos a,b|*] [--expires-days N]");
    const parts = ["node ~/agent-runner/tokens-cli.mjs add", `--name ${shQuote(args.name)}`];
    if (args.repos) parts.push(`--repos ${shQuote(args.repos)}`);
    if (args["expires-days"]) parts.push(`--expires-days ${shQuote(args["expires-days"])}`);
    await sshExec(host, parts.join(" "));
  } else if (sub === "list") {
    await sshExec(host, "node ~/agent-runner/tokens-cli.mjs list");
  } else if (sub === "revoke") {
    if (!args.name) fail("usage: vm-cli.mjs tokens revoke --name <name>");
    await sshExec(host, `node ~/agent-runner/tokens-cli.mjs revoke --name ${shQuote(args.name)}`);
  } else {
    fail("usage: vm-cli.mjs tokens <add|list|revoke> ...");
  }
}

async function cmdStatus(args, cfg) {
  const host = resolveHost(args, cfg);
  const env = await fetchEnv(host);
  console.log(`host:      ${host}`);
  console.log(`REPOS_DIR: ${env.REPOS_DIR || "(default ~/repos)"}`);
  console.log(`REPOS:     ${env.REPOS || "(none — issue poller idle)"}`);
  console.log(`RUNNER:    ${env.RUNNER || "claude"}`);
  console.log();
  await sshExec(
    host,
    "systemctl --no-pager status agent-runner agent-issue-poller.timer 2>&1 | grep -E 'Loaded|Active|\\.service|\\.timer'"
  );
}

function usage() {
  console.log(`vm-cli.mjs — local setup CLI for a hosted claude-vm instance (talks over ssh)

  connect <user@host> [--name <alias>]   save + select a host
  use <alias>                            switch the current host
  hosts                                  list saved hosts
  configure [--repos-dir D] [--repos "a/b c/d"] [--runner claude] [--host <alias>]
                                          set REPOS_DIR / REPOS / RUNNER (prompts for anything omitted)
  tokens add --name X [--repos a,b] [--expires-days N] [--host <alias>]
  tokens list [--host <alias>]
  tokens revoke --name X [--host <alias>]
  status [--host <alias>]                current config + service status
`);
}

async function main() {
  const [, , cmd, ...rest] = process.argv;
  const args = parseArgs(rest);
  const cfg = loadConfig();

  try {
    switch (cmd) {
      case "connect":
        return await cmdConnect(args, cfg);
      case "use":
        return await cmdUse(args, cfg);
      case "hosts":
        return cmdHosts(cfg);
      case "configure":
        return await cmdConfigure(args, cfg);
      case "tokens":
        return await cmdTokens(args, cfg);
      case "status":
        return await cmdStatus(args, cfg);
      default:
        return usage();
    }
  } catch (e) {
    fail(e.message);
  }
}

main();
