import type { Escalation, Incident, Quote } from "@volta/contracts";
import type { z } from "zod";

import { createCallBrief } from "../audit/callBrief";
import { evaluateMandate, type MandateDecision } from "../core/mandate";
import type { ExceptionCallContext } from "../core/exceptions";
import type { OperationStore } from "../core/state";
import { createModeConfiguration, type CallMode } from "./modes";
import {
  checkMandateSchema,
  confirmSelectedDealSchema,
  getLeverageSchema,
  registerQuoteSchema,
  notifyDashboardSchema,
  recordIncidentSchema,
  reviewDealSchema,
  triggerEscalationSchema,
  updateOperationStatusSchema
} from "./tools";

type ConfirmSelectedDealInput = z.infer<typeof confirmSelectedDealSchema>;

export type ToolCallRequest = {
  name: string;
  arguments: unknown;
};

/**
 * Server-owned facts about the call a tool call arrived on. Injected by the
 * telephony layer so identity and audio timing never come from the model.
 */
export type CallContext = {
  callId: string;
  carrierId?: string;
  carrierName?: string;
  /** Audio offset now, derived from counted Twilio media frames. */
  callClockMs: () => number;
};

export type ToolDependencies = {
  mode: CallMode;
  store: OperationStore;
  finalizeConfirmation: (
    intent: ConfirmSelectedDealInput
  ) => Promise<void> | void;
  now?: () => string;
  callContext?: CallContext;
  /**
   * Real quotes from the other live calls of this round. Supplied by the
   * telephony layer from auction state, so the agent can only cite offers
   * that were actually made.
   */
  leverage?: () => Quote[];
};

export type ExceptionToolDependencies = {
  store: OperationStore;
  context: ExceptionCallContext;
  now?: () => string;
};

export type ToolCallResult =
  | { outcome: "approved" }
  | {
      outcome: "leverage";
      quotes: Array<{
        carrierName: string;
        priceMxn: number;
        pickupTime: string;
      }>;
    }
  | { outcome: "registered"; mandateDecision: MandateDecision }
  | { outcome: "reviewed"; mandateDecision: MandateDecision }
  | { outcome: "confirmation_requested" }
  | { outcome: "incident_recorded"; feasibility: Incident["feasibility"] }
  | { outcome: "status_updated" }
  | { outcome: "dashboard_notified" }
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
      const now = dependencies.now ?? (() => new Date().toISOString());
      const context = dependencies.callContext;
      const callId = context?.callId ?? parsed.data.callId;
      if (callId === undefined) return invalidArguments();
      const sequence = dependencies.store.getOperation().quotes.length + 1;

      // Identity and timing belong to the server. A model asked which call it
      // is on invents a plausible id, which silently misattributes a quote to
      // the wrong carrier once several calls run at once.
      const quote: Quote = {
        ...parsed.data,
        id: parsed.data.id ?? `quote-${callId}-${sequence}`,
        callId,
        carrierId: context?.carrierId ?? parsed.data.carrierId,
        carrierName: context?.carrierName ?? parsed.data.carrierName,
        createdAt: context ? now() : (parsed.data.createdAt ?? now())
      };

      dependencies.store.registerQuote(quote);
      return { outcome: "registered", mandateDecision };
    }
    case "get_leverage": {
      const parsed = getLeverageSchema.safeParse(request.arguments ?? {});
      if (!parsed.success) return invalidArguments();

      const quotes = (dependencies.leverage?.() ?? []).map((quote) => ({
        carrierName: quote.carrierName,
        priceMxn: quote.priceMxn,
        pickupTime: quote.pickupTime
      }));
      return { outcome: "leverage", quotes };
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

      // The audio anchor and the call identity come from the live call, never
      // from the model: an invented offset makes a hallucinated commitment
      // indistinguishable from a real one in the audit trail.
      const context = dependencies.callContext;
      return confirmSelectedDeal(
        {
          ...parsed.data,
          timestampMs: context?.callClockMs() ?? parsed.data.timestampMs ?? 0,
          callId:
            context?.callId ??
            parsed.data.callId ??
            dependencies.store.getOperation().confirmationCallId ??
            "unknown-call"
        },
        dependencies
      );
    }
    case "trigger_escalation": {
      const parsed = triggerEscalationSchema.safeParse(request.arguments);
      if (!parsed.success) return invalidArguments();

      const operation = dependencies.store.getOperation();
      const mandateDecision = evaluateMandate(operation.mandate, {
        price: parsed.data.current_price_offered,
        pickupTime: operation.mandate.pickupDatetime
      });

      // A carrier's stated price is a quote whether or not the model also
      // called register_quote for it: escalating over a price it never
      // recorded would leave the board showing "awaiting quote" for a call
      // that already has one, undetectable from the transcript alone.
      const escalationCallId =
        dependencies.callContext?.callId ?? parsed.data.callId;
      const carrierName = dependencies.callContext?.carrierName;
      if (
        escalationCallId !== undefined &&
        carrierName &&
        !operation.quotes.some((quote) => quote.callId === escalationCallId)
      ) {
        const now = dependencies.now ?? (() => new Date().toISOString());
        const sequence = operation.quotes.length + 1;
        dependencies.store.registerQuote({
          id: `quote-${escalationCallId}-${sequence}`,
          callId: escalationCallId,
          carrierId: dependencies.callContext?.carrierId ?? "unknown",
          carrierName,
          priceMxn: parsed.data.current_price_offered,
          pickupTime: operation.mandate.pickupDatetime,
          createdAt: now()
        });
      }

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

export async function executeExceptionToolCall(
  request: ToolCallRequest,
  dependencies: ExceptionToolDependencies
): Promise<ToolCallResult> {
  switch (request.name) {
    case "record_incident":
      return recordExceptionIncident(request.arguments, dependencies);
    case "update_operation_status":
      return updateExceptionOperationStatus(request.arguments, dependencies);
    case "notify_dashboard":
      return notifyExceptionDashboard(request.arguments, dependencies);
    case "trigger_escalation":
      return triggerExceptionEscalation(request.arguments, dependencies);
    default:
      return { outcome: "rejected", reason: "tool_not_allowed" };
  }
}

function recordExceptionIncident(
  argumentsValue: unknown,
  dependencies: ExceptionToolDependencies
): ToolCallResult {
  const parsed = recordIncidentSchema.safeParse(argumentsValue);
  if (!parsed.success) return invalidArguments();

  const operation = dependencies.store.getOperation();
  if (operation.id !== dependencies.context.operationId) {
    return { outcome: "rejected", reason: "caller_unverified" };
  }
  if (!hasVerifiedCallerIdentity(parsed.data, dependencies.context)) {
    return { outcome: "rejected", reason: "caller_unverified" };
  }

  const feasibility = feasibilityFor(
    parsed.data.revisedEta,
    dependencies.context.mandate.destinationDatetime
  );
  if (!feasibility) return invalidArguments();

  dependencies.store.recordIncident({
    id: `incident-${dependencies.context.operationId}-${operation.incidents.length + 1}`,
    operationId: dependencies.context.operationId,
    callerName: parsed.data.callerName,
    carrierId: parsed.data.carrierId,
    truckPlate: parsed.data.truckPlate,
    processStage: parsed.data.processStage,
    issue: parsed.data.issue,
    delayMinutes: parsed.data.delayMinutes,
    revisedEta: parsed.data.revisedEta,
    feasibility,
    createdAt: (dependencies.now ?? (() => new Date().toISOString()))(),
    verifiedCallerIdentity: parsed.data.callerName
  });
  return { outcome: "incident_recorded", feasibility };
}

function updateExceptionOperationStatus(
  argumentsValue: unknown,
  dependencies: ExceptionToolDependencies
): ToolCallResult {
  const parsed = updateOperationStatusSchema.safeParse(argumentsValue);
  if (!parsed.success) return invalidArguments();

  const operation = dependencies.store.getOperation();
  if (operation.id !== dependencies.context.operationId) {
    return { outcome: "rejected", reason: "incident_not_found" };
  }
  const incident = operation.incidents.find(
    (candidate) =>
      candidate.id === parsed.data.incidentId &&
      candidate.operationId === dependencies.context.operationId
  );
  if (!incident) return { outcome: "rejected", reason: "incident_not_found" };

  const feasibility = feasibilityFor(
    incident.revisedEta,
    dependencies.context.mandate.destinationDatetime
  );
  if (!feasibility)
    return { outcome: "rejected", reason: "invalid_incident_eta" };
  if (feasibility === "unachievable") {
    return { outcome: "rejected", reason: "mandate_unachievable" };
  }

  dependencies.store.updateOperationStatus({
    incidentId: incident.id,
    status: "incident_monitoring"
  });
  return { outcome: "status_updated" };
}

function notifyExceptionDashboard(
  argumentsValue: unknown,
  dependencies: ExceptionToolDependencies
): ToolCallResult {
  const parsed = notifyDashboardSchema.safeParse(argumentsValue);
  if (!parsed.success) return invalidArguments();

  const operation = dependencies.store.getOperation();
  if (operation.id !== dependencies.context.operationId) {
    return { outcome: "rejected", reason: "incident_not_found" };
  }
  const incident = operation.incidents.find(
    (candidate) =>
      candidate.id === parsed.data.incidentId &&
      candidate.operationId === dependencies.context.operationId
  );
  if (!incident) return { outcome: "rejected", reason: "incident_not_found" };
  if (
    operation.dashboardNotifications.some(
      (notification) => notification.incidentId === incident.id
    )
  ) {
    return { outcome: "rejected", reason: "dashboard_already_notified" };
  }
  if (
    feasibilityFor(
      incident.revisedEta,
      dependencies.context.mandate.destinationDatetime
    ) !== "unachievable"
  ) {
    return { outcome: "rejected", reason: "mandate_achievable" };
  }

  dependencies.store.notifyDashboard({
    operationId: dependencies.context.operationId,
    incidentId: incident.id,
    message: `Incident ${incident.id} has a revised ETA after the destination deadline.`,
    createdAt: (dependencies.now ?? (() => new Date().toISOString()))()
  });
  return { outcome: "dashboard_notified" };
}

function triggerExceptionEscalation(
  argumentsValue: unknown,
  dependencies: ExceptionToolDependencies
): ToolCallResult {
  const parsed = triggerEscalationSchema.safeParse(argumentsValue);
  if (!parsed.success) return invalidArguments();

  const operation = dependencies.store.getOperation();
  if (operation.id !== dependencies.context.operationId) {
    return { outcome: "rejected", reason: "operation_mismatch" };
  }
  dependencies.store.requestEscalation({
    id: `escalation-${dependencies.context.operationId}-${operation.escalations.length + 1}`,
    operationId: dependencies.context.operationId,
    callId: parsed.data.callId,
    reason: parsed.data.reason,
    attemptedPriceMxn: parsed.data.current_price_offered,
    attemptedPickupTime: dependencies.context.mandate.pickupDatetime,
    status: "requested",
    requestedAt: (dependencies.now ?? (() => new Date().toISOString()))()
  });
  return { outcome: "escalated", reason: parsed.data.reason };
}

function hasVerifiedCallerIdentity(
  input: { carrierId: string; truckPlate?: string },
  context: ExceptionCallContext
): boolean {
  const carrierMatches = context.selectedCarrier
    ? input.carrierId === context.selectedCarrier.id
    : context.knownCarrierIds.includes(input.carrierId);
  const plateMatches =
    !context.knownTruckPlate ||
    !input.truckPlate ||
    input.truckPlate === context.knownTruckPlate;
  return carrierMatches && plateMatches;
}

function feasibilityFor(
  revisedEta: string,
  destinationDatetime: string
): Incident["feasibility"] | undefined {
  const eta = Date.parse(revisedEta);
  const deadline = Date.parse(destinationDatetime);
  if (!Number.isFinite(eta) || !Number.isFinite(deadline)) return undefined;
  return eta <= deadline ? "achievable" : "unachievable";
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
    return failConfirmation(intent, dependencies, "confirmation_call_mismatch");
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
  const confirmationCallId =
    operation.confirmationCallId ??
    dependencies.callContext?.callId ??
    intent.callId ??
    "unknown-call";
  try {
    dependencies.store.failConfirmation(reason, confirmationCallId);
  } catch {
    return { outcome: "rejected", reason: "confirmation_call_mismatch" };
  }
  dependencies.store.recordCallBrief(
    createCallBrief({
      id: `brief-${confirmationCallId}-${operation.callBriefs.length + 1}`,
      callId: confirmationCallId,
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
