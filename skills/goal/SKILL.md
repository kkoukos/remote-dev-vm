---
name: goal
description: Autonomously take a feature from scratch to an open GitHub PR — plan, implement, test, commit, push, open the PR. Invoked with /goal <feature description>. Never merges.
disable-model-invocation: true
---

# /goal — feature to open PR, end to end

The text after `/goal` is the feature goal. Complete it fully and finish by opening a
GitHub PR. Work autonomously — do not stop to ask questions unless truly blocked.

## Hard rules (never break these)

- **Never merge the PR.** Your job ends when the PR is open. Do not run `gh pr merge`.
- Never commit or push to `main`/`master` directly. Never force-push.
- Never commit secrets, `.env` files, or credentials.
- Follow the repo's own rules: if a `CLAUDE.md` exists, obey it — including any
  approval gates or forbidden files it defines. If the goal requires a change the
  repo's rules forbid, stop, and say so in your final report instead of doing it.

## Workflow

1. **Understand the repo.** Read `CLAUDE.md` / `README.md` / `CONTRIBUTING.md`. Detect
   package manager, test command, lint/typecheck commands, and branch conventions.
   If the repo has zero commits, this is the wrong skill — use `/bootstrap` instead.
2. **Sync and branch.**
   - `git fetch origin && git checkout main && git pull` (or `master`)
   - Create `feat/<short-kebab-slug>` from the up-to-date default branch.
3. **Plan.** Break the goal into concrete steps. Search the codebase for existing
   patterns, hooks, services, and types to reuse — do not reinvent what exists.
4. **Implement incrementally.** After each coherent unit of work, run the relevant
   tests. Write new tests for new behavior. Match existing code style exactly.
5. **Verify everything.** Before pushing, run the full check suite the repo defines
   (e.g. `lint`, `typecheck`, `test`, `build`). Fix failures — do not push red.
6. **Commit and push.** Small, logical commits with conventional messages
   (`feat: …`, `test: …`). Then `git push -u origin <branch>`.
7. **Open the PR.**
   ```
   gh pr create --title "<concise title>" --body "<body>"
   ```
   PR body must include: **Summary** (what and why), **Changes** (bullet list of key
   changes), **Testing** (what you ran and results), and **Notes** (tradeoffs,
   follow-ups, anything needing reviewer attention).
8. **Report.** End your response with the PR URL, a 3-line summary, and any items
   that need human review (e.g. approval-gated changes you avoided).

## If blocked

If auth is missing (`gh auth status` fails), tests can't run, or the goal is
impossible without breaking a hard rule: stop, leave the branch pushed if there is
useful work, and clearly report what's blocking and what a human must do.
