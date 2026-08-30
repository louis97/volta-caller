import type {
  Commitment,
  Escalation,
  Incident,
  OperationEvent,
  Quote
} from "@volta/contracts";
import { describe, expect, it } from "vitest";

import {
  createOperationFromMandate,
  seedOperation,
  THURSDAY_PICKUP
} from "../../src/core/seed";
import { createOperationStore } from "../../src/core/state";

const quote: Quote = {
  id: "quote-costa-pacifico-001",
  carrierId: "carrier-costa-pacifico",
  carrierName: "Transportes Costa Pacífico",
  priceMxn: 8500,
  etaMinutes: 90,
  pickupTime: THURSDAY_PICKUP,
  callId: "call-001",
  createdAt: "2026-09-01T15:00:00.000Z"
};

const commitment: Commitment = {
  id: "commitment-costa-pacifico-001",
  carrierId: "carrier-costa-pacifico",
  callId: "call-001",
  finalPriceMxn: 8500,
  pickupTime: THURSDAY_PICKUP,
  audioTimestampUrl: "https://audio.example.test/call-001?t=120",
  recapStatus: "sent",
  recapMessageId: "recap-001",
  finalizedAt: "2026-09-01T15:05:00.000Z"
};

const escalation: Escalation = {
  id: "escalation-001",
  operationId: "operation-textiles-pacifico-001",
  callId: "call-002",
  reason: "price_cap_exceeded",
  attemptedPriceMxn: 9500,
  attemptedPickupTime: THURSDAY_PICKUP,
  status: "requested",
  requestedAt: "2026-09-01T15:10:00.000Z"
};

const incident: Incident = {
  id: "incident-001",
  operationId: "operation-textiles-pacifico-001",
  callerName: "Juan Pérez",
  carrierId: "carrier-costa-pacifico",
  truckPlate: "ABC-123",
  processStage: "en_route",
  issue: "traffic delay",
  delayMinutes: 30,
  revisedEta: "2026-09-03T17:30:00-06:00",
  feasibility: "achievable",
  createdAt: "2026-09-03T14:00:00.000Z",
  verifiedCallerIdentity: "Juan Pérez"
};

describe("createOperationStore", () => {
  it("reviews a quote and makes an approved deal selectable", () => {
    const operation = seedOperation();
    operation.status = "negotiating";
    operation.quotes = [quote];
    const store = createOperationStore(operation);
    const received: OperationEvent[] = [];
    store.subscribe((event) => received.push(event));

    const reviewed = store.reviewDeal({
      quoteId: quote.id,
      reviewedAt: "2026-09-01T15:01:00.000Z"
    });

    expect(reviewed).toMatchObject({
      quoteId: quote.id,
      callId: quote.callId,
      mandateDecision: "APPROVED"
    });
    expect(store.getOperation().status).toBe("awaiting_client_selection");
    expect(received).toContainEqual({
      type: "deal.reviewed",
      operationId: operation.id,
      reviewedDeal: reviewed
    });
  });

  it("publishes each reviewed candidate without removing earlier candidates", () => {
    const operation = seedOperation();
    operation.status = "negotiating";
    operation.quotes = [
      quote,
      { ...quote, id: "quote-b", callId: "call-002", priceMxn: 9500 }
    ];
    const store = createOperationStore(operation);
    store.reviewDeal({
      quoteId: quote.id,
      reviewedAt: "2026-09-01T15:01:00.000Z"
    });
    store.reviewDeal({
      quoteId: "quote-b",
      reviewedAt: "2026-09-01T15:02:00.000Z"
    });

    expect(store.getOperation().reviewedDeals).toHaveLength(2);
    expect(store.getOperation().status).toBe("awaiting_client_selection");
  });

  it("rejects a second reviewed deal from the same discovery call", () => {
    const operation = seedOperation();
    operation.status = "negotiating";
    operation.quotes = [
      quote,
      { ...quote, id: "quote-same-call", priceMxn: 8700 }
    ];
    const store = createOperationStore(operation);
    store.reviewDeal({
      quoteId: quote.id,
      reviewedAt: "2026-09-01T15:01:00.000Z"
    });

    expect(() =>
      store.reviewDeal({
        quoteId: "quote-same-call",
        reviewedAt: "2026-09-01T15:02:00.000Z"
      })
    ).toThrow("call_already_reviewed");
    expect(store.getOperation().reviewedDeals).toHaveLength(1);
  });

  it("selects only an approved reviewed quote before destination expiry", () => {
    const operation = seedOperation();
    operation.status = "awaiting_client_selection";
    operation.quotes = [quote];
    operation.reviewedDeals = [
      {
        quoteId: quote.id,
        callId: quote.callId,
        mandateDecision: "APPROVED",
        reviewedAt: "2026-09-01T15:01:00.000Z"
      }
    ];
    const store = createOperationStore(operation);

    const selection = store.selectQuote({
      quoteId: quote.id,
      now: "2026-09-03T23:59:59Z"
    });

    expect(selection).toEqual({
      quoteId: quote.id,
      selectedAt: "2026-09-03T23:59:59Z",
      expiresAt: operation.mandate.destinationDatetime
    });
    expect(store.getOperation().status).toBe("carrier_selected");
  });

  it("marks an operation as selection_expired for an expired selection", () => {
    const operation = seedOperation();
    operation.status = "awaiting_client_selection";
    operation.quotes = [quote];
    operation.reviewedDeals = [
      {
        quoteId: quote.id,
        callId: quote.callId,
        mandateDecision: "APPROVED",
        reviewedAt: "2026-09-01T15:01:00.000Z"
      }
    ];
    const store = createOperationStore(operation);
    const before = store.getOperation();

    expect(() =>
      store.selectQuote({ quoteId: quote.id, now: "2026-09-04T00:00:00Z" })
    ).toThrow("selection_expired");
    expect(store.getOperation()).toMatchObject({
      ...before,
      status: "selection_expired"
    });
    expect(store.getOperation().selection).toBeUndefined();
  });

  it("rejects selection of a reviewed quote that is not approved", () => {
    const operation = seedOperation();
    operation.status = "awaiting_client_selection";
    operation.quotes = [{ ...quote, id: "quote-rejected", priceMxn: 9500 }];
    operation.reviewedDeals = [
      {
        quoteId: "quote-rejected",
        callId: quote.callId,
        mandateDecision: "REQUIRES_ESCALATION",
        reviewedAt: "2026-09-01T15:01:00.000Z"
      }
    ];
    const store = createOperationStore(operation);
    expect(() =>
      store.selectQuote({
        quoteId: "quote-rejected",
        now: "2026-09-03T23:00:00Z"
      })
    ).toThrow("selection_not_approved");
    expect(store.getOperation()).toEqual(operation);
  });

  it("transitions confirmation and records immutable incidents and notifications", () => {
    const operation = seedOperation();
    operation.status = "carrier_selected";
    operation.selection = {
      quoteId: quote.id,
      selectedAt: "2026-09-03T15:00:00.000Z",
      expiresAt: operation.mandate.destinationDatetime
    };
    const store = createOperationStore(operation);
    const received: OperationEvent[] = [];
    store.subscribe((event) => received.push(event));

    store.beginConfirmation(quote.id, "call-confirm-001");
    store.failConfirmation("caller_unverified", "call-confirm-001");
    store.recordIncident(incident);
    store.updateOperationStatus({
      incidentId: incident.id,
      status: "incident_monitoring"
    });
    const notification = {
      operationId: incident.operationId,
      incidentId: incident.id,
      message: "Delay recorded",
      createdAt: incident.createdAt
    };
    store.notifyDashboard(notification);

    expect(store.getOperation()).toMatchObject({
      status: "incident_monitoring",
      incidents: [incident],
      dashboardNotifications: [notification]
    });
    expect(received.map((event) => event.type)).toEqual([
      "confirmation.failed",
      "incident.updated",
      "dashboard.notification.created"
    ]);
  });

  it("rejects confirmation failure outside an active confirmation", () => {
    const store = createOperationStore(seedOperation());
    const before = store.getOperation();

    expect(() =>
      store.failConfirmation("caller_unverified", "call-001")
    ).toThrow("confirmation_not_allowed");
    expect(store.getOperation()).toEqual(before);
  });

  it("rejects a stale confirmation failure call ID without mutation", () => {
    const operation = seedOperation();
    operation.status = "carrier_selected";
    operation.selection = {
      quoteId: quote.id,
      selectedAt: "2026-09-03T15:00:00.000Z",
      expiresAt: operation.mandate.destinationDatetime
    };
    const store = createOperationStore(operation);
    store.beginConfirmation(quote.id, "call-confirm-current");
    const before = store.getOperation();

    expect(() =>
      store.failConfirmation("stale_callback", "call-confirm-stale")
    ).toThrow("confirmation_call_mismatch");
    expect(store.getOperation()).toEqual(before);
  });

  it("does not let listeners mutate newly emitted payloads", () => {
    const operation = seedOperation();
    operation.status = "negotiating";
    operation.quotes = [quote];
    const store = createOperationStore(operation);
    const received: OperationEvent[] = [];
    store.subscribe((event) => {
      received.push(event);
      if (event.type === "deal.reviewed") event.reviewedDeal.callId = "mutated";
      if (event.type === "incident.updated") event.incident.issue = "mutated";
      if (event.type === "dashboard.notification.created")
        event.notification.message = "mutated";
    });

    store.reviewDeal({
      quoteId: quote.id,
      reviewedAt: "2026-09-01T15:01:00.000Z"
    });
    store.recordIncident(incident);
    store.notifyDashboard({
      operationId: incident.operationId,
      incidentId: incident.id,
      message: "Delay recorded",
      createdAt: incident.createdAt
    });

    expect(store.getOperation().reviewedDeals[0].callId).toBe(quote.callId);
    expect(store.getOperation().incidents[0].issue).toBe(incident.issue);
    expect(store.getOperation().dashboardNotifications[0].message).toBe(
      "Delay recorded"
    );
  });
  it("publishes a quote event and retains the quote", () => {
    const store = createOperationStore(seedOperation());
    const received: OperationEvent[] = [];
    store.subscribe((event) => received.push(event));

    store.registerQuote(quote);

    expect(store.getOperation().quotes).toContainEqual(quote);
    expect(received).toEqual([
      {
        type: "quote.registered",
        operationId: "operation-textiles-pacifico-001",
        quote
      }
    ]);
  });

  it("publishes one matching event for each commitment and escalation mutation", () => {
    const store = createOperationStore(seedOperation());
    const received: OperationEvent[] = [];
    store.subscribe((event) => received.push(event));

    store.finalizeCommitment(commitment);
    store.requestEscalation(escalation);

    expect(store.getOperation()).toMatchObject({
      selectedCarrierId: commitment.carrierId,
      commitment,
      escalations: [escalation]
    });
    expect(received).toEqual([
      {
        type: "commitment.finalized",
        operationId: "operation-textiles-pacifico-001",
        commitment
      },
      {
        type: "escalation.requested",
        operationId: "operation-textiles-pacifico-001",
        escalation
      }
    ]);
  });

  it("stops delivering events after unsubscribe", () => {
    const store = createOperationStore(seedOperation());
    const received: OperationEvent[] = [];
    const unsubscribe = store.subscribe((event) => received.push(event));

    unsubscribe();
    store.registerQuote(quote);

    expect(received).toEqual([]);
  });

  it("replaces the active operation only through the store and publishes its mandate", () => {
    const store = createOperationStore(seedOperation());
    const received: OperationEvent[] = [];
    store.subscribe((event) => received.push(event));
    const nextOperation = createOperationFromMandate(
      {
        budget_cap: 8700,
        destination_datetime: "2026-09-03T18:00:00-06:00",
        destination_place: "Guadalajara, Jalisco",
        type_of_content: "Textiles",
        weight: 18400,
        measures: "120 × 100 × 110 cm",
        pickup_address: "Manzanillo, Colima",
        pickup_datetime: THURSDAY_PICKUP
      },
      "operation-mandate-1"
    );

    store.replaceOperation(nextOperation);

    expect(store.getOperation()).toEqual(nextOperation);
    expect(received).toEqual([
      {
        type: "mandate.created",
        operationId: "operation-mandate-1",
        mandate: nextOperation.mandate
      }
    ]);
  });

  it("returns snapshots that cannot mutate the store", () => {
    const store = createOperationStore(seedOperation());
    const snapshot = store.getOperation();

    snapshot.quotes.push(quote);
    snapshot.mandate.budgetCapMxn = 1;
    snapshot.candidates[0].name = "Changed outside the store";

    const storedOperation = store.getOperation();
    expect(storedOperation.quotes).toEqual([]);
    expect(storedOperation.mandate.budgetCapMxn).toBe(9000);
    expect(storedOperation.candidates[0].name).toBe(
      "Transportes Costa Pacífico"
    );
  });
});
