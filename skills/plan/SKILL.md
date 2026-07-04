---
name: plan
description: Turn a feature idea into a tree of independent/dependent subplans and dispatch them to the agent-runner VM — parallel where possible, stacked where dependent. Invoked with /plan <idea>. Asks clarifying questions, then registers the whole tree in one call; the VM keeps dispatching dependents on its own after this session ends.
disable-model-invocation: true
---

# /plan — idea to dispatched subplan tree

The text after `/plan` describes a feature or product. Turn it into a small
number of self-contained subplans with an explicit dependency tree, confirm
the breakdown with the user, then register the whole tree with
`agent-runner` in one call. Unlike `/goal`, this skill is meant to run
*interactively* — ask questions, don't guess at scope.

## Hard rules (never break these)

- Never call `agent-runner` endpoints without an explicit repo + token the
  user has confirmed for this run.
- Never register a plan the user hasn't seen and confirmed the subplan table
  for.
- Subplans form a **tree**, not a general dependency graph: each subplan may
  `dependsOn` at most one other subplan. A stacked git branch only has one
  base — a subplan that genuinely needs two independent parents' work must
  be re-sequenced into a chain (A → B → D), never registered as a
  multi-parent edge. `agent-runner` rejects `dependsOn` arrays outright.
- Don't explore the repo by trying to read local files — the session running
  this skill may have no local clone at all (phone, Cowork). Use
  `GET /repos/:repo/context` instead (step 3).

## Workflow

1. **Understand the ask.** Read the text after `/plan`.
2. **Ask clarifying questions**, one focused round — don't interrogate:
   - Target repo (existing product, or a brand-new one that doesn't exist on
     the VM yet).
   - Must-have vs. nice-to-have scope, and any hard constraints.
   - Model/effort preference for the subplan jobs (see `/goal`'s
     [Choosing model & effort](../../README.md#choosing-model--effort)).
   - The agent-runner endpoint and bearer token, if not already established
     earlier in this conversation.
3. **Explore context**, if a repo is named:
   ```
   curl -H "Authorization: Bearer $TOKEN" https://<endpoint>/repos/<repo>/context
   ```
   `{"exists": false}` means this is a brand-new product — the plan needs a
   bootstrap subplan (`create` or `gitUrl`, no `dependsOn`) that every other
   subplan will end up depending on. Otherwise, use the returned
   `CLAUDE.md`/`README.md`/manifest contents and file tree to avoid
   duplicating existing patterns, services, or types in the subplans you
   draft.
4. **Draft subplans as a tree.** For each: a `slug` (`^[a-z0-9-]+$`, becomes
   part of its branch name), a short title, a self-contained `goal` (this
   text becomes the job's `goal` field verbatim — write it the way you'd
   write a `/goal` invocation, since that's literally what runs), and
   `dependsOn` (another subplan's slug, or omitted for a root subplan).
   - If the repo doesn't exist yet, exactly one subplan carries
     `create:true` (or `gitUrl`) and no other fields need to declare
     `dependsOn` on it explicitly — the server attaches every other root
     subplan to it automatically. Only set `dependsOn` yourself for a
     genuine content dependency between two feature subplans.
   - If the natural shape of the request is a diamond (D needs both A's and
     B's work), don't register two parents — linearize: make B depend on A,
     and D depend on B, and say so plainly in D's goal text so the agent
     doesn't have to guess why B's changes are already there.
5. **Confirm with the user** before registering anything — a compact table:

   | slug | depends on | repo | summary |
   |------|-----------|------|---------|

   Let the user edit, reject, or reorder before you proceed.
6. **Register once.**
   ```
   curl -H "Authorization: Bearer $TOKEN" -X POST https://<endpoint>/plans \
     -d '{"repo": "<repo>", "subplans": [
           {"slug": "a", "goal": "...", "dependsOn": null},
           {"slug": "b", "goal": "...", "dependsOn": "a"}
         ]}'
   ```
   The response is the plan's current state — root subplans (and, for a
   brand-new repo, the bootstrap subplan) are already `"dispatched"` with a
   `jobId`/`branch` by the time this call returns. Everything with an unmet
   dependency is `"pending"`.
7. **Report.** Give the user:
   - The `planId`, and the exact follow-up command:
     `GET https://<endpoint>/plans/<planId>`.
   - A table: slug → status → job id → branch → base → PR URL (once known).
   - State plainly that **dispatch continues on the VM whether or not this
     session stays open** — `agent-runner` re-checks the plan on its own
     timer and dispatches each dependent subplan as soon as its parent's job
     finishes. There is nothing further to do here unless a subplan fails.
   - Restate: nothing auto-merges, and dependent subplans' PRs are stacked
     on their parent's branch — merge PRs in dependency order (a parent
     before its children).
   - Optionally, poll `GET /plans/<planId>` a few times (every ~60s is
     plenty — jobs run minutes, not seconds) to give a live readout before
     ending the turn, but say clearly that this polling is optional, not
     required for the plan to keep progressing.

## If blocked

If the agent-runner endpoint or token is missing, if no repo signal exists
at all, or if the request is too vague to decompose into concrete subplan
goals: stop and ask, rather than guessing at scope or inventing a repo name.
