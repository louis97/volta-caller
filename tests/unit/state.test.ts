import type {
  Commitment,
  Escalation,
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

describe("createOperationStore", () => {
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

  it("opens and patches call sessions while publishing their lifecycle", () => {
    const store = createOperationStore(seedOperation());
    const events: OperationEvent[] = [];
    store.subscribe((event) => events.push(event));
    store.openCallSession({ id: "call-1", operationId: "operation-textiles-pacifico-001", carrierId: "carrier-costa-pacifico", direction: "outbound", status: "pending", startedAt: "2026-09-01T15:00:00.000Z" });
    store.updateCallSession("call-1", { status: "failed", endedReason: "no-answer", endedAt: "2026-09-01T15:01:00.000Z" });
    expect(store.getOperation().callSessions[0]).toMatchObject({ id: "call-1", status: "failed", endedReason: "no-answer" });
    expect(events.map((event) => event.type)).toEqual(["call.started", "call.updated"]);
  });
});
