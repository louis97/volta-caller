# Shipment Notifications Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist and show organization-wide Volta operational notifications in the dashboard.

**Architecture:** Shipment events are the durable notification source. A server-owned publisher persists the event through `AgentRepository.addShipmentEvent` and then broadcasts an SSE `shipment.event.created` signal. Backend producers create the four notification event types, and the existing dashboard EventSource refreshes a Notifications view that lists persisted events.

**Tech Stack:** TypeScript, Express, Zod, Postgres, Vitest, Next.js, React, Motion.

**Spec:** `docs/superpowers/specs/2026-08-30-shipment-notifications-design.md`

## Global Constraints

- Persist every notification through `AgentRepository.addShipmentEvent` before broadcasting it.
- The feed is organization-wide, ordered by `occurredAt` descending, and isolation is enforced through the existing organization request context.
- Use the current SSE `/api/events` connection; do not add polling, WebSockets, or another live-connection type.
- No read/unread state, toast system, mobile push, WhatsApp intake, or notification preferences.
- Do not create a git commit; the user will commit the completed work.

---

### Task 1: Event contract and repository read model

**Files:**
- Modify: `packages/contracts/src/index.ts`
- Modify: `src/agent/repository.ts`
- Modify: `src/storage/postgres.ts`
- Test: `tests/unit/shipmentNotifications.test.ts`

**Interfaces:**
- Produces `ShipmentNotificationType`, extended `ShipmentEvent.type`, and `AgentRepository.listShipmentEvents(context)`.
- Consumes `ShipmentEvent` and `OrganizationContext`.

- [ ] **Step 1: Write failing repository tests**

```ts
it("returns only the requesting organization's shipment events newest first", async () => {
  await repository.addShipmentEvent(event({ id: "older", occurredAt: "2026-08-30T09:00:00.000Z" }));
  await repository.addShipmentEvent(event({ id: "newer", occurredAt: "2026-08-30T10:00:00.000Z" }));
  await repository.addShipmentEvent(event({ id: "other-org", organizationId: "other" }));

  await expect(repository.listShipmentEvents(context)).resolves.toMatchObject([
    { id: "newer" },
    { id: "older" }
  ]);
});
```

- [ ] **Step 2: Run the focused test and verify it fails because `listShipmentEvents` is absent**

Run: `npm test -- tests/unit/shipmentNotifications.test.ts`

- [ ] **Step 3: Add the notification type union and repository list implementation**

```ts
export type ShipmentNotificationType =
  | "quotes_ready_for_review"
  | "carrier_confirmation_received"
  | "incident_received"
  | "delay_assessed";

listShipmentEvents(context: OrganizationContext): Promise<ShipmentEvent[]>;
```

Implement the memory method by filtering `organizationId`, cloning, and sorting descending by `occurredAt`; implement the Postgres method with `ORDER BY occurred_at DESC`.

- [ ] **Step 4: Run the focused test and verify it passes**

Run: `npm test -- tests/unit/shipmentNotifications.test.ts`

### Task 2: Durable event publisher and read API

**Files:**
- Modify: `src/server.ts`
- Test: `tests/integration/server.test.ts`

**Interfaces:**
- Consumes `AgentRepository.addShipmentEvent`, `AgentRepository.listShipmentEvents`, request organization context, and server SSE clients.
- Produces `app.locals.publishShipmentEvent(event)` and `GET /api/shipment-events`.

- [ ] **Step 1: Write failing API and SSE tests**

```ts
it("lists persisted shipment events for the request organization", async () => {
  await repository.addShipmentEvent(event({ id: "event-1" }));
  const response = await request(app)
    .get("/api/shipment-events")
    .set(organizationHeaders);
  expect(response.body).toEqual([expect.objectContaining({ id: "event-1" })]);
});
```

```ts
it("publishes shipment.event.created only after persistence", async () => {
  // Connect an SSE client, invoke publishShipmentEvent, and assert the
  // observed event includes the persisted event ID.
});
```

- [ ] **Step 2: Run the focused test and verify it fails because the endpoint and publisher are absent**

Run: `npm test -- tests/integration/server.test.ts`

- [ ] **Step 3: Implement the publisher and endpoint**

```ts
async function publishShipmentEvent(event: ShipmentEvent): Promise<void> {
  await repository.addShipmentEvent(event);
  publishAgentEvent("shipment.event.created", event);
}

app.get("/api/shipment-events", async (request, response) => {
  const context = contextFromRequest(request, response);
  if (!context) return;
  response.status(200).json(await repository.listShipmentEvents(context));
});
```

The publisher must broadcast only to clients whose organization matches the event organization.

- [ ] **Step 4: Run the focused test and verify it passes**

Run: `npm test -- tests/integration/server.test.ts`

### Task 3: Create notification events from Volta workflows

**Files:**
- Modify: `src/telephony/orchestrator.ts`
- Modify: `src/agent/interpreter.ts`
- Modify: `src/server.ts`
- Test: `tests/unit/interpreter.test.ts`
- Test: `tests/unit/telephonyOrchestrator.test.ts`

**Interfaces:**
- Consumes `app.locals.publishShipmentEvent(event)` and workflow outcomes.
- Produces one event for quote-round readiness, confirmation result, verified incident, and delay assessment.

- [ ] **Step 1: Write failing workflow tests**

```ts
it("emits one quotes-ready event only after every candidate quote is reviewed", async () => {
  await completeCarrierRound();
  expect(events).toContainEqual(expect.objectContaining({
    type: "quotes_ready_for_review",
    metadata: { quoteIds: expect.any(Array), carrierCount: 3 }
  }));
});
```

```ts
it("records an incident and its unachievable delay assessment", () => {
  executeExceptionToolCall(recordIncidentRequest, dependencies);
  executeExceptionToolCall(notifyDashboardRequest, dependencies);
  expect(events.map((event) => event.type)).toEqual([
    "incident_received",
    "delay_assessed"
  ]);
});
```

- [ ] **Step 2: Run focused tests and verify they fail because event producers are absent**

Run: `npm test -- tests/unit/interpreter.test.ts tests/unit/telephonyOrchestrator.test.ts`

- [ ] **Step 3: Wire each producer to the server-owned publisher**

Use an injected callback rather than importing Express into agent modules. Create the events only after the underlying state transition succeeds. Confirmation emits `carrier_confirmation_received` once for either a final confirmation or a failed confirmation; incident recording emits `incident_received`; dashboard notification for an unachievable ETA emits `delay_assessed`; the orchestrator emits one ready event after the whole round is reviewed.

- [ ] **Step 4: Run focused tests and verify they pass**

Run: `npm test -- tests/unit/interpreter.test.ts tests/unit/telephonyOrchestrator.test.ts`

### Task 4: Notifications dashboard view

**Files:**
- Modify: `frontend/components/dashboard-console.tsx`
- Modify: `frontend/components/icons.tsx`
- Modify: `frontend/app/globals.css`
- Test: `frontend/components/dashboard-console.test.tsx`

**Interfaces:**
- Consumes `GET /api/shipment-events` and SSE event `shipment.event.created`.
- Produces the `notifications` navigation view and `NotificationsView`.

- [ ] **Step 1: Write failing component tests**

```tsx
it("opens organization-wide notifications from the drawer and shows newest events", async () => {
  mockShipmentEvents([newerEvent, olderEvent]);
  render(<DashboardConsole />);
  await userEvent.click(screen.getByRole("button", { name: /notifications/i }));
  expect(await screen.findByText(newerEvent.label)).toBeVisible();
  expect(screen.getByText(olderEvent.label)).toBeVisible();
});
```

```tsx
it("refreshes notifications after shipment.event.created", async () => {
  render(<DashboardConsole />);
  emitSse("shipment.event.created");
  await waitFor(() => expect(fetch).toHaveBeenCalledWith("/api/shipment-events"));
});
```

- [ ] **Step 2: Run the focused component test and verify it fails because the view is absent**

Run: `npm test -- frontend/components/dashboard-console.test.tsx`

- [ ] **Step 3: Implement the drawer row, view, details, and SSE refresh**

Add `notifications` to `View` and `navItems`; fetch persisted events in a focused hook; render cards using existing `Tag`, card, rail, and icon conventions. A card displays the event type-specific icon/tone, label, operation ID, and formatted time. The expanded section renders metadata as labeled values and an action to navigate to the relevant operation. Add only styles required for the existing design system.

- [ ] **Step 4: Run the focused component test and verify it passes**

Run: `npm test -- frontend/components/dashboard-console.test.tsx`

### Task 5: Whole-feature verification

**Files:**
- Modify: `docs/superpowers/specs/2026-08-30-shipment-notifications-design.md` only if implementation reveals a needed clarification.

- [ ] **Step 1: Run all automated checks**

Run: `npm run typecheck && npm run lint && npm test && npm run format:check`

- [ ] **Step 2: Check working tree without committing**

Run: `git status --short`

- [ ] **Step 3: Hand off changed files and verification results without a commit**
