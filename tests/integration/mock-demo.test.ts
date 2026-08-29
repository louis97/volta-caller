import { once } from "node:events";
import type { AddressInfo } from "node:net";

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
  it("runs three quotes, selects the best approved carrier, and exposes its audit record", async () => {
    const app = createApp();

    await expect(request(app, "/api/demo/run", { method: "POST" })).resolves.toMatchObject({
      status: 202
    });
    const operation = await request(app, "/api/operation");

    expect(operation.status).toBe(200);
    await expect(operation.json()).resolves.toMatchObject({
      quotes: expect.arrayContaining([
        expect.objectContaining({ priceMxn: 8500 }),
        expect.objectContaining({ priceMxn: 9200 })
      ]),
      commitment: expect.objectContaining({
        finalPriceMxn: 8500,
        recapStatus: "sent"
      })
    });
  });
});
