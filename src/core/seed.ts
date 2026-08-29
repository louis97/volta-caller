import type { CreateMandateRequest, Operation } from "@volta/contracts";

export const THURSDAY_PICKUP = "2026-09-03T10:00:00-06:00";

export function seedOperation(): Operation {
  return {
    id: "operation-textiles-pacifico-001",
    containerId: "MSCU-TP-001",
    shipper: "Textiles Pacífico",
    origin: "Manzanillo",
    destination: "Guadalajara",
    status: "open",
    mandate: {
      budgetCapMxn: 9000,
      pickupAddress: "Terminal de Contenedores, Manzanillo, Colima",
      pickupDatetime: THURSDAY_PICKUP,
      destinationPlace: "Textiles Pacífico, Guadalajara, Jalisco",
      destinationDatetime: "2026-09-03T18:00:00-06:00",
      typeOfContent: "Textiles",
      weightKg: 18400,
      measures: "120 × 100 × 110 cm",
      escalationPhone: "+52-33-0000-0000"
    },
    candidates: [
      {
        id: "carrier-costa-pacifico",
        name: "Transportes Costa Pacífico",
        phone: "+52-314-000-0001"
      },
      {
        id: "carrier-ruta-occidente",
        name: "Ruta Occidente",
        phone: "+52-33-000-0002"
      },
      {
        id: "carrier-logistica-manzanillo",
        name: "Logística Manzanillo",
        phone: "+52-314-000-0003"
      }
    ],
    quotes: [],
    callBriefs: [],
    escalations: []
  };
}

export function createOperationFromMandate(
  input: CreateMandateRequest,
  operationId: string
): Operation {
  return {
    id: operationId,
    containerId: "PENDING-ASSIGNMENT",
    shipper: "Unassigned",
    origin: input.pickup_address,
    destination: input.destination_place,
    status: "open",
    mandate: {
      budgetCapMxn: input.budget_cap,
      pickupAddress: input.pickup_address,
      pickupDatetime: input.pickup_datetime,
      destinationPlace: input.destination_place,
      destinationDatetime: input.destination_datetime,
      typeOfContent: input.type_of_content,
      weightKg: input.weight,
      measures: input.measures,
      escalationPhone: "unconfigured"
    },
    candidates: [],
    quotes: [],
    callBriefs: [],
    escalations: []
  };
}
