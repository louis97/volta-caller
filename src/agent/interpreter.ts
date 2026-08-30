import type { Escalation, Quote } from "@volta/contracts";
import type { z } from "zod";

import { createCallBrief } from "../audit/callBrief";
import { evaluateMandate, type MandateDecision } from "../core/mandate";
import type { OperationStore } from "../core/state";
import { createModeConfiguration, type CallMode } from "./modes";
import {
  checkMandateSchema,
  confirmSelectedDealSchema,
  registerQuoteSchema,
  reviewDealSchema,
  triggerEscalationSchema
} from "./tools";

type ConfirmSelectedDealInput = z.infer<typeof confirmSelectedDealSchema>;

export type ToolCallRequest = {
  name: string;
  arguments: unknown;
};

export type ToolDependencies = {
  mode: CallMode;
  store: OperationStore;
  finalizeConfirmation: (
    intent: ConfirmSelectedDealInput
  ) => Promise<void> | void;
  now?: () => string;
};

export type ToolCallResult =
  | { outcome: "approved" }
  | { outcome: "registered"; mandateDecision: MandateDecision }
  | { outcome: "reviewed"; mandateDecision: MandateDecision }
  | { outcome: "confirmation_requested" }
  | {
      outcome: "escalated";
      reason: string;
      mandateDecision?: MandateDecision;
    }
  | { outcome: "rejected"; reason: string };

export async function executeToolCall(
  request: ToolCallRequest,
  dependencies: ToolDependencies
): Promise<ToolCallResult> {
  if (!isToolAllowed(request.name, dependencies.mode)) {
    return { outcome: "rejected", reason: "tool_not_allowed" };
  }

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
    case "review_deal": {
      const parsed = reviewDealSchema.safeParse(request.arguments);
      if (!parsed.success) return invalidArguments();

      try {
        const operation = dependencies.store.getOperation();
        const quote = operation.quotes.find(
          (candidate) => candidate.id === parsed.data.quoteId
        );
        if (!quote) return { outcome: "rejected", reason: "quote_not_found" };
        const mandateDecision = evaluateMandate(operation.mandate, {
          price: quote.priceMxn,
          pickupTime: quote.pickupTime
        });
        dependencies.store.reviewDeal(parsed.data);
        return {
          outcome: "reviewed",
          mandateDecision
        };
      } catch (error) {
        return rejectedStoreError(error, "review_required");
      }
    }
    case "confirm_selected_deal": {
      const parsed = confirmSelectedDealSchema.safeParse(request.arguments);
      if (!parsed.success) return invalidArguments();

      return confirmSelectedDeal(parsed.data, dependencies);
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
      return { outcome: "rejected", reason: "tool_not_allowed" };
  }
}

async function confirmSelectedDeal(
  intent: ConfirmSelectedDealInput,
  dependencies: ToolDependencies
): Promise<ToolCallResult> {
  const operation = dependencies.store.getOperation();
  const selectedQuote = operation.selection
    ? operation.quotes.find(
        (quote) => quote.id === operation.selection?.quoteId
      )
    : undefined;

  if (
    operation.status !== "confirming_selected_carrier" ||
    !operation.selection ||
    !selectedQuote
  ) {
    return { outcome: "rejected", reason: "selection_required" };
  }
  if (operation.confirmationCallId !== intent.callId) {
    return { outcome: "rejected", reason: "confirmation_call_mismatch" };
  }

  const now = (dependencies.now ?? (() => new Date().toISOString()))();
  if (!isBefore(now, operation.selection.expiresAt)) {
    return failConfirmation(intent, dependencies, "selection_expired");
  }
  if (!hasMatchingSelectedTerms(intent, selectedQuote, operation.mandate)) {
    return failConfirmation(intent, dependencies, "terms_mismatch");
  }
  if (
    !operation.reviewedDeals.some(
      (deal) =>
        deal.quoteId === selectedQuote.id && deal.mandateDecision === "APPROVED"
    )
  ) {
    return failConfirmation(intent, dependencies, "mandate_not_approved");
  }

  const mandateDecision = evaluateMandate(operation.mandate, {
    price: intent.finalPrice,
    pickupTime: intent.pickupTime
  });
  if (mandateDecision.status !== "APPROVED") {
    return failConfirmation(intent, dependencies, mandateDecision.reason);
  }

  try {
    await dependencies.finalizeConfirmation(intent);
    return { outcome: "confirmation_requested" };
  } catch {
    return failConfirmation(intent, dependencies, "recap_failed");
  }
}

function isToolAllowed(name: string, mode: CallMode): boolean {
  return createModeConfiguration(mode).tools.some((tool) => tool.name === name);
}

function isBefore(left: string, right: string): boolean {
  const leftInstant = Date.parse(left);
  const rightInstant = Date.parse(right);
  return (
    Number.isFinite(leftInstant) &&
    Number.isFinite(rightInstant) &&
    leftInstant < rightInstant
  );
}

function hasMatchingSelectedTerms(
  intent: ConfirmSelectedDealInput,
  quote: Quote,
  mandate: ReturnType<OperationStore["getOperation"]>["mandate"]
): boolean {
  return (
    intent.quoteId === quote.id &&
    intent.carrierId === quote.carrierId &&
    intent.finalPrice === quote.priceMxn &&
    intent.pickupTime === quote.pickupTime &&
    intent.destinationDatetime === mandate.destinationDatetime &&
    intent.typeOfContent === mandate.typeOfContent &&
    intent.weightKg === mandate.weightKg &&
    intent.measures === mandate.measures
  );
}

function failConfirmation(
  intent: ConfirmSelectedDealInput,
  dependencies: ToolDependencies,
  reason: string
): ToolCallResult {
  const operation = dependencies.store.getOperation();
  try {
    dependencies.store.failConfirmation(reason, intent.callId);
  } catch {
    return { outcome: "rejected", reason: "confirmation_call_mismatch" };
  }
  dependencies.store.recordCallBrief(
    createCallBrief({
      id: `brief-${intent.callId}-${operation.callBriefs.length + 1}`,
      callId: intent.callId,
      carrierId: intent.carrierId,
      summary: `Confirmation failed because ${reason.replaceAll("_", " ")}.`,
      quotedPriceMxn: intent.finalPrice,
      objections: [reason],
      actions: ["Do not finalize the commitment", "Return to the dashboard"],
      outcome: "failed",
      createdAt: (dependencies.now ?? (() => new Date().toISOString()))()
    })
  );
  return { outcome: "rejected", reason };
}

function mandateResult(decision: MandateDecision): ToolCallResult {
  if (decision.status === "APPROVED") return { outcome: "approved" };
  if (decision.status === "REQUIRES_ESCALATION") {
    return { outcome: "escalated", reason: decision.reason };
  }
  return { outcome: "rejected", reason: decision.reason };
}

function rejectedStoreError(error: unknown, fallback: string): ToolCallResult {
  return {
    outcome: "rejected",
    reason: error instanceof Error ? error.message : fallback
  };
}

function createEscalation(
  store: OperationStore,
  reason: string,
  terms: {
    attemptedPriceMxn?: number;
    attemptedPickupTime?: string;
    current_price_offered?: number;
    callId?: string;
  },
  now: () => string
): Escalation {
  const operation = store.getOperation();
  return {
    id: `escalation-${operation.id}-${operation.escalations.length + 1}`,
    operationId: operation.id,
    callId: terms.callId,
    reason,
    attemptedPriceMxn: terms.attemptedPriceMxn ?? terms.current_price_offered,
    attemptedPickupTime: terms.attemptedPickupTime,
    status: "requested",
    requestedAt: now()
  };
}

function invalidArguments(): ToolCallResult {
  return { outcome: "rejected", reason: "invalid_arguments" };
}
