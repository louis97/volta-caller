import { once } from "node:events";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

import express from "express";
import { afterEach, expect, it } from "vitest";

import { seedOperation } from "../../src/core/seed";
import { createOperationStore, type OperationStore } from "../../src/core/state";
import { mountTelephonyRoutes } from "../../src/telephony/routes";

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(async (server) => {
      server.close();
      await once(server, "close");
    })
  );
});

/**
 * A call as a negotiation round leaves it: the session is opened under a
 * generated id and the Twilio sid is stamped on afterwards, so the two never
 * match. The console only ever has the sid to send back.
 */
function liveRoundCall(store: OperationStore): void {
  store.openCallSession({
    id: "call-9d2f",
    operationId: store.getOperation().id,
    carrierId: "carrier-001",
    driverName: "Fletes del Norte",
    direction: "outbound",
    status: "pending",
    startedAt: "2026-08-30T10:00:00.000Z"
  });
  store.updateCallSession("call-9d2f", {
    callSid: "CA0001",
    status: "in_progress"
  });
}

async function post(store: OperationStore, path: string): Promise<Response> {
  const app = express();
  mountTelephonyRoutes(app, { store });

  const server = app.listen(0);
  servers.push(server);
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;

  return fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ reason: "operator_requested" })
  });
}

function supervisionOf(store: OperationStore) {
  return store
    .getOperation()
    .callSessions.find((session) => session.id === "call-9d2f")?.supervision;
}

it("takes over a live call addressed by its Twilio sid", async () => {
  const store = createOperationStore(seedOperation());
  liveRoundCall(store);

  const response = await post(store, "/api/calls/CA0001/takeover");

  // Mock mode has no phone to ring, but reaching the dial at all is the proof
  // that matters: a session the route cannot resolve never gets that far, and
  // the 404 it used to return was swallowed by the console.
  expect(response.status).toBe(502);
  await expect(response.json()).resolves.toMatchObject({
    error: "supervisor_unreachable"
  });
  // And the board is told, rather than being left claiming a person is joining.
  expect(supervisionOf(store)).toMatchObject({
    state: "agent",
    reason: "supervisor_unreachable"
  });
});

it("refuses a call it does not have", async () => {
  const store = createOperationStore(seedOperation());
  liveRoundCall(store);

  const response = await post(store, "/api/calls/CA-not-ours/takeover");

  expect(response.status).toBe(404);
  await expect(response.json()).resolves.toMatchObject({
    error: "call_session_not_found"
  });
});

it("hands the conversation back to Volta by Twilio sid", async () => {
  const store = createOperationStore(seedOperation());
  liveRoundCall(store);

  const response = await post(store, "/api/calls/CA0001/handback");

  expect(response.status).toBe(200);
  expect(supervisionOf(store)).toMatchObject({ state: "returned_to_agent" });
});

it("moves the floor to a person by Twilio sid", async () => {
  const store = createOperationStore(seedOperation());
  liveRoundCall(store);

  const response = await post(store, "/api/calls/CA0001/connect");

  expect(response.status).toBe(200);
  expect(supervisionOf(store)).toMatchObject({ state: "human" });
});
