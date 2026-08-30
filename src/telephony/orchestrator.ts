import { randomUUID } from "node:crypto";
import type { Operation } from "@volta/contracts";

import { executeToolCall } from "../agent/interpreter";
import type { OperationStore } from "../core/state";
import { createMockTelephonyGateway } from "../mocks/telephony";
import type { TelephonyGateway } from "./twilio";

export type FanoutDependencies = {
  store: OperationStore;
  organizationId?: string;
  gateway?: TelephonyGateway;
  mode: "mock" | "live";
  publicBaseUrl?: string;
  from?: string;
  concurrency?: number;
  now?: () => string;
  onDialled?: (callId: string, carrier: { id: string; name: string }) => void;
  onRoundReviewed?: (input: {
    operationId: string;
    quoteIds: string[];
    carrierCount: number;
    occurredAt: string;
  }) => Promise<void> | void;
  /**
   * Who to dial this round. Defaults to the operation's seeded candidates;
   * the carrier directory overrides it so the pool can be edited from the
   * console without a redeploy.
   */
  carriers?: Operation["candidates"];
  /** Hard ceiling per leg; 0 or absent omits it. */
  timeLimitSeconds?: number;
  record?: boolean;
  /** Hang up instead of negotiating with an answering machine. */
  detectAnsweringMachine?: boolean;
};

export async function fanOutCalls(
  dependencies: FanoutDependencies
): Promise<void> {
  const { store, now = () => new Date().toISOString() } = dependencies;
  const operation = store.getOperation();
  const gateway = dependencies.gateway ?? createMockTelephonyGateway({ now });
  const candidates =
    dependencies.carriers && dependencies.carriers.length > 0
      ? dependencies.carriers
      : operation.candidates;
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
      const callContext = {
        operationId: operation.id,
        carrierId: candidate.id,
        organizationId: dependencies.organizationId
      };
      const created = await gateway.createOutboundCall({
        operationId: operation.id,
        carrierId: candidate.id,
        to: candidate.phone,
        from: dependencies.from ?? "",
        twimlUrl: withCallContext(
          `${(dependencies.publicBaseUrl ?? "").replace(/\/$/, "")}/twiml/outbound`,
          callContext
        ),
        statusCallbackUrl: withCallContext(
          `${(dependencies.publicBaseUrl ?? "").replace(/\/$/, "")}/twiml/status`,
          callContext
        ),
        // A round never carried these, so a call that reached voicemail ran
        // the agent against a recording for minutes with no ceiling.
        ...(dependencies.timeLimitSeconds
          ? { timeLimitSeconds: dependencies.timeLimitSeconds }
          : {}),
        record: dependencies.record === true,
        detectAnsweringMachine: dependencies.detectAnsweringMachine === true
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
            mode: "negotiation" as const,
            finalizeConfirmation: async () => {},
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
      // Publish every quote of the round for client review. `review_deal`
      // replaced `request_quote_approval`: a quote is market intelligence
      // until a human picks one, and picking is what authorises the closing
      // call.
      for (const quoteId of quoteIds) {
        await executeToolCall(
          {
            name: "review_deal",
            arguments: { quoteId, reviewedAt: now() }
          },
          {
            store,
            mode: "negotiation" as const,
            finalizeConfirmation: async () => {},
            now
          }
        );
      }
      await dependencies.onRoundReviewed?.({
        operationId: operation.id,
        quoteIds,
        carrierCount: candidates.length,
        occurredAt: now()
      });
    }
  }
}

export type OutboundCallContext = {
  operationId: string;
  carrierId?: string;
  organizationId?: string;
};

/**
 * Twilio may fetch TwiML and open the media WebSocket on another process. The
 * durable identifiers therefore travel with every callback instead of relying
 * on the process-local `dialled` map.
 */
export function withCallContext(
  url: string,
  context: OutboundCallContext
): string {
  const query = new URLSearchParams({ operationId: context.operationId });
  if (context.carrierId) query.set("carrierId", context.carrierId);
  if (context.organizationId)
    query.set("organizationId", context.organizationId);
  return `${url}${url.includes("?") ? "&" : "?"}${query.toString()}`;
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
