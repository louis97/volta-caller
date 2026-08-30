import { once } from "node:events";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { createConfirmationCoordinator } from "../../src/core/confirmation";
import { seedOperation, THURSDAY_PICKUP } from "../../src/core/seed";
import { createOperationStore } from "../../src/core/state";
import { createMockTelephonyGateway } from "../../src/mocks/telephony";
import { createApp } from "../../src/server";

const servers: ReturnType<ReturnType<typeof createApp>["listen"]>[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(async (server) => {
      server.close();
      await once(server, "close");
    })
  );
});

async function request(
  app: ReturnType<typeof createApp>,
  path: string,
  init?: RequestInit
) {
  const server = app.listen(0, "127.0.0.1");
  servers.push(server);
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;

  return fetch(`http://127.0.0.1:${port}${path}`, init);
}

describe("client selection API", () => {
  it("accepts a valid selection and starts one confirmation callback", async () => {
    const store = createReadyStore();
    const telephony = createMockTelephonyGateway();
    const confirmationCoordinator = createConfirmationCoordinator({
      store,
      telephony,
      now: () => "2026-09-01T15:02:00.000Z"
    });
    const app = createApp({
      scenario: { store, run: async () => {} },
      confirmationCoordinator
    });

    const response = await request(app, "/operations/op-1/select-quote", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ quoteId: "quote-a" })
    });

    expect(response.status).toBe(202);
    expect(
      telephony.calls.filter((call) => call.type === "created")
    ).toHaveLength(1);
    expect(store.getOperation()).toMatchObject({
      status: "confirming_selected_carrier",
      confirmationCallId: "mock-call-1",
      callBriefs: [
        expect.objectContaining({
          callId: "mock-call-1",
          carrierId: "carrier-costa-pacifico",
          quotedPriceMxn: 8500
        })
      ]
    });
    expect(telephony.calls).toContainEqual({
      type: "created",
      callId: "mock-call-1",
      input: expect.objectContaining({
        operationId: "op-1",
        carrierId: "carrier-costa-pacifico",
        to: seedOperation().candidates[0]!.phone
      })
    });
    expect(confirmationCoordinator.getCallContext("mock-call-1")).toEqual(
      expect.objectContaining({
        callId: "mock-call-1",
        mode: "confirmation",
        quote: expect.objectContaining({
          id: "quote-a",
          priceMxn: 8500,
          pickupTime: THURSDAY_PICKUP
        }),
        mandate: store.getOperation().mandate,
        configuration: expect.objectContaining({
          tools: expect.arrayContaining([
            expect.objectContaining({ name: "confirm_selected_deal" })
          ])
        })
      })
    );
  });

  it("rejects malformed selection requests without starting telephony", async () => {
    const store = createReadyStore();
    const telephony = createMockTelephonyGateway();
    const app = createApp({ store, telephony });

    const response = await request(app, "/operations/op-1/select-quote", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({})
    });

    expect(response.status).toBe(400);
    expect(telephony.calls).toEqual([]);
  });

  it("rejects another operation without starting telephony", async () => {
    const store = createReadyStore();
    const telephony = createMockTelephonyGateway();
    const app = createApp({ store, telephony });

    const response = await request(app, "/operations/other/select-quote", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ quoteId: "quote-a" })
    });

    expect(response.status).toBe(404);
    expect(telephony.calls).toEqual([]);
  });

  it("rejects expired selections without starting telephony", async () => {
    const store = createReadyStore();
    const telephony = createMockTelephonyGateway();
    const app = createApp({
      store,
      telephony,
      now: () => "2026-09-04T00:00:00.000Z"
    });

    const response = await request(app, "/operations/op-1/select-quote", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ quoteId: "quote-a" })
    });

    expect(response.status).toBe(409);
    expect(telephony.calls).toEqual([]);
    expect(store.getOperation().status).toBe("selection_expired");
    expect(store.getOperation().commitment).toBeUndefined();
  });

  it("rejects an unreviewed quote without starting telephony", async () => {
    const unreviewedStore = createOperationStore(seedSelectionOperation());
    unreviewedStore.registerQuote(selectionQuote());
    const unreviewedTelephony = createMockTelephonyGateway();
    const unreviewedApp = createApp({
      store: unreviewedStore,
      telephony: unreviewedTelephony
    });

    const unreviewed = await request(
      unreviewedApp,
      "/operations/op-1/select-quote",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ quoteId: "quote-a" })
      }
    );

    expect(unreviewed.status).toBe(409);
    expect(unreviewedTelephony.calls).toEqual([]);
  });

  it("rejects an out-of-mandate quote without starting telephony", async () => {
    const store = createReadyStore({ priceMxn: 9500 });
    const telephony = createMockTelephonyGateway();
    const app = createApp({ store, telephony });

    const response = await request(app, "/operations/op-1/select-quote", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ quoteId: "quote-a" })
    });

    expect(response.status).toBe(409);
    expect(telephony.calls).toEqual([]);
  });

  it("records an unavailable carrier failure without starting telephony", async () => {
    const store = createReadyStore({ carrierId: "carrier-not-configured" });
    const telephony = createMockTelephonyGateway();
    const app = createApp({ store, telephony });

    const response = await request(app, "/operations/op-1/select-quote", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ quoteId: "quote-a" })
    });

    expect(response.status).toBe(502);
    expect(telephony.calls).toEqual([]);
    expect(store.getOperation()).toMatchObject({
      status: "confirmation_failed",
      callBriefs: [
        expect.objectContaining({
          outcome: "failed",
          objections: ["confirmation_carrier_not_found"]
        })
      ]
    });
    expect(store.getOperation().commitment).toBeUndefined();
  });

  it("rejects a duplicate selection without a second callback", async () => {
    const store = createReadyStore();
    const telephony = createMockTelephonyGateway();
    const app = createApp({ store, telephony });
    const body = JSON.stringify({ quoteId: "quote-a" });

    const first = await request(app, "/operations/op-1/select-quote", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body
    });
    const second = await request(app, "/operations/op-1/select-quote", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body
    });

    expect(first.status).toBe(202);
    expect(second.status).toBe(409);
    expect(
      telephony.calls.filter((call) => call.type === "created")
    ).toHaveLength(1);
  });

  it("fails the operation with a brief when callback creation fails", async () => {
    const store = createReadyStore();
    const telephony = createMockTelephonyGateway();
    let attempts = 0;
    telephony.createOutboundCall = async () => {
      attempts += 1;
      throw new Error("gateway unavailable");
    };
    const app = createApp({ store, telephony });

    const response = await request(app, "/operations/op-1/select-quote", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ quoteId: "quote-a" })
    });

    expect(response.status).toBe(502);
    expect(attempts).toBe(1);
    expect(store.getOperation()).toMatchObject({
      status: "confirmation_failed",
      callBriefs: [
        expect.objectContaining({
          outcome: "failed",
          objections: ["confirmation_callback_creation_failed"]
        })
      ]
    });
  });
});

function createReadyStore({
  priceMxn = 8500,
  carrierId = "carrier-costa-pacifico"
}: { priceMxn?: number; carrierId?: string } = {}) {
  const operation = seedSelectionOperation();
  const store = createOperationStore(operation);
  const quote = selectionQuote({ priceMxn, carrierId });
  store.registerQuote(quote);
  store.reviewDeal({
    quoteId: quote.id,
    reviewedAt: "2026-09-01T15:01:00.000Z"
  });
  return store;
}

function seedSelectionOperation() {
  const operation = seedOperation();
  operation.id = "op-1";
  return operation;
}

function selectionQuote({
  priceMxn = 8500,
  carrierId = "carrier-costa-pacifico"
}: { priceMxn?: number; carrierId?: string } = {}) {
  return {
    id: "quote-a",
    carrierId,
    carrierName: "Transportes Costa Pacífico",
    priceMxn,
    etaMinutes: 90,
    pickupTime: THURSDAY_PICKUP,
    callId: "discovery-call-a",
    createdAt: "2026-09-01T15:00:00.000Z"
  };
}
