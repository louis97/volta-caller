import type {
  ApprovalRequest,
  CallBrief,
  CallSession,
  CallSupervision,
  ClientSelection,
  ClosingAuthorization,
  Commitment,
  DashboardNotification,
  Escalation,
  Incident,
  Operation,
  OperationEvent,
  Quote,
  ReviewedDeal,
  TranscriptSegment
} from "@volta/contracts";
import { evaluateMandate } from "./mandate";

export type OperationStore = {
  getOperation(): Operation;
  replaceOperation(operation: Operation): void;
  registerQuote(quote: Quote): void;
  openCallSession(callSession: CallSession): void;
  updateCallSession(
    callSessionId: string,
    patch: Partial<Omit<CallSession, "id" | "operationId">>
  ): CallSession;
  /** One transcribed utterance, published as soon as it lands. */
  appendTranscript(segment: TranscriptSegment): void;
  getTranscript(callId?: string): TranscriptSegment[];
  /** Records who the caller is hearing; the audio route itself is telephony's. */
  setCallSupervision(
    callSessionId: string,
    supervision: CallSupervision
  ): CallSession;
  requestCarrierSelectionApproval(input: {
    id: string;
    quoteIds: string[];
    recommendedQuoteId?: string;
    createdAt: string;
  }): ApprovalRequest;
  requestRevisedTermsApproval(input: {
    id: string;
    sourceQuoteId: string;
    proposedTerms: ApprovalRequest["proposedTerms"];
    createdAt: string;
  }): ApprovalRequest;
  getApproval(approvalId: string): ApprovalRequest | undefined;
  resolveApproval(input: {
    approvalId: string;
    action: "approve" | "decline";
    selectedQuoteId?: string;
    decidedBy: string;
    decidedAt: string;
  }): ApprovalRequest;
  undoApproval(input: {
    approvalId: string;
    undoneBy: string;
    undoneAt: string;
  }): ApprovalRequest;
  reviewDeal(input: { quoteId: string; reviewedAt: string }): ReviewedDeal;
  selectQuote(input: { quoteId: string; now: string }): ClientSelection;
  beginConfirmation(quoteId: string, callId?: string): void;
  failSelection(reason: string): void;
  failConfirmation(reason: string, callId: string): void;
  recordIncident(incident: Incident): void;
  updateOperationStatus(input: {
    incidentId: string;
    status: "incident_monitoring";
  }): void;
  notifyDashboard(notification: DashboardNotification): void;
  recordCallBrief(callBrief: CallBrief): void;
  finalizeCommitment(commitment: Commitment): void;
  requestEscalation(escalation: Escalation): void;
  subscribe(listener: (event: OperationEvent) => void): () => void;
};

export function createOperationStore(
  initialOperation: Operation
): OperationStore {
  let operation = clone(initialOperation);
  // Transcript lives beside the operation: it grows per utterance and would
  // otherwise force a full operation clone on every spoken line.
  const transcript: TranscriptSegment[] = [];
  const listeners = new Set<(event: OperationEvent) => void>();

  function publish(event: OperationEvent): void {
    for (const listener of listeners) {
      listener(clone(event));
    }
  }

  return {
    getOperation: () => clone(operation),
    replaceOperation: (nextOperation) => {
      operation = clone(nextOperation);
      publish({
        type: "mandate.created",
        operationId: operation.id,
        mandate: operation.mandate
      });
    },
    registerQuote: (quote) => {
      const storedQuote = clone(quote);
      operation = {
        ...operation,
        status:
          operation.status === "awaiting_client_selection"
            ? "awaiting_client_selection"
            : "negotiating",
        quotes: [...operation.quotes, storedQuote],
        callSessions: operation.callSessions.map((session) =>
          session.id === storedQuote.callId
            ? { ...session, quoteId: storedQuote.id }
            : session
        )
      };
      publish({
        type: "quote.registered",
        operationId: operation.id,
        quote: storedQuote
      });
    },
    openCallSession: (callSession) => {
      if (callSession.operationId !== operation.id) {
        throw new Error("call_operation_invalid");
      }
      if (operation.callSessions.some((item) => item.id === callSession.id)) {
        throw new Error("call_session_exists");
      }
      const storedCallSession = clone(callSession);
      operation = {
        ...operation,
        status: "negotiating",
        callSessions: [...operation.callSessions, storedCallSession]
      };
      publish({
        type: "call.started",
        operationId: operation.id,
        callSession: storedCallSession
      });
    },
    updateCallSession: (callSessionId, patch) => {
      const index = operation.callSessions.findIndex(
        (item) => item.id === callSessionId
      );
      if (index === -1) throw new Error("call_session_not_found");
      const callSession = { ...operation.callSessions[index], ...clone(patch) };
      const callSessions = [...operation.callSessions];
      callSessions[index] = callSession;
      operation = { ...operation, callSessions };
      publish({
        type: "call.updated",
        operationId: operation.id,
        callSession
      });
      return clone(callSession);
    },
    appendTranscript: (segment) => {
      const stored = clone(segment);
      transcript.push(stored);
      publish({
        type: "transcript.appended",
        operationId: operation.id,
        segment: stored
      });
    },
    setCallSupervision: (callSessionId, supervision) => {
      const index = operation.callSessions.findIndex(
        (item) => item.id === callSessionId
      );
      if (index === -1) throw new Error("call_session_not_found");

      const callSession: CallSession = {
        ...operation.callSessions[index]!,
        supervision: clone(supervision)
      };
      const callSessions = [...operation.callSessions];
      callSessions[index] = callSession;
      operation = { ...operation, callSessions };
      publish({
        type: "call.supervision.changed",
        operationId: operation.id,
        callSession: clone(callSession),
        supervision: clone(supervision)
      });
      return clone(callSession);
    },
    requestCarrierSelectionApproval: (input) => {
      const quoteIds = [...new Set(input.quoteIds)];
      if (
        quoteIds.length === 0 ||
        !quoteIds.every((id) =>
          operation.quotes.some((quote) => quote.id === id)
        )
      ) {
        throw new Error("approval_quotes_invalid");
      }
      if (
        operation.approvals.some((approval) => approval.status === "pending")
      ) {
        throw new Error("approval_already_pending");
      }
      if (
        input.recommendedQuoteId &&
        !quoteIds.includes(input.recommendedQuoteId)
      ) {
        throw new Error("approval_recommendation_invalid");
      }

      const approval: ApprovalRequest = {
        id: input.id,
        operationId: operation.id,
        type: "carrier_selection",
        status: "pending",
        quoteIds,
        recommendedQuoteId: input.recommendedQuoteId,
        createdAt: input.createdAt
      };
      operation = {
        ...operation,
        status: "awaiting_approval",
        approvals: [...operation.approvals, approval]
      };
      publish({
        type: "approval.requested",
        operationId: operation.id,
        approval
      });
      return clone(approval);
    },
    requestRevisedTermsApproval: (input) => {
      const sourceQuote = operation.quotes.find(
        (quote) => quote.id === input.sourceQuoteId
      );
      if (!sourceQuote || !input.proposedTerms) {
        throw new Error("approval_revision_invalid");
      }
      if (sourceQuote.carrierId !== input.proposedTerms.carrierId) {
        throw new Error("approval_revision_carrier_invalid");
      }
      if (
        operation.approvals.some((approval) => approval.status === "pending")
      ) {
        throw new Error("approval_already_pending");
      }

      const approval: ApprovalRequest = {
        id: input.id,
        operationId: operation.id,
        type: "revised_terms",
        status: "pending",
        quoteIds: [input.sourceQuoteId],
        proposedTerms: input.proposedTerms,
        createdAt: input.createdAt
      };
      operation = {
        ...operation,
        status: "awaiting_approval",
        approvals: [...operation.approvals, approval],
        closingAuthorization: undefined
      };
      publish({
        type: "approval.requested",
        operationId: operation.id,
        approval
      });
      return clone(approval);
    },
    getApproval: (approvalId) => {
      const approval = operation.approvals.find(
        (item) => item.id === approvalId
      );
      return approval ? clone(approval) : undefined;
    },
    resolveApproval: (input) => {
      const approvalIndex = operation.approvals.findIndex(
        (approval) => approval.id === input.approvalId
      );
      if (approvalIndex === -1) throw new Error("approval_not_found");

      const current = operation.approvals[approvalIndex];
      if (current.status !== "pending") throw new Error("approval_not_pending");
      if (
        current.type === "carrier_selection" &&
        input.action === "approve" &&
        !input.selectedQuoteId
      ) {
        throw new Error("approval_selection_required");
      }
      if (
        input.selectedQuoteId &&
        !current.quoteIds.includes(input.selectedQuoteId)
      ) {
        throw new Error("approval_quote_not_allowed");
      }

      const resolved: ApprovalRequest = {
        ...current,
        status: input.action === "approve" ? "approved" : "declined",
        selectedQuoteId:
          input.action === "approve" ? input.selectedQuoteId : undefined,
        decidedBy: input.decidedBy,
        decidedAt: input.decidedAt,
        decisionHistory: [
          ...(current.decisionHistory ?? []),
          {
            action: input.action,
            selectedQuoteId:
              input.action === "approve" ? input.selectedQuoteId : undefined,
            decidedBy: input.decidedBy,
            decidedAt: input.decidedAt
          }
        ]
      };
      const approvals = [...operation.approvals];
      approvals[approvalIndex] = resolved;

      let closingAuthorization: ClosingAuthorization | undefined;
      if (input.action === "approve") {
        const quote = operation.quotes.find((item) =>
          current.type === "carrier_selection"
            ? item.id === input.selectedQuoteId
            : item.id === current.quoteIds[0]
        );
        const terms =
          current.type === "revised_terms" ? current.proposedTerms : quote;
        if (!quote || !terms) throw new Error("approval_quote_not_found");
        closingAuthorization = {
          approvalId: resolved.id,
          quoteId: quote.id,
          carrierId: terms.carrierId,
          finalPriceMxn:
            "finalPriceMxn" in terms ? terms.finalPriceMxn : terms.priceMxn,
          pickupTime: terms.pickupTime,
          authorizedBy: input.decidedBy,
          authorizedAt: input.decidedAt
        };
      }

      operation = {
        ...operation,
        status: input.action === "approve" ? "negotiating" : "open",
        approvals,
        closingAuthorization
      };
      publish({
        type: "approval.resolved",
        operationId: operation.id,
        approval: resolved
      });
      return clone(resolved);
    },
    undoApproval: (input) => {
      const approvalIndex = operation.approvals.findIndex(
        (approval) => approval.id === input.approvalId
      );
      if (approvalIndex === -1) throw new Error("approval_not_found");

      const current = operation.approvals[approvalIndex];
      if (current.status === "pending")
        throw new Error("approval_already_pending");
      if (operation.commitment)
        throw new Error("approval_commitment_finalized");

      const decisionHistory = [...(current.decisionHistory ?? [])];
      const latestDecision = decisionHistory.at(-1);
      if (latestDecision) {
        decisionHistory[decisionHistory.length - 1] = {
          ...latestDecision,
          undoneBy: input.undoneBy,
          undoneAt: input.undoneAt
        };
      }
      const reopened: ApprovalRequest = {
        ...current,
        status: "pending",
        selectedQuoteId: undefined,
        decidedBy: undefined,
        decidedAt: undefined,
        decisionHistory
      };
      const approvals = [...operation.approvals];
      approvals[approvalIndex] = reopened;
      operation = {
        ...operation,
        status: "awaiting_approval",
        approvals,
        closingAuthorization: undefined
      };
      publish({
        type: "approval.reopened",
        operationId: operation.id,
        approval: reopened
      });
      return clone(reopened);
    },
    reviewDeal: ({ quoteId, reviewedAt }) => {
      if (
        operation.status !== "negotiating" &&
        operation.status !== "awaiting_client_selection"
      ) {
        throw new Error("review_not_allowed");
      }
      if (operation.reviewedDeals.some((deal) => deal.quoteId === quoteId)) {
        throw new Error("deal_already_reviewed");
      }
      const quote = operation.quotes.find(
        (candidate) => candidate.id === quoteId
      );
      if (!quote) throw new Error("quote_not_found");
      if (
        operation.reviewedDeals.some((deal) => deal.callId === quote.callId)
      ) {
        throw new Error("call_already_reviewed");
      }
      const decision = evaluateMandate(operation.mandate, {
        price: quote.priceMxn,
        pickupTime: quote.pickupTime
      });
      const reviewedDeal: ReviewedDeal = {
        quoteId,
        callId: quote.callId,
        mandateDecision: decision.status,
        reviewedAt
      };
      operation = {
        ...operation,
        status:
          operation.status === "negotiating"
            ? "awaiting_client_selection"
            : operation.status,
        reviewedDeals: [...operation.reviewedDeals, reviewedDeal]
      };
      publish({
        type: "deal.reviewed",
        operationId: operation.id,
        reviewedDeal
      });
      return clone(reviewedDeal);
    },
    selectQuote: ({ quoteId, now }) => {
      if (operation.status !== "awaiting_client_selection") {
        throw new Error("selection_not_allowed");
      }
      const reviewed = operation.reviewedDeals.find(
        (deal) => deal.quoteId === quoteId
      );
      const quote = operation.quotes.find(
        (candidate) => candidate.id === quoteId
      );
      if (!reviewed || !quote || reviewed.mandateDecision !== "APPROVED") {
        throw new Error("selection_not_approved");
      }
      const nowInstant = Date.parse(now);
      const expiryInstant = Date.parse(operation.mandate.destinationDatetime);
      if (
        !Number.isFinite(nowInstant) ||
        !Number.isFinite(expiryInstant) ||
        nowInstant >= expiryInstant
      ) {
        // A lapsed selection has to leave a trace: throwing alone would let
        // the operation sit in awaiting_client_selection as if nothing had
        // been attempted.
        operation = { ...operation, status: "selection_expired" };
        throw new Error("selection_expired");
      }
      const selection: ClientSelection = {
        quoteId,
        selectedAt: now,
        expiresAt: operation.mandate.destinationDatetime
      };
      operation = {
        ...operation,
        status: "carrier_selected",
        selectedCarrierId: quote.carrierId,
        selection
      };
      publish({
        type: "selection.created",
        operationId: operation.id,
        selection
      });
      return clone(selection);
    },
    beginConfirmation: (quoteId, callId) => {
      if (
        operation.status !== "carrier_selected" ||
        operation.selection?.quoteId !== quoteId
      ) {
        throw new Error("confirmation_not_allowed");
      }
      operation = {
        ...operation,
        status: "confirming_selected_carrier",
        ...(callId ? { confirmationCallId: callId } : {})
      };
    },
    failSelection: (reason) => {
      if (operation.status !== "carrier_selected") {
        throw new Error("confirmation_not_allowed");
      }
      operation = { ...operation, status: "confirmation_failed" };
      publish({
        type: "confirmation.failed",
        operationId: operation.id,
        reason
      });
    },
    failConfirmation: (reason, callId) => {
      if (operation.status !== "confirming_selected_carrier") {
        throw new Error("confirmation_not_allowed");
      }
      if (operation.confirmationCallId !== callId) {
        throw new Error("confirmation_call_mismatch");
      }
      operation = { ...operation, status: "confirmation_failed" };
      publish({
        type: "confirmation.failed",
        operationId: operation.id,
        reason
      });
    },
    recordIncident: (incident) => {
      const storedIncident = clone(incident);
      operation = {
        ...operation,
        incidents: [...operation.incidents, storedIncident]
      };
      publish({
        type: "incident.updated",
        operationId: operation.id,
        incident: storedIncident
      });
    },
    updateOperationStatus: ({ incidentId, status }) => {
      if (!operation.incidents.some((incident) => incident.id === incidentId)) {
        throw new Error("incident_not_found");
      }
      operation = { ...operation, status };
    },
    notifyDashboard: (notification) => {
      const storedNotification = clone(notification);
      operation = {
        ...operation,
        dashboardNotifications: [
          ...operation.dashboardNotifications,
          storedNotification
        ]
      };
      publish({
        type: "dashboard.notification.created",
        operationId: operation.id,
        notification: storedNotification
      });
    },
    recordCallBrief: (callBrief) => {
      const storedCallBrief = clone(callBrief);
      operation = {
        ...operation,
        callBriefs: [...operation.callBriefs, storedCallBrief]
      };
    },
    finalizeCommitment: (commitment) => {
      const storedCommitment = clone(commitment);
      operation = {
        ...operation,
        status: "committed",
        selectedCarrierId: storedCommitment.carrierId,
        commitment: storedCommitment
      };
      publish({
        type: "commitment.finalized",
        operationId: operation.id,
        commitment: storedCommitment
      });
    },
    requestEscalation: (escalation) => {
      const storedEscalation = clone(escalation);
      operation = {
        ...operation,
        status: "escalated",
        escalations: [...operation.escalations, storedEscalation]
      };
      publish({
        type: "escalation.requested",
        operationId: operation.id,
        escalation: storedEscalation
      });
    },
    getTranscript: (callId) =>
      transcript
        .filter((segment) => callId === undefined || segment.callId === callId)
        .map((segment) => clone(segment)),
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }
  };
}

function clone<T>(value: T): T {
  return structuredClone(value);
}
