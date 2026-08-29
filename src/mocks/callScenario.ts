import { createCommitmentFinalizer } from "../audit/commitment";
import { executeToolCall } from "../agent/interpreter";
import { seedOperation, THURSDAY_PICKUP } from "../core/seed";
import { createOperationStore, type OperationStore } from "../core/state";
import { MockSmsGateway } from "./sms";

const RUN_AT = "2026-09-01T15:00:00.000Z";
const RECAP_AT = "2026-09-01T15:05:00.000Z";

export type MockScenario = {
  store: OperationStore;
  run(): Promise<void>;
  closeApprovedDeal(): Promise<boolean>;
};

export function createMockScenario(
  onEvent?: Parameters<OperationStore["subscribe"]>[0]
): MockScenario {
  const store = createOperationStore(seedOperation());
  if (onEvent) store.subscribe(onEvent);
  const operation = store.getOperation();
  const costaPacifico = operation.candidates[0];
  const rutaOccidente = operation.candidates[1];
  const logisticaManzanillo = operation.candidates[2];

  return {
    store,
    async run() {
      await executeToolCall(
        {
          name: "register_quote",
          arguments: {
            id: "quote-costa-pacifico-001",
            carrierId: costaPacifico.id,
            carrierName: costaPacifico.name,
            priceMxn: 8750,
            etaMinutes: 90,
            pickupTime: THURSDAY_PICKUP,
            callId: "mock-quote-costa-pacifico-001",
            createdAt: RUN_AT
          }
        },
        { store, finalizeBooking: async () => {}, now: () => RUN_AT }
      );

      await executeToolCall(
        {
          name: "register_quote",
          arguments: {
            id: "quote-ruta-occidente-001",
            carrierId: rutaOccidente.id,
            carrierName: rutaOccidente.name,
            priceMxn: 8500,
            etaMinutes: 75,
            pickupTime: THURSDAY_PICKUP,
            callId: "mock-quote-ruta-occidente-001",
            createdAt: RUN_AT
          }
        },
        { store, finalizeBooking: async () => {}, now: () => RUN_AT }
      );
      await executeToolCall(
        {
          name: "register_quote",
          arguments: {
            id: "quote-logistica-manzanillo-001",
            carrierId: logisticaManzanillo.id,
            carrierName: logisticaManzanillo.name,
            priceMxn: 8640,
            etaMinutes: 80,
            pickupTime: THURSDAY_PICKUP,
            callId: "mock-quote-logistica-manzanillo-001",
            createdAt: RUN_AT
          }
        },
        { store, finalizeBooking: async () => {}, now: () => RUN_AT }
      );
      await executeToolCall(
        {
          name: "request_quote_approval",
          arguments: {
            quoteIds: [
              "quote-costa-pacifico-001",
              "quote-ruta-occidente-001",
              "quote-logistica-manzanillo-001"
            ],
            recommendedQuoteId: "quote-ruta-occidente-001"
          }
        },
        { store, finalizeBooking: async () => {}, now: () => RUN_AT }
      );
    },
    async closeApprovedDeal() {
      const activeOperation = store.getOperation();
      const authorization = activeOperation.closingAuthorization;
      if (!authorization) return false;

      const carrier = activeOperation.candidates.find(
        (candidate) => candidate.id === authorization.carrierId
      );
      if (!carrier) return false;
      const closeCallId = `mock-close-${carrier.id}-001`;
      const finalizeBooking = createCommitmentFinalizer({
        store,
        sms: new MockSmsGateway(),
        callId: closeCallId,
        recipient: activeOperation.mandate.escalationPhone,
        now: () => RECAP_AT
      });

      const result = await executeToolCall(
        {
          name: "commit_deal",
          arguments: {
            carrierId: authorization.carrierId,
            finalPrice: authorization.finalPriceMxn,
            pickupTime: authorization.pickupTime,
            timestampMs: 42_500,
            driverName: "María López",
            plate: "ABC-123"
          }
        },
        { store, finalizeBooking, now: () => RECAP_AT }
      );
      return result.outcome === "booking_requested";
    }
  };
}
