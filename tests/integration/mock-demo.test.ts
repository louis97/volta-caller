import { once } from "node:events";
import type { AddressInfo } from "node:net";
import type { Operation } from "@volta/contracts";

import { afterEach, describe, expect, it } from "vitest";

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
  const server = app.listen(0);
  servers.push(server);
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;

  return fetch(`http://127.0.0.1:${port}${path}`, init);
}

describe("mock demo API", () => {
  it("stores a complete dashboard mandate in the API-owned operation state", async () => {
    const app = createApp();
    const mandate = {
      budget_cap: 8700,
      destination_datetime: "2026-09-03T18:00:00-06:00",
      destination_place: "Textiles Pacífico, Guadalajara, Jalisco",
      type_of_content: "Textiles",
      weight: 18400,
      measures: "120 × 100 × 110 cm",
      pickup_address: "Terminal de Contenedores, Manzanillo, Colima",
      pickup_datetime: "2026-09-03T10:00:00-06:00"
    };

    const createResponse = await request(app, "/api/mandates", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(mandate)
    });

    expect(createResponse.status).toBe(201);
    await expect(createResponse.json()).resolves.toMatchObject({
      id: "operation-mandate-1",
      origin: mandate.pickup_address,
      destination: mandate.destination_place,
      mandate: {
        budgetCapMxn: mandate.budget_cap,
        destinationDatetime: mandate.destination_datetime,
        destinationPlace: mandate.destination_place,
        typeOfContent: mandate.type_of_content,
        weightKg: mandate.weight,
        measures: mandate.measures,
        pickupAddress: mandate.pickup_address,
        pickupDatetime: mandate.pickup_datetime
      }
    });

    await expect(getOperation(app)).resolves.toMatchObject({
      id: "operation-mandate-1",
      mandate: { budgetCapMxn: mandate.budget_cap }
    });
  });

  it("rejects an incomplete mandate without mutating the authoritative operation", async () => {
    const app = createApp();
    const before = await getOperation(app);

    const response = await request(app, "/api/mandates", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ budget_cap: 8700 })
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: "invalid_mandate"
    });
    await expect(getOperation(app)).resolves.toEqual(before);
  });

  it("publishes reviewed discovery candidates and awaits client selection without a commitment", async () => {
    const app = createApp();

    const health = await request(app, "/health");
    expect(health.status).toBe(200);
    await expect(health.json()).resolves.toEqual({
      status: "ok",
      mode: "mock"
    });

    const eventsResponse = await request(app, "/api/events");
    expect(eventsResponse.headers.get("content-type")).toContain(
      "text/event-stream"
    );
    const events = readUntilSecondReview(eventsResponse);

    await expect(
      request(app, "/api/demo/run", { method: "POST" })
    ).resolves.toMatchObject({ status: 202 });
    const firstOperation = await getOperation(app);
    const eventOutput = await events;

    expect(eventOutput).toContain("event: quote.registered");
    expect(eventOutput).toContain('data: {"type":"quote.registered"');
    expect(eventOutput).toContain("event: deal.reviewed");
    expect(firstOperation.quotes).toHaveLength(2);
    expect(firstOperation.quotes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ priceMxn: 8500 }),
        expect.objectContaining({ priceMxn: 9200 })
      ])
    );
    expect(firstOperation.callBriefs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ outcome: "unavailable" })
      ])
    );
    expect(firstOperation.reviewedDeals).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          quoteId: "quote-costa-pacifico-001",
          mandateDecision: "APPROVED"
        }),
        expect.objectContaining({
          quoteId: "quote-ruta-occidente-001",
          mandateDecision: "REQUIRES_ESCALATION"
        })
      ])
    );
    expect(firstOperation.status).toBe("awaiting_client_selection");
    expect(firstOperation.commitment).toBeUndefined();
    expect(firstOperation.escalations).toEqual([]);

    await request(app, "/api/demo/run", { method: "POST" });
    await expect(getOperation(app)).resolves.toEqual(firstOperation);
  });
});

async function getOperation(
  app: ReturnType<typeof createApp>
): Promise<Operation> {
  const response = await request(app, "/api/operation");
  expect(response.status).toBe(200);
  return response.json() as Promise<Operation>;
}

async function readUntilSecondReview(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("SSE response body was unavailable");

  const decoder = new TextDecoder();
  let output = "";
  while ((output.match(/event: deal\.reviewed/g) ?? []).length < 2) {
    const { done, value } = await reader.read();
    if (done)
      throw new Error("SSE stream closed before both deal review events");
    output += decoder.decode(value, { stream: true });
  }
  await reader.cancel();
  return output;
}
