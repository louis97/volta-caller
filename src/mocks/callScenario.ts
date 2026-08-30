import { createCallBrief } from "../audit/callBrief";
import { executeToolCall } from "../agent/interpreter";
import { seedOperation, THURSDAY_PICKUP } from "../core/seed";
import { createOperationStore, type OperationStore } from "../core/state";

const RUN_AT = "2026-09-01T15:00:00.000Z";

export type MockScenario = {
  store: OperationStore;
  run(): Promise<void>;
};

export function createMockScenario(
  onEvent?: Parameters<OperationStore["subscribe"]>[0]
): MockScenario {
  const store = createOperationStore(seedOperation());
  if (onEvent) store.subscribe(onEvent);
  const operation = store.getOperation();
  const approvedCarrier = operation.candidates[0];
  const overCapCarrier = operation.candidates[1];
  const unavailableCarrier = operation.candidates[2];
  const approvedCallId = "mock-call-costa-pacifico-001";
  const overCapCallId = "mock-call-ruta-occidente-001";
  const unavailableCallId = "mock-call-logistica-manzanillo-001";
  const toolDependencies = {
    mode: "negotiation" as const,
    store,
    finalizeConfirmation: async () => {},
    now: () => RUN_AT
  };

  return {
    store,
    async run() {
      await executeToolCall(
        {
          name: "register_quote",
          arguments: {
            id: "quote-costa-pacifico-001",
            carrierId: approvedCarrier.id,
            carrierName: approvedCarrier.name,
            priceMxn: 8500,
            etaMinutes: 90,
            pickupTime: THURSDAY_PICKUP,
            callId: approvedCallId,
            createdAt: RUN_AT
          }
        },
        toolDependencies
      );
      await executeToolCall(
        {
          name: "review_deal",
          arguments: {
            quoteId: "quote-costa-pacifico-001",
            reviewedAt: RUN_AT
          }
        },
        toolDependencies
      );

      await executeToolCall(
        {
          name: "register_quote",
          arguments: {
            id: "quote-ruta-occidente-001",
            carrierId: overCapCarrier.id,
            carrierName: overCapCarrier.name,
            priceMxn: 9200,
            etaMinutes: 75,
            pickupTime: THURSDAY_PICKUP,
            callId: overCapCallId,
            createdAt: RUN_AT
          }
        },
        toolDependencies
      );
      await executeToolCall(
        {
          name: "review_deal",
          arguments: {
            quoteId: "quote-ruta-occidente-001",
            reviewedAt: RUN_AT
          }
        },
        toolDependencies
      );

      store.recordCallBrief(
        createCallBrief({
          id: `brief-${unavailableCallId}`,
          callId: unavailableCallId,
          carrierId: unavailableCarrier.id,
          summary: `${unavailableCarrier.name} was unavailable to provide a quote.`,
          objections: ["carrier_unavailable"],
          actions: ["Continue with the available quotes"],
          outcome: "unavailable",
          createdAt: RUN_AT
        })
      );
    }
  };
}
