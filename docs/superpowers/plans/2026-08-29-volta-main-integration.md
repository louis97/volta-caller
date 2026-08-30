# Volta Main Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Merge peers' latest `origin/main` work into the reviewed Volta backend history on a separate integration branch and report the unified project's status.

**Architecture:** The integration branch starts from the current local Volta tip, including the preserved Task 6 work. It merges `origin/main` without rewriting either history. Conflicts are resolved by retaining peer-owned UI/deployment features and adapting shared backend contracts and APIs, then validated through the repository's checks.

**Tech Stack:** Git, npm workspaces, TypeScript, Vitest, ESLint, Prettier.

**Spec:** docs/superpowers/specs/2026-08-29-volta-main-integration-design.md

## Global Constraints

- Preserve `backup/external-pull-20260829-1943` and `stash@{0}`; never apply or delete them during integration.
- Work only on `integration/volta-main`; do not rewrite, force-push, or directly merge into `main`.
- Fetch peers through `origin/main`; do not use `git pull` on the local branch.
- Retain the current Task 6 commit and its uncommitted expiry-state work for audit; do not claim its review findings are resolved unless verification proves it.
- Do not change the peer-owned reviewed-quote UI except where a compile or API contract requires a compatibility update.

---

### Task 1: Preserve Local Work and Create the Integration Branch

**Files:**
- Modify: tests/integration/selection.test.ts
- Modify: tests/unit/state.test.ts
- Create: docs/superpowers/integration/2026-08-29-pre-merge-status.md

**Interfaces:**
- Consumes: current local backend tip and interrupted Task 6 changes.
- Produces: a clean `integration/volta-main` branch based on a committed local snapshot.

- [ ] **Step 1: Capture the pre-merge state**

Run:

~~~bash
git status --short
git log --oneline -20
git diff -- tests/integration/selection.test.ts tests/unit/state.test.ts
~~~

Expected: the audit records the exact uncommitted Task 6 files before any branch operation.

- [ ] **Step 2: Verify the interrupted expiry-state change**

Run:

~~~bash
npm test -- tests/unit/state.test.ts tests/integration/selection.test.ts
~~~

Expected: the focused test result identifies whether the local expiry-state edit is coherent before it is committed.

- [ ] **Step 3: Commit the local snapshot and create the branch**

~~~bash
git add tests/integration/selection.test.ts tests/unit/state.test.ts docs/superpowers/integration/2026-08-29-pre-merge-status.md
git commit -m "test: preserve selection expiry regression"
git switch -c integration/volta-main
~~~

Expected: `git status --short` is clean and `git branch --show-current` prints `integration/volta-main`.

### Task 2: Fetch and Merge Peer Main

**Files:**
- Modify: only files reported by `git diff --name-only --diff-filter=U` during the merge.
- Create: docs/superpowers/integration/2026-08-29-conflict-resolution.md

**Interfaces:**
- Consumes: `integration/volta-main` and `origin/main`.
- Produces: one merge commit joining both histories, or an audit stating why the merge cannot safely complete.

- [ ] **Step 1: Fetch and inspect the merge base**

~~~bash
git fetch origin main
git merge-base HEAD origin/main
git log --left-right --cherry-pick --oneline HEAD...origin/main
~~~

Expected: the distinct Volta and peer commits are visible before merging.

- [ ] **Step 2: Start the non-committing merge**

~~~bash
git merge --no-commit --no-ff origin/main
~~~

Expected: either a clean staged merge or a finite set of explicitly listed conflicts.

- [ ] **Step 3: Resolve each conflict at its ownership boundary**

For each conflicted file, record this form in `docs/superpowers/integration/2026-08-29-conflict-resolution.md`:

~~~md
| File | Peer behavior retained | Volta behavior retained | Verification |
| --- | --- | --- | --- |
| path | exact UI/deployment/API behavior | exact mandate/agent behavior | exact command |
~~~

Resolve shared contracts additively. Resolve server routes so peer routes remain reachable and Volta's mandate/selection routes remain available. Resolve frontend calls against the final backend API rather than retaining duplicate state owners.

- [ ] **Step 4: Verify the merge before committing**

~~~bash
git diff --check
npm run typecheck
npm run lint
npm test
~~~

Expected: all checks pass; if a check fails, add a minimal regression test before changing implementation.

- [ ] **Step 5: Commit the integration**

~~~bash
git add -A
git commit -m "merge: integrate latest main into Volta"
~~~

### Task 3: Audit the Unified Project

**Files:**
- Create: docs/superpowers/integration/2026-08-29-unified-project-gap-report.md

**Interfaces:**
- Consumes: the verified integration branch and its test results.
- Produces: an evidence-based complete/incomplete/incompatible/deferred feature inventory.

- [ ] **Step 1: Inventory product surfaces**

Run:

~~~bash
rg -n "select-quote|reviewedDeal|confirm_selected_deal|ExceptionCallContext|Twilio|Realtime|ngrok" src frontend packages tests
~~~

Expected: all dashboard, backend, agent, telephony, and mock integration touchpoints are enumerated.

- [ ] **Step 2: Record feature status with evidence**

Use this exact table in the report:

~~~md
| Surface | Status | Evidence | Remaining work |
| --- | --- | --- | --- |
| Dashboard mandate entry | complete/incomplete/incompatible/deferred | file and test | concrete next step |
~~~

Include mandate entry, reviewed-quote selection, confirmation callback, exception flow, Realtime/Twilio boundary, mock demo, deployment configuration, tests, and Task 6 review findings.

- [ ] **Step 3: Run final checks and commit the audit**

~~~bash
npm run typecheck
npm run lint
npm test
npm run format:check
git add docs/superpowers/integration/2026-08-29-unified-project-gap-report.md
git commit -m "docs: audit unified Volta project"
~~~

Expected: the audit names every non-passing command and whether it is new or pre-existing.

## Plan Self-Review

- **Spec coverage:** Task 1 preserves current work, Task 2 merges peer history safely, and Task 3 delivers the required unified-project gap report.
- **Placeholder scan:** The plan contains no unresolved placeholders; merge conflicts are explicitly documented per file rather than guessed.
- **Type consistency:** The plan does not invent runtime interfaces; it requires compatibility validation against the final merged contracts and routes.
