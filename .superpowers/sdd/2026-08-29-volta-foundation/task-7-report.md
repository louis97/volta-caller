# Task 7 Report: Mock-First API and Live Event Stream

## Delivered

- Added validated runtime configuration in `src/config/env.ts`. `VOLTA_MODE` only accepts `mock` or `live`; Twilio account SID and auth token must be supplied together when either is configured. Default mode remains `mock` and credentials are optional.
- Added `createMockScenario` in `src/mocks/callScenario.ts`. Each run creates a fresh seeded operation and store, registers the deterministic 8,500 MXN approved and 9,200 MXN over-cap quotes, records the unavailable third carrier, escalates the over-cap attempted commitment, and finalizes only the 8,500 MXN commitment using the reviewed recap finalizer with the active call ID and recipient.
- Added `createApp` in `src/server.ts` with `GET /health`, `GET /api/operation`, `POST /api/demo/run`, and typed SSE at `GET /api/events`.
- Added the end-to-end mock demo test in `tests/integration/mock-demo.test.ts`.

## RED Evidence

Command:

```text
PATH=/Users/lgualtero/.nvm/versions/node/v24.20.0/bin:$PATH npm test -- tests/integration/mock-demo.test.ts
```

Before implementation, Vitest failed to resolve `../../src/server` from `tests/integration/mock-demo.test.ts`; no HTTP application existed.

## GREEN Evidence

Focused test (run with the required local-loopback permission):

```text
Test Files  1 passed (1)
Tests       1 passed (1)
```

Full verification:

```text
npm test         Test Files 6 passed (6), Tests 28 passed (28)
npm run typecheck  passed for root, contracts, and frontend workspaces
npm run lint       passed
git diff --check   passed
```

## Self-review

- `POST /api/demo/run` replaces the scenario/store before executing it, so repeated mock runs do not retain prior quotes, briefs, commitments, or subscribers.
- External adapters are not constructed in mock mode; the scenario uses `MockSmsGateway` only.
- The finalizer receives the approved carrier's active call ID and the operation recipient (`mandate.escalationPhone`).
- SSE payloads retain the domain event `type` and use the same type as the SSE event name.
- The unavailable carrier is represented faithfully as a structured unavailable call brief rather than a fabricated quote price; the operation consequently retains two actual price quotes plus the unavailable call outcome.

## Concerns

- The supplied task-test snippet says there should be three quotes while also requiring one carrier to be unavailable. The existing `Quote` contract requires a numeric `priceMxn`, so this implementation preserves semantic integrity with two quotes and a third unavailable call brief. A dashboard can show all three carrier outcomes from `quotes`, `escalations`, and `callBriefs`.
- The local integration test needs loopback-listener permission in this sandbox; it is not a production dependency.

## Commits

- `04c6950` — contains the Task 7 API, scenario, and integration-test additions in the shared main snapshot.
- `5fa598f` — lint-safe subscription cleanup in `createMockScenario`.

## Round 1 Review Follow-up

### Root Cause and RED Evidence

The 9,200 MXN `commit_deal` route correctly escalated, but `createEscalation` used `new Date().toISOString()` inside the interpreter. The mock scenario supplied fixed times to the quote, brief, and commitment-finalizer paths, but not to that interpreter path. Two completed `POST /api/demo/run` operations therefore differed only in `escalations[0].requestedAt`.

The expanded integration regression test failed before the fix with:

```text
expected operation response to deeply equal the first run
requestedAt: "2026-08-29T20:26:54.947Z"
receivedAt:  "2026-08-29T20:26:54.955Z"
```

### Green and Full Evidence

`ToolDependencies` now accepts an optional `now` function with the previous real-time value as its runtime default. The mock scenario injects its deterministic run timestamp through every interpreter tool call.

The revised integration test now proves:

- `GET /health` returns the active mock-mode status;
- `GET /api/events` is an SSE stream with typed quote, escalation, and commitment event records;
- two demo runs produce identical operation payloads and replace, rather than append to, state;
- the third carrier is retained as an `unavailable` call brief;
- 9,200 MXN is retained as an over-cap quote/escalation while the only final commitment remains 8,500 MXN.

Commands after the fix:

```text
npm test -- tests/integration/mock-demo.test.ts   Test Files 1 passed (1), Tests 1 passed (1)
npm run typecheck                                 passed
npm run lint                                      passed
```
