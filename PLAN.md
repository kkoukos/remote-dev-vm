# /plan — plan directly on the agent

> **tl;dr:** one `/goal` ships one PR. `/plan` takes a *bigger* ask, chops it into a
> small **tree** of subplans, and fires the whole tree at your VM in one call.
> Independent pieces run in parallel in their own git worktrees; dependent pieces stack
> on top of their parent's branch. You register it and walk away — the VM keeps
> dispatching the rest on its own timer, even after your session ends. Still never
> merges. 💅

This is the deep-dive companion to the [`/plan` section of the README](README.md#plan-subplan-trees).
Read that first for the two-paragraph version; read this when you actually want to run it,
understand the tree model, or debug a stuck plan.

## When to use `/plan` vs `/goal`

| Use `/goal` when… | Use `/plan` when… |
|---|---|
| the change is one branch, one PR | the change is several PRs that build on each other |
| you can describe it in a sentence or two | you'd naturally break it into "first do A, then B and C off it" |
| you don't care about ordering | some pieces must land before others, and some are independent |

`/plan` is *interactive by design* — it asks clarifying questions before it dispatches
anything. `/goal` is fire-and-forget. If you find yourself writing a `/goal` with three
numbered phases in it, that's a `/plan`.

## The mental model: a tree, not a DAG

Every subplan may depend on **at most one** other subplan. That's not a limitation we
were too lazy to lift — it's the git model. Each subplan runs on its own branch
(`feat/<slug>`), and a stacked branch can only have **one** base. So:

- A **root** subplan (no `dependsOn`) branches off the repo's **default branch** and runs
  immediately.
- A **dependent** subplan branches off its **parent's branch** — but only *after* the
  parent's job finishes — and opens its PR with `--base <parent-branch>` (a stacked PR).

```
        ┌──────────── feat/api ───────────┐        (root: off main, runs now)
        │                                  │
   feat/ui (off feat/api)          feat/cli (off feat/api)   ← run in parallel once
        │                                                       api's job is done
   feat/docs (off feat/ui)
```

Independent subplans (`api` has no parent; `ui` and `cli` share one parent but not each
other) run **concurrently**. A chain (`api → ui → docs`) runs **in order**.

**Diamonds don't exist here.** If `D` genuinely needs both `A`'s and `B`'s work, you can't
give it two parents. Linearize: make `B` depend on `A`, and `D` depend on `B` — then say
so in `D`'s goal text so the agent knows why `A`'s changes are already present. The server
**rejects** a `dependsOn` array outright.

## The two moving parts

`/plan` is a thin interactive skill on top of three server endpoints. Knowing which is
which is the whole trick to using it:

1. **The `/plan` skill** (`skills/plan/SKILL.md`) — runs *interactively wherever you're
   already talking to Claude*: a terminal on the VM, VS Code, Cowork, your phone. It asks
   questions, drafts the subplan tree, shows you a table, and only then calls the server.
   It has **no local clone** assumption — it pulls repo context over HTTP.
2. **The agent-runner endpoints** (`agent-runner/server.mjs`) — the part that lives on the
   VM and does the actual dispatching over time:
   - `POST /plans` — register a whole subplan tree, dispatch whatever's ready now.
   - `GET  /plans/:id` — current status of every subplan (also nudges a dispatch pass).
   - `GET  /repos/:repo/context` — read `CLAUDE.md`/`README.md`/manifest + file list for a
     repo already on the VM, so a caller with no clone can gather context.

The skill is the friendly front door; the endpoints are the raw API you can hit with
`curl` if you'd rather drive it yourself.

## Using it — the skill path (recommended)

Once it's deployed (see [Enabling it](#enabling-it-on-the-vm) below):

```
/plan add a settings system: a settings API, a settings UI that calls it,
      and a CLI flag to dump settings as JSON
```

The skill will:

1. **Ask one focused round of questions** — target repo (existing or brand-new), must-have
   vs. nice-to-have scope, model/effort preference, and the endpoint + token if you haven't
   already established them in the conversation.
2. **Pull context** via `GET /repos/<repo>/context` (so it doesn't re-invent patterns that
   already exist). `{"exists": false}` tells it this is a 0→1 product that needs a bootstrap
   subplan.
3. **Draft the tree** and show you a compact table:

   | slug | depends on | repo | summary |
   |------|-----------|------|---------|
   | api  | —         | my-app | add a `/settings` GET/PUT endpoint |
   | ui   | api       | my-app | settings page that calls the API |
   | cli  | api       | my-app | `--dump-settings` flag → JSON |

4. **Wait for your confirmation** — edit, reorder, or reject before anything is registered.
   Nothing hits `POST /plans` until you say go.
5. **Register once**, then report the `planId`, the follow-up command, and a live status
   table — and make clear that dispatch continues on the VM whether or not the session
   stays open.

## Using it — the raw API

No skill needed; any authenticated caller can hit the endpoints directly. This is exactly
what the skill does under the hood.

### Register a plan (existing repo)

```bash
curl -H "Authorization: Bearer $TOKEN" -X POST https://code.example.com/agent/plans \
  -d '{"repo":"my-app","subplans":[
        {"slug":"api", "goal":"add a /settings GET+PUT API endpoint with a JSON store"},
        {"slug":"ui",  "goal":"add a settings page that reads/writes the /settings API", "dependsOn":"api"},
        {"slug":"cli", "goal":"add a --dump-settings flag that prints settings as JSON",  "dependsOn":"api"}
      ]}'
```

The response is the plan's current state. `api` is already `"dispatched"` with a `jobId`
and `branch` by the time the call returns; `ui` and `cli` are `"pending"` until `api`'s job
finishes.

### Register a plan (brand-new 0→1 product)

If the repo doesn't exist on the VM yet, **exactly one** subplan must carry `"create":true`
(or `"gitUrl"`). Every other subplan is automatically made to depend on it — you don't have
to wire that yourself:

```bash
curl -H "Authorization: Bearer $TOKEN" -X POST https://code.example.com/agent/plans \
  -d '{"repo":"new-app","subplans":[
        {"slug":"scaffold", "goal":"a Next.js app with a health route and Tailwind", "create":true},
        {"slug":"auth",     "goal":"add email magic-link auth"},
        {"slug":"billing",  "goal":"add Stripe checkout", "dependsOn":"auth"}
      ]}'
```

Here `scaffold` runs first (it's the creator), `auth` is auto-attached to it, and `billing`
stacks on `auth`. Nothing branches off a repo that has no first commit yet.

### Per-subplan options

Each subplan accepts the same optional fields as a single job — `runner`, `model`, `effort`,
`visibility`, `owner`, and `create`/`gitUrl` (on at most one subplan). The plan controls
`repo`/`branch`/`baseBranch`/`planId` itself; you don't set those per subplan.

### Check status

```bash
curl -H "Authorization: Bearer $TOKEN" https://code.example.com/agent/plans/<planId>
```

Returns every subplan's status, `jobId`, `branch`, `baseBranch`, and `prUrl` (once the job
opens one). **This GET also nudges a dispatch pass**, so it always reflects the freshest
state — but you don't need to poll for the plan to progress.

### Pull repo context (for a caller with no clone)

```bash
curl -H "Authorization: Bearer $TOKEN" https://code.example.com/agent/repos/<repo>/context
```

Returns `CLAUDE.md`/`README.md`/`package.json`/`pyproject.toml`/`go.mod`/`Cargo.toml`
contents (root only, capped) plus up to 200 tracked file paths — or `{"exists":false}` if
the repo isn't on the VM yet.

## Reading plan state

Each subplan is in one of five states:

| status | meaning |
|---|---|
| `pending` | waiting on a dependency, or waiting for a free dispatch slot |
| `dispatched` | its job is running (or queued) on the VM — has a `jobId` and `branch` |
| `done` | its job exited 0 and (usually) opened a PR |
| `failed` | its job exited non-zero or was cancelled |
| `blocked` | a parent (or ancestor) failed, so this will never run |

A transient dispatch hiccup (capacity limit, a git race) doesn't fail a subplan — it stays
`pending` with a `lastError` recorded and is retried on the next tick. **Only an actual job
failure blocks dependents.**

## Merging: order matters

Nothing auto-merges — same as `/goal`. But because dependent PRs are **stacked** (each
opened with `--base <parent-branch>`), review and merge them in **tree order — parents
before children**. If you merge `ui` before `api`, GitHub will show `ui`'s PR against a base
branch that no longer has the changes it was built on. Merge `api` → GitHub retargets `ui`'s
PR to the default branch automatically → then merge `ui`.

## Enabling it on the VM

The feature is split across **server code** (auto-deploys) and **skills** (manual copy).
Get both, or half of it silently won't work.

1. **Commit + push to `main`.** `server.mjs` and `runners/claude.sh` are *code*, so the
   [self-updater](README.md#self-updating) pulls and redeploys them within ~2 minutes —
   the `/plans` endpoints and worktree isolation come up on their own. No SSH needed for
   the server half.

2. **Install the updated skills where they run** — the self-updater redeploys the
   `agent-runner` code, **not** your `~/.claude/skills/`, so these are a manual `cp`:

   ```bash
   # On the VM (jobs run here — /goal now honors $BASE_BRANCH for stacked subplans):
   cp skills/goal/SKILL.md ~/.claude/skills/goal/
   mkdir -p ~/.claude/skills/plan && cp skills/plan/SKILL.md ~/.claude/skills/plan/
   ```

   - `skills/goal/SKILL.md` **must** be updated on the VM — the new version skips
     re-branching when `$BASE_BRANCH` is set and passes `--base` for stacked PRs. Without
     it, stacked subplans branch off `main` instead of their parent and the stacking breaks.
   - `skills/plan/SKILL.md` goes wherever you *invoke* `/plan`. Running it in a terminal on
     the VM? Install it on the VM. Running it from your laptop's `claude`? Install it there.
     Driving the raw API from Cowork by hand? You don't strictly need the skill at all.

3. **Force an update check** if you don't want to wait for the timer:

   ```bash
   systemctl start agent-selfupdate.service      # pull + redeploy + restart now
   journalctl -u agent-selfupdate.service -f     # watch it
   ```

4. **Sanity check** the endpoint is live:

   ```bash
   curl -H "Authorization: Bearer $TOKEN" https://code.example.com/agent/repos/<repo>/context
   ```

   A JSON body (not a 404) means the new server is up.

## Under the hood

- **Worktrees, not clones.** Each subplan gets a real `git worktree` at
  `REPOS_DIR/.worktrees/<repo>/feat/<slug>`, branched from its base. That's why independent
  subplans run concurrently instead of serializing behind `repoBusy` — they never touch the
  repo's one shared working tree, only shared git metadata (which is mutex-serialized during
  the fast add/remove step). The worktree is force-removed when the job ends; the **branch**
  is kept (the PR needs it).
- **Dispatch is a timer, not a request.** `POST /plans` dispatches whatever's ready and
  returns. A background tick (`PLAN_TICK_INTERVAL_MS`, default 20s) then keeps advancing the
  tree — marking finished jobs `done`, dispatching newly-unblocked dependents — with no
  client connected. Register the plan, close your laptop; the tree still finishes.
- **It survives an agent-runner restart.** Jobs are spawned detached and write their real
  exit code to a file; `reconcileJobs()` re-derives job status from disk on startup and every
  tick, so a job that finished (or the process that died) during a redeploy is finalized
  correctly — a plan never wedges because the server bounced mid-job.
- **Concurrency limits still apply.** Each token is capped at `MAX_CONCURRENT_PER_TOKEN`
  (default 5) running jobs; excess ready subplans stay `pending` and dispatch as slots free.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| `POST /plans` → 404 | server not updated yet — push landed but self-update hasn't run (`systemctl start agent-selfupdate.service`) |
| `dependsOn must be a single slug, not an array` | you tried to give a subplan two parents — linearize into a chain |
| `repo … does not exist … exactly one subplan must set create or gitUrl` | 0→1 plan with no bootstrap subplan |
| `repo … already exists … would collide` | you set `create`/`gitUrl` on a repo that's already on the VM |
| stacked subplan opened its PR against `main`, not its parent | the VM's `~/.claude/skills/goal/SKILL.md` is the old version — re-copy it (step 2 above) |
| subplan stuck `pending` with a `lastError` | transient (capacity/git race) — it retries each tick; check the error text |
| subplan `blocked` | an ancestor `failed`; fix and re-register the affected sub-tree |

## Safety

Everything from the [main README's Safety & cost](README.md#safety--cost) applies unchanged
— worktree jobs run under the same `dontAsk` permission mode and the same runner guardrails
as any other job. And the cardinal rule holds: **nothing merges itself.** Protect `main` with
branch protection and merge the stacked PRs yourself, parents first.
