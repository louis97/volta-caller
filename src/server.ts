import express, { type Request, type Response } from "express";
import type { OperationEvent } from "@volta/contracts";
import { z } from "zod";

import { env } from "./config/env";
import {
  ConfirmationCoordinatorError,
  createConfirmationCoordinator,
  type ConfirmationCoordinator
} from "./core/confirmation";
import { createOperationFromMandate } from "./core/seed";
import type { OperationStore } from "./core/state";
import { createMockScenario, type MockScenario } from "./mocks/callScenario";
import { createMockTelephonyGateway } from "./mocks/telephony";
import type { TelephonyGateway } from "./telephony/twilio";

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

const selectQuoteRequestSchema = z.object({
  quoteId: z.string().trim().min(1)
});

export type CreateAppDependencies = {
  scenario?: MockScenario;
  store?: OperationStore;
  telephony?: TelephonyGateway;
  confirmationCoordinator?: ConfirmationCoordinator;
  now?: () => string;
};

function writeEvent(response: Response, event: OperationEvent): void {
  response.write(`event: ${event.type}\n`);
  response.write(`data: ${JSON.stringify(event)}\n\n`);
}

export function createApp({
  scenario: injectedScenario,
  store: injectedStore,
  telephony = createMockTelephonyGateway(),
  confirmationCoordinator: injectedConfirmationCoordinator,
  now
}: CreateAppDependencies = {}) {
  const app = express();
  let scenario = injectedScenario ?? createMockScenario();
  const getStore = () => injectedStore ?? scenario.store;
  let confirmationCoordinator =
    injectedConfirmationCoordinator ??
    createConfirmationCoordinator({ store: getStore(), telephony, now });
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
    response.status(200).json(getStore().getOperation());
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
    getStore().replaceOperation(operation);
    response.status(201).json(getStore().getOperation());
  });

  app.post("/operations/:id/select-quote", async (request, response) => {
    const parsed = selectQuoteRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      response.status(400).json({ error: "invalid_selection" });
      return;
    }

    try {
      await confirmationCoordinator.start(
        request.params.id,
        parsed.data.quoteId
      );
      response.status(202).json(getStore().getOperation());
    } catch (error) {
      if (error instanceof ConfirmationCoordinatorError) {
        response
          .status(error.code === "operation_not_found" ? 404 : 502)
          .json({ error: error.code });
        return;
      }
      const code =
        error instanceof Error ? error.message : "selection_not_allowed";
      response.status(409).json({ error: code });
    }
  });

  app.post("/api/demo/run", async (_request, response) => {
    if (env.VOLTA_MODE !== "mock") {
      response.status(409).json({ error: "demo_requires_mock_mode" });
      return;
    }

    scenario = createMockScenario(publish);
    if (!injectedStore && !injectedConfirmationCoordinator) {
      confirmationCoordinator = createConfirmationCoordinator({
        store: scenario.store,
        telephony,
        now
      });
    }
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
