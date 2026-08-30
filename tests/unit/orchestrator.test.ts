import { describe, expect, it } from "vitest";
import { createOperationStore } from "../../src/core/state";
import { seedOperation } from "../../src/core/seed";
import { createMockTelephonyGateway } from "../../src/mocks/telephony";
import { fanOutCalls } from "../../src/telephony/orchestrator";

describe("fanOutCalls", () => {
  it("creates one mock session per candidate without a live gateway", async () => {
    const store = createOperationStore(seedOperation());
    const candidateCount = store.getOperation().candidates.length;
    await fanOutCalls({
      store,
      mode: "mock",
      now: () => "2026-09-01T00:00:00.000Z"
    });
    // One session per candidate, whatever the roster happens to be: the
    // carriers we demo with follow the handsets available, not a fixed count.
    expect(store.getOperation().callSessions).toHaveLength(candidateCount);
    expect(store.getOperation().callSessions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ status: "completed", callSid: "mock-call-1" })
      ])
    );
  });

  it("carries the durable operation and carrier identity on every Twilio callback", async () => {
    const store = createOperationStore(seedOperation());
    const gateway = createMockTelephonyGateway();

    await fanOutCalls({
      store,
      organizationId: "textiles-pacifico",
      mode: "live",
      publicBaseUrl: "https://volta.example.test",
      gateway,
      createCallReference: async (context) => ({
        callToken: `token-${context.carrierId}`
      })
    });

    const created = gateway.calls.filter((call) => call.type === "created");
    expect(created).toHaveLength(store.getOperation().candidates.length);
    for (const call of created) {
      if (call.type !== "created") continue;
      const twiml = new URL(call.input.twimlUrl);
      const status = new URL(call.input.statusCallbackUrl ?? "");
      expect(twiml.searchParams.get("callToken")).toBe(
        `token-${call.input.carrierId}`
      );
      expect(twiml.searchParams.has("operationId")).toBe(false);
      expect(twiml.searchParams.has("carrierId")).toBe(false);
      expect(twiml.searchParams.has("organizationId")).toBe(false);
      expect(status.search).toBe(twiml.search);
    }
  });

  it("does not dial live without a persisted call reference", async () => {
    const store = createOperationStore(seedOperation());
    const gateway = createMockTelephonyGateway();

    await fanOutCalls({
      store,
      organizationId: "textiles-pacifico",
      mode: "live",
      publicBaseUrl: "https://volta.example.test",
      gateway
    });

    expect(gateway.calls).toHaveLength(0);
    expect(store.getOperation().callSessions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          status: "failed",
          endedReason: "telephony_call_context_persistence_missing"
        })
      ])
    );
  });
});
