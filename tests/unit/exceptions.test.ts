import { describe, expect, it } from "vitest";

import { executeExceptionToolCall } from "../../src/agent/interpreter";
import { createExceptionModeConfiguration } from "../../src/agent/modes";
import { createExceptionCallContext } from "../../src/core/exceptions";
import { seedOperation } from "../../src/core/seed";
import { createOperationStore } from "../../src/core/state";

const selectedQuote = {
  id: "quote-costa-pacifico-001",
  carrierId: "carrier-costa-pacifico",
  carrierName: "Transportes Costa Pacífico",
  priceMxn: 8500,
  etaMinutes: 90,
  pickupTime: "2026-09-03T10:00:00-06:00",
  callId: "call-discovery-001",
  createdAt: "2026-09-01T15:00:00.000Z"
};

function operationWithSelectionAndHistory() {
  const operation = seedOperation();
  operation.status = "committed";
  operation.quotes = [selectedQuote];
  operation.selection = {
    quoteId: selectedQuote.id,
    selectedAt: "2026-09-01T15:02:00.000Z",
    expiresAt: operation.mandate.destinationDatetime
  };
  operation.commitment = {
    id: "commitment-costa-pacifico-001",
    carrierId: selectedQuote.carrierId,
    callId: "call-confirmation-001",
    finalPriceMxn: selectedQuote.priceMxn,
    pickupTime: selectedQuote.pickupTime,
    driverName: "María López",
    plate: "ABC-123",
    audioTimestampUrl: "https://audio.example.test/call-confirmation-001",
    recapStatus: "sent",
    finalizedAt: "2026-09-01T15:05:00.000Z"
  };
  operation.callBriefs = [
    {
      id: "brief-confirmation-001",
      callId: "call-confirmation-001",
      carrierId: selectedQuote.carrierId,
      summary: "Selected carrier confirmed the shipment.",
      objections: [],
      actions: ["Monitor the committed shipment"],
      outcome: "committed",
      createdAt: "2026-09-01T15:05:00.000Z"
    }
  ];
  return operation;
}

describe("exception call context", () => {
  it("preloads mandate, selected terms, and audit history before an exception call", () => {
    const operation = operationWithSelectionAndHistory();
    const context = createExceptionCallContext(operation);
    operation.mandate.destinationPlace = "Mutated destination";
    operation.callBriefs[0].summary = "Mutated brief";

    expect(context).toMatchObject({
      operationId: operation.id,
      mandate: { destinationPlace: "Textiles Pacífico, Guadalajara, Jalisco" },
      selectedCarrier: { id: selectedQuote.carrierId },
      selectedQuote,
      knownTruckPlate: "ABC-123",
      previousCallBriefs: [
        { summary: "Selected carrier confirmed the shipment." }
      ]
    });
  });

  it("injects frozen context without the escalation phone and exposes only exception writes", () => {
    const configuration = createExceptionModeConfiguration(
      createExceptionCallContext(operationWithSelectionAndHistory())
    );

    expect(configuration.tools.map((tool) => tool.name)).toEqual([
      "record_incident",
      "update_operation_status",
      "notify_dashboard",
      "trigger_escalation"
    ]);
    expect(configuration.instructions).toContain(
      '"operationId":"operation-textiles-pacifico-001"'
    );
    expect(configuration.instructions).not.toContain("+52-33-0000-0000");

    const forbiddenTools = [
      "identify_caller",
      "assess_mandate_feasibility",
      "check_mandate",
      "register_quote",
      "review_deal",
      "confirm_selected_deal"
    ];
    expect(configuration.tools.map((tool) => tool.name)).not.toEqual(
      expect.arrayContaining(forbiddenTools)
    );
  });
});

describe("exception write-only tools", () => {
  it("rejects an unmatched caller identity without recording an incident", async () => {
    const store = createOperationStore(operationWithSelectionAndHistory());
    const context = createExceptionCallContext(store.getOperation());

    const result = await executeExceptionToolCall(
      {
        name: "record_incident",
        arguments: {
          callerName: "Unknown driver",
          carrierId: "carrier-ruta-occidente",
          truckPlate: "ABC-123",
          processStage: "en_route",
          issue: "Traffic delay",
          delayMinutes: 30,
          revisedEta: "2026-09-03T17:30:00-06:00"
        }
      },
      { store, context }
    );

    expect(result).toEqual({
      outcome: "rejected",
      reason: "caller_unverified"
    });
    expect(store.getOperation().status).toBe("committed");
    expect(store.getOperation().incidents).toEqual([]);
    expect(store.getOperation().dashboardNotifications).toEqual([]);
  });

  it("notifies the dashboard only for a validated incident with an unachievable ETA", async () => {
    const store = createOperationStore(operationWithSelectionAndHistory());
    const context = createExceptionCallContext(store.getOperation());
    const incident = {
      callerName: "María López",
      carrierId: selectedQuote.carrierId,
      truckPlate: "ABC-123",
      processStage: "en_route",
      issue: "Road closure",
      delayMinutes: 90,
      revisedEta: "2026-09-03T18:30:00-06:00"
    };

    await expect(
      executeExceptionToolCall(
        { name: "record_incident", arguments: incident },
        { store, context, now: () => "2026-09-03T14:00:00.000Z" }
      )
    ).resolves.toEqual({
      outcome: "incident_recorded",
      feasibility: "unachievable"
    });

    const incidentId = store.getOperation().incidents[0].id;
    await expect(
      executeExceptionToolCall(
        { name: "notify_dashboard", arguments: { incidentId } },
        { store, context, now: () => "2026-09-03T14:01:00.000Z" }
      )
    ).resolves.toEqual({ outcome: "dashboard_notified" });
    await expect(
      executeExceptionToolCall(
        { name: "notify_dashboard", arguments: { incidentId } },
        { store, context }
      )
    ).resolves.toEqual({
      outcome: "rejected",
      reason: "dashboard_already_notified"
    });

    expect(store.getOperation().dashboardNotifications).toEqual([
      expect.objectContaining({
        incidentId,
        message:
          "Incident incident-operation-textiles-pacifico-001-1 has a revised ETA after the destination deadline."
      })
    ]);
  });

  it("only begins monitoring when the recorded ETA can still meet the mandate", async () => {
    const store = createOperationStore(operationWithSelectionAndHistory());
    const context = createExceptionCallContext(store.getOperation());

    await executeExceptionToolCall(
      {
        name: "record_incident",
        arguments: {
          callerName: "María López",
          carrierId: selectedQuote.carrierId,
          truckPlate: "ABC-123",
          processStage: "en_route",
          issue: "Traffic delay",
          delayMinutes: 30,
          revisedEta: "2026-09-03T17:30:00-06:00"
        }
      },
      { store, context }
    );
    const incidentId = store.getOperation().incidents[0].id;

    await expect(
      executeExceptionToolCall(
        { name: "update_operation_status", arguments: { incidentId } },
        { store, context }
      )
    ).resolves.toEqual({ outcome: "status_updated" });
    expect(store.getOperation().status).toBe("incident_monitoring");
    expect(store.getOperation().dashboardNotifications).toEqual([]);
    expect(store.getOperation().incidents).toEqual([
      expect.objectContaining({
        callerName: "María López",
        carrierId: selectedQuote.carrierId,
        truckPlate: "ABC-123",
        feasibility: "achievable"
      })
    ]);
  });
});
