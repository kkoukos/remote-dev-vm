#!/usr/bin/env node
// tokens-cli.mjs — mint/list/revoke agent-runner API tokens.
//
// Each token is named, scoped to a set of repo names (or "*"), and optionally
// expiring. The plaintext is printed once at mint time; only its hash is
// stored, so losing this output means minting a new token, not recovering it.
//
// Usage:
//   node tokens-cli.mjs add --name cowork --repos "my-app,other-app" [--expires-days 90]
//   node tokens-cli.mjs add --name admin --repos "*"
//   node tokens-cli.mjs list
//   node tokens-cli.mjs revoke --name cowork

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { loadTokens, saveTokens, mintToken, hashToken } from "./lib/tokens.mjs";

const DATA = process.env.AGENT_RUNNER_DATA || path.join(os.homedir(), "agent-runner-data");
const FILE = path.join(DATA, "tokens.json");
fs.mkdirSync(DATA, { recursive: true });

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) {
      out[argv[i].slice(2)] = argv[i + 1];
      i++;
    }
  }
  return out;
}

const [, , cmd, ...rest] = process.argv;
const args = parseArgs(rest);
const tokens = loadTokens(FILE);

function usage() {
  console.error("usage: tokens-cli.mjs <add|list|revoke> --name <name> [--repos a,b|*] [--expires-days N]");
  process.exit(1);
}

if (cmd === "add") {
  if (!args.name) usage();
  if (tokens.some((t) => t.name === args.name)) {
    console.error(`token "${args.name}" already exists — revoke it first if you want to replace it`);
    process.exit(1);
  }
  const repos = args.repos ? args.repos.split(",").map((s) => s.trim()).filter(Boolean) : ["*"];
  const token = mintToken();
  const expiresAt = args["expires-days"]
    ? new Date(Date.now() + Number(args["expires-days"]) * 86400000).toISOString()
    : null;
  tokens.push({
    name: args.name,
    hash: hashToken(token),
    repos,
    createdAt: new Date().toISOString(),
    expiresAt,
  });
  saveTokens(FILE, tokens);
  console.error(`# token "${args.name}"  repos=${repos.join(",")}  expires=${expiresAt || "never"}`);
  console.error(`# save this now — it will not be shown again:`);
  console.log(token);
} else if (cmd === "list") {
  if (!tokens.length) console.log("(no tokens yet)");
  for (const t of tokens) {
    console.log(`${t.name}\trepos=${(t.repos || []).join(",")}\tcreated=${t.createdAt}\texpires=${t.expiresAt || "never"}`);
  }
} else if (cmd === "revoke") {
  if (!args.name) usage();
  const next = tokens.filter((t) => t.name !== args.name);
  if (next.length === tokens.length) {
    console.error(`no token named "${args.name}"`);
    process.exit(1);
  }
  saveTokens(FILE, next);
  console.log(`revoked "${args.name}"`);
} else {
  usage();
}
