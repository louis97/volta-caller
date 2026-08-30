import type {
  CallBrief,
  CarrierCandidate,
  Incident,
  Mandate,
  Operation,
  OperationStatus,
  Quote
} from "@volta/contracts";

export type ExceptionCallContext = Readonly<{
  operationId: string;
  mandate: Mandate;
  lifecycleStatus: OperationStatus;
  selectedCarrier?: CarrierCandidate;
  selectedQuote?: Quote;
  knownCarrierIds: string[];
  knownTruckPlate?: string;
  previousCallBriefs: CallBrief[];
  previousIncidents: Incident[];
}>;

export function createExceptionCallContext(
  operation: Operation
): ExceptionCallContext {
  const selectedQuote = operation.selection
    ? operation.quotes.find(
        (quote) => quote.id === operation.selection?.quoteId
      )
    : undefined;

  return structuredClone({
    operationId: operation.id,
    mandate: operation.mandate,
    lifecycleStatus: operation.status,
    selectedCarrier: selectedQuote
      ? operation.candidates.find(
          (carrier) => carrier.id === selectedQuote.carrierId
        )
      : undefined,
    selectedQuote,
    knownCarrierIds: operation.candidates.map((carrier) => carrier.id),
    knownTruckPlate: operation.commitment?.plate,
    previousCallBriefs: operation.callBriefs,
    previousIncidents: operation.incidents
  });
}
