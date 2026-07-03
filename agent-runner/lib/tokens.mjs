// lib/tokens.mjs — shared token store for agent-runner.
//
// Tokens are named, individually revocable, and scoped to a set of repo names
// (or "*" for all). Only a SHA-256 hash of each token is stored on disk — the
// plaintext is shown once at mint time and never persisted.

import fs from "node:fs";
import crypto from "node:crypto";

const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");

export function loadTokens(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return [];
  }
}

export function saveTokens(file, tokens) {
  fs.writeFileSync(file, JSON.stringify(tokens, null, 2), { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}

export function mintToken() {
  return crypto.randomBytes(32).toString("base64url");
}

export function hashToken(token) {
  return sha256(token);
}

// Timing-safe lookup: hash the presented token, then compare digests (not
// raw tokens) so neither the store nor a leaked log ever holds plaintext.
export function findToken(tokens, bearer) {
  if (!bearer) return null;
  const hashBuf = Buffer.from(hashToken(bearer));
  const rec = tokens.find((t) => {
    const tBuf = Buffer.from(t.hash);
    return tBuf.length === hashBuf.length && crypto.timingSafeEqual(tBuf, hashBuf);
  });
  if (!rec) return null;
  if (rec.expiresAt && Date.now() > Date.parse(rec.expiresAt)) return null;
  return rec;
}

export function canAccessRepo(identity, repoName) {
  if (!identity?.repos || identity.repos.includes("*")) return true;
  return identity.repos.includes(repoName);
}
