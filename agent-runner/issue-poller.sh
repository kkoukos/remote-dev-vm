#!/usr/bin/env bash
# issue-poller — GitHub issues as a universal job queue.
#
# Any agent (Cowork, phone, web) opens an issue labeled `agent-goal` →
# this poller enqueues it on the local agent-runner API, comments "started",
# and when the job finishes comments the result + PR link and labels `agent-done`.
#
# Env (from ~/agent-runner/.env):
#   AGENT_RUNNER_TOKEN  (required)
#   REPOS               space-separated "owner/repo" list to watch (required)
#   API                 default http://127.0.0.1:7777
#   REPOS_DIR           where repos are cloned, default ~/repos
#   RUNNER              default claude
#   AGENT_RUNNER_DATA   default ~/agent-runner-data

set -euo pipefail
: "${AGENT_RUNNER_TOKEN:?AGENT_RUNNER_TOKEN required}"
REPOS="${REPOS:-}"
API="${API:-http://127.0.0.1:7777}"
REPOS_DIR="${REPOS_DIR:-$HOME/repos}"
RUNNER="${RUNNER:-claude}"
DATA="${AGENT_RUNNER_DATA:-$HOME/agent-runner-data}"
STATE="$DATA/issue-jobs.tsv"   # lines: owner/repo <TAB> issue# <TAB> job-id

[ -z "$REPOS" ] && exit 0
mkdir -p "$DATA" "$REPOS_DIR"
touch "$STATE"
AUTH=(-H "Authorization: Bearer $AGENT_RUNNER_TOKEN")

# ---- 1. pick up new issues -------------------------------------------------
for repo in $REPOS; do
  for l in agent-goal agent-running agent-done; do
    gh label create "$l" -R "$repo" >/dev/null 2>&1 || true
  done

  gh issue list -R "$repo" --label agent-goal --state open \
      --json number,title,body,labels |
  jq -c '.[] | select([.labels[].name] | (contains(["agent-running"]) or contains(["agent-done"])) | not)' |
  while read -r issue; do
    num=$(jq -r .number <<<"$issue")
    title=$(jq -r .title <<<"$issue")
    body=$(jq -r '.body // ""' <<<"$issue")
    local_path="$REPOS_DIR/${repo##*/}"

    gh issue edit "$num" -R "$repo" --add-label agent-running

    payload=$(jq -n \
      --arg repo "$local_path" \
      --arg gitUrl "https://github.com/$repo.git" \
      --arg goal "$title"$'\n\n'"$body" \
      --arg runner "$RUNNER" \
      '{repo:$repo, gitUrl:$gitUrl, goal:$goal, runner:$runner}')

    job_id=$(curl -sf "${AUTH[@]}" -X POST "$API/jobs" -d "$payload" | jq -r .id)

    if [ -n "$job_id" ] && [ "$job_id" != "null" ]; then
      gh issue comment "$num" -R "$repo" -b "🤖 Started job \`$job_id\` (runner: $RUNNER)."
      printf '%s\t%s\t%s\n' "$repo" "$num" "$job_id" >> "$STATE"
    else
      gh issue comment "$num" -R "$repo" -b "⚠️ Failed to enqueue job — check agent-runner on the VM."
      gh issue edit "$num" -R "$repo" --remove-label agent-running
    fi
  done
done

# ---- 2. report finished jobs -----------------------------------------------
TMP=$(mktemp)
while IFS=$'\t' read -r repo num job_id; do
  [ -z "${job_id:-}" ] && continue
  job=$(curl -sf "${AUTH[@]}" "$API/jobs/$job_id" || echo '{}')
  status=$(jq -r '.status // "unknown"' <<<"$job")
  case "$status" in
    done|failed|cancelled)
      pr=$(jq -r '.prUrl // empty' <<<"$job")
      tail=$(jq -r '.logTail // ""' <<<"$job" | tail -c 1500)
      if [ "$status" = done ] && [ -n "$pr" ]; then
        msg="✅ Job \`$job_id\` finished — PR: $pr"
      else
        msg="${status^^}: job \`$job_id\`${pr:+ — PR: $pr}"$'\n\n```\n'"$tail"$'\n```'
      fi
      gh issue comment "$num" -R "$repo" -b "$msg"
      gh issue edit "$num" -R "$repo" --remove-label agent-running --add-label agent-done
      ;;
    *)
      printf '%s\t%s\t%s\n' "$repo" "$num" "$job_id" >> "$TMP"   # still running
      ;;
  esac
done < "$STATE"
mv "$TMP" "$STATE"
