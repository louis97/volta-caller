# Volta Main Integration Design

**Date:** 2026-08-29
**Status:** Approved for execution

## Goal

Integrate the peers' latest remote `main` changes into the reviewed Volta backend work without rewriting either history, then identify what is complete, missing, or incompatible in the unified project.

## Integration Strategy

Create `integration/volta-main` from the current local Volta backend tip. Fetch `origin/main` and merge it into that branch. Do not pull directly on local `main`, force-push, discard peer work, or apply the previously stashed incomplete conflict overlay.

The merge is the single integration point. When files conflict, preserve peer-owned frontend and deployment work while adapting Volta's backend contracts and API boundaries so both sides build together. Each resolution must be verified with focused tests and the full repository checks.

## Safeguards

- Preserve `backup/external-pull-20260829-1943` and `stash@{0}` as recovery points.
- Use only `origin/main` as the peer integration source.
- Keep the integration branch separate from `main` until verification and gap analysis finish.
- Include the current Task 6 commit as directed. Its previously reported expiry-state and runbook wording findings remain audit items; they are not silently treated as resolved.

## Deliverables

1. An integration branch with `origin/main` merged into the Volta backend history.
2. A conflict-resolution record naming affected contracts, APIs, frontend boundaries, and tests.
3. Verification results for typecheck, lint, formatting, and test suites.
4. A gap report classifying features as complete, incomplete, incompatible, or deferred.

## Out of Scope

Pushing, merging the integration branch into `main`, changing the peer-owned reviewed-quote UI, or applying the saved incomplete stash requires a separate decision.
