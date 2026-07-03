---
name: bootstrap
description: Take a brand-new, empty repo from nothing to a working v1 product — scaffold, implement, commit, push. Invoked with /bootstrap <product description>. Pushes the initial version straight to main since there is nothing to protect yet; all work after that goes through /goal.
disable-model-invocation: true
---

# /bootstrap — empty repo to working v1

The text after `/bootstrap` describes the product to build. This repo was just
created and has zero commits — no existing code, no `main` history, and
usually no `CLAUDE.md` yet. Get it from nothing to a working, runnable first
version.

## Hard rules (never break these)

- Never commit secrets, `.env` files, or credentials.
- Build a real, working v1 — don't stub out fake functionality. Prefer a
  small, genuinely working slice over a large half-implemented one.
- Never push to any repo other than the one you're in.

## Workflow

1. **Confirm it's actually empty.** `git log` should fail or be empty. If the
   repo already has commits, stop — this is a job for `/goal`, not `/bootstrap`.
2. **Pick a stack.** If the goal specifies a stack or framework, use it.
   Otherwise choose something conventional and well-supported for the product
   type (a web app → a standard full-stack framework; a CLI → the ecosystem's
   usual tooling). Don't over-engineer — pick the simplest stack that fits.
3. **Scaffold.** Initialize the project, add `.gitignore`, `README.md` (what
   the product is, how to run it, how to test it), a license only if asked
   for one, and a basic CI workflow (install, lint, test) if the platform
   makes that easy (e.g. GitHub Actions).
4. **Implement a working v1.** Build enough real functionality to run and
   demonstrate the core value of the product goal — not a placeholder. Write
   tests for it.
5. **Verify.** Install deps, run lint/typecheck/tests/build. Fix failures
   before committing — don't ship red.
6. **Commit and push directly to `main`/`master`.** There is no history to
   protect and no PR reviewer for a repo's first commit — small logical
   commits are fine, then `git push -u origin main`. Do not open a PR for
   this initial push.
7. **Report.** End with the repo state (what got built, stack chosen, how to
   run it locally, what's tested), and 2-3 concrete suggestions for next
   features. Note that further work should go through `/goal` (branch + PR)
   from here on.

## If blocked

If `gh`/`git` auth is missing, or the goal is too vague to pick a stack or
scope a v1 (e.g. no product description at all): stop and report exactly
what's missing rather than guessing at requirements.
