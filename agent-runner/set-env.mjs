#!/usr/bin/env node
// set-env.mjs — safely update known keys in ~/agent-runner/.env.
//
// Reads KEY=VALUE lines from stdin (not argv — keeps values like "owner/a
// owner/b" out of shell quoting entirely) and rewrites only those keys in
// .env, leaving everything else untouched. Called remotely over ssh by the
// local vm-cli.mjs "configure" command, so setup doesn't require SSHing in
// and hand-editing the file.
//
// Usage:  node set-env.mjs <<'EOF'
//         REPOS_DIR=~/repos
//         REPOS=owner/repo1 owner/repo2
//         RUNNER=claude
//         EOF

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const ENV_FILE = path.join(os.homedir(), "agent-runner", ".env");
const ALLOWED = new Set(["REPOS_DIR", "REPOS", "RUNNER", "PORT", "MAX_CONCURRENT_PER_TOKEN"]);

const input = fs.readFileSync(0, "utf8");
const updates = new Map();
for (const line of input.split("\n")) {
  if (!line.trim()) continue;
  const i = line.indexOf("=");
  if (i < 0) continue;
  const key = line.slice(0, i).trim();
  if (!ALLOWED.has(key)) {
    console.error(`refusing unknown key: ${key} (allowed: ${[...ALLOWED].join(", ")})`);
    process.exit(1);
  }
  updates.set(key, line.slice(i + 1));
}
if (!updates.size) {
  console.error("no KEY=VALUE lines on stdin");
  process.exit(1);
}

let lines = fs.existsSync(ENV_FILE) ? fs.readFileSync(ENV_FILE, "utf8").split("\n") : [];
const seen = new Set();
lines = lines.map((line) => {
  const m = line.match(/^([A-Z_]+)=/);
  if (m && updates.has(m[1])) {
    seen.add(m[1]);
    return `${m[1]}=${updates.get(m[1])}`;
  }
  return line;
});
for (const [key, value] of updates) {
  if (!seen.has(key)) lines.push(`${key}=${value}`);
}

fs.writeFileSync(ENV_FILE, lines.join("\n"));
console.error(`updated: ${[...updates.keys()].join(", ")}`);
