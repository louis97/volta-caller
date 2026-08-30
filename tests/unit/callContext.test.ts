import { describe, expect, it } from "vitest";

import { createOperationFromMandate, seedOperation } from "../../src/core/seed";
import { createOperationStore } from "../../src/core/state";
import {
  callContextFromUrl,
  resolveCallDependencies
} from "../../src/telephony/routes";

describe("durable telephony call context", () => {
  it("rehydrates the requested operation instead of using another instance's stale store", async () => {
    const staleStore = createOperationStore(seedOperation());
    const correctOperation = createOperationFromMandate(
      {
        budget_cap: 5000,
        pickup_address: "Puerto de Santa Marta",
        pickup_datetime: "2026-08-31T05:00:00-05:00",
        destination_place: "Carrera 87 B #6-10, Medellín",
        destination_datetime: "2026-09-03T17:00:00-05:00",
        type_of_content: "contenedor frágil",
        weight: 40000,
        measures: "20 cm x 20 cm x 10 cm"
      },
      "operation-santa-marta"
    );
    correctOperation.candidates = [
      { id: "carrier-001", name: "Carrier correcto", phone: "+573001234567" }
    ];
    const correctStore = createOperationStore(correctOperation);

    const resolved = await resolveCallDependencies(
      {
        store: staleStore,
        resolveCallContext: async (reference) => {
          expect(reference).toEqual({
            operationId: "operation-santa-marta",
            carrierId: "carrier-001",
            organizationId: "textiles-pacifico"
          });
          return {
            store: correctStore,
            organizationId: "textiles-pacifico",
            carrier: correctOperation.candidates[0]
          };
        }
      },
      {
        operationId: "operation-santa-marta",
        carrierId: "carrier-001",
        organizationId: "textiles-pacifico"
      }
    );

    expect(resolved.store.getOperation()).toMatchObject({
      id: "operation-santa-marta",
      origin: "Puerto de Santa Marta",
      mandate: { budgetCapMxn: 5000, weightKg: 40000 }
    });
    expect(resolved.callContext?.carrier).toEqual({
      id: "carrier-001",
      name: "Carrier correcto",
      phone: "+573001234567"
    });
  });

  it("never falls back to stale state when a referenced operation is missing", async () => {
    await expect(
      resolveCallDependencies(
        {
          store: createOperationStore(seedOperation()),
          resolveCallContext: async () => undefined
        },
        { operationId: "operation-missing" }
      )
    ).rejects.toThrow("telephony_call_context_not_found");
  });

  it("reads the durable identifiers propagated to the media WebSocket", () => {
    expect(
      callContextFromUrl(
        new URL(
          "wss://volta.example.test/media-stream?operationId=operation-1&carrierId=carrier-2&organizationId=textiles-pacifico"
        )
      )
    ).toEqual({
      operationId: "operation-1",
      carrierId: "carrier-2",
      organizationId: "textiles-pacifico"
    });
  });
});
