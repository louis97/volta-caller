import { createHmac } from "node:crypto";
import { once } from "node:events";
import type { AddressInfo } from "node:net";

import { afterEach, expect, it, vi } from "vitest";

import {
  DeterministicAgentAnswerer,
  type AnswerRequest,
  type AgentAnswerer,
  type GroundedAnswer
} from "../../src/agent/operationalAgent";
import { MemoryAgentRepository } from "../../src/agent/repository";
import { createMemoryMandatesRepository } from "../../src/core/mandates/memory-repository";
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

it("answers a signed inbound Kapso WhatsApp text with the operational agent", async () => {
  const sendText = vi.fn().mockResolvedValue(undefined);
  const app = createApp({
    repository: new MemoryAgentRepository(),
    answerer: new DeterministicAgentAnswerer(),
    kapsoMessenger: { sendText },
    kapsoWebhookSecret: "kapso-test-secret"
  });
  const payload = JSON.stringify({
    message: {
      id: "wamid.test-1",
      type: "text",
      from: "+573001112233",
      text: { body: "¿Qué necesita atención?" },
      kapso: { direction: "inbound" }
    }
  });
  const signature = createHmac("sha256", "kapso-test-secret")
    .update(payload)
    .digest("hex");

  const response = await request(app, "/webhooks/kapso/whatsapp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-idempotency-key": "event-1",
      "x-webhook-event": "whatsapp.message.received",
      "x-webhook-signature": signature
    },
    body: payload
  });

  expect(response.status).toBe(200);
  expect(sendText).toHaveBeenCalledWith({
    to: "+573001112233",
    text: expect.any(String)
  });
});

it("sends a Kapso voice-note transcript to the operational agent", async () => {
  const sendText = vi.fn().mockResolvedValue(undefined);
  const app = createApp({
    repository: new MemoryAgentRepository(),
    answerer: new DeterministicAgentAnswerer(),
    kapsoMessenger: { sendText },
    kapsoWebhookSecret: "kapso-test-secret"
  });
  const payload = JSON.stringify({
    message: {
      id: "wamid.audio-1",
      type: "audio",
      from: "+573001112233",
      kapso: {
        direction: "inbound",
        transcript: { text: "¿Qué necesita atención?" }
      }
    }
  });
  const signature = createHmac("sha256", "kapso-test-secret")
    .update(payload)
    .digest("hex");

  const response = await request(app, "/webhooks/kapso/whatsapp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-idempotency-key": "audio-event-1",
      "x-webhook-event": "whatsapp.message.received",
      "x-webhook-signature": signature
    },
    body: payload
  });

  expect(response.status).toBe(200);
  expect(sendText).toHaveBeenCalledWith({
    to: "+573001112233",
    text: expect.any(String)
  });
});

it("approves a mandate from the same WhatsApp thread without calling the model again", async () => {
  const sendText = vi.fn().mockResolvedValue(undefined);
  const answerer: AgentAnswerer = {
    answer: vi.fn(async (request: AnswerRequest) => {
      const createTool = request.tools.find(
        (tool) => tool.name === "propose_create_mandate"
      );
      if (!createTool) throw new Error("missing_create_mandate_tool");
      const proposal = await createTool.execute({
        budget_cap: 40000000,
        destination_datetime: "2026-09-01T17:00:00-05:00",
        destination_place: "Calle 87B #6-10, Medellín",
        type_of_content: "Carga general no frágil",
        weight: 20000,
        measures: "Contenedor de 20 pies",
        pickup_address: "Sociedad Portuaria de Santa Marta",
        pickup_datetime: "2026-08-31T08:00:00-05:00"
      });
      return {
        answer: "El mandato está listo y requiere tu aprobación.",
        citationIds: [],
        evidence: [],
        proposedActions: proposal.proposedAction
          ? [proposal.proposedAction]
          : []
      };
    })
  };
  const app = createApp({
    repository: new MemoryAgentRepository(),
    mandatesRepository: createMemoryMandatesRepository(),
    answerer,
    kapsoMessenger: { sendText },
    kapsoWebhookSecret: "kapso-test-secret"
  });

  const proposal = await signedWhatsAppRequest(app, {
    id: "wamid.mandate-proposal",
    from: "+573001112233",
    type: "text",
    content: "Crea el mandato con los datos completos"
  });
  expect(proposal.status).toBe(200);
  expect(sendText).toHaveBeenLastCalledWith({
    to: "+573001112233",
    text: expect.stringContaining("*APROBAR*")
  });
  const proposalReply = sendText.mock.calls.at(-1)?.[0]?.text as string;
  const actionCode = proposalReply.match(/Código: ([a-f0-9]{8})/)?.[1];
  if (!actionCode) throw new Error("missing_whatsapp_action_code");

  const unauthorized = await signedWhatsAppRequest(app, {
    id: "wamid.mandate-unauthorized",
    from: "+573009998888",
    type: "text",
    content: `APROBAR ${actionCode}`
  });
  expect(unauthorized.status).toBe(200);
  expect(sendText).toHaveBeenLastCalledWith({
    to: "+573009998888",
    text: expect.stringContaining("No encontré una acción pendiente")
  });
  expect(answerer.answer).toHaveBeenCalledTimes(1);

  const approval = await signedWhatsAppRequest(app, {
    id: "wamid.mandate-approval",
    from: "+573001112233",
    type: "audio",
    content: "Apruebo"
  });
  expect(approval.status).toBe(200);
  expect(sendText).toHaveBeenLastCalledWith({
    to: "+573001112233",
    text: expect.stringContaining("Mandato aprobado y creado")
  });
  expect(answerer.answer).toHaveBeenCalledTimes(1);

  const operationResponse = await request(app, "/api/operation");
  await expect(operationResponse.json()).resolves.toMatchObject({
    mandate: {
      budgetCapMxn: 40000000,
      pickupAddress: "Sociedad Portuaria de Santa Marta",
      destinationPlace: "Calle 87B #6-10, Medellín"
    }
  });
});

it("allows Kapso to retry an event when sending the reply fails", async () => {
  const sendText = vi
    .fn()
    .mockRejectedValueOnce(new Error("kapso unavailable"))
    .mockResolvedValueOnce(undefined);
  const app = createApp({
    repository: new MemoryAgentRepository(),
    answerer: new DeterministicAgentAnswerer(),
    kapsoMessenger: { sendText },
    kapsoWebhookSecret: "kapso-test-secret"
  });
  const payload = JSON.stringify({
    message: {
      id: "wamid.retry-1",
      type: "text",
      from: "+573001112233",
      text: { body: "Hola" },
      kapso: { direction: "inbound" }
    }
  });
  const signature = createHmac("sha256", "kapso-test-secret")
    .update(payload)
    .digest("hex");
  const headers = {
    "content-type": "application/json",
    "x-idempotency-key": "retry-event-1",
    "x-webhook-event": "whatsapp.message.received",
    "x-webhook-signature": signature
  };

  const first = await request(app, "/webhooks/kapso/whatsapp", {
    method: "POST",
    headers,
    body: payload
  });
  const second = await request(app, "/webhooks/kapso/whatsapp", {
    method: "POST",
    headers,
    body: payload
  });

  expect(first.status).toBe(500);
  expect(second.status).toBe(200);
  expect(sendText).toHaveBeenCalledTimes(2);
});

it("rejects a concurrent retry until the original message is completed", async () => {
  const sendText = vi.fn().mockResolvedValue(undefined);
  let releaseAnswer: (() => void) | undefined;
  const answerer: AgentAnswerer = {
    answer: vi.fn(
      () =>
        new Promise<GroundedAnswer>((resolve) => {
          releaseAnswer = () =>
            resolve({
              answer: "Respuesta única",
              citationIds: [],
              evidence: [],
              proposedActions: []
            });
        })
    )
  };
  const app = createApp({
    repository: new MemoryAgentRepository(),
    answerer,
    kapsoMessenger: { sendText },
    kapsoWebhookSecret: "kapso-test-secret"
  });
  const payload = JSON.stringify({
    message: {
      id: "wamid.concurrent-1",
      type: "text",
      from: "+573001112233",
      text: { body: "Hola" },
      kapso: { direction: "inbound" }
    }
  });
  const signature = createHmac("sha256", "kapso-test-secret")
    .update(payload)
    .digest("hex");
  const headers = {
    "content-type": "application/json",
    "x-idempotency-key": "concurrent-event-1",
    "x-webhook-event": "whatsapp.message.received",
    "x-webhook-signature": signature
  };

  const original = request(app, "/webhooks/kapso/whatsapp", {
    method: "POST",
    headers,
    body: payload
  });
  await vi.waitFor(() => expect(answerer.answer).toHaveBeenCalledTimes(1));

  const concurrentRetry = await request(app, "/webhooks/kapso/whatsapp", {
    method: "POST",
    headers,
    body: payload
  });
  expect(concurrentRetry.status).toBe(503);
  expect(sendText).not.toHaveBeenCalled();

  releaseAnswer?.();
  expect((await original).status).toBe(200);

  const completedRetry = await request(app, "/webhooks/kapso/whatsapp", {
    method: "POST",
    headers,
    body: payload
  });
  expect(completedRetry.status).toBe(200);
  expect(await completedRetry.json()).toMatchObject({
    processed: 0,
    duplicates: 1
  });
  expect(answerer.answer).toHaveBeenCalledTimes(1);
  expect(sendText).toHaveBeenCalledTimes(1);
});

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

async function signedWhatsAppRequest(
  app: ReturnType<typeof createApp>,
  input: {
    id: string;
    from: string;
    type: "audio" | "text";
    content: string;
  }
) {
  const message =
    input.type === "audio"
      ? {
          id: input.id,
          type: input.type,
          from: input.from,
          kapso: {
            direction: "inbound",
            transcript: { text: input.content }
          }
        }
      : {
          id: input.id,
          type: input.type,
          from: input.from,
          text: { body: input.content },
          kapso: { direction: "inbound" }
        };
  const payload = JSON.stringify({ message });
  const signature = createHmac("sha256", "kapso-test-secret")
    .update(payload)
    .digest("hex");
  return request(app, "/webhooks/kapso/whatsapp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-idempotency-key": input.id,
      "x-webhook-event": "whatsapp.message.received",
      "x-webhook-signature": signature
    },
    body: payload
  });
}
