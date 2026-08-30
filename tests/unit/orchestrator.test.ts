import { describe, expect, it } from "vitest";
import { createOperationStore } from "../../src/core/state";
import { seedOperation } from "../../src/core/seed";
import { fanOutCalls } from "../../src/telephony/orchestrator";

describe("fanOutCalls", () => {
  it("creates one mock session per candidate without a live gateway", async () => {
    const store = createOperationStore(seedOperation());
    await fanOutCalls({
      store,
      mode: "mock",
      now: () => "2026-09-01T00:00:00.000Z"
    });
    expect(store.getOperation().callSessions).toHaveLength(3);
    expect(store.getOperation().callSessions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ status: "completed", callSid: "mock-call-1" })
      ])
    );
  });
});
