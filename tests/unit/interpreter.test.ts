import { describe, expect, it } from "vitest";

import { executeToolCall } from "../../src/agent/interpreter";
import { createModeConfiguration } from "../../src/agent/modes";
import { seedOperation, THURSDAY_PICKUP } from "../../src/core/seed";
import { createOperationStore } from "../../src/core/state";

const quote = {
  id: "quote-costa-pacifico-001",
  carrierId: "carrier-costa-pacifico",
  carrierName: "Transportes Costa Pacífico",
  priceMxn: 8500,
  etaMinutes: 90,
  pickupTime: THURSDAY_PICKUP,
  callId: "call-discovery-001",
  createdAt: "2026-09-01T15:00:00.000Z"
};

const confirmationArguments = {
  quoteId: quote.id,
  carrierId: quote.carrierId,
  finalPrice: quote.priceMxn,
  pickupTime: quote.pickupTime,
  destinationDatetime: "2026-09-03T18:00:00-06:00",
  typeOfContent: "Textiles",
  weightKg: 18_400,
  measures: "120 × 100 × 110 cm",
  timestampMs: 42_500,
  driverName: "Maria Lopez",
  plate: "ABC-123",
  callId: "call-confirmation-001"
};

describe("mode-specific agent tools", () => {
  it("does not expose confirmation tools in negotiation mode", () => {
    expect(
      createModeConfiguration("negotiation").tools.map((tool) => tool.name)
    ).not.toContain("confirm_selected_deal");
  });

  it("does not expose negotiation-only tools in confirmation mode", () => {
    expect(
      createModeConfiguration("confirmation").tools.map((tool) => tool.name)
    ).not.toContain("register_quote");
  });

  it("requires preloaded context before exception tools are configured", () => {
    expect(createModeConfiguration("exception").tools).toEqual([]);
  });

  it("rejects a confirmation tool invoked in negotiation mode", async () => {
    const store = createOperationStore(seedOperation());

    await expect(
      executeToolCall(
        { name: "confirm_selected_deal", arguments: confirmationArguments },
        { mode: "negotiation", store, finalizeConfirmation: async () => {} }
      )
    ).resolves.toEqual({ outcome: "rejected", reason: "tool_not_allowed" });
  });
});

describe("executeToolCall", () => {
  it("publishes a registered quote as a reviewed deal with its mandate decision", async () => {
    const store = createOperationStore(seedOperation());

    await executeToolCall(
      { name: "register_quote", arguments: quote },
      { mode: "negotiation", store, finalizeConfirmation: async () => {} }
    );
    const result = await executeToolCall(
      {
        name: "review_deal",
        arguments: { quoteId: quote.id, reviewedAt: "2026-09-01T15:01:00.000Z" }
      },
      { mode: "negotiation", store, finalizeConfirmation: async () => {} }
    );

    expect(result).toEqual({
      outcome: "reviewed",
      mandateDecision: { status: "APPROVED" }
    });
    expect(store.getOperation()).toMatchObject({
      status: "awaiting_client_selection",
      reviewedDeals: [
        {
          quoteId: quote.id,
          callId: quote.callId,
          mandateDecision: "APPROVED"
        }
      ]
    });
  });

  it("keeps an over-cap quote and its review available for audit", async () => {
    const store = createOperationStore(seedOperation());
    const overCapQuote = {
      ...quote,
      id: "quote-ruta-occidente-001",
      priceMxn: 9200
    };
    const dependencies = {
      mode: "negotiation" as const,
      store,
      finalizeConfirmation: async () => {}
    };

    await executeToolCall(
      { name: "register_quote", arguments: overCapQuote },
      dependencies
    );
    const result = await executeToolCall(
      {
        name: "review_deal",
        arguments: {
          quoteId: overCapQuote.id,
          reviewedAt: "2026-09-01T15:01:00.000Z"
        }
      },
      dependencies
    );

    expect(result).toEqual({
      outcome: "reviewed",
      mandateDecision: {
        status: "REQUIRES_ESCALATION",
        reason: "price_cap_exceeded"
      }
    });
    expect(store.getOperation().reviewedDeals).toEqual([
      expect.objectContaining({
        quoteId: overCapQuote.id,
        mandateDecision: "REQUIRES_ESCALATION"
      })
    ]);
  });

  it("rejects confirm_selected_deal without an active matching selection", async () => {
    const store = createOperationStore(seedOperation());

    await expect(
      executeToolCall(
        { name: "confirm_selected_deal", arguments: confirmationArguments },
        { mode: "confirmation", store, finalizeConfirmation: async () => {} }
      )
    ).resolves.toMatchObject({
      outcome: "rejected",
      reason: "selection_required"
    });
  });

  it("finalizes only a confirmation matching the selected quote and mandate terms", async () => {
    const store = createOperationStore(seedOperation());
    const finalized: unknown[] = [];
    store.registerQuote(quote);
    store.reviewDeal({
      quoteId: quote.id,
      reviewedAt: "2026-09-01T15:01:00.000Z"
    });
    store.selectQuote({ quoteId: quote.id, now: "2026-09-01T15:02:00.000Z" });
    store.beginConfirmation(quote.id, confirmationArguments.callId);

    const result = await executeToolCall(
      { name: "confirm_selected_deal", arguments: confirmationArguments },
      {
        mode: "confirmation",
        store,
        now: () => "2026-09-01T15:03:00.000Z",
        finalizeConfirmation: async (intent) => {
          finalized.push(intent);
        }
      }
    );

    expect(result).toEqual({ outcome: "confirmation_requested" });
    expect(finalized).toEqual([confirmationArguments]);
    expect(store.getOperation().status).toBe("confirming_selected_carrier");
  });

  it("fails confirmation and records a brief when a selected term changes", async () => {
    const store = createOperationStore(seedOperation());
    store.registerQuote(quote);
    store.reviewDeal({
      quoteId: quote.id,
      reviewedAt: "2026-09-01T15:01:00.000Z"
    });
    store.selectQuote({ quoteId: quote.id, now: "2026-09-01T15:02:00.000Z" });
    store.beginConfirmation(quote.id, confirmationArguments.callId);

    const result = await executeToolCall(
      {
        name: "confirm_selected_deal",
        arguments: {
          ...confirmationArguments,
          destinationDatetime: "2026-09-03T19:00:00-06:00"
        }
      },
      {
        mode: "confirmation",
        store,
        finalizeConfirmation: async () => {
          throw new Error("finalizer must not run");
        }
      }
    );

    expect(result).toEqual({ outcome: "rejected", reason: "terms_mismatch" });
    expect(store.getOperation()).toMatchObject({
      status: "confirmation_failed",
      callBriefs: [
        expect.objectContaining({
          callId: confirmationArguments.callId,
          carrierId: quote.carrierId,
          outcome: "failed"
        })
      ]
    });
    expect(store.getOperation().commitment).toBeUndefined();
  });

  it("fails confirmation and records a brief when the callback identity mismatches", async () => {
    const store = createOperationStore(seedOperation());
    store.registerQuote(quote);
    store.reviewDeal({
      quoteId: quote.id,
      reviewedAt: "2026-09-01T15:01:00.000Z"
    });
    store.selectQuote({ quoteId: quote.id, now: "2026-09-01T15:02:00.000Z" });
    store.beginConfirmation(quote.id, confirmationArguments.callId);

    const result = await executeToolCall(
      {
        name: "confirm_selected_deal",
        arguments: {
          ...confirmationArguments,
          callId: "stale-confirmation-call"
        }
      },
      {
        mode: "confirmation",
        store,
        finalizeConfirmation: async () => {
          throw new Error("finalizer must not run");
        }
      }
    );

    expect(result).toEqual({
      outcome: "rejected",
      reason: "confirmation_call_mismatch"
    });
    expect(store.getOperation()).toMatchObject({
      status: "confirmation_failed",
      callBriefs: [
        expect.objectContaining({
          callId: confirmationArguments.callId,
          carrierId: quote.carrierId,
          outcome: "failed",
          objections: ["confirmation_call_mismatch"]
        })
      ]
    });
    expect(store.getOperation().commitment).toBeUndefined();
  });
});
