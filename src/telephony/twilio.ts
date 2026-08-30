import type { CallSession } from "@volta/contracts";

export type OutboundCallInput = {
  operationId: string;
  carrierId?: string;
  to: string;
  from: string;
  twimlUrl: string;
  statusCallbackUrl?: string;
  /**
   * Hard ceiling for the call. Prepaid balance is drained silently by a leg a
   * bug left open, so every outbound call carries a limit.
   */
  timeLimitSeconds?: number;
  /**
   * Dual-channel keeps agent and counterparty on separate tracks, which is what
   * makes the audit player readable. Recording is required for commitments to
   * link to an audio timestamp.
   */
  record?: boolean;
};

export type TransferInput = {
  callId: string;
  supervisorPhone: string;
};

export type TelephonyGateway = {
  createOutboundCall(input: OutboundCallInput): Promise<CallSession>;
  transferToSupervisor(input: TransferInput): Promise<void>;
};

export type TwilioCallClient = {
  calls: {
    create(input: {
      to: string;
      from: string;
      url: string;
      timeLimit?: number;
      record?: boolean;
      recordingChannels?: "mono" | "dual";
      statusCallback?: string;
      statusCallbackEvent?: Array<
        "initiated" | "ringing" | "answered" | "completed"
      >;
    }): Promise<{ sid: string }>;
    (callId: string): { update(input: { twiml: string }): Promise<unknown> };
  };
};

export type TwilioGatewayDependencies = {
  client: TwilioCallClient;
  now?: () => string;
};

export function createInboundTwiML(mediaStreamUrl: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Connect><Stream url="${escapeXml(mediaStreamUrl)}" /></Connect></Response>`;
}

export function createTwilioGateway({
  client,
  now = () => new Date().toISOString()
}: TwilioGatewayDependencies): TelephonyGateway {
  return {
    async createOutboundCall(input) {
      const call = await client.calls.create({
        to: input.to,
        from: input.from,
        url: input.twimlUrl,
        ...(input.statusCallbackUrl === undefined
          ? {}
          : {
              statusCallback: input.statusCallbackUrl,
              statusCallbackEvent: [
                "initiated",
                "ringing",
                "answered",
                "completed"
              ]
            }),
        ...(input.timeLimitSeconds === undefined
          ? {}
          : { timeLimit: input.timeLimitSeconds }),
        ...(input.record === true
          ? { record: true, recordingChannels: "dual" as const }
          : {})
      });
      return {
        id: call.sid,
        operationId: input.operationId,
        carrierId: input.carrierId,
        direction: "outbound",
        status: "in_progress",
        startedAt: now()
      };
    },
    async transferToSupervisor(input) {
      await client.calls(input.callId).update({
        twiml: `<Response><Dial>${escapeXml(input.supervisorPhone)}</Dial></Response>`
      });
    }
  };
}

export type TwilioStatus =
  | "queued"
  | "initiated"
  | "ringing"
  | "answered"
  | "in-progress"
  | "completed"
  | "busy"
  | "no-answer"
  | "failed"
  | "canceled";

export function mapTwilioStatus(
  status: TwilioStatus
): Pick<CallSession, "status" | "endedAt" | "endedReason"> {
  if (status === "completed")
    return { status: "completed", endedAt: new Date().toISOString() };
  if (
    status === "busy" ||
    status === "no-answer" ||
    status === "failed" ||
    status === "canceled"
  ) {
    return {
      status: "failed",
      endedAt: new Date().toISOString(),
      endedReason: status
    };
  }
  return { status: "in_progress" };
}

function escapeXml(value: string): string {
  return value.replace(/[<>&'"]/g, (character) => {
    const entities: Record<string, string> = {
      "<": "&lt;",
      ">": "&gt;",
      "&": "&amp;",
      "'": "&apos;",
      '"': "&quot;"
    };
    return entities[character];
  });
}
