import type { CallSession } from "@volta/contracts";

export type OutboundCallInput = {
  operationId: string;
  carrierId?: string;
  to: string;
  from: string;
  twimlUrl: string;
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
        url: input.twimlUrl
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
