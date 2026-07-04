---
name: eval
description: Read-only post-merge evaluation of a merged GitHub PR — score the change 0-5 against a rubric, list concrete issues/risks with severity, post the result as a PR comment, and log it. Invoked with /eval <repo context + merged PR number>. Never modifies the codebase; opens an issue only when the score is 2 or lower.
disable-model-invocation: true
---

# /eval — read-only evaluation of a merged PR

The text after `/eval` names a merged PR number (e.g. "evaluate PR #12") in the repo
you are running in (already on this VM). Evaluate what that PR actually changed,
post the evaluation back on the PR, and log it. Work autonomously — do not stop to
ask questions unless truly blocked.

## Hard rules (never break these)

- **Strictly read-only toward the codebase.** Never create a branch, never commit,
  never push, never open a PR, never modify, create, or delete any file inside the
  repo. Your only outputs are: a PR comment, an entry in the eval log (outside the
  repo), and — for low scores only — a GitHub issue.
- Never merge, close, reopen, or revert anything.
- Never post secrets, `.env` contents, or credentials in comments or issues.

## Workflow

1. **Identify the PR.** Extract the PR number `<n>` from the goal text. Confirm it
   exists and is merged: `gh pr view <n> --json number,title,state,mergedAt,mergeCommit,body`.
   If it is not merged yet, evaluate the diff anyway but say so in the comment.
2. **Get the diff.** Prefer `gh pr diff <n>`. If that fails (e.g. rate limit),
   fall back to the merge commit: `git fetch origin && git show <mergeCommit>`
   (or `git diff <mergeCommit>^1 <mergeCommit>` for a true merge commit).
3. **Understand the intent.** Read the PR title/body and any linked issue to know
   what the change was *supposed* to accomplish, then read the surrounding code
   (read-only) as needed to judge the diff in context.
4. **Evaluate.** Produce a structured evaluation:
   - **Overall score (0–5)** per the rubric below, judging what the change
     accomplished relative to its stated goal.
   - **Issues & risks** — a bulleted list of *concrete* findings: bugs, security
     concerns, missing tests, performance problems, questionable tradeoffs. Each
     bullet gets a rough severity tag: `[high]`, `[medium]`, or `[low]`. If there
     are genuinely none, say so explicitly rather than inventing filler.
5. **Post the comment.** Comment the evaluation on the PR:
   ```
   gh pr comment <n> --body "<evaluation markdown>"
   ```
   Format: a heading like `## 🤖 Agent evaluation — score: X/5`, a one-paragraph
   summary of what the change accomplished, then the issues/risks bullet list.
6. **Append to the eval log.** Write the *same* record to
   `${AGENT_RUNNER_DATA:-~/agent-runner-data}/evals/<repo>-<n>.md` (create the
   `evals/` directory if needed; `<repo>` is the bare repo directory name). Prefix
   the record with a line noting the date and the PR URL. This directory is outside
   the repo, so writing it does not violate the read-only rule.
7. **Low score → open an issue.** If and only if the score is **2 or lower**, open
   a GitHub issue summarizing the concerns so a human (or a follow-up `/goal`) can
   act on them:
   ```
   gh issue create --label agent-eval \
     --title "Eval: PR #<n> scored <X>/5 — <short reason>" \
     --body "<summary of concerns + link to PR #<n>>"
   ```
   If the `agent-eval` label doesn't exist, create it first
   (`gh label create agent-eval --description "Opened by /eval" || true`).
   **Never** use the `agent-goal` label — that would trigger the issue poller and
   start an unrequested job.
8. **Report.** End your response with the score, the PR comment URL, the eval log
   path, and the issue URL if one was opened.

## Scoring rubric (0–5)

| Score | Meaning |
|-------|---------|
| 5 | Fully accomplishes the stated goal; correct, tested, no meaningful risks. |
| 4 | Accomplishes the goal; minor gaps (e.g. a missing edge-case test or small style issues), nothing that needs urgent follow-up. |
| 3 | Mostly accomplishes the goal, but has notable gaps — weak/missing tests, unhandled edge cases, or a debatable design tradeoff worth revisiting. |
| 2 | Partially accomplishes the goal, or works but introduces a real bug/security/performance risk that needs follow-up. |
| 1 | Barely addresses the goal, or the risks introduced outweigh what it delivers. |
| 0 | Does not accomplish the goal at all, is broken, or is actively harmful. |

Scores of 2 or lower open an `agent-eval` issue (step 7); 3 and above only comment
and log.

## If blocked

If auth is missing (`gh auth status` fails), the PR number can't be found, or the
diff can't be fetched by either method: stop and clearly report what's blocking and
what a human must do. Do not guess at a PR number.
