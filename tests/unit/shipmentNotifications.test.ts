import type { ShipmentEvent } from "@volta/contracts";
import { describe, expect, it } from "vitest";

import {
  MemoryAgentRepository,
  type OrganizationContext
} from "../../src/agent/repository";

const context: OrganizationContext = {
  organizationId: "textiles-pacifico",
  userId: "dispatcher-001"
};

describe("shipment notifications", () => {
  it("lists only the requesting organization's events newest first", async () => {
    const repository = new MemoryAgentRepository();
    await repository.addShipmentEvent(
      event("older", "2026-08-30T09:00:00.000Z")
    );
    await repository.addShipmentEvent(
      event("newer", "2026-08-30T10:00:00.000Z")
    );
    await repository.addShipmentEvent(
      event("other-org", "2026-08-30T11:00:00.000Z", "another-organization")
    );

    await expect(repository.listShipmentEvents(context)).resolves.toMatchObject(
      [{ id: "newer" }, { id: "older" }]
    );
  });
});

function event(
  id: string,
  occurredAt: string,
  organizationId = context.organizationId
): ShipmentEvent {
  return {
    id,
    organizationId,
    operationId: "operation-001",
    type: "quotes_ready_for_review",
    label: "Carrier quotes are ready for review.",
    source: "volta",
    occurredAt,
    receivedAt: occurredAt,
    metadata: { quoteIds: ["quote-001"], carrierCount: 1 }
  };
}
