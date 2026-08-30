import type { Operation } from "@volta/contracts";

/**
 * Sentinel id for "no mandate has been sent yet". Membership is decided by the
 * id and not by blank fields, so a real mandate that happens to arrive with an
 * empty measures string is never mistaken for an absent one.
 */
export const NO_OPERATION_ID = "operation-none";

/**
 * The operation a process holds before its first mandate arrives. It exists so
 * the store can stay non-nullable for its fifty-odd readers without inventing
 * a shipment: every field a carrier would hear is blank, and `hasMandate`
 * refuses the call before any of it can be spoken.
 */
export function emptyOperation(): Operation {
  return {
    id: NO_OPERATION_ID,
    containerId: "",
    shipper: "",
    origin: "",
    destination: "",
    status: "open",
    mandate: {
      budgetCapMxn: 0,
      pickupAddress: "",
      pickupDatetime: "",
      destinationPlace: "",
      destinationDatetime: "",
      typeOfContent: "",
      weightKg: 0,
      measures: "",
      escalationPhone: "unconfigured"
    },
    candidates: [],
    callSessions: [],
    quotes: [],
    approvals: [],
    callBriefs: [],
    escalations: [],
    reviewedDeals: [],
    incidents: [],
    dashboardNotifications: []
  };
}

export function hasMandate(operation: Operation): boolean {
  return operation.id !== NO_OPERATION_ID;
}
