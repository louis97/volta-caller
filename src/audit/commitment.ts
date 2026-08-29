import type { Commitment } from "@volta/contracts";

import type { OperationStore } from "../core/state";
import { createCallBrief } from "./callBrief";

export type SmsMessageStatus = "sent" | "failed";

export type SmsMessage = {
  id: string;
  to: string;
  body: string;
  status: SmsMessageStatus;
};

export type SmsGateway = {
  send(message: Pick<SmsMessage, "to" | "body">): Promise<SmsMessage>;
};

export type CommitmentInput = {
  callId: string;
  containerId: string;
  priceMxn: number;
  pickupTime: string;
  timestampMs: number;
  driverName?: string;
  recipient: string;
};

export type CommitmentRecap = {
  audioTimestampUrl: string;
  recapStatus: SmsMessageStatus;
  messageId: string;
};

export async function generateCommitmentRecap(
  input: CommitmentInput,
  sms: SmsGateway
): Promise<CommitmentRecap> {
  const audioTimestampUrl = `/audio/recordings/${input.callId}#t=${input.timestampMs / 1000}`;
  const body = `Textiles Pacífico - Confirmación de Reserva: Carga ${input.containerId}, Tarifa $${input.priceMxn} MXN, Pick-up: ${input.pickupTime}, Chofer: ${input.driverName ?? "pendiente"}. Cita confirmada.`;
  const message = await sms.send({ to: input.recipient, body });

  return {
    audioTimestampUrl,
    recapStatus: message.status,
    messageId: message.id
  };
}

type BookingIntent = {
  carrierId: string;
  finalPrice: number;
  pickupTime: string;
  timestampMs: number;
  driverName?: string;
  plate?: string;
};

export type CommitmentFinalizerOptions = {
  store: OperationStore;
  sms: SmsGateway;
  callId: string;
  recipient: string;
  now?: () => string;
};

export function createCommitmentFinalizer({
  store,
  sms,
  callId,
  recipient,
  now = () => new Date().toISOString()
}: CommitmentFinalizerOptions): (intent: BookingIntent) => Promise<void> {
  return async (intent) => {
    const operation = store.getOperation();
    const recordFailedRecap = () => {
      store.recordCallBrief(
        createCallBrief({
          id: `brief-${callId}-${operation.callBriefs.length + 1}`,
          callId,
          carrierId: intent.carrierId,
          summary:
            "La recapitulación por SMS falló; la reserva no se finalizó.",
          quotedPriceMxn: intent.finalPrice,
          objections: [],
          actions: ["Enviar recapitulación por SMS", "No finalizar la reserva"],
          outcome: "failed",
          createdAt: now()
        })
      );
    };

    let recap: CommitmentRecap;
    try {
      recap = await generateCommitmentRecap(
        {
          callId,
          containerId: operation.containerId,
          priceMxn: intent.finalPrice,
          pickupTime: intent.pickupTime,
          timestampMs: intent.timestampMs,
          driverName: intent.driverName,
          recipient
        },
        sms
      );
    } catch (error) {
      recordFailedRecap();
      throw new Error("sms_recap_failed", { cause: error });
    }

    if (recap.recapStatus === "failed") {
      recordFailedRecap();
      throw new Error("sms_recap_failed");
    }

    const commitment: Commitment = {
      id: `commitment-${operation.id}-${intent.carrierId}`,
      carrierId: intent.carrierId,
      callId,
      finalPriceMxn: intent.finalPrice,
      pickupTime: intent.pickupTime,
      driverName: intent.driverName,
      plate: intent.plate,
      audioTimestampUrl: recap.audioTimestampUrl,
      recapStatus: "sent",
      recapMessageId: recap.messageId,
      finalizedAt: now()
    };
    store.finalizeCommitment(commitment);
  };
}
