import { createCallBrief } from "../audit/callBrief";
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
};

export function createMockScenario(onEvent?: Parameters<OperationStore["subscribe"]>[0]): MockScenario {
  const store = createOperationStore(seedOperation());
  if (onEvent) store.subscribe(onEvent);
  const operation = store.getOperation();
  const approvedCarrier = operation.candidates[0];
  const overCapCarrier = operation.candidates[1];
  const unavailableCarrier = operation.candidates[2];
  const approvedCallId = "mock-call-costa-pacifico-001";
  const overCapCallId = "mock-call-ruta-occidente-001";
  const unavailableCallId = "mock-call-logistica-manzanillo-001";
  const finalizeBooking = createCommitmentFinalizer({
    store,
    sms: new MockSmsGateway(),
    callId: approvedCallId,
    recipient: operation.mandate.escalationPhone,
    now: () => RECAP_AT
  });

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
        { store, finalizeBooking }
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
        { store, finalizeBooking }
      );
      await executeToolCall(
        {
          name: "commit_deal",
          arguments: {
            carrierId: overCapCarrier.id,
            finalPrice: 9200,
            pickupTime: THURSDAY_PICKUP,
            timestampMs: 31_000
          }
        },
        { store, finalizeBooking }
      );

      store.recordCallBrief(
        createCallBrief({
          id: `brief-${unavailableCallId}`,
          callId: unavailableCallId,
          carrierId: unavailableCarrier.id,
          summary: `${unavailableCarrier.name} no estuvo disponible para cotizar.`,
          objections: ["carrier_unavailable"],
          actions: ["Continuar con las cotizaciones disponibles"],
          outcome: "unavailable",
          createdAt: RUN_AT
        })
      );

      await executeToolCall(
        {
          name: "commit_deal",
          arguments: {
            carrierId: approvedCarrier.id,
            finalPrice: 8500,
            pickupTime: THURSDAY_PICKUP,
            timestampMs: 42_500,
            driverName: "María López",
            plate: "ABC-123"
          }
        },
        { store, finalizeBooking }
      );
    }
  };
}
