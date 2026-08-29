import { createServer } from "node:http";

import express, { type Request, type Response } from "express";
import type { OperationEvent } from "@volta/contracts";

import { env } from "./config/env";
import { createMockScenario } from "./mocks/callScenario";
import {
  attachTelephonyWebSockets,
  mountTelephonyRoutes
} from "./telephony/routes";

function writeEvent(response: Response, event: OperationEvent): void {
  response.write(`event: ${event.type}\n`);
  response.write(`data: ${JSON.stringify(event)}\n\n`);
}

export function createApp() {
  const app = express();
  let scenario = createMockScenario();
  const eventClients = new Set<Response>();

  const publish = (event: OperationEvent) => {
    for (const client of eventClients) writeEvent(client, event);
  };

  app.get("/health", (_request, response) => {
    response.status(200).json({ status: "ok", mode: env.VOLTA_MODE });
  });

  app.get("/api/operation", (_request, response) => {
    response.status(200).json(scenario.store.getOperation());
  });

  app.post("/api/demo/run", async (_request, response) => {
    if (env.VOLTA_MODE !== "mock") {
      response.status(409).json({ error: "demo_requires_mock_mode" });
      return;
    }

    scenario = createMockScenario(publish);
    await scenario.run();
    response.sendStatus(202);
  });

  app.get("/api/events", (request: Request, response: Response) => {
    response.status(200).set({
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "Content-Type": "text/event-stream"
    });
    response.flushHeaders();
    eventClients.add(response);
    request.on("close", () => eventClients.delete(response));
  });

  mountTelephonyRoutes(app);

  return app;
}

// tsx reports argv[1] as an absolute path, which uses backslashes on Windows;
// comparing against a POSIX suffix there never matches and the API silently
// never listens.
const entrypoint = process.argv[1]?.replaceAll("\\", "/");

if (entrypoint?.endsWith("src/server.ts")) {
  // The media relay needs the raw HTTP server to handle WebSocket upgrades,
  // which `app.listen()` does not expose.
  const server = createServer(createApp());
  attachTelephonyWebSockets(server);
  server.listen(env.PORT, () => {
    console.log(`Volta API listening on port ${env.PORT} (${env.VOLTA_MODE})`);
  });
}
