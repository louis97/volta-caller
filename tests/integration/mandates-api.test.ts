import { once } from "node:events";
import type { AddressInfo } from "node:net";

import { afterEach, expect, it, vi } from "vitest";
import type { CreateMandateRequest, ShipmentEvent } from "@volta/contracts";

import { createApp } from "../../src/server";
import {
  DeterministicAgentAnswerer,
  type AgentAnswerer
} from "../../src/agent/operationalAgent";
import { MemoryAgentRepository } from "../../src/agent/repository";
import { seedOperation } from "../../src/core/seed";
import { createOperationStore } from "../../src/core/state";
import { buildCallInstructions } from "../../src/agent/prompt";
import { createMockTelephonyGateway } from "../../src/mocks/telephony";
import {
  callContextFromUrl,
  resolveCallDependencies
} from "../../src/telephony/routes";
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
  vi.restoreAllMocks();
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

it("carries a mandate through a durable token into another instance's prompt", async () => {
  const repository = new MemoryAgentRepository();
  await repository.createCarrier({
    id: "carrier-santa-marta",
    organizationId: "textiles-pacifico",
    name: "Transportes del Caribe",
    phone: "+573001234567",
    lanes: ["Santa Marta → Bogotá"],
    active: true,
    createdAt: "2026-08-30T08:00:00.000Z"
  });
  const gateway = createMockTelephonyGateway();
  const mandateBackend = createApp({
    repository,
    telephony: gateway,
    mandatesRepository: new MemoryRepository()
  });
  const santaMartaMandate: CreateMandateRequest = {
    budget_cap: 5000,
    pickup_address: "Santa Marta",
    pickup_datetime: "2026-08-31T05:00:00-05:00",
    destination_place: "Centro comercial Tintal, Bogotá",
    destination_datetime: "2026-09-03T17:00:00-05:00",
    type_of_content: "frágil",
    weight: 40000,
    measures: "20 m de largo × 20 m de alto × 10 m de ancho"
  };

  const createResponse = await request(mandateBackend, "/api/mandates", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(santaMartaMandate)
  });
  expect(createResponse.status).toBe(201);

  const outbound = gateway.calls.find((event) => event.type === "created");
  if (!outbound || outbound.type !== "created") {
    throw new Error("missing_outbound_call");
  }
  const reference = callContextFromUrl(
    new URL(outbound.input.twimlUrl, "https://voice.example.test")
  );
  expect(reference?.callToken).toBeTruthy();
  expect(outbound.input.twimlUrl).not.toContain("operation-mandate-1");

  // A separate process starts on the Manzanillo seed, just like the Render
  // instance in the incident. The persisted token must override that state.
  const voiceBackend = createApp({
    repository,
    store: createOperationStore(seedOperation()),
    mandatesRepository: new MemoryRepository()
  });
  if (!reference) throw new Error("missing_call_reference");
  const resolved = await resolveCallDependencies(
    {
      store: voiceBackend.locals.operationStore,
      resolveCallContext: voiceBackend.locals.resolveTelephonyCallContext
    },
    reference
  );
  const instructions = buildCallInstructions(resolved.store.getOperation());

  expect(resolved.store.getOperation()).toMatchObject({
    id: "operation-mandate-1",
    origin: "Santa Marta",
    destination: "Centro comercial Tintal, Bogotá"
  });
  expect(instructions).toContain("Santa Marta");
  expect(instructions).toContain("Centro comercial Tintal, Bogotá");
  expect(instructions).not.toContain("Manzanillo");
});

it("hangs up a context-free outbound callback before opening media", async () => {
  const app = createApp({
    repository: new MemoryAgentRepository(),
    mandatesRepository: new MemoryRepository()
  });
  const response = await request(app, "/twiml/outbound", { method: "POST" });

  expect(response.status).toBe(200);
  expect(await response.text()).toContain("<Hangup/>");
});

it("lists shipment notifications for the dashboard organization", async () => {
  const repository = new MemoryAgentRepository();
  const event: ShipmentEvent = {
    id: "notification-001",
    organizationId: "textiles-pacifico",
    operationId: "operation-001",
    type: "quotes_ready_for_review",
    label: "Carrier quotes are ready for review.",
    source: "volta",
    occurredAt: "2026-08-30T10:00:00.000Z",
    receivedAt: "2026-08-30T10:00:00.000Z"
  };
  await repository.addShipmentEvent(event);
  const app = createApp({
    repository,
    mandatesRepository: new MemoryRepository()
  });

  const response = await request(app, "/api/shipment-events");

  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toEqual([event]);
});

it("lists durable mandate operations and opens one by id", async () => {
  const repository = new MemoryAgentRepository();
  const first = seedOperation();
  const second = {
    ...seedOperation(),
    id: "operation-second-mandate",
    containerId: "CONT-SANTA-MARTA-20",
    origin: "Santa Marta",
    destination: "Medellín"
  };
  await repository.syncOperation("textiles-pacifico", first);
  await repository.syncOperation("textiles-pacifico", second);
  const app = createApp({
    repository,
    mandatesRepository: new MemoryRepository()
  });

  const listResponse = await request(app, "/api/operations");
  expect(listResponse.status).toBe(200);
  await expect(listResponse.json()).resolves.toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        id: first.id,
        pipelineStage: expect.any(String)
      }),
      expect.objectContaining({
        id: second.id,
        origin: "Santa Marta",
        destination: "Medellín",
        pipelineStage: expect.any(String)
      })
    ])
  );

  const detailResponse = await request(
    app,
    "/api/operations/operation-second-mandate"
  );
  expect(detailResponse.status).toBe(200);
  await expect(detailResponse.json()).resolves.toMatchObject({
    id: second.id,
    containerId: "CONT-SANTA-MARTA-20",
    origin: "Santa Marta",
    destination: "Medellín"
  });

  const missingResponse = await request(app, "/api/operations/missing");
  expect(missingResponse.status).toBe(404);
});

it("resolves an approval against the mandate named by the dashboard", async () => {
  const repository = new MemoryAgentRepository();
  const current = seedOperation();
  const selected = {
    ...seedOperation(),
    id: "operation-selected-mandate",
    origin: "Santa Marta",
    destination: "Medellín",
    status: "awaiting_approval" as const
  };
  selected.quotes = [
    {
      id: "quote-selected",
      carrierId: selected.candidates[0]!.id,
      carrierName: selected.candidates[0]!.name,
      priceMxn: 5000,
      pickupTime: selected.mandate.pickupDatetime,
      callId: "call-selected",
      createdAt: "2026-08-30T08:00:00.000Z"
    }
  ];
  selected.approvals = [
    {
      id: "approval-selected",
      operationId: selected.id,
      type: "carrier_selection",
      status: "pending",
      quoteIds: ["quote-selected"],
      recommendedQuoteId: "quote-selected",
      createdAt: "2026-08-30T08:01:00.000Z"
    }
  ];
  await repository.syncOperation("textiles-pacifico", current);
  await repository.syncOperation("textiles-pacifico", selected);
  const app = createApp({
    repository,
    mandatesRepository: new MemoryRepository()
  });

  const response = await request(
    app,
    "/api/approvals/approval-selected/decision?operationId=operation-selected-mandate",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        action: "approve",
        selectedQuoteId: "quote-selected"
      })
    }
  );

  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toMatchObject({
    approval: { id: "approval-selected", status: "approved" },
    operation: {
      id: "operation-selected-mandate",
      closingAuthorization: { quoteId: "quote-selected" }
    }
  });
  await expect(
    repository.getOperation(
      { organizationId: "textiles-pacifico", userId: "test" },
      current.id
    )
  ).resolves.toMatchObject({ approvals: [] });
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

  const notifications = await request(app, "/api/shipment-events");
  await expect(notifications.json()).resolves.toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        type: "quotes_ready_for_review",
        operationId: "operation-mandate-1"
      })
    ])
  );

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

it("deletes a conversation only within its organization", async () => {
  const app = createApp({
    mandatesRepository: new MemoryRepository(),
    repository: new MemoryAgentRepository(),
    answerer: new DeterministicAgentAnswerer()
  });
  const ownerHeaders = {
    "content-type": "application/json",
    "x-volta-org-id": "organization-owner",
    "x-volta-user-id": "dispatcher-owner"
  };
  const createResponse = await request(app, "/api/agent/conversations", {
    method: "POST",
    headers: ownerHeaders,
    body: JSON.stringify({ title: "Discard this chat" })
  });
  const created = (await createResponse.json()) as { id: string };

  const foreignDelete = await request(
    app,
    `/api/agent/conversations/${created.id}`,
    {
      method: "DELETE",
      headers: {
        "x-volta-org-id": "organization-other",
        "x-volta-user-id": "dispatcher-other"
      }
    }
  );
  expect(foreignDelete.status).toBe(404);
  const detailBeforeDelete = await request(
    app,
    `/api/agent/conversations/${created.id}`,
    { headers: ownerHeaders }
  );
  expect(detailBeforeDelete.status).toBe(200);

  const deleteResponse = await request(
    app,
    `/api/agent/conversations/${created.id}`,
    { method: "DELETE", headers: ownerHeaders }
  );
  expect(deleteResponse.status).toBe(204);
  const detailAfterDelete = await request(
    app,
    `/api/agent/conversations/${created.id}`,
    { headers: ownerHeaders }
  );
  expect(detailAfterDelete.status).toBe(404);
  const listResponse = await request(app, "/api/agent/conversations", {
    headers: ownerHeaders
  });
  await expect(listResponse.json()).resolves.toEqual([]);
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

it("sanitizes agent failures before streaming them to the browser", async () => {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  const app = createApp({
    mandatesRepository: new MemoryRepository(),
    repository: new MemoryAgentRepository(),
    answerer: {
      answer: async () => {
        throw new Error("private upstream detail: credential and schema data");
      }
    }
  });
  const createResponse = await request(app, "/api/agent/conversations", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "Failure handling" })
  });
  const created = (await createResponse.json()) as { id: string };

  const messageResponse = await request(
    app,
    `/api/agent/conversations/${created.id}/messages`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ question: "Summarize the active operation" })
    }
  );
  const stream = await messageResponse.text();

  expect(messageResponse.status).toBe(200);
  expect(stream).toContain("event: error");
  expect(stream).toContain('"error":"agent_request_failed"');
  expect(stream).toContain("No action was taken");
  expect(stream).not.toContain("private upstream detail");
});

it("creates the mandate and starts the quote round only after agent approval", async () => {
  const mandatesRepository = new MemoryRepository();
  const answerer: AgentAnswerer = {
    async answer(request) {
      const createTool = request.tools.find(
        (tool) => tool.name === "propose_create_mandate"
      );
      if (!createTool) throw new Error("missing_create_mandate_tool");
      const proposal = await createTool.execute(mandate);
      return {
        answer: "El mandato quedó pendiente de aprobación humana en Volta.",
        citationIds: [],
        evidence: [],
        proposedActions: proposal.proposedAction
          ? [proposal.proposedAction]
          : []
      };
    }
  };
  const app = createApp({
    mandatesRepository,
    repository: new MemoryAgentRepository(),
    answerer
  });
  const carrierResponse = await request(app, "/api/carriers", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name: "Transportes Norte",
      phone: "+525511111111",
      lanes: ["Manzanillo → Guadalajara"]
    })
  });
  expect(carrierResponse.status).toBe(201);
  const conversationResponse = await request(app, "/api/agent/conversations", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "Nuevo mandato" })
  });
  const conversation = (await conversationResponse.json()) as { id: string };
  const messageResponse = await request(
    app,
    `/api/agent/conversations/${conversation.id}/messages`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        question: "Crea este mandato con presupuesto máximo de 8700.5 MXN"
      })
    }
  );
  const events = await messageResponse.text();
  const finalData = events
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .at(-1);
  if (!finalData) throw new Error("missing_final_agent_event");
  const message = JSON.parse(finalData.slice(6)) as {
    proposedActions: Array<{ id: string; status: string }>;
  };
  expect(message.proposedActions).toEqual([
    expect.objectContaining({ status: "pending" })
  ]);
  await expect(mandatesRepository.list()).resolves.toHaveLength(0);

  const decisionResponse = await request(
    app,
    `/api/agent/actions/${message.proposedActions[0].id}/decision`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision: "approve" })
    }
  );
  const decision = (await decisionResponse.json()) as {
    action: { status: string };
    operation: {
      id: string;
      mandate: { budgetCapMxn: number };
      callSessions: unknown[];
    };
  };

  expect(decisionResponse.status).toBe(200);
  expect(decision.action.status).toBe("executed");
  expect(decision.operation).toMatchObject({
    id: "operation-mandate-1",
    mandate: { budgetCapMxn: mandate.budget_cap }
  });
  expect(decision.operation.callSessions).toHaveLength(1);
  await expect(mandatesRepository.list()).resolves.toEqual([
    expect.objectContaining(mandate)
  ]);
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
