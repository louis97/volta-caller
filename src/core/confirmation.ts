import type { Mandate, Quote } from "@volta/contracts";

import {
  createModeConfiguration,
  type ModeConfiguration
} from "../agent/modes";
import { createCallBrief } from "../audit/callBrief";
import type { TelephonyGateway } from "../telephony/twilio";
import type { OperationStore } from "./state";

export type ConfirmationCallContext = {
  callId: string;
  operationId: string;
  carrierId: string;
  mode: "confirmation";
  configuration: ModeConfiguration;
  quote: Quote;
  mandate: Mandate;
};

export type ConfirmationCoordinator = {
  start(operationId: string, quoteId: string): Promise<void>;
  getCallContext(callId: string): ConfirmationCallContext | undefined;
};

export type ConfirmationCoordinatorDependencies = {
  store: OperationStore;
  telephony: TelephonyGateway;
  now?: () => string;
  from?: string;
  twimlUrl?: string;
  configuration?: ModeConfiguration;
};

export class ConfirmationCoordinatorError extends Error {
  constructor(
    readonly code:
      "operation_not_found" | "confirmation_callback_creation_failed",
    options?: ErrorOptions
  ) {
    super(code, options);
  }
}

export function createConfirmationCoordinator({
  store,
  telephony,
  now = () => new Date().toISOString(),
  from = "+52-33-0000-0000",
  twimlUrl = "/telephony/confirmation",
  configuration = createModeConfiguration("confirmation")
}: ConfirmationCoordinatorDependencies): ConfirmationCoordinator {
  const contexts = new Map<string, ConfirmationCallContext>();

  return {
    async start(operationId, quoteId) {
      const operation = store.getOperation();
      if (operation.id !== operationId) {
        throw new ConfirmationCoordinatorError("operation_not_found");
      }

      const selectedAt = now();
      store.selectQuote({ quoteId, now: selectedAt });
      const selectedOperation = store.getOperation();
      const quote = selectedOperation.quotes.find(
        (candidate) => candidate.id === quoteId
      );
      const carrier = quote
        ? selectedOperation.candidates.find(
            (candidate) => candidate.id === quote.carrierId
          )
        : undefined;

      if (!quote || !carrier) {
        failBeforeCallback({
          store,
          operation: selectedOperation,
          quote,
          reason: "confirmation_carrier_not_found",
          now
        });
        throw new ConfirmationCoordinatorError(
          "confirmation_callback_creation_failed"
        );
      }

      let callId: string;
      try {
        const session = await telephony.createOutboundCall({
          operationId: selectedOperation.id,
          carrierId: quote.carrierId,
          to: carrier.phone,
          from,
          twimlUrl
        });
        callId = session.id;
      } catch (error) {
        failBeforeCallback({
          store,
          operation: selectedOperation,
          quote,
          reason: "confirmation_callback_creation_failed",
          now
        });
        throw new ConfirmationCoordinatorError(
          "confirmation_callback_creation_failed",
          { cause: error }
        );
      }

      store.beginConfirmation(quote.id, callId);
      const context: ConfirmationCallContext = {
        callId,
        operationId: selectedOperation.id,
        carrierId: quote.carrierId,
        mode: "confirmation",
        configuration,
        quote: structuredClone(quote),
        mandate: structuredClone(selectedOperation.mandate)
      };
      contexts.set(callId, context);
      store.recordCallBrief(
        createCallBrief({
          id: `brief-${callId}`,
          callId,
          carrierId: quote.carrierId,
          summary:
            "Confirmation callback started for the client-selected quote.",
          quotedPriceMxn: quote.priceMxn,
          objections: [],
          actions: ["Confirm the selected terms without renegotiation"],
          outcome: "quoted",
          createdAt: selectedAt
        })
      );
    },
    getCallContext(callId) {
      const context = contexts.get(callId);
      const operation = store.getOperation();
      if (
        !context ||
        operation.status !== "confirming_selected_carrier" ||
        operation.confirmationCallId !== callId
      ) {
        return undefined;
      }
      return structuredClone(context);
    }
  };
}

function failBeforeCallback({
  store,
  operation,
  quote,
  reason,
  now
}: {
  store: OperationStore;
  operation: ReturnType<OperationStore["getOperation"]>;
  quote: Quote | undefined;
  reason: string;
  now: () => string;
}): void {
  store.failSelection(reason);
  store.recordCallBrief(
    createCallBrief({
      id: `brief-uncreated-confirmation-${operation.id}-${quote?.id ?? "unknown"}`,
      callId: `uncreated-confirmation-${operation.id}-${quote?.id ?? "unknown"}`,
      carrierId: quote?.carrierId,
      summary: `Confirmation callback could not start because ${reason.replaceAll("_", " ")}.`,
      quotedPriceMxn: quote?.priceMxn,
      objections: [reason],
      actions: ["Do not finalize the commitment", "Return to the dashboard"],
      outcome: "failed",
      createdAt: now()
    })
  );
}
