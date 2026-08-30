import { once } from "node:events";
import type { AddressInfo } from "node:net";

import type { CreateMandateRequest } from "@volta/contracts";
import { afterEach, expect, it } from "vitest";

import { createApp } from "../../src/server";
import type {
  MandateRecord,
  MandatesRepository
} from "../../src/core/mandates/types";

const servers: ReturnType<ReturnType<typeof createApp>["listen"]>[] = [];

const mandate: CreateMandateRequest = {
  budget_cap: 8700.5,
  destination_datetime: "2026-09-03T18:00:00-06:00",
  destination_place: "Guadalajara",
  type_of_content: "Textiles",
  weight: 18400,
  measures: "120 x 100 x 110 cm",
  pickup_address: "Manzanillo",
  pickup_datetime: "2026-09-03T10:00:00-06:00"
};

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(async (server) => {
      server.close();
      await once(server, "close");
    })
  );
});

it("creates a real operation, then retains the mandate record", async () => {
  const app = createApp({ mandatesRepository: new MemoryRepository() });
  const createResponse = await request(app, "/api/mandates", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(mandate)
  });

  expect(createResponse.status).toBe(201);
  const operation = (await createResponse.json()) as {
    id: string;
    mandate: { budgetCapMxn: number };
  };
  expect(operation).toMatchObject({
    id: "operation-mandate-1",
    mandate: { budgetCapMxn: 8700.5 }
  });

  const oneResponse = await request(app, "/api/mandates/mandate-1");
  const created = (await oneResponse.json()) as MandateRecord;
  expect(created).toMatchObject({ id: "mandate-1", budget_cap: 8700.5 });

  const listResponse = await request(app, "/api/mandates");
  await expect(listResponse.json()).resolves.toEqual([created]);
});

it("runs the mock call round through quotes and stops for a client decision", async () => {
  const app = createApp({ mandatesRepository: new MemoryRepository() });
  for (const carrier of [
    { name: "Transportes Norte", phone: "+525511111111" },
    { name: "Carga Occidente", phone: "+525522222222" }
  ]) {
    const carrierResponse = await request(app, "/api/carriers", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...carrier, lanes: ["Manzanillo → Guadalajara"] })
    });
    expect(carrierResponse.status).toBe(201);
  }

  const createResponse = await request(app, "/api/mandates", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(mandate)
  });

  expect(createResponse.status).toBe(201);
  const operation = (await createResponse.json()) as {
    pipelineStage: string;
    quotes: Array<{ id: string }>;
    callSessions: Array<{ status: string; quoteId?: string }>;
    reviewedDeals: Array<{ quoteId: string; mandateDecision: string }>;
  };
  expect(operation.pipelineStage).toBe("awaiting_approval");
  expect(operation.quotes).toHaveLength(2);
  expect(operation.callSessions).toHaveLength(2);
  expect(operation.callSessions).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        status: "completed",
        quoteId: expect.any(String)
      }),
      expect.objectContaining({
        status: "completed",
        quoteId: expect.any(String)
      })
    ])
  );
  // Every quote of the round is published for the client to choose from;
  // reviewing is what stops the round and hands the decision to a human.
  expect(operation.reviewedDeals.map((deal) => deal.quoteId)).toEqual(
    expect.arrayContaining(operation.quotes.map((quote) => quote.id))
  );

  const readResponse = await request(app, "/api/operation");
  await expect(readResponse.json()).resolves.toMatchObject({
    pipelineStage: "awaiting_approval"
  });
});

class MemoryRepository implements MandatesRepository {
  private readonly records: MandateRecord[] = [];

  async create(input: CreateMandateRequest): Promise<MandateRecord> {
    const record: MandateRecord = {
      id: `mandate-${this.records.length + 1}`,
      ...input,
      created_at: "2026-09-01T15:00:00.000Z",
      updated_at: "2026-09-01T15:00:00.000Z"
    };
    this.records.push(record);
    return record;
  }

  async findById(id: string): Promise<MandateRecord | null> {
    return this.records.find((record) => record.id === id) ?? null;
  }

  async list(): Promise<MandateRecord[]> {
    return [...this.records];
  }
}

async function request(
  app: ReturnType<typeof createApp>,
  path: string,
  init?: RequestInit
): Promise<Response> {
  const server = app.listen(0);
  servers.push(server);
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  return fetch(`http://127.0.0.1:${port}${path}`, init);
}
