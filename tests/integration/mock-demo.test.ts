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

async function request(app: ReturnType<typeof createApp>, path: string, init?: RequestInit) {
  const server = app.listen(0);
  servers.push(server);
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;

  return fetch(`http://127.0.0.1:${port}${path}`, init);
}

describe("mock demo API", () => {
  it("replaces each demo run with deterministic carrier outcomes and audit state", async () => {
    const app = createApp();

    const health = await request(app, "/health");
    expect(health.status).toBe(200);
    await expect(health.json()).resolves.toEqual({ status: "ok", mode: "mock" });

    const eventsResponse = await request(app, "/api/events");
    expect(eventsResponse.headers.get("content-type")).toContain("text/event-stream");
    const events = readUntilCommitment(eventsResponse);

    await expect(request(app, "/api/demo/run", { method: "POST" })).resolves.toMatchObject({ status: 202 });
    const firstOperation = await getOperation(app);
    const eventOutput = await events;

    expect(eventOutput).toContain("event: quote.registered");
    expect(eventOutput).toContain('data: {"type":"quote.registered"');
    expect(eventOutput).toContain("event: escalation.requested");
    expect(eventOutput).toContain("event: commitment.finalized");
    expect(firstOperation.quotes).toHaveLength(2);
    expect(firstOperation.quotes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ priceMxn: 8500 }),
        expect.objectContaining({ priceMxn: 9200 })
      ])
    );
    expect(firstOperation.callBriefs).toEqual(
      expect.arrayContaining([expect.objectContaining({ outcome: "unavailable" })])
    );
    expect(firstOperation.escalations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ attemptedPriceMxn: 9200, reason: "price_cap_exceeded" })
      ])
    );
    expect(firstOperation.commitment).toMatchObject({ finalPriceMxn: 8500, recapStatus: "sent" });

    await request(app, "/api/demo/run", { method: "POST" });
    await expect(getOperation(app)).resolves.toEqual(firstOperation);
  });
});

async function getOperation(app: ReturnType<typeof createApp>): Promise<Operation> {
  const response = await request(app, "/api/operation");
  expect(response.status).toBe(200);
  return response.json() as Promise<Operation>;
}

async function readUntilCommitment(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("SSE response body was unavailable");

  const decoder = new TextDecoder();
  let output = "";
  while (!output.includes("event: commitment.finalized")) {
    const { done, value } = await reader.read();
    if (done) throw new Error("SSE stream closed before the commitment event");
    output += decoder.decode(value, { stream: true });
  }
  await reader.cancel();
  return output;
}
