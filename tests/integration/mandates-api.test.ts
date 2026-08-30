import { once } from "node:events";
import type { AddressInfo } from "node:net";

import type { CreateMandateRequest } from "@volta/contracts";
import { afterEach, expect, it } from "vitest";

import { createApp } from "../../src/server";
import { DeterministicAgentAnswerer } from "../../src/agent/operationalAgent";
import { MemoryAgentRepository } from "../../src/agent/repository";
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

it("runs the mock call round through quotes and a pending carrier approval", async () => {
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
    approvals: Array<{ status: string; quoteIds: string[] }>;
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
  expect(operation.approvals).toEqual([
    expect.objectContaining({
      status: "pending",
      quoteIds: expect.arrayContaining(
        operation.quotes.map((quote) => quote.id)
      )
    })
  ]);

  const readResponse = await request(app, "/api/operation");
  await expect(readResponse.json()).resolves.toMatchObject({
    pipelineStage: "awaiting_approval"
  });
});

it("renames a durable Volta conversation", async () => {
  const app = createApp({
    mandatesRepository: new MemoryRepository(),
    repository: new MemoryAgentRepository(),
    answerer: new DeterministicAgentAnswerer()
  });
  const createResponse = await request(app, "/api/agent/conversations", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "Original title" })
  });
  const created = (await createResponse.json()) as { id: string };

  const renameResponse = await request(
    app,
    `/api/agent/conversations/${created.id}`,
    {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Carrier exceptions" })
    }
  );

  expect(renameResponse.status).toBe(200);
  await expect(renameResponse.json()).resolves.toMatchObject({
    id: created.id,
    title: "Carrier exceptions"
  });
  const listResponse = await request(app, "/api/agent/conversations");
  await expect(listResponse.json()).resolves.toEqual([
    expect.objectContaining({ id: created.id, title: "Carrier exceptions" })
  ]);
});

it("streams readable central-brain activity before the grounded answer", async () => {
  const app = createApp({
    mandatesRepository: new MemoryRepository(),
    repository: new MemoryAgentRepository(),
    answerer: new DeterministicAgentAnswerer()
  });
  const createResponse = await request(app, "/api/agent/conversations", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "Operational status" })
  });
  const created = (await createResponse.json()) as { id: string };

  const messageResponse = await request(
    app,
    `/api/agent/conversations/${created.id}/messages`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ question: "What needs my attention?" })
    }
  );
  const stream = await messageResponse.text();

  expect(messageResponse.status).toBe(200);
  expect(stream).toContain("event: activity");
  expect(stream).toContain("Searching operational records");
  expect(stream).toContain("Reviewing items that need attention");
  expect(stream).toContain("event: final");
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
