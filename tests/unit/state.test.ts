import type {
  Commitment,
  Escalation,
  OperationEvent,
  Quote
} from "@volta/contracts";
import { describe, expect, it } from "vitest";

import { seedOperation, THURSDAY_PICKUP } from "../../src/core/seed";
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

  it("returns snapshots that cannot mutate the store", () => {
    const store = createOperationStore(seedOperation());
    const snapshot = store.getOperation();

    snapshot.quotes.push(quote);
    snapshot.mandate.maxPriceMxn = 1;
    snapshot.candidates[0].name = "Changed outside the store";

    const storedOperation = store.getOperation();
    expect(storedOperation.quotes).toEqual([]);
    expect(storedOperation.mandate.maxPriceMxn).toBe(9000);
    expect(storedOperation.candidates[0].name).toBe(
      "Transportes Costa Pacífico"
    );
  });
});
