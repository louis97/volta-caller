import express, { type Request, type Response } from "express";
import type { OperationEvent } from "@volta/contracts";
import OpenAI from "openai";
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

const approvalDecisionSchema = z.object({
  action: z.enum(["approve", "decline"]),
  selectedQuoteId: z.string().trim().min(1).optional(),
  decidedBy: z.string().trim().min(1).max(120)
});

const approvalUndoSchema = z.object({
  undoneBy: z.string().trim().min(1).max(120)
});

const copilotRequestSchema = z.object({
  question: z.string().trim().min(1).max(2000),
  history: z
    .array(
      z.object({
        role: z.enum(["assistant", "user"]),
        content: z.string().trim().min(1).max(4000)
      })
    )
    .max(8)
    .default([])
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

  app.get("/api/approvals", (_request, response) => {
    const operation = scenario.store.getOperation();
    response
      .status(200)
      .json(
        operation.approvals.filter((approval) => approval.status === "pending")
      );
  });

  app.get("/api/approvals/:approvalId", (request, response) => {
    const approval = scenario.store.getApproval(request.params.approvalId);
    if (!approval) {
      response.status(404).json({ error: "approval_not_found" });
      return;
    }
    response.status(200).json({
      approval,
      operation: scenario.store.getOperation()
    });
  });

  app.post("/api/approvals/:approvalId/decision", (request, response) => {
    const parsed = approvalDecisionSchema.safeParse(request.body);
    if (!parsed.success) {
      response.status(400).json({
        error: "invalid_approval_decision",
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message
        }))
      });
      return;
    }

    try {
      const approval = scenario.store.resolveApproval({
        approvalId: request.params.approvalId,
        ...parsed.data,
        decidedAt: new Date().toISOString()
      });
      response.status(200).json({
        approval,
        operation: scenario.store.getOperation()
      });
    } catch (error) {
      const reason =
        error instanceof Error ? error.message : "approval_invalid";
      const status = reason === "approval_not_found" ? 404 : 409;
      response.status(status).json({ error: reason });
    }
  });

  app.post("/api/approvals/:approvalId/undo", (request, response) => {
    const parsed = approvalUndoSchema.safeParse(request.body);
    if (!parsed.success) {
      response.status(400).json({ error: "invalid_approval_undo" });
      return;
    }

    try {
      const approval = scenario.store.undoApproval({
        approvalId: request.params.approvalId,
        ...parsed.data,
        undoneAt: new Date().toISOString()
      });
      response.status(200).json({
        approval,
        operation: scenario.store.getOperation()
      });
    } catch (error) {
      const reason =
        error instanceof Error ? error.message : "approval_undo_invalid";
      const status = reason === "approval_not_found" ? 404 : 409;
      response.status(status).json({ error: reason });
    }
  });

  app.post("/api/demo/close-approved-deal", async (_request, response) => {
    if (env.VOLTA_MODE !== "mock") {
      response.status(409).json({ error: "demo_requires_mock_mode" });
      return;
    }
    const committed = await scenario.closeApprovedDeal();
    if (!committed) {
      response.status(409).json({ error: "closing_authorization_required" });
      return;
    }
    response.status(202).json(scenario.store.getOperation());
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

  app.post("/api/copilot", async (request, response) => {
    const parsed = copilotRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      response.status(400).json({ error: "invalid_copilot_question" });
      return;
    }

    if (!env.OPENAI_API_KEY) {
      response.status(503).json({
        error: "copilot_unavailable",
        message:
          "Volta Copilot needs OPENAI_API_KEY before it can answer process questions."
      });
      return;
    }

    try {
      const client = new OpenAI({ apiKey: env.OPENAI_API_KEY });
      const completion = await client.responses.create({
        model: env.VOLTA_COPILOT_MODEL,
        instructions: buildCopilotInstructions(scenario.store.getOperation()),
        input: buildCopilotInput(parsed.data.question, parsed.data.history)
      });
      const answer = completion.output_text.trim();

      response.status(200).json({
        answer:
          answer ||
          "I could not produce a grounded answer from the current operation."
      });
    } catch (error) {
      console.error("Volta Copilot request failed", error);
      response.status(502).json({
        error: "copilot_request_failed",
        message: "Volta Copilot could not answer right now. Try again shortly."
      });
    }
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

function buildCopilotInstructions(operation: unknown): string {
  return [
    "You are Volta Copilot, the dispatcher's operational assistant.",
    "Answer in the language used by the dispatcher.",
    "Use only the authoritative operation snapshot supplied below. If a fact is absent, say so plainly.",
    "Never claim that you changed a mandate, called a carrier, approved an exception, or sent a message.",
    "Treat the mandate as binding and explicitly flag any price or pickup-time conflict.",
    "Keep answers concise, concrete, and useful to an operations dispatcher.",
    "AUTHORITATIVE OPERATION SNAPSHOT:",
    JSON.stringify(operation)
  ].join("\n\n");
}

function buildCopilotInput(
  question: string,
  history: Array<{ role: "assistant" | "user"; content: string }>
): string {
  const transcript = history.map((turn) => {
    const speaker = turn.role === "assistant" ? "Volta Copilot" : "Dispatcher";
    return speaker + ": " + turn.content;
  });

  return [...transcript, "Dispatcher: " + question].join("\n");
}

if (process.argv[1]?.endsWith("src/server.ts")) {
  createApp().listen(env.PORT, () => {
    console.log(`Volta API listening on port ${env.PORT}`);
  });
}
