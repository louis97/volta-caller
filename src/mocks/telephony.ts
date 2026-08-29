import type { CallSession } from "@volta/contracts";

import type {
  OutboundCallInput,
  TelephonyGateway,
  TransferInput
} from "../telephony/twilio";

export type MockTelephonyEvent = {
  type: "created" | "transferred";
  callId: string;
};

export type MockTelephonyGateway = TelephonyGateway & {
  calls: MockTelephonyEvent[];
};

export function createMockTelephonyGateway({
  now = () => new Date().toISOString()
}: { now?: () => string } = {}): MockTelephonyGateway {
  const calls: MockTelephonyEvent[] = [];
  let nextCall = 1;

  return {
    calls,
    async createOutboundCall(input: OutboundCallInput): Promise<CallSession> {
      const id = `mock-call-${nextCall++}`;
      return {
        id,
        operationId: input.operationId,
        carrierId: input.carrierId,
        direction: "outbound",
        status: "in_progress",
        startedAt: now()
      };
    },
    async transferToSupervisor(input: TransferInput): Promise<void> {
      calls.push({ type: "transferred", callId: input.callId });
    }
  };
}
