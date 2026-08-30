import { describe, expect, it } from "vitest";

import { executeToolCall } from "../../src/agent/interpreter";
import { seedOperation, THURSDAY_PICKUP } from "../../src/core/seed";
import { createOperationStore } from "../../src/core/state";
import { attachMediaStreamRelay } from "../../src/telephony/mediaStream";
import { callClockMs, createCallRegistry } from "../../src/telephony/registry";

class FakeSocket {
  readonly sent: string[] = [];
  private readonly listeners: Array<(message: string) => void> = [];

  send(message: string): void {
    this.sent.push(message);
  }

  on(event: "message" | "close", listener: (message: string) => void): void {
    if (event === "message") this.listeners.push(listener);
  }

  receive(message: object): void {
    for (const listener of this.listeners) listener(JSON.stringify(message));
  }
}

function frame(): object {
  return { event: "media", streamSid: "MZ1", media: { payload: "AAAA" } };
}

describe("call clock", () => {
  it("advances one 20 ms tick per inbound media frame", () => {
    const registry = createCallRegistry();
    const twilio = new FakeSocket();
    const realtime = new FakeSocket();

    attachMediaStreamRelay({
      twilio,
      realtime,
      executeToolCall: async () => ({ outcome: "approved" }),
      onStart: ({ streamSid, callSid }) =>
        registry.open({
          callSid: callSid ?? streamSid,
          streamSid,
          operationId: "operation-1",
          direction: "outbound",
          startedAt: "2026-08-29T23:00:00.000Z"
        })
    });

    twilio.receive({
      event: "start",
      streamSid: "MZ1",
      start: { streamSid: "MZ1", callSid: "CA1" }
    });
    for (let index = 0; index < 50; index += 1) twilio.receive(frame());

    expect(callClockMs(registry.get("MZ1")!)).toBe(1000);
  });

  it("anchors a commitment to the call clock, not to model input", async () => {
    const store = createOperationStore(seedOperation());
    const booked: Array<{ timestampMs?: number }> = [];
    const dependencies = {
      mode: "confirmation" as const,
      store,
      finalizeConfirmation: (intent: { timestampMs?: number }) => {
        booked.push(intent);
      },
      callContext: { callId: "CA-real", callClockMs: () => 94_200 }
    };

    // Reach a client-selected carrier: only then may a confirmation close.
    const quote = {
      id: "quote-1",
      carrierId: "carrier-costa-pacifico",
      carrierName: "Transportes Costa Pacífico",
      priceMxn: 8500,
      etaMinutes: 90,
      pickupTime: THURSDAY_PICKUP,
      callId: "CA-real",
      createdAt: "2026-09-01T15:00:00.000Z"
    };
    store.registerQuote(quote);
    store.reviewDeal({
      quoteId: quote.id,
      reviewedAt: "2026-09-01T15:01:00.000Z"
    });
    store.selectQuote({ quoteId: quote.id, now: "2026-09-01T15:02:00.000Z" });
    store.beginConfirmation(quote.id, "CA-real");

    const mandate = store.getOperation().mandate;
    await executeToolCall(
      {
        name: "confirm_selected_deal",
        arguments: {
          quoteId: quote.id,
          carrierId: quote.carrierId,
          finalPrice: quote.priceMxn,
          pickupTime: quote.pickupTime,
          destinationDatetime: mandate.destinationDatetime,
          typeOfContent: mandate.typeOfContent,
          weightKg: mandate.weightKg,
          measures: mandate.measures,
          // The model claims an offset. It must not survive.
          timestampMs: 999_999
        }
      },
      dependencies
    );

    expect(booked).toHaveLength(1);
    expect(booked[0]?.timestampMs).toBe(94_200);
  });

  it("stamps a quote with the server's call id, ignoring the model's", async () => {
    const store = createOperationStore(seedOperation());

    await executeToolCall(
      {
        name: "register_quote",
        arguments: {
          carrierId: "carrier-costa-pacifico",
          carrierName: "Transportes Costa Pacífico",
          priceMxn: 8500,
          etaMinutes: 90,
          pickupTime: THURSDAY_PICKUP,
          callId: "call-invented-by-the-model"
        }
      },
      {
        store,
        mode: "negotiation" as const,
        finalizeConfirmation: () => {},
        callContext: { callId: "CA-real", callClockMs: () => 0 }
      }
    );

    expect(store.getOperation().quotes[0]?.callId).toBe("CA-real");
  });
});
