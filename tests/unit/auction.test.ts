import { describe, expect, it } from "vitest";
import type { Quote } from "@volta/contracts";

import { createAuction } from "../../src/telephony/auction";

const THURSDAY = "2026-09-03T10:00:00-06:00";
const FRIDAY = "2026-09-04T10:00:00-06:00";

const options = {
  budgetCapMxn: 9000,
  pickupDatetime: THURSDAY,
  carrierIds: ["a", "b", "c"]
};

function quote(
  carrierId: string,
  priceMxn: number,
  pickupTime = THURSDAY
): Quote {
  return {
    id: `quote-${carrierId}`,
    carrierId,
    carrierName: carrierId.toUpperCase(),
    priceMxn,
    etaMinutes: 90,
    pickupTime,
    callId: `CA-${carrierId}`,
    createdAt: "2026-08-29T23:00:00.000Z"
  };
}

describe("auction", () => {
  it("stays open while any carrier has not answered", () => {
    const auction = createAuction(options);
    auction.recordQuote(quote("a", 8500));

    expect(auction.status()).toMatchObject({
      state: "OPEN",
      unresolved: ["b", "c"]
    });
  });

  it("resolves once every carrier has quoted or dropped out", () => {
    const auction = createAuction(options);
    auction.recordQuote(quote("a", 8500));
    auction.recordQuote(quote("b", 8200));
    auction.markUnavailable("c", "no_trucks");

    const status = auction.status();
    expect(status).toMatchObject({ state: "RESOLVED" });
    if (status.state !== "RESOLVED") throw new Error("unreachable");
    expect(status.best.carrierId).toBe("b");
  });

  it("does not let a cheaper truck on the wrong day win", () => {
    const auction = createAuction(options);
    // Cheapest, but Friday: the mandate authorises Thursday.
    auction.recordQuote(quote("a", 8200, FRIDAY));
    auction.recordQuote(quote("b", 8600));
    auction.markUnavailable("c", "no_trucks");

    const status = auction.status();
    if (status.state !== "RESOLVED") throw new Error("expected RESOLVED");
    expect(status.best.carrierId).toBe("b");
    expect(status.best.priceMxn).toBe(8600);
  });

  it("reports a gap rather than recommending an out-of-mandate offer", () => {
    const auction = createAuction(options);
    auction.recordQuote(quote("a", 9500));
    auction.recordQuote(quote("b", 9200));
    auction.recordQuote(quote("c", 9800));

    expect(auction.status()).toMatchObject({
      state: "NO_VIABLE_OFFER",
      reason: "every_offer_over_cap"
    });
  });

  it("reports no market when nobody quotes", () => {
    const auction = createAuction(options);
    for (const carrierId of ["a", "b", "c"])
      auction.markUnavailable(carrierId, "no_answer");

    expect(auction.status()).toEqual({ state: "NO_MARKET" });
  });

  it("offers only real quotes from other carriers as leverage", () => {
    const auction = createAuction(options);
    auction.recordQuote(quote("a", 8500));
    auction.recordQuote(quote("b", 8200));

    const leverage = auction.leverageFor("a");

    expect(leverage.map((item) => item.carrierId)).toEqual(["b"]);
    expect(leverage[0]?.priceMxn).toBe(8200);
    // Nothing to cite before anyone has quoted.
    expect(createAuction(options).leverageFor("a")).toEqual([]);
  });
});

describe("get_leverage tool", () => {
  it("returns only quotes the auction actually holds", async () => {
    const { executeToolCall } = await import("../../src/agent/interpreter");
    const { seedOperation } = await import("../../src/core/seed");
    const { createOperationStore } = await import("../../src/core/state");

    const auction = createAuction(options);
    auction.recordQuote(quote("b", 8200));
    const store = createOperationStore(seedOperation());

    const result = await executeToolCall(
      { name: "get_leverage", arguments: {} },
      {
        store,
        finalizeBooking: () => {},
        leverage: () => auction.leverageFor("a")
      }
    );

    expect(result).toEqual({
      outcome: "leverage",
      quotes: [{ carrierName: "B", priceMxn: 8200, pickupTime: THURSDAY }]
    });
  });

  it("returns nothing when no other carrier has quoted", async () => {
    const { executeToolCall } = await import("../../src/agent/interpreter");
    const { seedOperation } = await import("../../src/core/seed");
    const { createOperationStore } = await import("../../src/core/state");

    const result = await executeToolCall(
      { name: "get_leverage", arguments: {} },
      {
        store: createOperationStore(seedOperation()),
        finalizeBooking: () => {}
      }
    );

    // No leverage supplied at all: the agent has nothing it may cite.
    expect(result).toEqual({ outcome: "leverage", quotes: [] });
  });
});

describe("telephony context", () => {
  it("gives every leg of a round the same auction and registry", async () => {
    const { telephonyContext } = await import("../../src/telephony/routes");
    const { seedOperation } = await import("../../src/core/seed");
    const { createOperationStore } = await import("../../src/core/state");

    const store = createOperationStore(seedOperation());

    // The routes and the WebSocket handler are wired separately; both resolve
    // their context from the store they were handed.
    const fromRoutes = telephonyContext(store);
    const fromSocket = telephonyContext(store);

    expect(fromSocket).toBe(fromRoutes);
    expect(fromSocket.auction).toBe(fromRoutes.auction);
    expect(fromSocket.registry).toBe(fromRoutes.registry);
  });

  it("keeps separate operations isolated from each other", async () => {
    const { telephonyContext } = await import("../../src/telephony/routes");
    const { seedOperation } = await import("../../src/core/seed");
    const { createOperationStore } = await import("../../src/core/state");

    const first = telephonyContext(createOperationStore(seedOperation()));
    const second = telephonyContext(createOperationStore(seedOperation()));

    expect(second).not.toBe(first);
  });
});
