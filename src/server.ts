import express, { type Request, type Response } from "express";
import type { OperationEvent } from "@volta/contracts";
import { z } from "zod";

import { env } from "./config/env";
import { createOperationFromMandate } from "./core/seed";
import { createMockScenario } from "./mocks/callScenario";

const createMandateRequestSchema = z.object({
  budget_cap: z.number().finite().nonnegative(),
  destination_datetime: z.string().datetime({ offset: true }),
  destination_place: z.string().trim().min(1).max(240),
  type_of_content: z.string().trim().min(1).max(120),
  weight: z.number().finite().positive(),
  measures: z.string().trim().min(1).max(120),
  pickup_address: z.string().trim().min(1).max(240),
  pickup_datetime: z.string().datetime({ offset: true })
});

function writeEvent(response: Response, event: OperationEvent): void {
  response.write(`event: ${event.type}\n`);
  response.write(`data: ${JSON.stringify(event)}\n\n`);
}

export function createApp() {
  const app = express();
  let scenario = createMockScenario();
  let mandateSequence = 1;
  const eventClients = new Set<Response>();

  app.use(express.json());

  const publish = (event: OperationEvent) => {
    for (const client of eventClients) writeEvent(client, event);
  };

  app.get("/health", (_request, response) => {
    response.status(200).json({ status: "ok", mode: env.VOLTA_MODE });
  });

  app.get("/api/operation", (_request, response) => {
    response.status(200).json(scenario.store.getOperation());
  });

  app.post("/api/mandates", (request, response) => {
    const parsed = createMandateRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      response.status(400).json({
        error: "invalid_mandate",
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message
        }))
      });
      return;
    }

    const operation = createOperationFromMandate(
      parsed.data,
      `operation-mandate-${mandateSequence++}`
    );
    scenario.store.replaceOperation(operation);
    response.status(201).json(scenario.store.getOperation());
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

  return app;
}

if (process.argv[1]?.endsWith("src/server.ts")) {
  createApp().listen(env.PORT, () => {
    console.log(`Volta API listening on port ${env.PORT}`);
  });
}
