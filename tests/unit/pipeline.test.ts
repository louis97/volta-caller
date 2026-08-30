import { describe, expect, it } from "vitest";
import { derivePipelineStage } from "../../src/core/pipeline";
import { seedOperation } from "../../src/core/seed";

describe("derivePipelineStage", () => {
  it("projects call, quote, approval and commitment states in precedence order", () => {
    const operation = seedOperation();
    expect(derivePipelineStage(operation)).toBe("open");
    operation.callSessions.push({ id: "call", operationId: operation.id, direction: "outbound", status: "pending", startedAt: "2026-09-01T00:00:00Z" });
    expect(derivePipelineStage(operation)).toBe("calling");
    operation.quotes.push({ id: "quote", carrierId: "carrier", carrierName: "Carrier", priceMxn: 1, etaMinutes: 1, pickupTime: operation.mandate.pickupDatetime, callId: "call", createdAt: "2026-09-01T00:00:00Z" });
    expect(derivePipelineStage(operation)).toBe("quoting");
    operation.status = "awaiting_approval";
    expect(derivePipelineStage(operation)).toBe("awaiting_approval");
    operation.status = "committed";
    expect(derivePipelineStage(operation)).toBe("committed");
  });
});
