import type { ApprovalRequest, Escalation, Quote } from "@volta/contracts";
import type { z } from "zod";

import { evaluateMandate, type MandateDecision } from "../core/mandate";
import type { OperationStore } from "../core/state";
import {
  checkMandateSchema,
  commitDealSchema,
  registerQuoteSchema,
  requestQuoteApprovalSchema,
  triggerEscalationSchema
} from "./tools";

type CommitDealInput = z.infer<typeof commitDealSchema>;

export type ToolCallRequest = {
  name: string;
  arguments: unknown;
};

export type ToolDependencies = {
  store: OperationStore;
  finalizeBooking: (intent: CommitDealInput) => Promise<void> | void;
  now?: () => string;
};

export type ToolCallResult =
  | { outcome: "approved" }
  | { outcome: "registered"; mandateDecision: MandateDecision }
  | { outcome: "approval_requested"; approval: ApprovalRequest }
  | { outcome: "booking_requested" }
  | {
      outcome: "escalated";
      reason: string;
      mandateDecision?: MandateDecision;
    }
  | {
      outcome: "rejected";
      reason:
        | "invalid_arguments"
        | "invalid_tool"
        | "invalid_price"
        | "approval_required";
    }
  | { outcome: "booking_failed" };

export async function executeToolCall(
  request: ToolCallRequest,
  dependencies: ToolDependencies
): Promise<ToolCallResult> {
  switch (request.name) {
    case "check_mandate": {
      const parsed = checkMandateSchema.safeParse(request.arguments);
      if (!parsed.success) return invalidArguments();

      return mandateResult(
        evaluateMandate(dependencies.store.getOperation().mandate, parsed.data)
      );
    }
    case "register_quote": {
      const parsed = registerQuoteSchema.safeParse(request.arguments);
      if (!parsed.success) return invalidArguments();

      const mandateDecision = evaluateMandate(
        dependencies.store.getOperation().mandate,
        { price: parsed.data.priceMxn, pickupTime: parsed.data.pickupTime }
      );
      dependencies.store.registerQuote(parsed.data as Quote);
      return { outcome: "registered", mandateDecision };
    }
    case "request_quote_approval": {
      const parsed = requestQuoteApprovalSchema.safeParse(request.arguments);
      if (!parsed.success) return invalidArguments();

      const operation = dependencies.store.getOperation();
      const recommendation =
        parsed.data.recommendedQuoteId ??
        operation.quotes
          .filter((quote) => parsed.data.quoteIds.includes(quote.id))
          .sort((left, right) => left.priceMxn - right.priceMxn)[0]?.id;
      try {
        const approval = dependencies.store.requestCarrierSelectionApproval({
          id: `approval-${operation.id}-${operation.approvals.length + 1}`,
          quoteIds: parsed.data.quoteIds,
          recommendedQuoteId: recommendation,
          createdAt: (dependencies.now ?? (() => new Date().toISOString()))()
        });
        return { outcome: "approval_requested", approval };
      } catch {
        return { outcome: "rejected", reason: "invalid_arguments" };
      }
    }
    case "commit_deal": {
      const parsed = commitDealSchema.safeParse(request.arguments);
      if (!parsed.success) return invalidArguments();

      const decision = evaluateMandate(
        dependencies.store.getOperation().mandate,
        {
          price: parsed.data.finalPrice,
          pickupTime: parsed.data.pickupTime
        }
      );
      if (decision.status !== "APPROVED") {
        if (decision.status === "REQUIRES_ESCALATION") {
          dependencies.store.requestEscalation(
            createEscalation(
              dependencies.store,
              decision.reason,
              parsed.data,
              dependencies.now ?? (() => new Date().toISOString())
            )
          );
          return { outcome: "escalated", reason: decision.reason };
        }
        return { outcome: "rejected", reason: decision.reason };
      }

      const operation = dependencies.store.getOperation();
      const authorization = operation.closingAuthorization;
      if (!authorization) {
        return { outcome: "rejected", reason: "approval_required" };
      }
      if (
        authorization.carrierId !== parsed.data.carrierId ||
        authorization.finalPriceMxn !== parsed.data.finalPrice ||
        authorization.pickupTime !== parsed.data.pickupTime
      ) {
        dependencies.store.requestRevisedTermsApproval({
          id: `approval-${operation.id}-${operation.approvals.length + 1}`,
          sourceQuoteId: authorization.quoteId,
          proposedTerms: {
            carrierId: parsed.data.carrierId,
            finalPriceMxn: parsed.data.finalPrice,
            pickupTime: parsed.data.pickupTime
          },
          createdAt: (dependencies.now ?? (() => new Date().toISOString()))()
        });
        return { outcome: "escalated", reason: "approved_terms_changed" };
      }

      try {
        await dependencies.finalizeBooking(parsed.data);
        return { outcome: "booking_requested" };
      } catch {
        return { outcome: "booking_failed" };
      }
    }
    case "trigger_escalation": {
      const parsed = triggerEscalationSchema.safeParse(request.arguments);
      if (!parsed.success) return invalidArguments();

      const operation = dependencies.store.getOperation();
      const mandateDecision = evaluateMandate(operation.mandate, {
        price: parsed.data.current_price_offered,
        pickupTime: operation.mandate.pickupDatetime
      });
      dependencies.store.requestEscalation(
        createEscalation(
          dependencies.store,
          parsed.data.reason,
          {
            ...parsed.data,
            attemptedPickupTime: operation.mandate.pickupDatetime
          },
          dependencies.now ?? (() => new Date().toISOString())
        )
      );
      return {
        outcome: "escalated",
        reason: parsed.data.reason,
        mandateDecision
      };
    }
    default:
      return { outcome: "rejected", reason: "invalid_tool" };
  }
}

function mandateResult(decision: MandateDecision): ToolCallResult {
  if (decision.status === "APPROVED") return { outcome: "approved" };
  if (decision.status === "REQUIRES_ESCALATION") {
    return { outcome: "escalated", reason: decision.reason };
  }
  return { outcome: "rejected", reason: decision.reason };
}

function createEscalation(
  store: OperationStore,
  reason: string,
  terms: {
    attemptedPriceMxn?: number;
    attemptedPickupTime?: string;
    current_price_offered?: number;
    callId?: string;
    finalPrice?: number;
    pickupTime?: string;
  },
  now: () => string
): Escalation {
  const operation = store.getOperation();
  return {
    id: `escalation-${operation.id}-${operation.escalations.length + 1}`,
    operationId: operation.id,
    callId: terms.callId,
    reason,
    attemptedPriceMxn:
      terms.attemptedPriceMxn ??
      terms.current_price_offered ??
      terms.finalPrice,
    attemptedPickupTime: terms.attemptedPickupTime ?? terms.pickupTime,
    status: "requested",
    requestedAt: now()
  };
}

function invalidArguments(): ToolCallResult {
  return { outcome: "rejected", reason: "invalid_arguments" };
}
