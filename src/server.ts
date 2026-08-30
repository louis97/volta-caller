import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import express, { type Request, type Response } from "express";
import type {
  Carrier,
  OperationEvent,
  Operation,
  OperationReadModel,
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
import type { OperationStore } from "./core/state";
import type { TelephonyGateway } from "./telephony/twilio";
import {
  ConfirmationCoordinatorError,
  createConfirmationCoordinator,
  type ConfirmationCoordinator
} from "./core/confirmation";
import { createMockScenario, type MockScenario } from "./mocks/callScenario";
import { createMockTelephonyGateway } from "./mocks/telephony";
import { createOperationFromMandate, seedOperation } from "./core/seed";
import { derivePipelineStage } from "./core/pipeline";
import { fanOutCalls } from "./telephony/orchestrator";
import { PostgresAgentRepository } from "./storage/postgres";
import {
  createKapsoMessenger,
  inboundKapsoMessage,
  receivedKapsoMessages,
  verifyKapsoSignature,
  type KapsoMessenger,
  type KapsoWebhookPayload
} from "./whatsapp/kapso";
import {
  attachTelephonyWebSockets,
  createLiveTelephonyGateway,
  mountTelephonyRoutes,
  telephonyContext
} from "./telephony/routes";

const approvalDecisionSchema = z.object({
  action: z.enum(["approve", "decline"]),
  selectedQuoteId: z.string().trim().min(1).optional(),
  decidedBy: z.string().trim().min(1).max(120).optional()
});
const approvalUndoSchema = z.object({
  undoneBy: z.string().trim().min(1).max(120).optional()
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
const selectQuoteRequestSchema = z.object({
  quoteId: z.string().trim().min(1)
});
const createConversationSchema = z.object({
  title: z.string().trim().min(1).max(120).optional()
});
const renameConversationSchema = z.object({
  title: z.string().trim().min(1).max(120)
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
    "exception",
    "quotes_ready_for_review",
    "carrier_confirmation_received",
    "incident_received",
    "delay_assessed"
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
  confirmationCoordinator?: ConfirmationCoordinator;
  /** Injected scenario/store/telephony, for tests that drive one operation. */
  scenario?: Partial<MockScenario> & { store: OperationStore };
  store?: OperationStore;
  telephony?: TelephonyGateway;
  now?: () => string;
  repository?: AgentRepository;
  answerer?: AgentAnswerer;
  mandatesRepository?: MandatesRepository;
  kapsoMessenger?: KapsoMessenger;
  kapsoWebhookSecret?: string;
};

type EventClient = { response: Response; organizationId: string };

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
  const eventClients = new Set<EventClient>();
  let activeOrganizationId = env.VOLTA_DEFAULT_ORGANIZATION_ID;
  const injectedStore = options.store ?? options.scenario?.store;
  const scenario: MockScenario = options.scenario
    ? {
        run: async () => {},
        closeApprovedDeal: async () => false,
        ...options.scenario
      }
    : injectedStore
      ? {
          store: injectedStore,
          run: async () => {},
          closeApprovedDeal: async () => false
        }
      : createMockScenario();
  // One map, resolved from the store: the routes, the WebSocket handler and a
  // mandate's fan-out all have to agree on which carrier a call sid belongs
  // to, or the agent is talking to "unknown".
  const dialled = telephonyContext(scenario.store).dialled;
  // A client's quote selection is what authorises the closing call; this
  // places it.
  const confirmationCoordinator =
    options.confirmationCoordinator ??
    createConfirmationCoordinator({
      store: scenario.store,
      telephony: options.telephony ?? createMockTelephonyGateway(),
      now: options.now
    });
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
  const kapsoMessenger =
    options.kapsoMessenger ??
    (env.KAPSO_API_KEY && env.KAPSO_PHONE_NUMBER_ID
      ? createKapsoMessenger({
          apiKey: env.KAPSO_API_KEY,
          phoneNumberId: env.KAPSO_PHONE_NUMBER_ID
        })
      : undefined);
  const kapsoWebhookSecret =
    options.kapsoWebhookSecret ?? env.KAPSO_WEBHOOK_SECRET;
  const processedKapsoEvents = new Set<string>();

  app.post(
    "/webhooks/kapso/whatsapp",
    express.raw({ type: "application/json", limit: "1mb" }),
    async (request, response) => {
      if (!kapsoMessenger || !kapsoWebhookSecret) {
        response.status(503).json({ error: "kapso_not_configured" });
        return;
      }
      const signature = request.header("x-webhook-signature") ?? undefined;
      if (!verifyKapsoSignature(request.body, signature, kapsoWebhookSecret)) {
        response.status(401).json({ error: "invalid_kapso_signature" });
        return;
      }
      if (request.header("x-webhook-event") !== "whatsapp.message.received") {
        response.status(200).json({ ignored: true });
        return;
      }
      const idempotencyKey = request.header("x-idempotency-key");
      if (idempotencyKey && processedKapsoEvents.has(idempotencyKey)) {
        response.status(200).json({ duplicate: true });
        return;
      }
      let payload: KapsoWebhookPayload;
      try {
        payload = JSON.parse(
          request.body.toString("utf8")
        ) as KapsoWebhookPayload;
      } catch {
        response.status(400).json({ error: "invalid_kapso_payload" });
        return;
      }
      try {
        for (const item of receivedKapsoMessages(payload)) {
          const inbound = inboundKapsoMessage(item);
          if (!inbound) continue;
          const context: OrganizationContext = {
            organizationId: env.VOLTA_DEFAULT_ORGANIZATION_ID,
            userId: `whatsapp:${inbound.from}`
          };
          const title = `WhatsApp · ${inbound.from}`;
          const conversation =
            (await agent.listConversations(context)).find(
              (item) => item.title === title
            ) ?? (await agent.createConversation(context, title));
          const reply = inbound.content
            ? (await agent.ask(context, conversation.id, inbound.content))
                .content
            : inbound.type === "audio"
              ? "No pude transcribir ese audio. Intenta enviarlo de nuevo o escríbeme tu consulta."
              : "Por ahora puedo responder mensajes de texto o audios que Kapso pueda transcribir.";
          await kapsoMessenger.sendText({ to: inbound.from, text: reply });
        }
        if (idempotencyKey) processedKapsoEvents.add(idempotencyKey);
        response.status(200).json({ received: true });
      } catch (error) {
        console.error("Kapso WhatsApp webhook failed", error);
        response.status(500).json({ error: "kapso_webhook_processing_failed" });
      }
    }
  );

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
    for (const client of eventClients) {
      if (client.organizationId === activeOrganizationId) {
        writeEvent(client.response, event);
      }
    }
  };
  const publishShipmentEvent = async (event: ShipmentEvent) => {
    await repository.addShipmentEvent(event);
    for (const client of eventClients) {
      if (client.organizationId === event.organizationId) {
        writeAgentEvent(client.response, "shipment.event.created", event);
      }
    }
  };
  const quoteReadyOperations = new Set<string>();
  const publishQuotesReady = async (input: {
    operationId: string;
    quoteIds: string[];
    carrierCount: number;
    occurredAt: string;
  }) => {
    if (quoteReadyOperations.has(input.operationId)) return;
    quoteReadyOperations.add(input.operationId);
    await publishShipmentEvent({
      id: randomUUID(),
      organizationId: activeOrganizationId,
      operationId: input.operationId,
      type: "quotes_ready_for_review",
      label: "Carrier quotes are ready for review.",
      source: "volta",
      occurredAt: input.occurredAt,
      receivedAt: input.occurredAt,
      metadata: { quoteIds: input.quoteIds, carrierCount: input.carrierCount }
    });
  };
  const notifyFromOperationEvent = (event: OperationEvent) => {
    const operation = scenario.store.getOperation();
    const now = new Date().toISOString();
    if (event.type === "deal.reviewed") {
      const quoteIds = operation.reviewedDeals.map((deal) => deal.quoteId);
      if (
        operation.candidates.length > 0 &&
        quoteIds.length >= operation.candidates.length
      ) {
        void publishQuotesReady({
          operationId: event.operationId,
          quoteIds,
          carrierCount: operation.candidates.length,
          occurredAt: event.reviewedDeal.reviewedAt
        });
      }
    } else if (event.type === "commitment.finalized") {
      void publishShipmentEvent({
        id: randomUUID(),
        organizationId: activeOrganizationId,
        operationId: event.operationId,
        type: "carrier_confirmation_received",
        label: "Carrier confirmed the selected quote.",
        source: "volta",
        occurredAt: now,
        receivedAt: now,
        metadata: {
          quoteId: operation.selection?.quoteId,
          carrierId: event.commitment.carrierId,
          outcome: "confirmed"
        }
      });
    } else if (event.type === "confirmation.failed") {
      void publishShipmentEvent({
        id: randomUUID(),
        organizationId: activeOrganizationId,
        operationId: event.operationId,
        type: "carrier_confirmation_received",
        label: "Carrier denied or could not confirm the selected quote.",
        source: "volta",
        occurredAt: now,
        receivedAt: now,
        metadata: { outcome: "denied", reason: event.reason }
      });
    } else if (event.type === "incident.updated") {
      const incident = event.incident;
      void publishShipmentEvent({
        id: randomUUID(),
        organizationId: activeOrganizationId,
        operationId: event.operationId,
        type: "incident_received",
        label: `Incident reported: ${incident.issue}`,
        source: "volta",
        occurredAt: incident.createdAt,
        receivedAt: now,
        metadata: {
          incidentId: incident.id,
          callerName: incident.callerName,
          revisedEta: incident.revisedEta,
          delayMinutes: incident.delayMinutes
        }
      });
    } else if (event.type === "dashboard.notification.created") {
      const incident = operation.incidents.find(
        (item) => item.id === event.notification.incidentId
      );
      void publishShipmentEvent({
        id: randomUUID(),
        organizationId: activeOrganizationId,
        operationId: event.operationId,
        type: "delay_assessed",
        label: event.notification.message,
        source: "volta",
        occurredAt: event.notification.createdAt,
        receivedAt: now,
        metadata: {
          incidentId: event.notification.incidentId,
          revisedEta: incident?.revisedEta,
          destinationDeadline: operation.mandate.destinationDatetime,
          escalationRequired: true
        }
      });
    }
  };
  // Already built above (possibly injected); wire its event stream now that
  // `publish` exists.
  scenario.store.subscribe((event) => {
    publish(event);
    notifyFromOperationEvent(event);
  });
  app.locals.operationStore = scenario.store;
  app.locals.publishShipmentEvent = publishShipmentEvent;
  app.locals.telephonyDialled = dialled;
  app.locals.ensureCarrierDirectory = () =>
    ensureCarrierDirectory(repository, activeOrganizationId);
  app.locals.listTranscript = (callId?: string) =>
    repository.listTranscript(activeOrganizationId, callId);
  app.locals.listActiveCarriers = async () => {
    const carriers = await repository.listCarriers(activeOrganizationId);
    return carriers
      .filter((carrier) => carrier.active)
      .map((carrier) => ({
        id: carrier.id,
        name: carrier.name,
        phone: carrier.phone
      }));
  };
  app.locals.saveTranscriptSegment = (
    segment: import("@volta/contracts").TranscriptSegment
  ) => {
    void repository
      .addTranscriptSegments([segment])
      .catch((error: unknown) =>
        console.error("[transcript] persist failed:", error)
      );
  };
  app.locals.saveCallSession = (
    session: import("@volta/contracts").CallSession
  ) => repository.saveCallSession(activeOrganizationId, session);
  const agent = createOperationalAgent({
    repository,
    answerer,
    getCurrentOperation: () => scenario.store.getOperation(),
    executeCloseApprovedDeal: () => scenario.closeApprovedDeal(),
    resolveCarrierSelection: (input) => {
      scenario.store.resolveApproval({
        approvalId: input.approvalId,
        action: "approve",
        selectedQuoteId: input.selectedQuoteId,
        decidedBy: input.decidedBy,
        decidedAt: input.decidedAt
      });
      return true;
    }
  });
  const persistCurrentOperation = (context: OrganizationContext) =>
    repository.syncOperation(
      context.organizationId,
      scenario.store.getOperation()
    );

  const persistCallSessions = async (context: OrganizationContext) => {
    await Promise.all(
      scenario.store
        .getOperation()
        .callSessions.map((session) =>
          repository.saveCallSession(context.organizationId, session)
        )
    );
  };

  app.get("/health", (_request, response) => {
    response.status(200).json({ status: "ok", mode: env.VOLTA_MODE });
  });
  const operationReadModel = (operation: Operation): OperationReadModel => ({
    ...operation,
    pipelineStage: derivePipelineStage(operation)
  });

  app.get("/api/operation", (_request, response) => {
    response
      .status(200)
      .json(operationReadModel(scenario.store.getOperation()));
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
      operation: operationReadModel(scenario.store.getOperation())
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
        decidedBy:
          parsed.data.decidedBy ??
          contextFromRequest(request, response)?.userId ??
          "dispatcher",
        decidedAt: new Date().toISOString()
      });
      const context = contextFromRequest(request, response);
      if (context) await persistCurrentOperation(context);
      response.status(200).json({
        approval,
        operation: operationReadModel(scenario.store.getOperation())
      });
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
        undoneBy:
          parsed.data.undoneBy ??
          contextFromRequest(request, response)?.userId ??
          "dispatcher",
        undoneAt: new Date().toISOString()
      });
      const context = contextFromRequest(request, response);
      if (context) await persistCurrentOperation(context);
      response.status(200).json({
        approval,
        operation: operationReadModel(scenario.store.getOperation())
      });
    } catch (error) {
      const reason =
        error instanceof Error ? error.message : "approval_undo_invalid";
      response
        .status(reason === "approval_not_found" ? 404 : 409)
        .json({ error: reason });
    }
  });

  app.post("/api/mandates", async (request, response) => {
    try {
      const mandate = await createMandate(mandatesRepository, request.body);
      const context = contextFromRequest(request, response);
      if (!context) return;
      activeOrganizationId = context.organizationId;
      const carriers = await repository.listCarriers(context.organizationId);
      const operation = createOperationFromMandate(
        mandate,
        `operation-${mandate.id}`
      );
      const active = carriers
        .filter((carrier) => carrier.active)
        .map(({ id, name, phone }) => ({ id, name, phone }));

      // An empty directory would dial nobody and look like the mandate simply
      // did nothing, so the seeded pool stands in and says so.
      if (active.length === 0) {
        console.warn(
          "[mandates] no active carriers in the directory; falling back to the seeded pool"
        );
      }
      operation.candidates =
        active.length > 0 ? active : seedOperation().candidates;

      scenario.store.replaceOperation(operation);
      await persistCurrentOperation(context);

      // A new mandate opens a new market: the round's quotes must not inherit
      // the previous one, and each leg has to be attributable to its carrier
      // or get_leverage has nothing real to cite.
      const telephony = telephonyContext(scenario.store);
      telephony.resetAuction();

      console.log(
        `[mandates] dialling ${operation.candidates.length}: ${operation.candidates
          .map((candidate) => candidate.name)
          .join(", ")}`
      );

      await fanOutCalls({
        store: scenario.store,
        mode: env.VOLTA_MODE,
        publicBaseUrl: env.PUBLIC_BASE_URL,
        from: env.TWILIO_FROM_NUMBER,
        gateway:
          env.VOLTA_MODE === "live" ? createLiveTelephonyGateway() : undefined,
        timeLimitSeconds: env.CALL_TIME_LIMIT_SECONDS,
        record: env.TWILIO_RECORD_CALLS,
        detectAnsweringMachine: true,
        onDialled: (callId, carrier) => {
          telephony.dialled.set(callId, carrier);
          telephony.auction.startCall(carrier.id, callId);
        },
        onRoundReviewed: publishQuotesReady
      });
      await persistCallSessions(context);
      await persistCurrentOperation(context);
      response
        .status(201)
        .json(operationReadModel(scenario.store.getOperation()));
    } catch (error) {
      if (error instanceof InvalidMandateError) {
        response.status(400).json({ error: error.code });
        return;
      }
      console.error("Mandate creation failed", error);
      response.status(500).json({ error: "mandate_persistence_failed" });
    }
  });

  /**
   * A client picking a quote is what authorises the closing call; the
   * coordinator places it. Quotes on their own are only market intelligence.
   */
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
      response.status(202).json(scenario.store.getOperation());
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

  app.get("/api/carriers", async (request, response) => {
    const context = contextFromRequest(request, response);
    if (!context) return;
    response
      .status(200)
      .json(await repository.listCarriers(context.organizationId));
  });

  app.post("/api/carriers", async (request, response) => {
    const context = contextFromRequest(request, response);
    if (!context) return;
    const body = request.body as Partial<
      Pick<Carrier, "name" | "phone" | "lanes" | "active">
    >;
    if (!body.name?.trim() || !body.phone?.trim()) {
      response.status(400).json({ error: "invalid_carrier" });
      return;
    }
    const carrier: Carrier = {
      organizationId: context.organizationId,
      id: randomUUID(),
      name: body.name.trim(),
      phone: body.phone.trim(),
      lanes: body.lanes ?? [],
      active: body.active ?? true,
      createdAt: new Date().toISOString()
    };
    response.status(201).json(await repository.createCarrier(carrier));
  });

  app.patch("/api/carriers/:carrierId", async (request, response) => {
    const context = contextFromRequest(request, response);
    if (!context) return;
    const carrier = await repository.updateCarrier(
      context.organizationId,
      request.params.carrierId,
      request.body as Partial<
        Pick<Carrier, "name" | "phone" | "lanes" | "active">
      >
    );
    if (!carrier) {
      response.status(404).json({ error: "carrier_not_found" });
      return;
    }
    response.status(200).json(carrier);
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

  app.patch(
    "/api/agent/conversations/:conversationId",
    async (request, response) => {
      const context = contextFromRequest(request, response);
      if (!context) return;
      const parsed = renameConversationSchema.safeParse(request.body);
      if (!parsed.success) {
        response.status(400).json({ error: "invalid_conversation_title" });
        return;
      }
      try {
        const conversation = await agent.renameConversation(
          context,
          request.params.conversationId,
          parsed.data.title
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

  app.delete(
    "/api/agent/conversations/:conversationId",
    async (request, response) => {
      const context = contextFromRequest(request, response);
      if (!context) return;
      try {
        const deleted = await agent.deleteConversation(
          context,
          request.params.conversationId
        );
        if (!deleted) {
          response.status(404).json({ error: "conversation_not_found" });
          return;
        }
        response.status(204).end();
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
      try {
        const message = await agent.ask(
          context,
          request.params.conversationId,
          parsed.data.question,
          (activity) => writeAgentEvent(response, "activity", activity)
        );
        writeAgentEvent(response, "final", message);
      } catch (error) {
        console.error("Volta agent request failed", error);
        writeAgentEvent(response, "error", publicAgentFailure(error));
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
        response.status(200).json({
          action,
          operation: operationReadModel(scenario.store.getOperation())
        });
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

  app.get("/api/shipment-events", async (request, response) => {
    const context = contextFromRequest(request, response);
    if (!context) return;
    try {
      response.status(200).json(await repository.listShipmentEvents(context));
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
    await publishShipmentEvent(event);
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

  app.get("/api/events", (request: Request, response: Response) => {
    const context = contextFromRequest(request, response);
    if (!context) return;
    response.status(200).set({
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "Content-Type": "text/event-stream"
    });
    response.write("retry: 3000\n\n");
    response.flushHeaders();
    const client = { response, organizationId: context.organizationId };
    eventClients.add(client);
    const heartbeat = setInterval(() => response.write(": ping\n\n"), 20_000);
    request.on("close", () => {
      clearInterval(heartbeat);
      eventClients.delete(client);
    });
  });

  mountTelephonyRoutes(app, {
    store: scenario.store,
    dialled,
    organizationId: activeOrganizationId,
    onCallSessionChanged: (session) =>
      void repository.saveCallSession(activeOrganizationId, session),
    onTranscriptAppended: (segment) =>
      app.locals.saveTranscriptSegment(segment),
    // The console's carrier directory is what a round dials.
    listActiveCarriers: () => app.locals.listActiveCarriers(),
    listTranscript: (callId?: string) =>
      repository.listTranscript(activeOrganizationId, callId)
  });

  return app;
}

/**
 * Makes sure the demo pool is present in the directory, so the testing panel
 * has something to show and a round has someone to dial without anyone
 * retyping three numbers. Additive only.
 */
async function ensureCarrierDirectory(
  repository: AgentRepository,
  organizationId: string
): Promise<void> {
  try {
    const existing = await repository.listCarriers(organizationId);
    const known = new Set(existing.map((carrier) => carrier.phone));

    // Adds only what is missing, by number. Anything the team added or
    // deactivated through the console is left exactly as they left it.
    const missing = seedOperation().candidates.filter(
      (candidate) => !known.has(candidate.phone)
    );
    if (missing.length === 0) return;

    for (const candidate of missing) {
      await repository.createCarrier({
        id: candidate.id,
        organizationId,
        name: candidate.name,
        phone: candidate.phone,
        lanes: [],
        active: true,
        createdAt: new Date().toISOString()
      });
    }
    console.log(
      `[carriers] added ${missing.length} missing to the directory: ${missing
        .map((candidate) => candidate.phone)
        .join(", ")}`
    );
  } catch (error) {
    // A directory that cannot be seeded still falls back to the seeded pool.
    console.error("[carriers] could not seed the directory:", error);
  }
}

function createDefaultMandatesRepository(): MandatesRepository {
  if (env.VOLTA_MODE !== "live") return createMemoryMandatesRepository();

  const supabaseKey =
    env.SUPABASE_SERVICE_ROLE_KEY ?? env.SUPABASE_PUBLISHABLE_KEY;

  // VOLTA_MODE=live carries two independent meanings: real telephony and real
  // persistence. Refusing to boot without Supabase blocks all voice work on a
  // dependency the call path never touches, so an unconfigured mandate store
  // degrades loudly to memory instead of taking the process down.
  if (!env.SUPABASE_URL || !supabaseKey) {
    console.warn(
      "[mandates] live mode without Supabase; mandates are in memory and will not survive a restart"
    );
    return createMemoryMandatesRepository();
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

function publicAgentFailure(error: unknown) {
  const reason = error instanceof Error ? error.message : "";
  if (reason === "conversation_not_found") {
    return {
      error: "agent_conversation_missing",
      message: "This conversation is no longer available. Start a new chat.",
      retryable: false
    };
  }
  if (reason === "agent_model_unavailable") {
    return {
      error: "agent_model_unavailable",
      message: "Volta's language model is not configured.",
      retryable: false
    };
  }
  if (
    reason.includes("Schema field") ||
    reason.includes("Invalid schema for function")
  ) {
    return {
      error: "agent_configuration_invalid",
      message: "Volta's operational tools are temporarily unavailable.",
      retryable: false
    };
  }
  const status =
    typeof error === "object" && error !== null && "status" in error
      ? Number(error.status)
      : undefined;
  if (status === 429) {
    return {
      error: "agent_rate_limited",
      message: "Volta is receiving too many requests. Try again shortly.",
      retryable: true
    };
  }
  return {
    error: "agent_request_failed",
    message: "Volta could not answer right now. No action was taken.",
    retryable: true
  };
}

export function isMainModule(moduleUrl: string, entrypoint?: string): boolean {
  return Boolean(entrypoint && moduleUrl === pathToFileURL(entrypoint).href);
}

if (isMainModule(import.meta.url, process.argv[1])) {
  // The media relay needs the raw HTTP server to handle WebSocket upgrades,
  // which `app.listen()` does not expose.
  const app = createApp();
  const server = createServer(app);
  // createApp mounts telephony against its scenario store; retain it on the
  // app so the WebSocket handler shares the exact same instance.
  attachTelephonyWebSockets(server, {
    store: app.locals.operationStore,
    dialled: app.locals.telephonyDialled,
    onCallSessionChanged: (session) => void app.locals.saveCallSession(session),
    onTranscriptAppended: (segment) =>
      app.locals.saveTranscriptSegment(segment),
    // The console's carrier directory is what a round dials.
    listActiveCarriers: () => app.locals.listActiveCarriers(),
    listTranscript: (callId?: string) => app.locals.listTranscript(callId)
  });

  void app.locals.ensureCarrierDirectory?.();

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
