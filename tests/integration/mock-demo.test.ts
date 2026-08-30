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
  it("persists a complete dashboard mandate without changing the operation state", async () => {
    const app = createApp();
    const before = await getOperation(app);
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
      id: expect.any(String),
      ...mandate,
      created_at: expect.any(String),
      updated_at: expect.any(String)
    });

    await expect(getOperation(app)).resolves.toEqual(before);
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

  it("validates copilot questions before attempting a model request", async () => {
    const app = createApp();

    const response = await request(app, "/api/copilot", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ question: " " })
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "invalid_copilot_question"
    });
  });

  it("creates a HITL quote round, then books only after the API records a selection", async () => {
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
    const events = readUntilEvent(eventsResponse, "approval.requested");

    await expect(
      request(app, "/api/demo/run", { method: "POST" })
    ).resolves.toMatchObject({ status: 202 });
    const eventOutput = await events;
    const quoteRound = await getOperation(app);

    expect(eventOutput).toContain("event: quote.registered");
    expect(eventOutput).toContain('data: {"type":"quote.registered"');
    expect(eventOutput).toContain("event: approval.requested");
    expect(quoteRound.status).toBe("awaiting_approval");
    expect(quoteRound.quotes).toHaveLength(3);
    expect(quoteRound.quotes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ priceMxn: 8750 }),
        expect.objectContaining({ priceMxn: 8500 }),
        expect.objectContaining({ priceMxn: 8640 })
      ])
    );
    expect(quoteRound.commitment).toBeUndefined();
    expect(quoteRound.approvals).toMatchObject([
      {
        type: "carrier_selection",
        status: "pending",
        recommendedQuoteId: "quote-ruta-occidente-001"
      }
    ]);

    const approvalId = quoteRound.approvals[0].id;
    const approvalQueue = await request(app, "/api/approvals");
    expect(approvalQueue.status).toBe(200);
    await expect(approvalQueue.json()).resolves.toMatchObject([
      { id: approvalId, status: "pending" }
    ]);
    const approvalDetail = await request(app, `/api/approvals/${approvalId}`);
    expect(approvalDetail.status).toBe(200);
    await expect(approvalDetail.json()).resolves.toMatchObject({
      approval: { id: approvalId, status: "pending" },
      operation: { id: quoteRound.id }
    });
    const decision = await request(
      app,
      `/api/approvals/${approvalId}/decision`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "approve",
          selectedQuoteId: "quote-ruta-occidente-001",
          decidedBy: "Bryan Riano"
        })
      }
    );
    expect(decision.status).toBe(200);
    const authorized = await getOperation(app);
    expect(authorized.commitment).toBeUndefined();
    expect(authorized.closingAuthorization).toMatchObject({
      carrierId: "carrier-ruta-occidente",
      finalPriceMxn: 8500
    });

    const undo = await request(app, `/api/approvals/${approvalId}/undo`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ undoneBy: "Bryan Riano" })
    });
    expect(undo.status).toBe(200);
    const reopened = await getOperation(app);
    expect(reopened).toMatchObject({ status: "awaiting_approval" });
    expect(reopened.closingAuthorization).toBeUndefined();
    expect(reopened.approvals[0]).toMatchObject({ status: "pending" });
    expect(reopened.approvals[0].decisionHistory).toMatchObject([
      { action: "approve", undoneBy: "Bryan Riano" }
    ]);

    const reapproval = await request(
      app,
      `/api/approvals/${approvalId}/decision`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "approve",
          selectedQuoteId: "quote-ruta-occidente-001",
          decidedBy: "Bryan Riano"
        })
      }
    );
    expect(reapproval.status).toBe(200);
    const closeCall = await request(app, "/api/demo/close-approved-deal", {
      method: "POST"
    });
    expect(closeCall.status).toBe(202);
    const committed = await getOperation(app);
    expect(committed.commitment).toMatchObject({
      carrierId: "carrier-ruta-occidente",
      finalPriceMxn: 8500,
      recapStatus: "sent"
    });
    expect(committed.approvals[0]).toMatchObject({
      status: "approved",
      selectedQuoteId: "quote-ruta-occidente-001",
      decidedBy: "Bryan Riano"
    });

    await request(app, "/api/demo/run", { method: "POST" });
    const resetRound = await getOperation(app);
    expect(resetRound).toMatchObject({
      status: "awaiting_approval",
      quotes: quoteRound.quotes
    });
    expect(resetRound.commitment).toBeUndefined();
  });

  it("answers across shipment events and transcripts with navigable evidence", async () => {
    const app = createApp();
    await request(app, "/api/demo/run", { method: "POST" });
    const conversationResponse = await request(
      app,
      "/api/agent/conversations",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "Seguimiento y negociación" })
      }
    );
    expect(conversationResponse.status).toBe(201);
    const conversation = (await conversationResponse.json()) as { id: string };

    const locationResponse = await request(
      app,
      `/api/agent/conversations/${conversation.id}/messages`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ question: "¿En qué parte está el envío?" })
      }
    );
    const locationMessage = finalAgentMessage(await locationResponse.text());
    expect(locationMessage.citations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sourceType: "shipment_event",
          excerpt: expect.stringContaining("Manzanillo")
        })
      ])
    );

    const transcriptResponse = await request(
      app,
      `/api/agent/conversations/${conversation.id}/messages`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ question: "¿Qué dijeron en las negociaciones?" })
      }
    );
    const transcriptMessage = finalAgentMessage(
      await transcriptResponse.text()
    );
    expect(transcriptMessage.citations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sourceType: "transcript" }),
        expect.objectContaining({ sourceType: "quote" })
      ])
    );
    expect(transcriptMessage.citations[0].href).toMatch(/^\/api\/evidence\//);
  });

  it("isolates conversations by organization and executes an action only after approval", async () => {
    const app = createApp();
    await request(app, "/api/demo/run", { method: "POST" });
    const operation = await getOperation(app);
    const approvalId = operation.approvals[0].id;
    await request(app, `/api/approvals/${approvalId}/decision`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        action: "approve",
        selectedQuoteId: "quote-ruta-occidente-001",
        decidedBy: "Bryan Riano"
      })
    });
    const createResponse = await request(app, "/api/agent/conversations", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-volta-org-id": "organization-a",
        "x-volta-user-id": "dispatcher-a"
      },
      body: JSON.stringify({})
    });
    const conversation = (await createResponse.json()) as { id: string };
    const otherOrganization = await request(
      app,
      `/api/agent/conversations/${conversation.id}`,
      {
        headers: {
          "x-volta-org-id": "organization-b",
          "x-volta-user-id": "dispatcher-b"
        }
      }
    );
    expect(otherOrganization.status).toBe(404);

    const askResponse = await request(
      app,
      `/api/agent/conversations/${conversation.id}/messages`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-volta-org-id": "organization-a",
          "x-volta-user-id": "dispatcher-a"
        },
        body: JSON.stringify({ question: "Ejecuta la llamada de cierre" })
      }
    );
    const message = finalAgentMessage(await askResponse.text());
    expect(message.proposedActions).toMatchObject([
      { type: "close_approved_deal", status: "pending" }
    ]);
    expect((await getOperation(app)).commitment).toBeUndefined();

    const actionResponse = await request(
      app,
      `/api/agent/actions/${message.proposedActions[0].id}/decision`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-volta-org-id": "organization-a",
          "x-volta-user-id": "dispatcher-a"
        },
        body: JSON.stringify({ decision: "approve" })
      }
    );
    expect(actionResponse.status).toBe(200);
    await expect(actionResponse.json()).resolves.toMatchObject({
      action: { status: "executed", decidedBy: "dispatcher-a" },
      operation: { commitment: { finalPriceMxn: 8500 } }
    });
  });
});

function finalAgentMessage(stream: string) {
  const finalEvent = stream
    .split("\n\n")
    .find((event) => event.startsWith("event: final\n"));
  if (!finalEvent) throw new Error(`Final agent event missing: ${stream}`);
  const data = finalEvent
    .split("\n")
    .find((line) => line.startsWith("data: "))
    ?.slice(6);
  if (!data) throw new Error("Final agent data missing");
  return JSON.parse(data) as {
    citations: Array<{ sourceType: string; excerpt: string; href: string }>;
    proposedActions: Array<{ id: string; type: string; status: string }>;
  };
}

async function getOperation(
  app: ReturnType<typeof createApp>
): Promise<Operation> {
  const response = await request(app, "/api/operation");
  expect(response.status).toBe(200);
  return response.json() as Promise<Operation>;
}

async function readUntilEvent(
  response: Response,
  eventName: string
): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("SSE response body was unavailable");

  const decoder = new TextDecoder();
  let output = "";
  while (!output.includes(`event: ${eventName}`)) {
    const { done, value } = await reader.read();
    if (done)
      throw new Error(`SSE stream closed before the ${eventName} event`);
    output += decoder.decode(value, { stream: true });
  }
  await reader.cancel();
  return output;
}
