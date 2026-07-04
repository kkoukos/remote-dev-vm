#!/usr/bin/env bash
# eval-poller — dispatch a post-merge evaluation for every newly-merged PR.
#
# For each watched repo it lists PRs merged to the default branch since a
# per-repo time cursor and enqueues one `eval` job per new PR on the local
# agent-runner API. The eval runner (runners/eval.sh → /eval) is read-only: it
# scores the merged change and comments the result back on the PR, so — unlike
# issue-poller — there is nothing to report back to here. Phase 2 just drops the
# finished jobs from the state file.
#
# Modeled on issue-poller.sh (same env-from-.env style, same local API, same
# TSV state files under AGENT_RUNNER_DATA, same two-phase detect/cleanup shape).
#
# Env (from ~/agent-runner/.env):
#   EVAL_POLLER_TOKEN   API token; falls back to AGENT_RUNNER_TOKEN (one required)
#   AGENT_RUNNER_TOKEN  fallback API token
#   EVAL_REPOS          space-separated "owner/repo" list to watch (empty = idle)
#   API                 default http://127.0.0.1:7777
#   REPOS_DIR           where repos are cloned, default ~/repos
#   AGENT_RUNNER_DATA   default ~/agent-runner-data

set -euo pipefail
TOKEN="${EVAL_POLLER_TOKEN:-${AGENT_RUNNER_TOKEN:-}}"
: "${TOKEN:?EVAL_POLLER_TOKEN or AGENT_RUNNER_TOKEN required}"
EVAL_REPOS="${EVAL_REPOS:-}"
API="${API:-http://127.0.0.1:7777}"
REPOS_DIR="${REPOS_DIR:-$HOME/repos}"
RUNNER="eval"                       # fixed — never the shared $RUNNER (issue-poller sets that to claude)
DATA="${AGENT_RUNNER_DATA:-$HOME/agent-runner-data}"
CURSORS="$DATA/eval-cursor.tsv"     # lines: owner/repo <TAB> ISO8601 mergedAt cursor
STATE="$DATA/eval-jobs.tsv"         # lines: owner/repo <TAB> PR# <TAB> job-id

[ -z "$EVAL_REPOS" ] && exit 0
mkdir -p "$DATA" "$REPOS_DIR"
touch "$CURSORS" "$STATE"
AUTH=(-H "Authorization: Bearer $TOKEN")

# ---- 1. detect newly-merged PRs and dispatch an eval each ------------------
now="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
for repo in $EVAL_REPOS; do
  # Per-repo cursor: the mergedAt of the newest PR we've already evaluated.
  cursor="$(awk -F'\t' -v r="$repo" '$1==r{print $2}' "$CURSORS" | tail -n1)"
  if [ -z "$cursor" ]; then
    # First time we see this repo: start the clock *now* so we don't evaluate
    # the entire back-catalog of already-merged PRs.
    printf '%s\t%s\n' "$repo" "$now" >> "$CURSORS"
    continue
  fi

  # New PRs merged to the default branch since the cursor, oldest first — so a
  # transient enqueue failure leaves the cursor *behind* the PRs we skipped and
  # they're retried on the next tick instead of being silently lost.
  # `|| true`: a transient gh failure (rate limit, network) for one repo must
  # skip that repo, not abort the whole run — otherwise `set -e`+`pipefail`
  # would kill the poller before the other repos and phase 2 get their turn.
  new="$(gh pr list -R "$repo" --state merged --base main --limit 100 \
         --json number,title,mergedAt,mergeCommit |
    jq -c --arg cur "$cursor" \
      '[ .[] | select(.mergedAt != null and .mergedAt > $cur) ]
       | sort_by(.mergedAt) | .[]')" || true
  [ -z "$new" ] && continue

  newcursor="$cursor"
  while read -r pr; do
    [ -z "$pr" ] && continue
    num=$(jq -r .number <<<"$pr")
    title=$(jq -r .title <<<"$pr")
    merged=$(jq -r .mergedAt <<<"$pr")

    # Idempotency: never double-dispatch a PR we're already tracking.
    if awk -F'\t' -v r="$repo" -v n="$num" '$1==r && $2==n{f=1} END{exit !f}' "$STATE"; then
      newcursor="$merged"
      continue
    fi

    payload=$(jq -n \
      --arg repo "${repo##*/}" \
      --arg gitUrl "https://github.com/$repo.git" \
      --arg goal "Evaluate merged PR #$num: $title" \
      --arg runner "$RUNNER" \
      '{repo:$repo, gitUrl:$gitUrl, goal:$goal, runner:$runner}')

    # `|| true`: under `set -e`+`pipefail` a failed POST (curl -f on a non-2xx,
    # e.g. the repo is busy) would otherwise exit the script here, before the
    # graceful break below ever runs. Leave job_id empty and handle it instead.
    job_id=$(curl -sf "${AUTH[@]}" -X POST "$API/jobs" -d "$payload" | jq -r .id) || true

    if [ -n "$job_id" ] && [ "$job_id" != "null" ]; then
      printf '%s\t%s\t%s\n' "$repo" "$num" "$job_id" >> "$STATE"
      newcursor="$merged"
    else
      # Couldn't enqueue (e.g. the repo is busy with another job). Stop here so
      # the cursor stays behind this PR and we retry it — and everything newer —
      # next tick, instead of skipping past it.
      echo "eval-poller: failed to enqueue eval for $repo#$num — will retry" >&2
      break
    fi
  done <<< "$new"

  # Advance the cursor to the newest PR we successfully handled.
  if [ "$newcursor" != "$cursor" ]; then
    tmp=$(mktemp)
    awk -F'\t' -v r="$repo" -v c="$newcursor" \
      'BEGIN{OFS="\t"} $1==r{next} {print} END{print r, c}' "$CURSORS" > "$tmp"
    mv "$tmp" "$CURSORS"
  fi
done

# ---- 2. drop finished eval jobs from the state file ------------------------
TMP=$(mktemp)
while IFS=$'\t' read -r repo num job_id; do
  [ -z "${job_id:-}" ] && continue
  job=$(curl -sf "${AUTH[@]}" "$API/jobs/$job_id" || echo '{}')
  status=$(jq -r '.status // "unknown"' <<<"$job")
  case "$status" in
    done|failed|cancelled) ;;   # finished — the eval runner already commented on the PR; just drop it
    *) printf '%s\t%s\t%s\n' "$repo" "$num" "$job_id" >> "$TMP" ;;   # still running (or server unreachable) — keep
  esac
done < "$STATE"
mv "$TMP" "$STATE"
