import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import express, { type Request, type Response } from "express";
import type {
  OperationEvent,
  ShipmentEvent,
  TranscriptSegment
} from "@volta/contracts";
import { z } from "zod";

import {
  DeterministicAgentAnswerer,
  OpenAIAgentAnswerer,
  type AgentAnswerer,
  UnavailableAgentAnswerer,
  conversationTitle,
  createOperationalAgent
} from "./agent/operationalAgent";
import {
  type AgentRepository,
  MemoryAgentRepository,
  type OrganizationContext
} from "./agent/repository";
import { env, missingTelephonyConfig } from "./config/env";
import { createMemoryMandatesRepository } from "./core/mandates/memory-repository";
import {
  createMandate,
  getMandate,
  InvalidMandateError,
  listMandates
} from "./core/mandates/service";
import { createSupabaseMandatesRepositoryFromConfig } from "./core/mandates/supabase-repository";
import type { MandatesRepository } from "./core/mandates/types";
import { createMockScenario } from "./mocks/callScenario";
import { PostgresAgentRepository } from "./storage/postgres";
import {
  attachTelephonyWebSockets,
  mountTelephonyRoutes
} from "./telephony/routes";

const approvalDecisionSchema = z.object({
  action: z.enum(["approve", "decline"]),
  selectedQuoteId: z.string().trim().min(1).optional(),
  decidedBy: z.string().trim().min(1).max(120)
});
const approvalUndoSchema = z.object({
  undoneBy: z.string().trim().min(1).max(120)
});
const legacyCopilotRequestSchema = z.object({
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
const createConversationSchema = z.object({
  title: z.string().trim().min(1).max(120).optional()
});
const askAgentSchema = z.object({
  question: z.string().trim().min(1).max(2000)
});
const actionDecisionSchema = z.object({
  decision: z.enum(["approve", "decline"])
});
const shipmentEventSchema = z.object({
  id: z.string().trim().min(1).optional(),
  operationId: z.string().trim().min(1),
  type: z.enum([
    "created",
    "pickup_scheduled",
    "at_origin",
    "picked_up",
    "in_transit",
    "checkpoint",
    "delivered",
    "exception"
  ]),
  label: z.string().trim().min(1).max(240),
  location: z.string().trim().min(1).max(240).optional(),
  source: z.string().trim().min(1).max(120),
  occurredAt: z.string().datetime({ offset: true }),
  metadata: z.record(z.string(), z.unknown()).optional()
});
const transcriptSegmentsSchema = z.object({
  operationId: z.string().trim().min(1),
  callId: z.string().trim().min(1),
  segments: z
    .array(
      z.object({
        id: z.string().trim().min(1).optional(),
        speaker: z.enum(["agent", "carrier", "dispatcher", "unknown"]),
        text: z.string().trim().min(1).max(8000),
        startMs: z.number().int().nonnegative(),
        endMs: z.number().int().nonnegative(),
        createdAt: z.string().datetime({ offset: true }).optional()
      })
    )
    .min(1)
    .max(500)
});

export type CreateAppOptions = {
  repository?: AgentRepository;
  answerer?: AgentAnswerer;
  mandatesRepository?: MandatesRepository;
};

function writeEvent(response: Response, event: OperationEvent): void {
  response.write(`event: ${event.type}\n`);
  response.write(`data: ${JSON.stringify(event)}\n\n`);
}

function writeAgentEvent(response: Response, event: string, data: unknown) {
  response.write(`event: ${event}\n`);
  response.write(`data: ${JSON.stringify(data)}\n\n`);
}

export function createApp(options: CreateAppOptions = {}) {
  const app = express();
  let scenario = createMockScenario();
  const eventClients = new Set<Response>();
  const mandatesRepository =
    options.mandatesRepository ?? createDefaultMandatesRepository();
  const repository =
    options.repository ??
    (env.DATABASE_URL
      ? new PostgresAgentRepository(env.DATABASE_URL)
      : new MemoryAgentRepository());
  const answerer =
    options.answerer ??
    (env.OPENAI_API_KEY
      ? new OpenAIAgentAnswerer(env.OPENAI_API_KEY, env.VOLTA_COPILOT_MODEL)
      : env.VOLTA_MODE === "mock"
        ? new DeterministicAgentAnswerer()
        : new UnavailableAgentAnswerer());

  app.use(express.json({ limit: "1mb" }));
  app.use("/api", (request, response, next) => {
    if (
      env.VOLTA_MODE === "live" &&
      (!request.header("x-volta-org-id") || !request.header("x-volta-user-id"))
    ) {
      response.status(401).json({ error: "authentication_required" });
      return;
    }
    next();
  });

  const publish = (event: OperationEvent) => {
    for (const client of eventClients) writeEvent(client, event);
  };
  const agent = createOperationalAgent({
    repository,
    answerer,
    getCurrentOperation: () => scenario.store.getOperation(),
    executeCloseApprovedDeal: () => scenario.closeApprovedDeal()
  });
  const persistCurrentOperation = (context: OrganizationContext) =>
    repository.syncOperation(
      context.organizationId,
      scenario.store.getOperation()
    );

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
    response
      .status(200)
      .json({ approval, operation: scenario.store.getOperation() });
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
      const context = contextFromRequest(request, response);
      if (context) await persistCurrentOperation(context);
      response
        .status(200)
        .json({ approval, operation: scenario.store.getOperation() });
    } catch (error) {
      const reason =
        error instanceof Error ? error.message : "approval_invalid";
      response
        .status(reason === "approval_not_found" ? 404 : 409)
        .json({ error: reason });
    }
  });

  app.post("/api/approvals/:approvalId/undo", async (request, response) => {
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
      const context = contextFromRequest(request, response);
      if (context) await persistCurrentOperation(context);
      response
        .status(200)
        .json({ approval, operation: scenario.store.getOperation() });
    } catch (error) {
      const reason =
        error instanceof Error ? error.message : "approval_undo_invalid";
      response
        .status(reason === "approval_not_found" ? 404 : 409)
        .json({ error: reason });
    }
  });

  app.post("/api/demo/close-approved-deal", async (request, response) => {
    if (env.VOLTA_MODE !== "mock") {
      response.status(409).json({ error: "demo_requires_mock_mode" });
      return;
    }
    const committed = await scenario.closeApprovedDeal();
    if (!committed) {
      response.status(409).json({ error: "closing_authorization_required" });
      return;
    }
    const context = contextFromRequest(request, response);
    if (context) await persistCurrentOperation(context);
    response.status(202).json(scenario.store.getOperation());
  });

  app.post("/api/mandates", async (request, response) => {
    try {
      response
        .status(201)
        .json(await createMandate(mandatesRepository, request.body));
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

  app.post("/api/agent/conversations", async (request, response) => {
    const context = contextFromRequest(request, response);
    if (!context) return;
    const parsed = createConversationSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      response.status(400).json({ error: "invalid_agent_conversation" });
      return;
    }
    try {
      await persistCurrentOperation(context);
      const conversation = await agent.createConversation(
        context,
        parsed.data.title
      );
      response.status(201).json(conversation);
    } catch (error) {
      storageFailure(response, error);
    }
  });

  app.get("/api/agent/conversations", async (request, response) => {
    const context = contextFromRequest(request, response);
    if (!context) return;
    try {
      response.status(200).json(await agent.listConversations(context));
    } catch (error) {
      storageFailure(response, error);
    }
  });

  app.get(
    "/api/agent/conversations/:conversationId",
    async (request, response) => {
      const context = contextFromRequest(request, response);
      if (!context) return;
      try {
        const conversation = await agent.getConversation(
          context,
          request.params.conversationId
        );
        if (!conversation) {
          response.status(404).json({ error: "conversation_not_found" });
          return;
        }
        response.status(200).json(conversation);
      } catch (error) {
        storageFailure(response, error);
      }
    }
  );

  app.post(
    "/api/agent/conversations/:conversationId/messages",
    async (request, response) => {
      const context = contextFromRequest(request, response);
      if (!context) return;
      const parsed = askAgentSchema.safeParse(request.body);
      if (!parsed.success) {
        response.status(400).json({ error: "invalid_agent_question" });
        return;
      }
      response.status(200).set({
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "Content-Type": "text/event-stream"
      });
      response.flushHeaders();
      writeAgentEvent(response, "status", { stage: "retrieving" });
      try {
        writeAgentEvent(response, "status", { stage: "answering" });
        const message = await agent.ask(
          context,
          request.params.conversationId,
          parsed.data.question
        );
        writeAgentEvent(response, "final", message);
      } catch (error) {
        const reason =
          error instanceof Error ? error.message : "agent_request_failed";
        writeAgentEvent(response, "error", { error: reason });
      } finally {
        response.end();
      }
    }
  );

  app.post(
    "/api/agent/actions/:actionId/decision",
    async (request, response) => {
      const context = contextFromRequest(request, response);
      if (!context) return;
      const parsed = actionDecisionSchema.safeParse(request.body);
      if (!parsed.success) {
        response.status(400).json({ error: "invalid_agent_action_decision" });
        return;
      }
      try {
        const action = await agent.decideAction(
          context,
          request.params.actionId,
          parsed.data.decision
        );
        response
          .status(200)
          .json({ action, operation: scenario.store.getOperation() });
      } catch (error) {
        const reason =
          error instanceof Error ? error.message : "agent_action_failed";
        response
          .status(reason === "agent_action_not_found" ? 404 : 409)
          .json({ error: reason });
      }
    }
  );

  app.get("/api/evidence/:sourceType/:sourceId", async (request, response) => {
    const context = contextFromRequest(request, response);
    if (!context) return;
    try {
      const evidence = await repository.getEvidence(
        context,
        request.params.sourceType,
        request.params.sourceId
      );
      if (!evidence) {
        response.status(404).json({ error: "evidence_not_found" });
        return;
      }
      response.status(200).json(evidence);
    } catch (error) {
      storageFailure(response, error);
    }
  });

  app.post("/api/internal/shipment-events", async (request, response) => {
    if (!authorizeInternalRequest(request, response)) return;
    const context = contextFromRequest(request, response);
    if (!context) return;
    const parsed = shipmentEventSchema.safeParse(request.body);
    if (!parsed.success) {
      response.status(400).json({ error: "invalid_shipment_event" });
      return;
    }
    const event: ShipmentEvent = {
      ...parsed.data,
      id: parsed.data.id ?? randomUUID(),
      organizationId: context.organizationId,
      receivedAt: new Date().toISOString()
    };
    await repository.addShipmentEvent(event);
    response.status(201).json(event);
  });

  app.post("/api/internal/transcript-segments", async (request, response) => {
    if (!authorizeInternalRequest(request, response)) return;
    const context = contextFromRequest(request, response);
    if (!context) return;
    const parsed = transcriptSegmentsSchema.safeParse(request.body);
    if (!parsed.success) {
      response.status(400).json({ error: "invalid_transcript_segments" });
      return;
    }
    const segments: TranscriptSegment[] = parsed.data.segments.map(
      (segment) => ({
        ...segment,
        id: segment.id ?? randomUUID(),
        organizationId: context.organizationId,
        operationId: parsed.data.operationId,
        callId: parsed.data.callId,
        createdAt: segment.createdAt ?? new Date().toISOString()
      })
    );
    await repository.addTranscriptSegments(segments);
    response.status(201).json({ segments });
  });

  app.post("/api/copilot", async (request, response) => {
    const parsed = legacyCopilotRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      response.status(400).json({ error: "invalid_copilot_question" });
      return;
    }
    const context = contextFromRequest(request, response);
    if (!context) return;
    try {
      const conversation = await agent.createConversation(
        context,
        conversationTitle(parsed.data.question)
      );
      const message = await agent.ask(
        context,
        conversation.id,
        parsed.data.question
      );
      response.status(200).json({
        answer: message.content,
        citations: message.citations,
        proposedActions: message.proposedActions,
        conversationId: conversation.id
      });
    } catch (error) {
      console.error("Volta agent request failed", error);
      response.status(502).json({
        error: "agent_request_failed",
        message: "Volta could not answer right now. Try again shortly."
      });
    }
  });

  app.post("/api/demo/run", async (request, response) => {
    if (env.VOLTA_MODE !== "mock") {
      response.status(409).json({ error: "demo_requires_mock_mode" });
      return;
    }
    scenario = createMockScenario(publish);
    await scenario.run();
    const context = contextFromRequest(request, response);
    if (context) {
      await persistCurrentOperation(context);
      await seedMockKnowledge(
        repository,
        context,
        scenario.store.getOperation().id
      );
    }
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

function contextFromRequest(
  request: Request,
  response: Response
): OrganizationContext | undefined {
  const organizationId = request.header("x-volta-org-id");
  const userId = request.header("x-volta-user-id");
  if (env.VOLTA_MODE === "live" && (!organizationId || !userId)) {
    response.status(401).json({ error: "authentication_required" });
    return undefined;
  }
  return {
    organizationId: organizationId ?? env.VOLTA_DEFAULT_ORGANIZATION_ID,
    userId: userId ?? "demo-dispatcher"
  };
}

function authorizeInternalRequest(request: Request, response: Response) {
  if (env.VOLTA_MODE === "mock") return true;
  const supplied = request.header("x-volta-internal-key");
  if (!env.VOLTA_INTERNAL_API_KEY || supplied !== env.VOLTA_INTERNAL_API_KEY) {
    response.status(401).json({ error: "internal_authentication_required" });
    return false;
  }
  return true;
}

function storageFailure(response: Response, error: unknown) {
  console.error("Volta storage request failed", error);
  response.status(503).json({ error: "agent_storage_unavailable" });
}

async function seedMockKnowledge(
  repository: AgentRepository,
  context: OrganizationContext,
  operationId: string
) {
  const occurredAt = "2026-09-01T15:00:00.000Z";
  await repository.addShipmentEvent({
    id: `event-${operationId}-at-origin`,
    organizationId: context.organizationId,
    operationId,
    type: "at_origin",
    label: "Carga en origen mientras se coordina el transporte",
    location: "Terminal de Contenedores, Manzanillo, Colima",
    source: "volta_demo",
    occurredAt,
    receivedAt: occurredAt
  });
  const transcripts = [
    [
      "mock-quote-costa-pacifico-001",
      "Transportes Costa Pacífico",
      8750,
      "La unidad estaría disponible noventa minutos después."
    ],
    [
      "mock-quote-ruta-occidente-001",
      "Ruta Occidente",
      8500,
      "Podemos respetar la recolección del jueves a las diez."
    ],
    [
      "mock-quote-logistica-manzanillo-001",
      "Logística Manzanillo",
      8640,
      "La confirmación de unidad tarda ochenta minutos."
    ]
  ] as const;
  await repository.addTranscriptSegments(
    transcripts.flatMap(([callId, carrier, price, objection], index) => [
      {
        id: `${callId}-agent`,
        organizationId: context.organizationId,
        operationId,
        callId,
        speaker: "agent" as const,
        text: "Volta solicita tarifa y disponibilidad para Manzanillo a Guadalajara con pickup jueves 10:00.",
        startMs: 0,
        endMs: 8200,
        createdAt: occurredAt
      },
      {
        id: `${callId}-carrier`,
        organizationId: context.organizationId,
        operationId,
        callId,
        speaker: "carrier" as const,
        text: `${carrier} cotiza MXN ${price}. ${objection}`,
        startMs: 8300 + index * 100,
        endMs: 18_000 + index * 100,
        createdAt: occurredAt
      }
    ])
  );
}

export function isMainModule(moduleUrl: string, entrypoint?: string): boolean {
  return Boolean(entrypoint && moduleUrl === pathToFileURL(entrypoint).href);
}

if (isMainModule(import.meta.url, process.argv[1])) {
  // The media relay needs the raw HTTP server to handle WebSocket upgrades,
  // which `app.listen()` does not expose.
  const server = createServer(createApp());
  attachTelephonyWebSockets(server);

  const missing = missingTelephonyConfig();
  if (missing.length > 0) {
    console.warn(
      `[config] live mode is missing ${missing.join(", ")}; outbound calls will fail`
    );
  }

  server.listen(env.PORT, () => {
    console.log(`Volta API listening on port ${env.PORT} (${env.VOLTA_MODE})`);
  });
}
