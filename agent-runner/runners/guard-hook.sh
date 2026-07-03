#!/usr/bin/env bash
# PreToolUse hook for the Bash tool, wired in via claude-settings.json.
#
# claude-settings.json's permissions.deny already blocks the common, literal forms of
# these commands via prefix matching (e.g. `Bash(rm -rf *)`). Prefix matching only
# looks at the start of a command (or right after && / || / ; / |), so it misses
# compound, reordered, or piped variants — `cd /tmp && rm -rf .`, `git push origin
# --force`, `curl install.sh | bash`. This hook catches those with regex over the
# full command string.
#
# This is defense-in-depth, not a sandbox: a determined adversarial prompt could
# still find phrasing that slips past regex heuristics. For untrusted input, use
# Anthropic's reference devcontainer (default-deny firewall) instead — see
# README.md "Safety & cost".
#
# Protocol: Claude Code pipes {"tool_name":..., "tool_input":{"command": "..."}, ...}
# on stdin. Emitting the JSON below denies the call; exiting 0 with no output allows
# it to fall through to normal permission evaluation.

input="$(cat)"
tool="$(jq -r '.tool_name // empty' <<<"$input" 2>/dev/null)"
[ "$tool" = "Bash" ] || exit 0
cmd="$(jq -r '.tool_input.command // empty' <<<"$input" 2>/dev/null)"
[ -n "$cmd" ] || exit 0

deny() {
  jq -n --arg reason "$1" \
    '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"deny",permissionDecisionReason:$reason}}'
  exit 0
}

# --- nuking the repo ---
# rm -rf detection: recursive-flag and force-flag can appear combined (-rf, -fr),
# separate (-r -f), or long-form (--recursive --force), in either order — so check
# for "a recursive-ish flag" AND "a force-ish flag" anywhere in the command rather
# than one fixed flag ordering.
if grep -qE '\brm\b' <<<"$cmd" \
   && grep -qiE '(^|[[:space:]])-[a-z]*r[a-z]*([[:space:]]|$)|--recursive\b' <<<"$cmd" \
   && grep -qiE '(^|[[:space:]])-[a-z]*f[a-z]*([[:space:]]|$)|--force\b' <<<"$cmd"; then
  deny "Recursive force-delete (rm -rf and variants) is blocked by guardrail."
fi
if grep -qiE '\bgit[[:space:]]+(reset[[:space:]]+--hard|clean[[:space:]]+-[a-z]*f[a-z]*\b|filter-branch|filter-repo)\b' <<<"$cmd"; then
  deny "Destructive git history/working-tree rewrite is blocked by guardrail."
fi
if grep -qiE '\bgit[[:space:]]+push\b[^&|;]*(--force\b|(^|[[:space:]])-f([[:space:]]|$)|--delete\b)' <<<"$cmd" \
   || grep -qiE '\bgit[[:space:]]+push\b[^&|;]*:[[:alnum:]/_-]*[[:space:]]*($|[&|;])' <<<"$cmd"; then
  deny "Force-push or remote-branch delete is blocked by guardrail."
fi
# Case-sensitive on purpose: -D is force-delete-even-if-unmerged, -d is the safe
# delete-only-if-merged form. Folding case here would block the safe form too.
if grep -qE '\bgit[[:space:]]+branch\b[^&|;]*(-[a-zA-Z]*D\b|--delete[[:space:]]+--force\b|--force[[:space:]]+--delete\b)' <<<"$cmd"; then
  deny "Force branch delete is blocked by guardrail."
fi

# --- making an EXISTING repo public (or deleting it) ---
# `gh repo create ... --public` is intentionally NOT blocked here: server.mjs's
# create:true + visibility:"public" is a human-chosen field for a brand-new
# repo with nothing to protect yet (see the 0->1 flow in README.md). The risk
# this guards against is an agent flipping visibility on an EXISTING repo
# mid-task, which only ever happens via `gh repo edit` / `gh api`, never `create`.
if grep -qiE '\bgh[[:space:]]+repo[[:space:]]+edit\b[^&|;]*(--visibility[[:space:]]+public|--public\b)' <<<"$cmd" \
   || grep -qiE '\bgh[[:space:]]+api\b[^&|;]*(visibility[^&|;]*public|private[^&|;]*false)' <<<"$cmd" \
   || grep -qiE '\bgh[[:space:]]+repo[[:space:]]+delete\b' <<<"$cmd"; then
  deny "Changing an existing repo's visibility, or deleting it, is blocked by guardrail — a human must do this."
fi

# --- reading secrets (Doppler is the source of truth; .env* shouldn't be read) ---
if grep -qiE "(^|[/[:space:]'\"(])\\.env(\\.(local|development(\\.local)?|production(\\.local)?|staging(\\.local)?|test(\\.local)?))?([/[:space:]'\")]|\$)" <<<"$cmd" \
   && ! grep -qiE '\.env\.(example|sample|template|dist|defaults)\b' <<<"$cmd" \
   && grep -qiE '\b(cat|less|more|head|tail|strings|xxd|base64|python[0-9.]*|node|perl|ruby|cp|scp)\b' <<<"$cmd"; then
  deny "Reading .env-style secret files is blocked by guardrail — secrets are managed by Doppler; use 'doppler run --' to inject them at runtime instead."
fi
if grep -qiE '\bdoppler[[:space:]]+(secrets[[:space:]]+(download|get)|configure|login)\b' <<<"$cmd"; then
  deny "Doppler secret-value / re-auth commands are blocked by guardrail."
fi
if grep -qiE '(^|&&|\|\||;)[[:space:]]*(env|printenv)[[:space:]]*($|[|;&>])' <<<"$cmd" \
   || grep -qiE '(^|&&|\|\||;)[[:space:]]*export[[:space:]]+-p\b' <<<"$cmd"; then
  deny "Dumping the process environment is blocked by guardrail (may expose Doppler-injected secrets)."
fi
if grep -qiE '\.(aws/credentials|ssh/id_[a-z]+|npmrc|netrc)\b' <<<"$cmd" \
   && grep -qiE '\b(cat|less|more|head|tail|cp|scp)\b' <<<"$cmd"; then
  deny "Reading credential files is blocked by guardrail."
fi

# --- sudo: scoped to package-manager installs, not a blanket root escalation ---
# Jobs are allowed to install new interpreters/tools (python, node versions, global
# libraries, etc.) — including via apt/yum/dnf/snap/dpkg/npm -g, which need root on
# the VPS (the Docker/Railway image already runs as root, so sudo never appears
# there). What's still blocked is using sudo for anything else — `sudo rm`, `sudo
# cat`, `sudo bash`, `sudo su` — so root access doesn't become a back door around
# the nuke/secrets guardrails above (those checks match regardless of a sudo
# prefix, but there's no reason to allow arbitrary root commands at all).
if grep -qiE '\bsudo\b' <<<"$cmd" \
   && ! grep -qiE '\bsudo[[:space:]]+(apt(-get)?|yum|dnf|snap)[[:space:]]+(install|upgrade)\b' <<<"$cmd" \
   && ! grep -qiE '\bsudo[[:space:]]+dpkg[[:space:]]+-i\b' <<<"$cmd" \
   && ! grep -qiE '\bsudo[[:space:]]+(npm|yarn|pnpm)[[:space:]]+(install|add|i)\b' <<<"$cmd" \
   && ! grep -qiE '\bsudo[[:space:]]+pip[0-9]?[[:space:]]+install\b' <<<"$cmd"; then
  deny "sudo is only allowed for package-manager installs on this unattended runner (apt/yum/dnf/snap/dpkg/npm/pip install) — not for '$cmd'."
fi

exit 0
