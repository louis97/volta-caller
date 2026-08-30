import { randomUUID } from "node:crypto";
import type { Operation } from "@volta/contracts";

import { executeToolCall } from "../agent/interpreter";
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

export async function fanOutCalls(
  dependencies: FanoutDependencies
): Promise<void> {
  const { store, now = () => new Date().toISOString() } = dependencies;
  const operation = store.getOperation();
  const gateway = dependencies.gateway ?? createMockTelephonyGateway({ now });
  const candidates = operation.candidates;
  const limit = Math.max(1, dependencies.concurrency ?? 4);
  let cursor = 0;

  async function dial(
    candidate: Operation["candidates"][number],
    candidateIndex: number
  ) {
    const pendingId = `call-${randomUUID()}`;
    store.openCallSession({
      id: pendingId,
      operationId: operation.id,
      carrierId: candidate.id,
      driverName: candidate.name,
      direction: "outbound",
      status: "pending",
      startedAt: now()
    });
    try {
      const created = await gateway.createOutboundCall({
        operationId: operation.id,
        carrierId: candidate.id,
        to: candidate.phone,
        from: dependencies.from ?? "",
        twimlUrl: `${(dependencies.publicBaseUrl ?? "").replace(/\/$/, "")}/twiml/outbound`,
        statusCallbackUrl: `${(dependencies.publicBaseUrl ?? "").replace(/\/$/, "")}/twiml/status`
      });
      store.updateCallSession(pendingId, {
        callSid: created.id,
        status: "in_progress",
        startedAt: created.startedAt
      });
      dependencies.onDialled?.(created.id, candidate);
      if (dependencies.mode === "mock") {
        await executeToolCall(
          {
            name: "register_quote",
            arguments: mockQuote(candidate, candidateIndex, operation)
          },
          {
            store,
            finalizeBooking: async () => {},
            now,
            callContext: {
              callId: pendingId,
              carrierId: candidate.id,
              carrierName: candidate.name,
              callClockMs: () => 0
            }
          }
        );
        store.updateCallSession(pendingId, {
          status: "completed",
          endedAt: now()
        });
      }
    } catch (error) {
      store.updateCallSession(pendingId, {
        status: "failed",
        endedAt: now(),
        endedReason: error instanceof Error ? error.message : "dial_failed"
      });
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(limit, candidates.length) }, async () => {
      while (cursor < candidates.length) {
        const candidateIndex = cursor++;
        const candidate = candidates[candidateIndex];
        if (candidate) await dial(candidate, candidateIndex);
      }
    })
  );

  if (dependencies.mode === "mock") {
    const completedSessions = store
      .getOperation()
      .callSessions.filter(
        (session) =>
          session.operationId === operation.id &&
          session.status === "completed" &&
          session.quoteId
      );
    const quoteIds = completedSessions.flatMap((session) =>
      session.quoteId ? [session.quoteId] : []
    );
    const current = store.getOperation();
    if (
      candidates.length > 0 &&
      quoteIds.length === candidates.length &&
      !current.approvals.some((approval) => approval.status === "pending")
    ) {
      const recommendedQuoteId = current.quotes
        .filter((quote) => quoteIds.includes(quote.id))
        .sort((left, right) => left.priceMxn - right.priceMxn)[0]?.id;
      await executeToolCall(
        {
          name: "request_quote_approval",
          arguments: { quoteIds, recommendedQuoteId }
        },
        { store, finalizeBooking: async () => {}, now }
      );
    }
  }
}

function mockQuote(
  candidate: Operation["candidates"][number],
  candidateIndex: number,
  operation: Operation
) {
  // Stable offsets intentionally yield both mandate-compliant and over-cap
  // offers, so mock runs demonstrate the dispatcher decision boundary.
  const priceOffsets = [-250, 175, -80, 320];
  const etaMinutes = [75, 90, 105, 120];
  return {
    carrierId: candidate.id,
    carrierName: candidate.name,
    priceMxn: Math.max(
      0,
      operation.mandate.budgetCapMxn +
        priceOffsets[candidateIndex % priceOffsets.length]
    ),
    etaMinutes: etaMinutes[candidateIndex % etaMinutes.length],
    pickupTime: operation.mandate.pickupDatetime
  };
}
