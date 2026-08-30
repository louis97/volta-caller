import { randomUUID } from "node:crypto";
import type { Operation } from "@volta/contracts";

import type { OperationStore } from "../core/state";
import { createMockTelephonyGateway } from "../mocks/telephony";
import type { TelephonyGateway } from "./twilio";

export type FanoutDependencies = {
  store: OperationStore;
  gateway?: TelephonyGateway;
  mode: "mock" | "live";
  publicBaseUrl?: string;
  from?: string;
  concurrency?: number;
  now?: () => string;
  onDialled?: (callId: string, carrier: { id: string; name: string }) => void;
};

export async function fanOutCalls(dependencies: FanoutDependencies): Promise<void> {
  const { store, now = () => new Date().toISOString() } = dependencies;
  const operation = store.getOperation();
  const gateway = dependencies.gateway ?? createMockTelephonyGateway({ now });
  const candidates = operation.candidates;
  const limit = Math.max(1, dependencies.concurrency ?? 4);
  let cursor = 0;

  async function dial(candidate: Operation["candidates"][number]) {
    const pendingId = `call-${randomUUID()}`;
    store.openCallSession({ id: pendingId, operationId: operation.id, carrierId: candidate.id, driverName: candidate.name, direction: "outbound", status: "pending", startedAt: now() });
    try {
      const created = await gateway.createOutboundCall({
        operationId: operation.id, carrierId: candidate.id, to: candidate.phone,
        from: dependencies.from ?? "", twimlUrl: `${(dependencies.publicBaseUrl ?? "").replace(/\/$/, "")}/twiml/outbound`,
        statusCallbackUrl: `${(dependencies.publicBaseUrl ?? "").replace(/\/$/, "")}/twiml/status`
      });
      store.updateCallSession(pendingId, { callSid: created.id, status: "in_progress", startedAt: created.startedAt });
      dependencies.onDialled?.(created.id, candidate);
      if (dependencies.mode === "mock") {
        // Mock lifecycle deliberately never touches Twilio; quote collection is
        // still handled by the normal interpreter path in integration flows.
        store.updateCallSession(pendingId, { status: "completed", endedAt: now() });
      }
    } catch (error) {
      store.updateCallSession(pendingId, { status: "failed", endedAt: now(), endedReason: error instanceof Error ? error.message : "dial_failed" });
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, candidates.length) }, async () => {
    while (cursor < candidates.length) {
      const candidate = candidates[cursor++];
      if (candidate) await dial(candidate);
    }
  }));
}
