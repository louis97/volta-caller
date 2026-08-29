import type {
  CallBrief,
  Commitment,
  Escalation,
  Operation,
  OperationEvent,
  Quote
} from "@volta/contracts";

export type OperationStore = {
  getOperation(): Operation;
  registerQuote(quote: Quote): void;
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
    registerQuote: (quote) => {
      const storedQuote = clone(quote);
      operation = {
        ...operation,
        status: "negotiating",
        quotes: [...operation.quotes, storedQuote]
      };
      publish({
        type: "quote.registered",
        operationId: operation.id,
        quote: storedQuote
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
