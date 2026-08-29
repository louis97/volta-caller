import type { Mandate } from "@volta/contracts";
import { describe, expect, it } from "vitest";

import { evaluateMandate } from "../../src/core/mandate";

const mandate: Mandate = {
  maxPriceMxn: 9000,
  pickupTime: "2026-09-03T10:00:00-06:00",
  escalationPhone: "+52-33-0000-0000"
};

describe("evaluateMandate", () => {
  it.each([
    [8500, "2026-09-03T10:00:00-06:00", "APPROVED"],
    [9001, "2026-09-03T10:00:00-06:00", "REQUIRES_ESCALATION"],
    [8500, "2026-09-04T10:00:00-06:00", "REQUIRES_ESCALATION"]
  ])("evaluates %i MXN at %s as %s", (price, pickupTime, status) => {
    expect(evaluateMandate(mandate, { price, pickupTime }).status).toBe(status);
  });

  it("approves the price cap only at the mandate pickup timestamp", () => {
    expect(
      evaluateMandate(mandate, {
        price: 9000,
        pickupTime: "2026-09-03T10:00:00-06:00"
      })
    ).toEqual({ status: "APPROVED" });
  });

  it.each([
    [Number.NaN, "invalid_price"],
    [Number.POSITIVE_INFINITY, "invalid_price"],
    [-1, "invalid_price"]
  ])("rejects invalid price %s with %s", (price, reason) => {
    expect(
      evaluateMandate(mandate, {
        price,
        pickupTime: "2026-09-03T10:00:00-06:00"
      })
    ).toEqual({ status: "REJECTED", reason });
  });

  it("escalates a price over the mandate cap with an explicit reason", () => {
    expect(
      evaluateMandate(mandate, {
        price: 9001,
        pickupTime: "2026-09-03T10:00:00-06:00"
      })
    ).toEqual({ status: "REQUIRES_ESCALATION", reason: "price_cap_exceeded" });
  });

  it("escalates an unapproved pickup timestamp with an explicit reason", () => {
    expect(
      evaluateMandate(mandate, {
        price: 8500,
        pickupTime: "2026-09-04T10:00:00-06:00"
      })
    ).toEqual({
      status: "REQUIRES_ESCALATION",
      reason: "pickup_window_unapproved"
    });
  });
});
