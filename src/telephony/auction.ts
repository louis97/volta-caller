import type { Operation, Quote } from "@volta/contracts";

/**
 * Where one carrier stands in the market. A carrier is "unresolved" until it
 * either quotes or drops out, which is what tells us the market is complete.
 */
export type CarrierStanding =
  | { status: "pending"; carrierId: string }
  | { status: "calling"; carrierId: string; callId: string }
  | { status: "quoted"; carrierId: string; quote: Quote }
  | { status: "unavailable"; carrierId: string; reason: string };

export type AuctionStatus =
  /** Still waiting on carriers; a recommendation now could miss a better price. */
  | { state: "OPEN"; unresolved: string[] }
  /** Every carrier answered or dropped, and at least one quote is in budget. */
  | { state: "RESOLVED"; best: Quote; ranked: Quote[] }
  /** Everyone answered and nothing fits the mandate. Not a failure: a gap. */
  | { state: "NO_VIABLE_OFFER"; ranked: Quote[]; reason: string }
  /** Nobody quoted at all. */
  | { state: "NO_MARKET" };

export type Auction = {
  startCall(carrierId: string, callId: string): void;
  recordQuote(quote: Quote): void;
  markUnavailable(carrierId: string, reason: string): void;
  /** Quotes from other live calls, for use as negotiating leverage. */
  leverageFor(carrierId: string): Quote[];
  status(): AuctionStatus;
  standings(): CarrierStanding[];
};

export type AuctionOptions = {
  /** Cap and pickup window a quote has to satisfy to be recommendable. */
  budgetCapMxn: number;
  pickupDatetime: string;
  carrierIds: string[];
};

/**
 * Scores a quote so "best" is not simply "cheapest". A cheaper truck on the
 * wrong day does not satisfy the mandate, so it cannot win: the window is a
 * gate, and price only ranks what already fits.
 */
function isViable(quote: Quote, options: AuctionOptions): boolean {
  return (
    quote.priceMxn <= options.budgetCapMxn &&
    quote.pickupTime === options.pickupDatetime
  );
}

export function createAuction(options: AuctionOptions): Auction {
  const standings = new Map<string, CarrierStanding>(
    options.carrierIds.map((carrierId) => [
      carrierId,
      { status: "pending", carrierId }
    ])
  );

  const quotes = (): Quote[] =>
    [...standings.values()]
      .filter((standing) => standing.status === "quoted")
      .map((standing) => (standing as { quote: Quote }).quote);

  const unresolved = (): string[] =>
    [...standings.values()]
      .filter(
        (standing) =>
          standing.status === "pending" || standing.status === "calling"
      )
      .map((standing) => standing.carrierId);

  return {
    startCall(carrierId, callId) {
      standings.set(carrierId, { status: "calling", carrierId, callId });
    },

    recordQuote(quote) {
      standings.set(quote.carrierId, {
        status: "quoted",
        carrierId: quote.carrierId,
        quote
      });
    },

    markUnavailable(carrierId, reason) {
      standings.set(carrierId, { status: "unavailable", carrierId, reason });
    },

    leverageFor(carrierId) {
      // Only real, recorded quotes from other carriers. There is no path here
      // for the agent to cite a number that was never actually offered.
      return quotes()
        .filter((quote) => quote.carrierId !== carrierId)
        .sort((left, right) => left.priceMxn - right.priceMxn);
    },

    status() {
      const pending = unresolved();
      if (pending.length > 0) return { state: "OPEN", unresolved: pending };

      const all = quotes();
      if (all.length === 0) return { state: "NO_MARKET" };

      const ranked = [...all].sort(
        (left, right) => left.priceMxn - right.priceMxn
      );
      const viable = ranked.filter((quote) => isViable(quote, options));

      if (viable.length === 0) {
        return {
          state: "NO_VIABLE_OFFER",
          ranked,
          reason: ranked.every((quote) => quote.priceMxn > options.budgetCapMxn)
            ? "every_offer_over_cap"
            : "no_offer_matches_pickup_window"
        };
      }

      return { state: "RESOLVED", best: viable[0]!, ranked };
    },

    standings: () => [...standings.values()]
  };
}

export function auctionFromOperation(operation: Operation): Auction {
  const auction = createAuction({
    budgetCapMxn: operation.mandate.budgetCapMxn,
    pickupDatetime: operation.mandate.pickupDatetime,
    carrierIds: operation.candidates.map((candidate) => candidate.id)
  });
  for (const quote of operation.quotes) auction.recordQuote(quote);
  return auction;
}
