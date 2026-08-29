import { describe, expect, it } from "vitest";

import {
  createCommitmentFinalizer,
  generateCommitmentRecap
} from "../../src/audit/commitment";
import { createCallBrief } from "../../src/audit/callBrief";
import { seedOperation, THURSDAY_PICKUP } from "../../src/core/seed";
import { createOperationStore } from "../../src/core/state";
import { MockSmsGateway } from "../../src/mocks/sms";

const input = {
  callId: "CA123",
  containerId: "MSCU-TP-001",
  priceMxn: 8500,
  pickupTime: THURSDAY_PICKUP,
  timestampMs: 42_500,
  driverName: "María López",
  recipient: "+52-33-0000-0000"
};

describe("commitment audit services", () => {
  it("creates an audio timestamp URL and records a Spanish SMS recap", async () => {
    const mockSms = new MockSmsGateway();

    const result = await generateCommitmentRecap(input, mockSms);

    expect(result.audioTimestampUrl).toBe("/audio/recordings/CA123#t=42.5");
    expect(mockSms.sent).toMatchObject([
      {
        to: "+52-33-0000-0000",
        body: "Textiles Pacífico - Confirmación de Reserva: Carga MSCU-TP-001, Tarifa $8500 MXN, Pick-up: 2026-09-03T10:00:00-06:00, Chofer: María López. Cita confirmada.",
        id: "mock-sms-1",
        status: "sent"
      }
    ]);
    expect(result.recapStatus).toBe("sent");
    expect(result.messageId).toBe("mock-sms-1");
  });

  it("keeps a failed recap out of final commitments and records a structured failed brief", async () => {
    const store = createOperationStore(seedOperation());
    const finalizer = createCommitmentFinalizer({
      store,
      sms: new MockSmsGateway("failed"),
      callId: "CA123",
      recipient: "+52-33-0000-0000",
      now: () => "2026-09-01T15:05:00.000Z"
    });

    await expect(
      finalizer({
        carrierId: "carrier-costa-pacifico",
        finalPrice: 8500,
        pickupTime: THURSDAY_PICKUP,
        timestampMs: 42_500,
        driverName: "María López",
        plate: "ABC-123"
      })
    ).rejects.toThrow("sms_recap_failed");

    expect(store.getOperation().commitment).toBeUndefined();
    expect(store.getOperation().callBriefs).toMatchObject([
      {
        callId: "CA123",
        carrierId: "carrier-costa-pacifico",
        quotedPriceMxn: 8500,
        actions: ["Enviar recapitulación por SMS", "No finalizar la reserva"],
        outcome: "failed"
      }
    ]);
  });

  it("records a failed brief when the SMS gateway rejects", async () => {
    const store = createOperationStore(seedOperation());
    const finalizer = createCommitmentFinalizer({
      store,
      sms: {
        send: async () => {
          throw new Error("gateway_unavailable");
        }
      },
      callId: "CA123",
      recipient: "+52-33-0000-0000",
      now: () => "2026-09-01T15:05:00.000Z"
    });

    await expect(
      finalizer({
        carrierId: "carrier-costa-pacifico",
        finalPrice: 8500,
        pickupTime: THURSDAY_PICKUP,
        timestampMs: 42_500,
        driverName: "María López",
        plate: "ABC-123"
      })
    ).rejects.toThrow("sms_recap_failed");

    expect(store.getOperation().commitment).toBeUndefined();
    expect(store.getOperation().callBriefs).toMatchObject([
      {
        callId: "CA123",
        carrierId: "carrier-costa-pacifico",
        quotedPriceMxn: 8500,
        actions: ["Enviar recapitulación por SMS", "No finalizar la reserva"],
        outcome: "failed"
      }
    ]);
  });

  it("finalizes a commitment only after a sent recap", async () => {
    const store = createOperationStore(seedOperation());
    const finalizer = createCommitmentFinalizer({
      store,
      sms: new MockSmsGateway(),
      callId: "CA123",
      recipient: "+52-33-0000-0000",
      now: () => "2026-09-01T15:05:00.000Z"
    });

    await finalizer({
      carrierId: "carrier-costa-pacifico",
      finalPrice: 8500,
      pickupTime: THURSDAY_PICKUP,
      timestampMs: 42_500,
      driverName: "María López",
      plate: "ABC-123"
    });

    expect(store.getOperation().commitment).toMatchObject({
      carrierId: "carrier-costa-pacifico",
      callId: "CA123",
      finalPriceMxn: 8500,
      audioTimestampUrl: "/audio/recordings/CA123#t=42.5",
      recapStatus: "sent",
      recapMessageId: "mock-sms-1"
    });
  });

  it("preserves structured facts and actions in a call brief", () => {
    const brief = createCallBrief({
      id: "brief-CA123",
      callId: "CA123",
      carrierId: "carrier-costa-pacifico",
      summary: "Transportes Costa Pacífico confirmó el conductor y la tarifa.",
      quotedPriceMxn: 8500,
      objections: [],
      actions: ["Confirmar cita", "Enviar recapitulación por SMS"],
      outcome: "committed",
      createdAt: "2026-09-01T15:05:00.000Z"
    });

    expect(brief).toMatchObject({
      quotedPriceMxn: 8500,
      actions: ["Confirmar cita", "Enviar recapitulación por SMS"],
      outcome: "committed"
    });
  });
});
