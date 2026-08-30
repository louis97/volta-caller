import type {
  CallBrief,
  Commitment,
  ClientSelection,
  DashboardNotification,
  Escalation,
  Incident,
  Operation,
  OperationEvent,
  Quote,
  ReviewedDeal
} from "@volta/contracts";
import { evaluateMandate } from "./mandate";

export type OperationStore = {
  getOperation(): Operation;
  replaceOperation(operation: Operation): void;
  registerQuote(quote: Quote): void;
  reviewDeal(input: { quoteId: string; reviewedAt: string }): ReviewedDeal;
  selectQuote(input: { quoteId: string; now: string }): ClientSelection;
  beginConfirmation(quoteId: string): void;
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
        quotes: [...operation.quotes, storedQuote]
      };
      publish({
        type: "quote.registered",
        operationId: operation.id,
        quote: storedQuote
      });
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
    beginConfirmation: (quoteId) => {
      if (
        operation.status !== "carrier_selected" ||
        operation.selection?.quoteId !== quoteId
      ) {
        throw new Error("confirmation_not_allowed");
      }
      operation = { ...operation, status: "confirming_selected_carrier" };
    },
    failConfirmation: (reason, callId) => {
      void callId;
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
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }
  };
}

function clone<T>(value: T): T {
  return structuredClone(value);
}
