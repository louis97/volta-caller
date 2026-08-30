# Volta Agentic Backend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement Volta’s English negotiation, client-authorized confirmation, and exception-handling backend without building the frontend selection interface.

**Architecture:** The shared contracts encode the mandate, reviewed candidate, selection, operation states, and incident data. Mode-specific prompt/tool sets call a single interpreter, which gates every state transition. Exception calls receive an immutable, preloaded operation context and make only validated write-tool calls while live. The frontend submits a selected quote to one HTTP endpoint; the backend validates it and invokes the confirmation-call adapter.

**Tech Stack:** Node.js 20+, TypeScript, Express, Zod, Vitest, native `fetch` integration tests, Twilio/OpenAI adapter interfaces, npm workspaces.

**Spec:** docs/superpowers/specs/2026-08-29-volta-client-approval-agent-design.md

## Global Constraints

- All prompts, tool names, tool descriptions, call summaries, and tests added by this plan are English.
- The dashboard owns the selection UI; this plan provides only its shared contracts and POST /operations/:id/select-quote backend boundary.
- Negotiation mode cannot select or book; confirmation mode cannot renegotiate; exception mode cannot book, select, or alter a mandate.
- A selection is valid only before mandate.destinationDatetime and authorizes one callback for exact reviewed terms. Expiry comparisons use parsed instants, never lexicographic datetime strings.
- Failed confirmation, failed recap, unknown caller, or unachievable mandate never creates a commitment.
- Exception-mode client notification is dashboard-only; SMS/email is excluded.
- Exception mode has no mid-call read or assessment tools: mandate, operation, carrier, quote, truck, briefs, and incidents are loaded into an immutable `ExceptionCallContext` before dialogue starts.
- Exception-mode writes validate the preloaded context again at the backend boundary; caller identity failure records no incident and creates no dashboard notification.
- No listener, broker, polling loop, automatic retry, mandate versioning, quote invalidation, or replacement-carrier selection is introduced.

---

## File Structure

~~~text
packages/contracts/src/index.ts             operation states, reviewed candidates, selections, incidents, events
src/core/state.ts                           validated operation mutations and event publishing
src/agent/modes.ts                          per-mode prompt and allowlisted tool definitions
src/agent/prompt.ts                         English prompt text by mode
src/agent/tools.ts                          Zod schemas for all tools
src/agent/interpreter.ts                    mode-aware, state-guarded tool execution
src/core/confirmation.ts                    selection validation and confirmation-call orchestration
src/core/exceptions.ts                      preloaded exception context and validated write workflow
src/server.ts                               select-quote HTTP endpoint
tests/unit/contracts.test.ts                contract and seed coverage
tests/unit/interpreter.test.ts              negotiation and confirmation tool boundaries
tests/unit/exceptions.test.ts               exception mode behavior
tests/integration/selection.test.ts         endpoint and callback orchestration
~~~

### Task 1: Extend Shared Approval and Exception Contracts

**Files:**
- Modify: packages/contracts/src/index.ts
- Modify: src/core/seed.ts
- Modify: tests/unit/contracts.test.ts

**Interfaces:**
- Produces: OperationStatus, ReviewedDeal, ClientSelection, Incident, DashboardNotification, and operation events for deal review, selection, confirmation failure, incident update, and dashboard notification.
- Consumes: existing Mandate, Quote, CallBrief, and Operation types.

- [ ] **Step 1: Write failing contract tests**

~~~ts
it("models a reviewed candidate, selected quote, and exception state", () => {
  const operation = seedOperation();
  expect(operation.status).toBe("open");
  expect(operation.reviewedDeals).toEqual([]);
  expect(operation.selection).toBeUndefined();
  expect(operation.incidents).toEqual([]);
  expect(operation.dashboardNotifications).toEqual([]);
});
~~~

- [ ] **Step 2: Verify RED**

Run: npm test -- tests/unit/contracts.test.ts

Expected: FAIL because reviewedDeals, selection, incidents, and the extended state union do not exist.

- [ ] **Step 3: Implement additive shared types**

~~~ts
export type OperationStatus =
  | "open" | "negotiating" | "awaiting_client_selection"
  | "carrier_selected" | "confirming_selected_carrier"
  | "committed" | "selection_expired" | "confirmation_failed"
  | "incident_monitoring" | "escalated" | "failed";

export type ClientSelection = {
  quoteId: string;
  selectedAt: string;
  expiresAt: string;
};

export type ReviewedDeal = {
  quoteId: string;
  callId: string;
  mandateDecision: "APPROVED" | "REJECTED" | "REQUIRES_ESCALATION";
  reviewedAt: string;
};
~~~

Define `DashboardNotification` with an operation ID, incident ID, message, and created timestamp. Define `Incident` with verified caller identity, process stage, issue, truck, delayMinutes, revisedEta, feasibility, and createdAt. Extend `Operation` using `reviewedDeals`, `selection`, `incidents`, and `dashboardNotifications` without removing existing audit fields. `reviewedDeals` must retain out-of-mandate candidates for audit, but only `APPROVED` reviewed candidates are selectable.

- [ ] **Step 4: Verify GREEN**

Run: npm test -- tests/unit/contracts.test.ts && npm run typecheck

Expected: PASS.

- [ ] **Step 5: Commit**

~~~bash
git add packages/contracts/src/index.ts src/core/seed.ts tests/unit/contracts.test.ts
git commit -m "feat: add approval and exception contracts"
~~~

### Task 2: Add State Transitions for Reviewed Deals, Selection, and Incidents

**Files:**
- Modify: src/core/state.ts
- Modify: tests/unit/state.test.ts

**Interfaces:**
- Consumes: Task 1 contracts.
- Produces: reviewDeal, selectQuote, beginConfirmation, failConfirmation, recordIncident, updateOperationStatus, and notifyDashboard methods on OperationStore.

- [ ] **Step 1: Write failing state-transition tests**

~~~ts
it("selects only a reviewed quote before destination expiry", () => {
  const store = createOperationStore(operationWithReviewedQuote);
  store.selectQuote({ quoteId: "quote-a", now: beforeDeadline });
  expect(store.getOperation().status).toBe("carrier_selected");
});

it("publishes each reviewed candidate without removing earlier candidates", () => {
  store.reviewDeal({ quoteId: "quote-b", reviewedAt: beforeDeadline });
  expect(store.getOperation().reviewedDeals).toHaveLength(2);
  expect(store.getOperation().status).toBe("awaiting_client_selection");
});

it("does not mutate an operation for an expired selection", () => {
  expect(() => store.selectQuote({ quoteId: "quote-a", now: afterDeadline }))
    .toThrow("selection_expired");
});
~~~

- [ ] **Step 2: Verify RED**

Run: npm test -- tests/unit/state.test.ts

Expected: FAIL because selection transitions do not exist.

- [ ] **Step 3: Implement guarded, copy-on-write transitions**

~~~ts
selectQuote(input: { quoteId: string; now: string }): ClientSelection;
reviewDeal(input: { quoteId: string; reviewedAt: string }): ReviewedDeal;
beginConfirmation(quoteId: string): void;
failConfirmation(reason: string, callId: string): void;
recordIncident(incident: Incident): void;
updateOperationStatus(input: { incidentId: string; status: "incident_monitoring" }): void;
notifyDashboard(notification: DashboardNotification): void;
~~~

`reviewDeal` must permit each completed discovery call to publish exactly one reviewed candidate, without removing earlier reviewed candidates. The first review changes `negotiating` to `awaiting_client_selection`; subsequent quote registration and review are permitted while awaiting selection. `selectQuote` must require awaiting_client_selection, a matching **approved** reviewed quote, and `Date.parse(now) < Date.parse(mandate.destinationDatetime)`. It writes expiresAt from the mandate destination datetime and publishes a typed selection event. A second selection after `carrier_selected` or `confirming_selected_carrier` fails without mutation. No method in this task may finalize a commitment.

- [ ] **Step 4: Verify GREEN**

Run: npm test -- tests/unit/state.test.ts && npm run typecheck

Expected: PASS; snapshots and emitted events remain immutable.

- [ ] **Step 5: Commit**

~~~bash
git add src/core/state.ts tests/unit/state.test.ts
git commit -m "feat: add client selection state transitions"
~~~

### Task 3: Replace Automatic Booking with Mode-Specific English Tools

**Files:**
- Create: src/agent/modes.ts
- Modify: src/agent/prompt.ts
- Modify: src/agent/tools.ts
- Modify: src/agent/interpreter.ts
- Modify: src/telephony/mediaStream.ts
- Modify: tests/unit/interpreter.test.ts
- Modify: tests/unit/telephony.test.ts
- Modify: src/mocks/callScenario.ts
- Modify: tests/integration/mock-demo.test.ts

**Interfaces:**
- Consumes: Task 1 status types and Task 2 store methods.
- Produces: createModeConfiguration(mode), review_deal, confirm_selected_deal, and mode-aware executeToolCall.

- [ ] **Step 1: Write failing mode and tool-boundary tests**

~~~ts
it("does not expose confirmation tools in negotiation mode", () => {
  expect(createModeConfiguration("negotiation").tools.map((tool) => tool.name))
    .not.toContain("confirm_selected_deal");
});

it("rejects confirm_selected_deal without an active matching selection", async () => {
  await expect(executeToolCall(request, confirmationDependencies))
    .resolves.toMatchObject({ outcome: "rejected", reason: "selection_required" });
});
~~~

- [ ] **Step 2: Verify RED**

Run: npm test -- tests/unit/interpreter.test.ts

Expected: FAIL because mode configurations and guarded confirmation are absent.

- [ ] **Step 3: Implement mode configurations and English prompts**

~~~ts
export type CallMode = "negotiation" | "confirmation" | "exception";

export function createModeConfiguration(mode: CallMode) {
  return { instructions: prompts[mode], tools: toolsByMode[mode] };
}
~~~

Make `createRealtimeSessionConfig` accept the configuration returned by `createModeConfiguration`, rather than importing a global prompt and global tool list. Negotiation allows check_mandate, register_quote, review_deal, trigger_escalation. Confirmation allows check_mandate, confirm_selected_deal, trigger_escalation. Exception configuration is implemented in Task 5. Remove commit_deal from every definition, prompt, mock scenario, and demo expectation. The mock discovery scenario must register and review the eligible carrier immediately, retain the over-cap carrier for audit, and finish at awaiting_client_selection without a commitment.

review_deal must require a registered quote and publish a ReviewedDeal with its mandate decision. confirm_selected_deal must require confirming_selected_carrier, matching quote identity, a non-expired selection, exact quote terms (price, pickup datetime, destination datetime, cargo constraints), mandate approval, and a successful recap-backed finalizer. Any mismatch calls `failConfirmation`, records a failed call brief, and never finalizes a commitment.

- [ ] **Step 4: Verify GREEN**

Run: npm test -- tests/unit/interpreter.test.ts && npm run typecheck

Expected: PASS; no mode can invoke a tool outside its allowlist.

- [ ] **Step 5: Commit**

~~~bash
git add src/agent src/telephony/mediaStream.ts src/mocks/callScenario.ts tests/unit/interpreter.test.ts tests/unit/telephony.test.ts tests/integration/mock-demo.test.ts
git commit -m "feat: add mode-specific Volta tool guards"
~~~

### Task 4: Implement Client Selection Endpoint and Confirmation Callback

**Files:**
- Create: src/core/confirmation.ts
- Modify: src/server.ts
- Modify: src/mocks/telephony.ts
- Create: tests/integration/selection.test.ts

**Interfaces:**
- Consumes: OperationStore.selectQuote, OperationStore.beginConfirmation, TelephonyGateway.createOutboundCall, and confirmation mode configuration.
- Produces: POST /operations/:id/select-quote and ConfirmationCoordinator.start.

- [ ] **Step 1: Write a failing endpoint test**

~~~ts
it("accepts a valid selection and starts one confirmation callback", async () => {
  const response = await request(app, "/operations/op-1/select-quote", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ quoteId: "quote-a" })
  });

  expect(response.status).toBe(202);
  expect(telephony.calls.filter((call) => call.type === "created")).toHaveLength(1);
});
~~~

- [ ] **Step 2: Verify RED**

Run: npm test -- tests/integration/selection.test.ts

Expected: FAIL because the endpoint and coordinator do not exist.

- [ ] **Step 3: Implement the HTTP and orchestration boundary**

~~~ts
app.post("/operations/:id/select-quote", async (request, response) => {
  const selection = selectQuoteRequestSchema.parse(request.body);
  await confirmationCoordinator.start(request.params.id, selection.quoteId);
  response.status(202).json(store.getOperation());
});
~~~

Make `createApp` accept injected scenario/store and `ConfirmationCoordinator` dependencies so its endpoint is integration-testable without Twilio. The coordinator must validate operation ID, call `selectQuote`, transition to `confirming_selected_carrier`, construct a confirmation-mode call context from the exact selected quote and mandate, and invoke `TelephonyGateway.createOutboundCall` once using that carrier's configured phone. Persist the returned callback call ID in the call brief/context. Return 404 for another operation, 400 for an invalid request body, and 409 for expiry, an unreviewed/out-of-mandate quote, or duplicate selection. Do not call telephony on any non-202 result. On telephony failure, set `confirmation_failed` and create a failure brief; no retry is scheduled.

- [ ] **Step 4: Verify GREEN**

Run: npm test -- tests/integration/selection.test.ts && npm test

Expected: PASS; repeated endpoint calls cannot start a second callback.

- [ ] **Step 5: Commit**

~~~bash
git add src/core/confirmation.ts src/server.ts src/mocks/telephony.ts tests/integration/selection.test.ts
git commit -m "feat: trigger confirmation after client selection"
~~~

### Task 5: Implement Preloaded Exception Context and Write-Only Tools

**Files:**
- Create: src/core/exceptions.ts
- Modify: src/agent/modes.ts
- Modify: src/agent/prompt.ts
- Modify: src/agent/tools.ts
- Modify: src/agent/interpreter.ts
- Modify: src/telephony/mediaStream.ts
- Modify: tests/unit/interpreter.test.ts
- Modify: tests/unit/telephony.test.ts
- Create: tests/unit/exceptions.test.ts

**Interfaces:**
- Consumes: Task 1 operation/incident contracts, Task 2 state methods, and Task 3 mode-aware Realtime configuration.
- Produces: `ExceptionCallContext`, `createExceptionCallContext(operation)`, `createExceptionModeConfiguration(context)`, and `executeExceptionToolCall(request, dependencies)`.

- [ ] **Step 1: Write failing context and write-boundary tests**

~~~ts
it("preloads mandate, selected terms, and audit history before an exception call", () => {
  const context = createExceptionCallContext(operationWithSelectionAndHistory);
  expect(context).toMatchObject({
    operationId: operationWithSelectionAndHistory.id,
    mandate: operationWithSelectionAndHistory.mandate,
    selectedQuote: operationWithSelectionAndHistory.quotes[0],
    previousCallBriefs: operationWithSelectionAndHistory.callBriefs
  });
});

it("rejects an unmatched caller identity without recording an incident", async () => {
  const result = await executeExceptionToolCall(unmatchedCallerIncident, dependencies);
  expect(result).toEqual({ outcome: "rejected", reason: "caller_unverified" });
  expect(store.getOperation().incidents).toEqual([]);
  expect(store.getOperation().dashboardNotifications).toEqual([]);
});

it("notifies the dashboard only for a validated incident with an unachievable ETA", async () => {
  await executeExceptionToolCall(validUnachievableIncident, dependencies);
  await executeExceptionToolCall({ name: "notify_dashboard", arguments: { incidentId } }, dependencies);
  expect(store.getOperation().dashboardNotifications).toHaveLength(1);
});
~~~

- [ ] **Step 2: Verify RED**

Run: npm test -- tests/unit/exceptions.test.ts tests/unit/telephony.test.ts

Expected: FAIL because exception context construction, write-only schemas, and context-aware Realtime setup do not exist.

- [ ] **Step 3: Implement immutable call-context construction and prompt injection**

~~~ts
export type ExceptionCallContext = Readonly<{
  operationId: string;
  mandate: Mandate;
  lifecycleStatus: OperationStatus;
  selectedCarrier?: CarrierCandidate;
  selectedQuote?: Quote;
  knownTruckPlate?: string;
  previousCallBriefs: CallBrief[];
  previousIncidents: Incident[];
}>;

export function createExceptionCallContext(operation: Operation): ExceptionCallContext {
  const selectedQuote = operation.selection
    ? operation.quotes.find((quote) => quote.id === operation.selection?.quoteId)
    : undefined;
  return structuredClone({
    operationId: operation.id,
    mandate: operation.mandate,
    lifecycleStatus: operation.status,
    selectedCarrier: selectedQuote
      ? operation.candidates.find((carrier) => carrier.id === selectedQuote.carrierId)
      : undefined,
    selectedQuote,
    knownTruckPlate: operation.commitment?.plate,
    previousCallBriefs: operation.callBriefs,
    previousIncidents: operation.incidents
  });
}
~~~

Add `createExceptionModeConfiguration(context)` in `src/agent/modes.ts`. It produces the English exception prompt plus a compact, JSON-delimited rendering of the context and exactly four tool definitions: `record_incident`, `update_operation_status`, `notify_dashboard`, and `trigger_escalation`. Pass that configuration into `createRealtimeSessionConfig` before attaching the media relay. Do not serialize the dashboard escalation phone into spoken prompt instructions.

- [ ] **Step 4: Implement schema-validated write handlers**

~~~ts
export type ExceptionToolDependencies = {
  store: OperationStore;
  context: ExceptionCallContext;
  now?: () => string;
};

export async function executeExceptionToolCall(
  request: ToolCallRequest,
  dependencies: ExceptionToolDependencies
): Promise<ToolCallResult>;
~~~

`record_incident` accepts `callerName`, `carrierId`, optional `truckPlate`, `processStage`, `issue`, `delayMinutes`, and `revisedEta`. It rejects with `caller_unverified` unless the operation ID still matches, the carrier is the selected carrier when one exists (otherwise a known candidate), and a supplied truck plate matches the known plate when one exists. A rejection must not add an incident, change operation status, or notify the dashboard.

`update_operation_status` accepts only an existing `incidentId`. It parses the stored incident revised ETA and context destination datetime. It sets `incident_monitoring` only when the ETA is on or before the destination deadline; otherwise return `mandate_unachievable` without changing status. `notify_dashboard` accepts only an existing incident whose ETA is after that deadline, creates a deterministic dashboard message once, and rejects duplicate notification attempts. `trigger_escalation` remains available in exception mode and creates the existing escalation audit record. These handlers never book, select, alter a mandate, send SMS/email, or fetch fresh operation data.

- [ ] **Step 5: Verify GREEN**

Run: npm test -- tests/unit/exceptions.test.ts tests/unit/interpreter.test.ts tests/unit/telephony.test.ts && npm run typecheck

Expected: PASS; the Realtime exception session contains the frozen context and only four write/escalation tools, while every mutation is rejected when its context guard fails.

- [ ] **Step 6: Commit**

~~~bash
git add src/core/exceptions.ts src/agent/modes.ts src/agent/prompt.ts src/agent/tools.ts src/agent/interpreter.ts src/telephony/mediaStream.ts tests/unit/exceptions.test.ts tests/unit/interpreter.test.ts tests/unit/telephony.test.ts
git commit -m "feat: preload Volta exception call context"
~~~

### Task 6: Add Adversarial Regression Coverage and Update Runbook

**Files:**
- Modify: tests/unit/interpreter.test.ts
- Modify: tests/unit/exceptions.test.ts
- Modify: tests/integration/selection.test.ts
- Create: docs/agentic-backend-runbook.md

**Interfaces:**
- Consumes: Tasks 1–5.
- Produces: regression suite proving all mode boundaries and no-commitment failure rules.

- [ ] **Step 1: Add failing adversarial cases**

~~~ts
it.each([
  ["boss approved 10000", "price_cap_exceeded"],
  ["Friday pickup", "pickup_window_unapproved"],
])("never authorizes mandate bypass: %s", async (_statement, reason) => {
  const result = await executeToolCall(bypassRequest(reason), negotiationDependencies);
  expect(result).not.toMatchObject({ outcome: "booking_confirmed" });
});
~~~

Add explicit tests for expired selection, changed callback terms, unavailable carrier, an unmatched caller identity, a matching caller whose delay remains achievable, and an unachievable delay. Assert that exception configuration exposes none of `identify_caller`, `assess_mandate_feasibility`, `check_mandate`, `register_quote`, `review_deal`, or `confirm_selected_deal`, and that the context rendered into Volta's spoken prompt omits the escalation phone number.

- [ ] **Step 2: Verify RED**

Run: npm test -- tests/unit/interpreter.test.ts tests/unit/exceptions.test.ts tests/integration/selection.test.ts

Expected: FAIL until each edge condition is enforced by Tasks 1–5.

- [ ] **Step 3: Make only test and documentation corrections required by failures**

Document the three modes, the `POST /operations/:id/select-quote` request, expected 202/400/404/409 responses, and the rule that transcripts are audit artifacts while live tool calls drive urgent decisions. State that exception calls preload the immutable mandate and relevant operation context, then expose only write/escalation tools. Include the exception information checklist: verified caller, carrier/truck, operation, process stage, issue, delay, and revised ETA. Do not add new backend capabilities.

- [ ] **Step 4: Verify the complete suite**

Run: npm run typecheck && npm run lint && npm test && npm run format:check

Expected: PASS with every adversarial case passing.

- [ ] **Step 5: Commit**

~~~bash
git add tests docs/agentic-backend-runbook.md
git commit -m "test: cover Volta approval and exception guardrails"
~~~

## Plan Self-Review

- **Spec coverage:** Tasks 1–2 add approval/incident state, Task 3 implements English mode-specific AI tools and runtime configuration, Task 4 implements client-to-backend confirmation orchestration, Task 5 preloads and validates exception context while keeping live calls write-only, and Task 6 proves the mandatory safety and failure cases.
- **Placeholder scan:** No unresolved placeholders or unspecified validation/error-handling steps appear.
- **Type consistency:** Task 1 introduces shared types; Task 2 owns their state transitions; Task 3 and Task 5 consume the same guarded store methods; Task 4 uses selection methods and the confirmation mode; Task 6 tests the exact interfaces created in the preceding tasks.

