import express, { type Request, type Response } from "express";
import type { OperationEvent } from "@volta/contracts";
import { pathToFileURL } from "node:url";
import OpenAI from "openai";
import { z } from "zod";

import { env } from "./config/env";
import {
  createMandate,
  getMandate,
  InvalidMandateError,
  listMandates
} from "./core/mandates/service";
import { createMemoryMandatesRepository } from "./core/mandates/memory-repository";
import { createSupabaseMandatesRepositoryFromConfig } from "./core/mandates/supabase-repository";
import type { MandatesRepository } from "./core/mandates/types";
import { createMockScenario } from "./mocks/callScenario";

const approvalDecisionSchema = z.object({
  action: z.enum(["approve", "decline"]),
  selectedQuoteId: z.string().trim().min(1).optional(),
  decidedBy: z.string().trim().min(1).max(120)
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

export function createApp({
  mandatesRepository = createDefaultMandatesRepository()
}: { mandatesRepository?: MandatesRepository } = {}) {
  const app = express();
  let scenario = createMockScenario();
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

  app.post("/api/approvals/:approvalId/decision", async (request, response) => {
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
      if (approval.status === "approved" && env.VOLTA_MODE === "mock") {
        await scenario.closeApprovedDeal();
      }
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

  app.post("/api/mandates", async (request, response) => {
    try {
      response.status(201).json(await createMandate(mandatesRepository, request.body));
    } catch (error) {
      if (error instanceof InvalidMandateError) {
        response.status(400).json({ error: error.code });
        return;
      }
      console.error("Mandate creation failed", error);
      response.status(500).json({ error: "mandate_persistence_failed" });
    }
  });

  app.get("/api/mandates", async (_request, response) => {
    try {
      response.status(200).json(await listMandates(mandatesRepository));
    } catch (error) {
      console.error("Mandate listing failed", error);
      response.status(500).json({ error: "mandate_persistence_failed" });
    }
  });

  app.get("/api/mandates/:id", async (request, response) => {
    try {
      const id = request.params.id;
      if (typeof id !== "string") {
        response.status(404).json({ error: "mandate_not_found" });
        return;
      }
      const mandate = await getMandate(mandatesRepository, id);
      if (!mandate) {
        response.status(404).json({ error: "mandate_not_found" });
        return;
      }
      response.status(200).json(mandate);
    } catch (error) {
      console.error("Mandate lookup failed", error);
      response.status(500).json({ error: "mandate_persistence_failed" });
    }
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

function createDefaultMandatesRepository(): MandatesRepository {
  if (env.VOLTA_MODE !== "live") return createMemoryMandatesRepository();
  const supabaseKey =
    env.SUPABASE_SERVICE_ROLE_KEY ?? env.SUPABASE_PUBLISHABLE_KEY;
  if (!env.SUPABASE_URL || !supabaseKey) {
    throw new Error(
      "SUPABASE_URL and either SUPABASE_PUBLISHABLE_KEY or SUPABASE_SERVICE_ROLE_KEY are required in live mode"
    );
  }
  return createSupabaseMandatesRepositoryFromConfig(
    env.SUPABASE_URL,
    supabaseKey
  );
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

export function isMainModule(moduleUrl: string, entrypoint?: string): boolean {
  return Boolean(entrypoint && moduleUrl === pathToFileURL(entrypoint).href);
}

if (isMainModule(import.meta.url, process.argv[1])) {
  createApp().listen(env.PORT, () => {
    console.log(`Volta API listening on port ${env.PORT}`);
  });
}
