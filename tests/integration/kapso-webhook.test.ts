import { createHmac } from "node:crypto";
import { once } from "node:events";
import type { AddressInfo } from "node:net";

import { afterEach, expect, it, vi } from "vitest";

import { DeterministicAgentAnswerer } from "../../src/agent/operationalAgent";
import { MemoryAgentRepository } from "../../src/agent/repository";
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
