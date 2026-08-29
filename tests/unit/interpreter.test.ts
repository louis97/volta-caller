import { describe, expect, it } from "vitest";

import { executeToolCall } from "../../src/agent/interpreter";
import { seedOperation, THURSDAY_PICKUP } from "../../src/core/seed";
import { createOperationStore } from "../../src/core/state";

const approvedTerms = {
  carrierId: "carrier-costa-pacifico",
  finalPrice: 8500,
  pickupTime: THURSDAY_PICKUP,
  timestampMs: 42_500,
  driverName: "María López",
  plate: "ABC-123"
};

describe("executeToolCall", () => {
  it("escalates and never commits a 10,000 MXN request", async () => {
    const store = createOperationStore(seedOperation());
    const finalized: unknown[] = [];

    const result = await executeToolCall(
      {
        name: "commit_deal",
        arguments: { ...approvedTerms, finalPrice: 10_000 }
      },
      {
        store,
        finalizeBooking: async (intent) => {
          finalized.push(intent);
        }
      }
    );

    expect(result).toMatchObject({
      outcome: "escalated",
      reason: "price_cap_exceeded"
    });
    expect(store.getOperation().commitment).toBeUndefined();
    expect(store.getOperation().escalations).toMatchObject([
      {
        reason: "price_cap_exceeded",
        attemptedPriceMxn: 10_000,
        attemptedPickupTime: THURSDAY_PICKUP
      }
    ]);
    expect(finalized).toEqual([]);
  });

  it("escalates an unapproved pickup time before calling the finalizer", async () => {
    const store = createOperationStore(seedOperation());
    const finalized: unknown[] = [];

    const result = await executeToolCall(
      {
        name: "commit_deal",
        arguments: {
          ...approvedTerms,
          pickupTime: "2026-09-03T11:00:00-06:00"
        }
      },
      {
        store,
        finalizeBooking: async (intent) => {
          finalized.push(intent);
        }
      }
    );

    expect(result).toMatchObject({
      outcome: "escalated",
      reason: "pickup_window_unapproved"
    });
    expect(store.getOperation().commitment).toBeUndefined();
    expect(finalized).toEqual([]);
  });

  it("passes only mandate-approved booking intent to the injected finalizer", async () => {
    const store = createOperationStore(seedOperation());
    const finalized: unknown[] = [];

    const result = await executeToolCall(
      { name: "commit_deal", arguments: approvedTerms },
      {
        store,
        finalizeBooking: async (intent) => {
          finalized.push(intent);
        }
      }
    );

    expect(result).toEqual({ outcome: "booking_requested" });
    expect(finalized).toEqual([approvedTerms]);
    expect(store.getOperation().commitment).toBeUndefined();
  });

  it("registers a validated quote in the operation store", async () => {
    const store = createOperationStore(seedOperation());

    const result = await executeToolCall(
      {
        name: "register_quote",
        arguments: {
          id: "quote-costa-pacifico-001",
          carrierId: "carrier-costa-pacifico",
          carrierName: "Transportes Costa Pacífico",
          priceMxn: 8500,
          etaMinutes: 90,
          pickupTime: THURSDAY_PICKUP,
          callId: "call-001",
          createdAt: "2026-09-01T15:00:00.000Z"
        }
      },
      { store, finalizeBooking: async () => {} }
    );

    expect(result).toEqual({
      outcome: "registered",
      mandateDecision: { status: "APPROVED" }
    });
    expect(store.getOperation().quotes).toMatchObject([
      { id: "quote-costa-pacifico-001", priceMxn: 8500 }
    ]);
  });

  it("rejects malformed tool input without mutating the operation", async () => {
    const store = createOperationStore(seedOperation());

    const result = await executeToolCall(
      {
        name: "register_quote",
        arguments: { carrierId: "carrier-costa-pacifico", priceMxn: "8500" }
      },
      { store, finalizeBooking: async () => {} }
    );

    expect(result).toEqual({
      outcome: "rejected",
      reason: "invalid_arguments"
    });
    expect(store.getOperation().quotes).toEqual([]);
  });

  it("records an over-cap quote with its mandate evaluation", async () => {
    const store = createOperationStore(seedOperation());

    const result = await executeToolCall(
      {
        name: "register_quote",
        arguments: {
          id: "quote-costa-pacifico-002",
          carrierId: "carrier-costa-pacifico",
          carrierName: "Transportes Costa Pacífico",
          priceMxn: 10_000,
          etaMinutes: 90,
          pickupTime: THURSDAY_PICKUP,
          callId: "call-002",
          createdAt: "2026-09-01T15:05:00.000Z"
        }
      },
      { store, finalizeBooking: async () => {} }
    );

    expect(result).toEqual({
      outcome: "registered",
      mandateDecision: {
        status: "REQUIRES_ESCALATION",
        reason: "price_cap_exceeded"
      }
    });
    expect(store.getOperation().quotes).toMatchObject([
      { id: "quote-costa-pacifico-002", priceMxn: 10_000 }
    ]);
  });

  it("requires current_price_offered when triggering an escalation", async () => {
    const store = createOperationStore(seedOperation());

    const result = await executeToolCall(
      {
        name: "trigger_escalation",
        arguments: { reason: "carrier_requested_exception" }
      },
      { store, finalizeBooking: async () => {} }
    );

    expect(result).toEqual({
      outcome: "rejected",
      reason: "invalid_arguments"
    });
    expect(store.getOperation().escalations).toEqual([]);
  });

  it("records an over-cap escalation with its mandate evaluation", async () => {
    const store = createOperationStore(seedOperation());

    const result = await executeToolCall(
      {
        name: "trigger_escalation",
        arguments: {
          reason: "carrier_requested_exception",
          current_price_offered: 10_000,
          callId: "call-003"
        }
      },
      { store, finalizeBooking: async () => {} }
    );

    expect(result).toEqual({
      outcome: "escalated",
      reason: "carrier_requested_exception",
      mandateDecision: {
        status: "REQUIRES_ESCALATION",
        reason: "price_cap_exceeded"
      }
    });
    expect(store.getOperation().escalations).toMatchObject([
      {
        reason: "carrier_requested_exception",
        attemptedPriceMxn: 10_000,
        attemptedPickupTime: THURSDAY_PICKUP,
        callId: "call-003"
      }
    ]);
  });
});
