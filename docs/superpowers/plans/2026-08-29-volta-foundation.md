# Volta Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a locally runnable, mock-first Volta monorepo that demonstrates mandate-safe parallel carrier negotiation, commitment auditing, and a live dashboard.

**Architecture:** The root npm workspace is an Express TypeScript API; `frontend` is a Next.js dashboard; `packages/contracts` is the dependency-light source of shared domain contracts. The API owns state and emits typed operation events. Twilio, OpenAI Realtime, and SMS are adapter interfaces with deterministic mock implementations selected by default.

**Tech Stack:** Node.js 20+, TypeScript, npm workspaces, Express, `ws`, Zod, Vitest, Next.js, React, Tailwind CSS, Twilio SDK, OpenAI Realtime WebSocket protocol, ESLint, Prettier, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-08-29-volta-foundation-design.md`

## Global Constraints

- The default run mode is local and mock-first; no Twilio or OpenAI credential is required for unit tests or the dashboard demo.
- The mandate is inviolable: price must be at or below 9,000 MXN and pickup must be Thursday at 10:00 AM.
- Only the API may mutate operation state or retain a mandate. The dashboard submits a mandate only
  through `POST /api/mandates` and then reads the canonical operation back from the API; local form
  state, local storage, and optimistic UI are never sources of truth.
- A final commitment requires both an audio timestamp reference and a written-recap record.
- Unavailable services, invalid events, conflicting terms, and recap failures must result in explicit recoverable state and a call-brief entry.
- Real Twilio/OpenAI smoke tests remain opt-in and are excluded from default CI.
- Workspaces share types only through `@volta/contracts`; do not import another workstream’s internal files.

---

## File Structure

```text
package.json                         root scripts and npm workspaces
tsconfig.json                        strict API TypeScript configuration
src/config/env.ts                    validated runtime configuration
src/core/mandate.ts                  deterministic mandate evaluator
src/core/state.ts                    in-memory operations and event stream
src/core/seed.ts                     Textiles Pacífico operation and three carriers
src/agent/*                          Volta prompt, schemas, and tool interpreter
src/audit/*                          commitments, recaps, and call briefs
src/telephony/*                      Twilio and media-stream adapters
src/mocks/*                          mock voice, SMS, and telephony adapters
src/server.ts                        HTTP API and server-sent event stream
packages/contracts/src/index.ts      shared entities, events, and API DTOs
frontend/*                           Next.js dashboard and audit detail views
tests/unit/*                         unit tests for each backend boundary
tests/integration/mock-demo.test.ts  complete mock negotiation test
.github/*                            CI and pull-request workflow
```

### Task 1: Establish Workspaces and Developer Tooling

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `.editorconfig`, `.prettierrc.json`, `eslint.config.mjs`, `.gitignore`, `.env.example`
- Create: `frontend/package.json`, `frontend/tsconfig.json`, `frontend/next.config.ts`, `frontend/tailwind.config.ts`
- Create: `packages/contracts/package.json`, `packages/contracts/tsconfig.json`

**Consumes:** Node.js 20+ and npm workspaces.

**Produces:** `npm run lint`, `npm run typecheck`, `npm test`, and `npm run dev`; workspace package `@volta/contracts`.

- [ ] **Step 1: Write the root workspace manifest**

```json
{
  "name": "volta-caller",
  "private": true,
  "workspaces": ["frontend", "packages/*"],
  "scripts": {
    "dev": "concurrently -n api,web -c cyan,magenta \"npm:dev:api\" \"npm:dev:web\"",
    "dev:api": "tsx watch src/server.ts",
    "dev:web": "npm --workspace frontend run dev",
    "lint": "eslint .",
    "typecheck": "tsc --noEmit && npm --workspace @volta/contracts run typecheck && npm --workspace frontend run typecheck",
    "test": "vitest run",
    "format:check": "prettier --check ."
  }
}
```

- [ ] **Step 2: Install the declared dependencies**

Run: `npm install`

Expected: a root lockfile is created and `npm --workspace @volta/contracts run typecheck` resolves the shared workspace.

- [ ] **Step 3: Verify the empty workspace**

Run: `npm run typecheck && npm run lint && npm test`

Expected: all three commands exit successfully before product code exists.

- [ ] **Step 4: Commit the tooling foundation**

```bash
git add package.json package-lock.json tsconfig.json vitest.config.ts .editorconfig .prettierrc.json eslint.config.mjs .gitignore .env.example frontend packages/contracts
git commit -m "chore: initialize Volta workspaces and tooling"
```

### Task 2: Define Shared Domain Contracts and Demo Seed Data

**Files:**
- Create: `packages/contracts/src/index.ts`, `src/core/seed.ts`
- Test: `tests/unit/contracts.test.ts`

**Consumes:** `@volta/contracts` from Task 1.

**Produces:** `Mandate`, `Operation`, `Quote`, `CallSession`, `Commitment`, `CallBrief`, `Escalation`, `OperationEvent`, and `seedOperation()`.

- [ ] **Step 1: Write the failing contract test**

```ts
import { THURSDAY_PICKUP, seedOperation } from "../../src/core/seed";

it("seeds three carrier candidates under one Textiles Pacífico operation", () => {
  const operation = seedOperation();
  expect(operation.containerId).toBe("MSCU-TP-001");
  expect(operation.mandate.maxPriceMxn).toBe(9000);
  expect(operation.candidates).toHaveLength(3);
  expect(operation.mandate.pickupTime).toBe(THURSDAY_PICKUP);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -- tests/unit/contracts.test.ts`

Expected: FAIL because the shared entities and seed function do not exist.

- [ ] **Step 3: Implement the shared contracts and deterministic seed**

```ts
export type Mandate = { maxPriceMxn: number; pickupTime: string; escalationPhone: string };
export type OperationEvent =
  | { type: "quote.registered"; operationId: string; quote: Quote }
  | { type: "commitment.finalized"; operationId: string; commitment: Commitment }
  | { type: "escalation.requested"; operationId: string; escalation: Escalation };
```

- [ ] **Step 4: Verify the contract boundary**

Run: `npm test -- tests/unit/contracts.test.ts && npm run typecheck`

Expected: PASS.

- [ ] **Step 5: Commit the domain contract**

```bash
git add packages/contracts/src/index.ts src/core/seed.ts tests/unit/contracts.test.ts
git commit -m "feat: add shared drayage domain contracts"
```

### Task 3: Implement the Inviolable Mandate Evaluator

**Files:**
- Create: `src/core/mandate.ts`
- Test: `tests/unit/mandate.test.ts`

**Consumes:** `Mandate` from `@volta/contracts`.

**Produces:** `evaluateMandate(mandate, terms): MandateDecision`, whose status is `APPROVED`, `REJECTED`, or `REQUIRES_ESCALATION`.

- [ ] **Step 1: Write the failing guardrail test**

```ts
it.each([
  [8500, "2026-09-03T10:00:00-06:00", "APPROVED"],
  [9001, "2026-09-03T10:00:00-06:00", "REQUIRES_ESCALATION"],
  [8500, "2026-09-04T10:00:00-06:00", "REQUIRES_ESCALATION"],
])("evaluates %i MXN at %s as %s", (price, pickupTime, status) => {
  expect(evaluateMandate(mandate, { price, pickupTime }).status).toBe(status);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -- tests/unit/mandate.test.ts`

Expected: FAIL because `evaluateMandate` does not exist.

- [ ] **Step 3: Implement explicit decision codes**

```ts
export function evaluateMandate(mandate: Mandate, terms: { price: number; pickupTime: string }): MandateDecision {
  if (!Number.isFinite(terms.price) || terms.price < 0) return { status: "REJECTED", reason: "invalid_price" };
  if (terms.price > mandate.maxPriceMxn) return { status: "REQUIRES_ESCALATION", reason: "price_cap_exceeded" };
  if (terms.pickupTime !== mandate.pickupTime) return { status: "REQUIRES_ESCALATION", reason: "pickup_window_unapproved" };
  return { status: "APPROVED" };
}
```

- [ ] **Step 4: Verify mandate tests pass**

Run: `npm test -- tests/unit/mandate.test.ts`

Expected: PASS; no price over 9,000 MXN or unapproved pickup time is approved.

- [ ] **Step 5: Commit mandate logic**

```bash
git add src/core/mandate.ts tests/unit/mandate.test.ts
git commit -m "feat: enforce Volta mandate guardrails"
```

### Task 4: Build In-Memory Operation State and Event Publishing

**Files:**
- Create: `src/core/state.ts`
- Test: `tests/unit/state.test.ts`

**Consumes:** contracts from Task 2.

**Produces:** `OperationStore` with `getOperation`, `registerQuote`, `finalizeCommitment`, `requestEscalation`, and `subscribe`.

- [ ] **Step 1: Write the failing event-order test**

```ts
it("publishes a quote event and retains the quote", () => {
  const store = createOperationStore(seedOperation());
  const received: OperationEvent[] = [];
  store.subscribe((event) => received.push(event));
  store.registerQuote(quote);
  expect(store.getOperation().quotes).toContainEqual(quote);
  expect(received[0]).toMatchObject({ type: "quote.registered", quote });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -- tests/unit/state.test.ts`

Expected: FAIL because the store factory does not exist.

- [ ] **Step 3: Implement a copy-on-write, subscribable store**

```ts
export type OperationStore = {
  getOperation(): Operation;
  registerQuote(quote: Quote): void;
  finalizeCommitment(commitment: Commitment): void;
  requestEscalation(escalation: Escalation): void;
  subscribe(listener: (event: OperationEvent) => void): () => void;
};
```

- [ ] **Step 4: Verify store tests pass**

Run: `npm test -- tests/unit/state.test.ts`

Expected: PASS; unsubscribe prevents delivery and each mutation publishes one matching event.

- [ ] **Step 5: Commit state management**

```bash
git add src/core/state.ts tests/unit/state.test.ts
git commit -m "feat: add in-memory operation state stream"
```


### Task 5: Add Agent Instructions, Tool Schemas, and Interpreter

**Files:**
- Create: `src/agent/prompt.ts`, `src/agent/tools.ts`, `src/agent/interpreter.ts`
- Test: `tests/unit/interpreter.test.ts`

**Consumes:** Tasks 3–4 and Zod.

**Produces:** `VOLTA_SYSTEM_PROMPT`, `agentToolDefinitions`, and `executeToolCall(request, dependencies)`.

- [ ] **Step 1: Write failing approval and escalation tests**

```ts
it("escalates and never commits a 10,000 MXN request", async () => {
  const result = await executeToolCall({ name: "commit_deal", arguments: overCapTerms }, dependencies);
  expect(result).toMatchObject({ outcome: "escalated", reason: "price_cap_exceeded" });
  expect(store.getOperation().commitment).toBeUndefined();
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -- tests/unit/interpreter.test.ts`

Expected: FAIL because the schemas and executor do not exist.

- [ ] **Step 3: Implement Zod schemas and the state-safe tool boundary**

```ts
export const commitDealSchema = z.object({
  carrierId: z.string().min(1),
  finalPrice: z.number().nonnegative(),
  pickupTime: z.string().datetime(),
  timestampMs: z.number().int().nonnegative(),
  driverName: z.string().optional(),
  plate: z.string().optional(),
});
```

Define `check_mandate`, `register_quote`, `commit_deal`, and `trigger_escalation`. The Spanish prompt must require Volta to stop speaking on interruption, request the fixed route/window, counter only within mandate, escalate unapproved terms, and confirm recap details only after a successful booking.

- [ ] **Step 4: Verify tool behavior**

Run: `npm test -- tests/unit/interpreter.test.ts`

Expected: PASS; malformed input is rejected, quotes are registered, and commits cannot bypass mandate evaluation.

- [ ] **Step 5: Commit the agent boundary**

```bash
git add src/agent tests/unit/interpreter.test.ts
git commit -m "feat: add mandate-safe Volta tool interpreter"
```

### Task 6: Implement Audit, Commitment, Call-Brief, and Mock SMS Services

**Files:**
- Create: `src/audit/commitment.ts`, `src/audit/callBrief.ts`, `src/mocks/sms.ts`
- Test: `tests/unit/commitment.test.ts`

**Consumes:** approved tool results from Task 5 and the operation store.

**Produces:** `generateCommitmentRecap(input)`, `createCallBrief(input)`, and `MockSmsGateway.sent`.

- [ ] **Step 1: Write the failing commitment-recap test**

```ts
it("creates an audio timestamp URL and records a Spanish SMS recap", async () => {
  const result = await generateCommitmentRecap(input, mockSms);
  expect(result.audioTimestampUrl).toBe("/audio/recordings/CA123#t=42.5");
  expect(mockSms.sent[0].body).toContain("Tarifa $8500 MXN");
  expect(result.recapStatus).toBe("sent");
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -- tests/unit/commitment.test.ts`

Expected: FAIL because the audit services do not exist.

- [ ] **Step 3: Implement verified recap generation and structured briefs**

```ts
export async function generateCommitmentRecap(input: CommitmentInput, sms: SmsGateway): Promise<CommitmentRecap> {
  const audioTimestampUrl = `/audio/recordings/\${input.callId}#t=\${input.timestampMs / 1000}`;
  const body = `Textiles Pacífico - Confirmación de Reserva: Carga \${input.containerId}, Tarifa $\${input.priceMxn} MXN, Pick-up: \${input.pickupTime}, Chofer: \${input.driverName ?? "pendiente"}. Cita confirmada.`;
  const message = await sms.send({ to: input.recipient, body });
  return { audioTimestampUrl, recapStatus: message.status, messageId: message.id };
}
```

The interpreter finalizes a commitment only when `recapStatus` is `sent`; it records `failed` along with a call brief for every SMS failure.

- [ ] **Step 4: Verify audit behavior**

Run: `npm test -- tests/unit/commitment.test.ts`

Expected: PASS; a failed recap leaves no final commitment.

- [ ] **Step 5: Commit audit services**

```bash
git add src/audit src/mocks/sms.ts tests/unit/commitment.test.ts
git commit -m "feat: add auditable commitment recaps"
```

### Task 7: Expose the Mock-First API and Live Event Stream

**Files:**
- Create: `src/config/env.ts`, `src/server.ts`, `src/mocks/callScenario.ts`
- Test: `tests/integration/mock-demo.test.ts`

**Consumes:** Tasks 2–6.

**Produces:** `GET /health`, `GET /api/operation`, `POST /api/mandates`, `POST /api/demo/run`, and
`GET /api/events`.

- [ ] **Step 1: Write the failing end-to-end mock-demo test**

```ts
it("runs three quotes, selects the best approved carrier, and exposes its audit record", async () => {
  await request(app).post("/api/demo/run").expect(202);
  const operation = await request(app).get("/api/operation").expect(200);
  expect(operation.body.quotes).toHaveLength(3);
  expect(operation.body.commitment.finalPriceMxn).toBe(8500);
  expect(operation.body.commitment.recapStatus).toBe("sent");
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -- tests/integration/mock-demo.test.ts`

Expected: FAIL because the HTTP application and scenario runner do not exist.

- [ ] **Step 3: Implement environment validation and routes**

```ts
export const env = z.object({
  PORT: z.coerce.number().default(3001),
  VOLTA_MODE: z.enum(["mock", "live"]).default("mock"),
  TWILIO_ACCOUNT_SID: z.string().optional(),
  TWILIO_AUTH_TOKEN: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),
}).parse(process.env);
```

`POST /api/demo/run` must emit deterministic carrier outcomes of 8,500 MXN, 9,200 MXN, and unavailable; only the 8,500 MXN quote is finalized. `GET /api/events` serializes `OperationEvent` values as server-sent events.

`POST /api/mandates` accepts the eight dashboard fields `budget_cap`, `destination_datetime`,
`destination_place`, `type_of_content`, `weight`, `measures`, `pickup_address`, and
`pickup_datetime`. It validates the complete payload before replacing the active in-memory
operation, returns HTTP 201 with the canonical read model, and emits `mandate.created`. Invalid
payloads return HTTP 400 and must leave the authoritative operation unchanged. The dashboard
submits the shared request contract to `/api/mandates`; its Next.js rewrite targets
`VOLTA_API_URL`, defaulting to `http://localhost:3001` for local work. The UI only confirms a
mandate after the HTTP 201 response.

- [ ] **Step 4: Verify the complete backend suite**

Run: `npm test`

Expected: PASS; the mock demo is repeatable and requires no credentials.

- [ ] **Step 5: Commit the local API**

```bash
git add src/config src/server.ts src/mocks/callScenario.ts tests/integration/mock-demo.test.ts
git commit -m "feat: add mock Volta demo API"
```


### Task 8: Add Twilio and OpenAI Realtime Adapter Contracts

**Files:**
- Create: `src/telephony/twilio.ts`, `src/telephony/mediaStream.ts`, `src/mocks/telephony.ts`
- Test: `tests/unit/telephony.test.ts`

**Consumes:** environment mode, agent prompt, tool interpreter, and call-session contracts.

**Produces:** `TelephonyGateway`, `createInboundTwiML`, `createOutboundCall`, `transferToSupervisor`, and `attachMediaStreamRelay`.

- [ ] **Step 1: Write failing TwiML and relay-configuration tests**

```ts
it("returns a media-stream TwiML response for an inbound call", () => {
  expect(createInboundTwiML("wss://demo.ngrok.app/media-stream"))
    .toContain("<Stream url=\\"wss://demo.ngrok.app/media-stream\\"");
});

it("configures g711_ulaw and server VAD for realtime sessions", () => {
  expect(createRealtimeSessionConfig().input_audio_format).toBe("g711_ulaw");
  expect(createRealtimeSessionConfig().turn_detection.type).toBe("server_vad");
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -- tests/unit/telephony.test.ts`

Expected: FAIL because adapter functions do not exist.

- [ ] **Step 3: Implement injectable real and mock adapters**

```ts
export type TelephonyGateway = {
  createOutboundCall(input: OutboundCallInput): Promise<CallSession>;
  transferToSupervisor(input: TransferInput): Promise<void>;
};

export function createRealtimeSessionConfig() {
  return {
    input_audio_format: "g711_ulaw",
    output_audio_format: "g711_ulaw",
    turn_detection: { type: "server_vad", silence_duration_ms: 350 },
    instructions: VOLTA_SYSTEM_PROMPT,
    tools: agentToolDefinitions,
  };
}
```

The relay forwards Twilio `media.payload` as `input_audio_buffer.append`, forwards OpenAI audio deltas to Twilio as `media`, stops playback on interruption events, and routes function calls through `executeToolCall`. Keep WebSocket construction behind an injectable factory so tests use fake sockets.

- [ ] **Step 4: Verify telephony tests**

Run: `npm test -- tests/unit/telephony.test.ts`

Expected: PASS; mock mode makes no network connection.

- [ ] **Step 5: Commit voice adapters**

```bash
git add src/telephony src/mocks/telephony.ts tests/unit/telephony.test.ts
git commit -m "feat: add Twilio and Realtime adapter boundary"
```

### Task 9: Build the Live Dashboard and Audit Detail View

**Files:**
- Create: `frontend/app/layout.tsx`, `frontend/app/page.tsx`, `frontend/app/audit/[id]/page.tsx`, `frontend/app/globals.css`
- Create: `frontend/lib/api.ts`, `frontend/lib/events.ts`, `frontend/components/CallBoard.tsx`, `frontend/components/QuoteTable.tsx`, `frontend/components/CommitmentCard.tsx`
- Test: `frontend/components/QuoteTable.test.tsx`

**Consumes:** API DTOs and events solely from `@volta/contracts`.

**Produces:** a live call/quote board, a demo-start control, and an audit page that displays recap and timestamp URL.

- [ ] **Step 1: Write the failing quote-comparison test**

```tsx
it("marks the lowest approved quote as selected", () => {
  render(<QuoteTable quotes={[quote8500, quote9200]} mandateMax={9000} />);
  expect(screen.getByText("Seleccionada")).toBeInTheDocument();
  expect(screen.getByText("Fuera de mandato")).toBeInTheDocument();
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm --workspace frontend test -- QuoteTable.test.tsx`

Expected: FAIL because the component does not exist.

- [ ] **Step 3: Implement data loading and server-sent event updates**

```ts
export function subscribeToOperationEvents(onEvent: (event: OperationEvent) => void) {
  const source = new EventSource(`\${process.env.NEXT_PUBLIC_API_URL}/api/events`);
  source.onmessage = (message) => onEvent(JSON.parse(message.data) as OperationEvent);
  return () => source.close();
}
```

The dashboard must make all three candidate calls, quoted prices, mandate status, selected commitment, recap status, and escalation state legible. The audit route must show the structured call brief and link to the audio timestamp.

- [ ] **Step 4: Verify frontend checks**

Run: `npm --workspace frontend test && npm --workspace frontend run typecheck`

Expected: PASS.

- [ ] **Step 5: Commit dashboard views**

```bash
git add frontend
git commit -m "feat: add Volta live dashboard and audit view"
```

### Task 10: Document Local Operation and Add CI

**Files:**
- Create: `.github/workflows/ci.yml`, `.github/pull_request_template.md`
- Create: `README.md`, `docs/team-workstreams.md`, `docs/ngrok-twilio-runbook.md`
- Test: complete root verification suite

**Consumes:** all workspaces and scripts from Tasks 1–9.

**Produces:** reproducible local startup, ngrok webhook setup, four-person ownership guide, and GitHub pull-request quality gate.

- [ ] **Step 1: Write the CI workflow**

```yaml
name: CI
on: [pull_request, push]
jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20, cache: npm }
      - run: npm ci
      - run: npm run format:check
      - run: npm run lint
      - run: npm run typecheck
      - run: npm test
```

- [ ] **Step 2: Verify the documented local path from clean dependencies**

Run: `npm ci && npm run typecheck && npm test`

Expected: PASS; `npm run dev` starts both applications in mock mode and `POST /api/demo/run` produces an auditable 8,500 MXN booking.

- [ ] **Step 3: Write non-secret ngrok and Twilio instructions**

Document `ngrok http 3001`, the Twilio inbound voice webhook URL, the media-stream WSS URL, required environment-variable names, and the rule that `.env` is never committed. Assign one owner and one reviewer to each of the four workstreams.

- [ ] **Step 4: Commit the operational handoff**

```bash
git add .github README.md docs/team-workstreams.md docs/ngrok-twilio-runbook.md
git commit -m "docs: add Volta local demo and collaboration runbook"
```

## Plan Self-Review

- **Spec coverage:** Tasks 1–2 cover workspace isolation and domain contracts; Task 3 covers mandate invariants; Tasks 4–7 cover state, tools, commitments, call briefs, recap, and local demo; Task 8 covers Twilio/OpenAI VAD, barge-in, and escalation boundaries; Task 9 covers the live comparison/audit dashboard; Task 10 covers team handoff and CI. Production authentication, databases, and cloud deployment are intentionally deferred by the spec.
- **Placeholder scan:** No unresolved placeholders or unspecified validation/error-handling steps appear. Each task states files, interfaces, a failing test, a verification command, and a commit target.
- **Type consistency:** `Mandate`, `Quote`, `Commitment`, `CallBrief`, `Escalation`, and `OperationEvent` originate in `@volta/contracts`. `evaluateMandate` feeds `executeToolCall`, which gates the store and audit workflow.
