import type { Operation } from "@volta/contracts";

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
      maxPriceMxn: 9000,
      pickupTime: THURSDAY_PICKUP,
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
