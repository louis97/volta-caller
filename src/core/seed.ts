import type {
  CarrierCandidate,
  CreateMandateRequest,
  Operation
} from "@volta/contracts";

export const THURSDAY_PICKUP = "2026-09-03T10:00:00-06:00";

/**
 * The demo pool the carrier directory is backfilled with, so a round always
 * has someone to dial without anyone retyping three numbers. These are the
 * only seeded values production code is allowed to reach: a mandate is never
 * seeded, because a carrier would hear it.
 */
export function seedCarriers(): CarrierCandidate[] {
  return [
    {
      id: "carrier-costa-pacifico",
      name: "Transportes Costa Pacífico",
      phone: "+573104083853"
    },
    {
      id: "carrier-ruta-occidente",
      name: "Ruta Occidente",
      phone: "+573142117112"
    },
    {
      id: "carrier-fletes-bajio",
      name: "Fletes del Bajío",
      phone: "+573224118118"
    }
  ];
}

/**
 * Test fixture only. Nothing under `src/` may import this: a process that has
 * not been sent a mandate holds `emptyOperation()`, and dialling is refused
 * until a real one arrives. Wiring this back into the runtime is what made
 * every call announce a container from Manzanillo to Guadalajara.
 */
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
      // Real, verified handset. The fiction stays Mexican; the dialling is not.
      escalationPhone: "+573224118118"
    },
    candidates: seedCarriers(),
    callSessions: [],
    quotes: [],
    callBriefs: [],
    escalations: [],
    reviewedDeals: [],
    incidents: [],
    dashboardNotifications: []
  };
}

export function createOperationFromMandate(
  input: CreateMandateRequest,
  operationId: string
): Operation {
  return {
    id: operationId,
    containerId: "PENDING-ASSIGNMENT",
    // Spoken aloud on every call: "Volta, de Unassigned" is not a company.
    shipper: "Textiles Pacífico",
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
    callSessions: [],
    quotes: [],
    callBriefs: [],
    escalations: [],
    reviewedDeals: [],
    incidents: [],
    dashboardNotifications: []
  };
}
