import type { Mandate } from "@volta/contracts";

export type MandateDecision =
  | { status: "APPROVED" }
  | { status: "REJECTED"; reason: "invalid_price" }
  | {
      status: "REQUIRES_ESCALATION";
      reason: "price_cap_exceeded" | "pickup_window_unapproved";
    };

export function evaluateMandate(
  mandate: Mandate,
  terms: { price: number; pickupTime: string }
): MandateDecision {
  if (!Number.isFinite(terms.price) || terms.price < 0) {
    return { status: "REJECTED", reason: "invalid_price" };
  }

  if (terms.price > mandate.budgetCapMxn) {
    return { status: "REQUIRES_ESCALATION", reason: "price_cap_exceeded" };
  }

  if (terms.pickupTime !== mandate.pickupDatetime) {
    return {
      status: "REQUIRES_ESCALATION",
      reason: "pickup_window_unapproved"
    };
  }

  return { status: "APPROVED" };
}
