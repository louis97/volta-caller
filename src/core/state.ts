import type {
  ApprovalRequest,
  CallBrief,
  CallSession,
  ClosingAuthorization,
  Commitment,
  Escalation,
  Operation,
  OperationEvent,
  Quote
} from "@volta/contracts";

export type OperationStore = {
  getOperation(): Operation;
  replaceOperation(operation: Operation): void;
  registerQuote(quote: Quote): void;
  openCallSession(callSession: CallSession): void;
  updateCallSession(
    callSessionId: string,
    patch: Partial<Omit<CallSession, "id" | "operationId">>
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
  recordCallBrief(callBrief: CallBrief): void;
  finalizeCommitment(commitment: Commitment): void;
  requestEscalation(escalation: Escalation): void;
  subscribe(listener: (event: OperationEvent) => void): () => void;
};

export function createOperationStore(
  initialOperation: Operation
): OperationStore {
  let operation = clone(initialOperation);
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
        status: "negotiating",
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
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }
  };
}

function clone<T>(value: T): T {
  return structuredClone(value);
}
