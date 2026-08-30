import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import express, { type Request, type Response } from "express";
import type {
  AgentConversation,
  AgentMessage,
  Carrier,
  OperationEvent,
  Operation,
  OperationReadModel,
  ProposedAction,
  Quote,
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
  operationVersion,
  type OrganizationContext
} from "./agent/repository";
import { env, missingTelephonyConfig } from "./config/env";
import { createMemoryMandatesRepository } from "./core/mandates/memory-repository";
import {
  createMandate as persistMandate,
  getMandate,
  InvalidMandateError,
  listMandates
} from "./core/mandates/service";
import { createSupabaseMandatesRepositoryFromConfig } from "./core/mandates/supabase-repository";
import type { MandatesRepository } from "./core/mandates/types";
import { createOperationStore, type OperationStore } from "./core/state";
import {
  createTelephonyCallToken,
  hashTelephonyCallToken,
  telephonyContextExpiry
} from "./core/telephonyContext";
import type { TelephonyGateway } from "./telephony/twilio";
import {
  ConfirmationCoordinatorError,
  createConfirmationCoordinator,
  type ConfirmationCoordinator
} from "./core/confirmation";
import { createMockScenario, type MockScenario } from "./mocks/callScenario";
import { createMockTelephonyGateway } from "./mocks/telephony";
import { hasMandate } from "./core/emptyOperation";
import { createOperationFromMandate, seedCarriers } from "./core/seed";
import { derivePipelineStage } from "./core/pipeline";
import {
  fanOutCalls,
  type OutboundCallContext,
  type OutboundCallReference
} from "./telephony/orchestrator";
import { PostgresAgentRepository } from "./storage/postgres";
import { OpenAIQuoteExtractor } from "./agent/quoteExtractor";
import {
  createKapsoMessenger,
  inboundKapsoMessage,
  receivedKapsoMessages,
  verifyKapsoSignature,
  whatsappActionDecision,
  type KapsoMessenger,
  type KapsoWebhookPayload
} from "./whatsapp/kapso";
import { warmOutboundCall } from "./telephony/prewarm";
import {
  attachTelephonyWebSockets,
  createLiveTelephonyGateway,
  mountTelephonyRoutes,
  telephonyContext
} from "./telephony/routes";

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

async function whatsappPendingActions(
  repository: AgentRepository,
  context: OrganizationContext,
  conversation: AgentConversation,
  reference?: string
) {
  const actionIds = [
    ...new Set(
      conversation.messages.flatMap((message) =>
        message.proposedActions.map((action) => action.id)
      )
    )
  ];
  const actions = await Promise.all(
    actionIds.map((actionId) => repository.getAction(context, actionId))
  );
  const normalizedReference = reference?.toLowerCase();
  return actions.filter(
    (action): action is ProposedAction =>
      action !== undefined &&
      action.status === "pending" &&
      action.conversationId === conversation.id &&
      action.requestedBy === context.userId &&
      (!normalizedReference ||
        action.id.toLowerCase().startsWith(normalizedReference))
  );
}

function whatsappApprovalInstructions(
  actions: ProposedAction[],
  interactiveButtons = false
) {
  if (actions.length === 0) return undefined;
  if (actions.length === 1) {
    if (interactiveButtons) {
      return "Selecciona *Aprobar* o *Rechazar*. También puedes escribir APROBAR o RECHAZAR.";
    }
    return `Para ejecutarla desde WhatsApp responde *APROBAR*. Para descartarla, responde *RECHAZAR*. Código: ${actions[0].id.slice(0, 8)}.`;
  }
  return [
    "Hay varias acciones pendientes. Responde APROBAR o RECHAZAR seguido del código:",
    ...actions.map((action) => `• ${action.id.slice(0, 8)} — ${action.summary}`)
  ].join("\n");
}

function whatsappInteractiveBody(content: string, instructions: string) {
  const separator = "\n\n";
  const available = Math.max(0, 1024 - separator.length - instructions.length);
  const summary =
    content.length > available
      ? `${content.slice(0, Math.max(0, available - 1))}…`
      : content;
  return `${summary}${separator}${instructions}`;
}

function whatsappDecisionReply(action: ProposedAction) {
  if (action.status === "declined") {
    return "Acción rechazada. No se realizaron cambios operativos.";
  }
  if (action.status === "executed") {
    if (action.type === "create_mandate") {
      return "✅ Mandato aprobado y creado. Ya inicié la ronda de cotizaciones con los transportistas activos.";
    }
    if (action.type === "resolve_carrier_selection") {
      return "✅ Opción elegida. Ya inicié la llamada de cierre al proveedor seleccionado.";
    }
    return "✅ Opción elegida. Ya inicié la llamada de cierre al proveedor seleccionado.";
  }
  if (action.status === "expired") {
    return "La propuesta venció porque la operación cambió. Pídeme generar una nueva propuesta.";
  }
  if (action.failureReason === "mandate_saved_activation_failed") {
    return "El mandato sí quedó guardado, pero no pude activar la ronda de llamadas. No lo vuelvas a crear: revisa la operación en Volta para reanudarla.";
  }
  if (action.type === "create_mandate" && action.status === "failed") {
    return "No pude confirmar que el mandato aprobado quedara completo. No lo dupliques; revisa Mandates en Volta antes de intentarlo de nuevo.";
  }
  return "No pude ejecutar la acción aprobada. Revisa el detalle en Volta antes de intentarlo de nuevo.";
}

/** A number in an app header is not a delivery destination until it is E.164-like. */
function whatsappRecipient(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const digits = value.replace(/\D/g, "");
  return /^[1-9]\d{7,14}$/.test(digits) ? `+${digits}` : undefined;
}

function selectionRecipient(context: OrganizationContext): string | undefined {
  const fromWhatsApp = context.userId.startsWith("whatsapp:")
    ? context.userId.slice("whatsapp:".length)
    : undefined;
  return whatsappRecipient(fromWhatsApp ?? env.VOLTA_SELECTION_WHATSAPP_TO);
}

function topApprovedQuotes(operation: Operation): Quote[] {
  const approved = new Set(
    operation.reviewedDeals
      .filter((deal) => deal.mandateDecision === "APPROVED")
      .map((deal) => deal.quoteId)
  );
  return operation.quotes
    .filter((quote) => approved.has(quote.id))
    .sort(
      (left, right) =>
        left.priceMxn - right.priceMxn ||
        (left.etaMinutes ?? Number.MAX_SAFE_INTEGER) -
          (right.etaMinutes ?? Number.MAX_SAFE_INTEGER) ||
        left.createdAt.localeCompare(right.createdAt)
    )
    .slice(0, 2);
}

function quoteSelectionMessage(
  operation: Operation,
  quotes: Quote[],
  actions: ProposedAction[]
): string {
  const options = quotes.map((quote, index) => {
    const eta =
      quote.etaMinutes === undefined ? "sin ETA" : `${quote.etaMinutes} min`;
    return `${index + 1}. *${quote.carrierName}* — MXN ${quote.priceMxn.toLocaleString("en-US")} — ${eta}`;
  });
  const fallback = actions
    .map(
      (action, index) => `Opción ${index + 1}: APROBAR ${action.id.slice(0, 8)}`
    )
    .join("\n");
  return [
    `Terminó la ronda de cotizaciones para ${operation.origin} → ${operation.destination}.`,
    "Estas son las mejores opciones que cumplen el mandato:",
    ...options,
    "Elige una opción para que Volta llame al proveedor y cierre el deal.",
    `Si no ves los botones, responde exactamente:\n${fallback}`
  ].join("\n\n");
}

export function createApp(options: CreateAppOptions = {}) {
  const app = express();
  const eventClients = new Set<EventClient>();
  let activeOrganizationId = env.VOLTA_DEFAULT_ORGANIZATION_ID;
  const injectedStore = options.store ?? options.scenario?.store;
  const scenario: MockScenario = options.scenario
    ? {
        run: async () => {},
        ...options.scenario
      }
    : injectedStore
      ? {
          store: injectedStore,
          run: async () => {}
        }
      : createMockScenario();
  // One map, resolved from the store: the routes, the WebSocket handler and a
  // mandate's fan-out all have to agree on which carrier a call sid belongs
  // to, or the agent is talking to "unknown".
  const dialled = telephonyContext(scenario.store).dialled;
  const mandatesRepository =
    options.mandatesRepository ?? createDefaultMandatesRepository();
  const repository =
    options.repository ??
    (env.DATABASE_URL
      ? new PostgresAgentRepository(env.DATABASE_URL)
      : new MemoryAgentRepository());
  const createTelephonyCallReference = async (
    context: OutboundCallContext
  ): Promise<OutboundCallReference> => {
    const callToken = createTelephonyCallToken();
    const createdAt = options.now?.() ?? new Date().toISOString();
    await repository.saveTelephonyCallContext({
      tokenHash: hashTelephonyCallToken(callToken),
      organizationId:
        context.organizationId ?? env.VOLTA_DEFAULT_ORGANIZATION_ID,
      operationId: context.operationId,
      carrierId: context.carrierId,
      createdAt,
      expiresAt: telephonyContextExpiry(createdAt)
    });
    return { callToken };
  };
  // A client's quote selection is what authorises the closing call; this
  // places it, reusing the same call-context token mechanism as negotiation
  // calls so the confirmation callback rehydrates on the real TwiML route.
  const confirmationCoordinator =
    options.confirmationCoordinator ??
    createConfirmationCoordinator({
      store: scenario.store,
      telephony: options.telephony ?? createMockTelephonyGateway(),
      now: options.now,
      twimlBaseUrl: env.PUBLIC_BASE_URL,
      createCallReference: createTelephonyCallReference
    });
  const answerer =
    options.answerer ??
    (env.OPENAI_API_KEY
      ? new OpenAIAgentAnswerer(env.OPENAI_API_KEY, env.VOLTA_COPILOT_MODEL)
      : env.VOLTA_MODE === "mock"
        ? new DeterministicAgentAnswerer()
        : new UnavailableAgentAnswerer());
  const quoteExtractor = env.OPENAI_API_KEY
    ? new OpenAIQuoteExtractor(
        env.OPENAI_API_KEY,
        env.VOLTA_QUOTE_EXTRACTION_MODEL
      )
    : undefined;
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
        let processed = 0;
        let completedDuplicates = 0;
        let processingDuplicates = 0;
        const items = receivedKapsoMessages(payload);
        for (const [index, item] of items.entries()) {
          const inbound = inboundKapsoMessage(item);
          if (!inbound) continue;
          const receiptId =
            inbound.id ??
            (idempotencyKey ? `${idempotencyKey}:${index}` : undefined);
          if (receiptId) {
            const claim = await repository.claimInboundMessage(
              "kapso-whatsapp",
              receiptId
            );
            if (claim === "completed") {
              completedDuplicates += 1;
              continue;
            }
            if (claim === "processing") {
              processingDuplicates += 1;
              continue;
            }
          }
          const context: OrganizationContext = {
            organizationId: env.VOLTA_DEFAULT_ORGANIZATION_ID,
            userId: `whatsapp:${inbound.from}`
          };
          try {
            const title = `WhatsApp · ${inbound.from}`;
            const conversation =
              (await agent.listConversations(context)).find(
                (item) =>
                  item.title === title && item.createdBy === context.userId
              ) ?? (await agent.createConversation(context, title));
            const decision =
              inbound.actionDecision ?? whatsappActionDecision(inbound.content);
            let reply: string;
            let replyButtons: Array<{ id: string; title: string }> | undefined;
            if (decision) {
              const decisionContent =
                inbound.content ??
                (decision.decision === "approve" ? "Aprobar" : "Rechazar");
              const currentConversation = await agent.getConversation(
                context,
                conversation.id
              );
              if (!currentConversation)
                throw new Error("conversation_not_found");
              const pendingActions = await whatsappPendingActions(
                repository,
                context,
                currentConversation,
                decision.reference
              );
              await agent.recordChannelMessage(
                context,
                conversation.id,
                "user",
                decisionContent
              );
              if (pendingActions.length !== 1) {
                reply =
                  pendingActions.length === 0
                    ? "No encontré una acción pendiente de este chat que coincida. Revisa la propuesta o escribe tu solicitud de nuevo."
                    : "Hay varias acciones pendientes. Responde APROBAR seguido del código mostrado en la propuesta, por ejemplo: APROBAR 1a2b3c4d.";
              } else {
                const action = await agent.decideAction(
                  context,
                  pendingActions[0].id,
                  decision.decision
                );
                reply = whatsappDecisionReply(action);
              }
              await agent.recordChannelMessage(
                context,
                conversation.id,
                "assistant",
                reply
              );
            } else if (inbound.content) {
              const message = await agent.ask(
                context,
                conversation.id,
                inbound.content
              );
              const pendingActions = message.proposedActions.filter(
                (action) => action.status === "pending"
              );
              const useButtons =
                pendingActions.length === 1 &&
                kapsoMessenger.sendInteractiveButtons !== undefined;
              const instructions = whatsappApprovalInstructions(
                pendingActions,
                useButtons
              );
              if (instructions) {
                await agent.recordChannelMessage(
                  context,
                  conversation.id,
                  "assistant",
                  instructions
                );
              }
              reply = instructions
                ? `${message.content}\n\n${instructions}`
                : message.content;
              if (useButtons && instructions) {
                reply = whatsappInteractiveBody(message.content, instructions);
                replyButtons = [
                  {
                    id: `volta:approve:${pendingActions[0].id}`,
                    title: "Aprobar"
                  },
                  {
                    id: `volta:decline:${pendingActions[0].id}`,
                    title: "Rechazar"
                  }
                ];
              }
            } else {
              reply =
                inbound.type === "audio"
                  ? "No pude transcribir ese audio. Intenta enviarlo de nuevo o escríbeme tu consulta."
                  : "Por ahora puedo responder mensajes de texto o audios que Kapso pueda transcribir.";
            }
            if (replyButtons && kapsoMessenger.sendInteractiveButtons) {
              try {
                await kapsoMessenger.sendInteractiveButtons({
                  to: inbound.from,
                  bodyText: reply,
                  buttons: replyButtons
                });
              } catch (error) {
                console.warn(
                  "Kapso interactive buttons failed; falling back to text",
                  error
                );
                await kapsoMessenger.sendText({
                  to: inbound.from,
                  text: reply
                });
              }
            } else {
              await kapsoMessenger.sendText({
                to: inbound.from,
                text: reply
              });
            }
            if (receiptId) {
              await repository.completeInboundMessage(
                "kapso-whatsapp",
                receiptId
              );
            }
            processed += 1;
          } catch (error) {
            if (receiptId) {
              await repository.releaseInboundMessage(
                "kapso-whatsapp",
                receiptId
              );
            }
            throw error;
          }
        }
        if (processingDuplicates > 0) {
          response.status(503).json({ processing: true });
          return;
        }
        response.status(200).json({
          received: true,
          processed,
          duplicates: completedDuplicates
        });
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
  const quoteSelectionPromptOperations = new Set<string>();
  const sendQuoteSelectionPrompt = async (input: {
    operationId: string;
    occurredAt: string;
  }) => {
    if (quoteSelectionPromptOperations.has(input.operationId)) return;
    const operation = scenario.store.getOperation();
    if (
      operation.id !== input.operationId ||
      operation.status !== "awaiting_client_selection"
    ) {
      return;
    }
    const recipient = whatsappRecipient(operation.mandate.escalationPhone);
    if (!recipient) {
      console.warn(
        `[quotes] ${operation.id} is ready, but no WhatsApp recipient is configured`
      );
      return;
    }
    if (!kapsoMessenger) {
      console.warn(
        `[quotes] ${operation.id} is ready, but Kapso is not configured`
      );
      return;
    }
    const quotes = topApprovedQuotes(operation);
    if (quotes.length === 0) {
      console.warn(
        `[quotes] ${operation.id} has no mandate-approved quote to offer`
      );
      return;
    }

    const context: OrganizationContext = {
      organizationId: activeOrganizationId,
      userId: `whatsapp:${recipient}`
    };
    const title = `WhatsApp · ${recipient}`;
    const conversation =
      (await agent.listConversations(context)).find(
        (item) => item.title === title && item.createdBy === context.userId
      ) ?? (await agent.createConversation(context, title));
    const actions: ProposedAction[] = quotes.map((quote, index) => ({
      id: randomUUID(),
      organizationId: context.organizationId,
      conversationId: conversation.id,
      operationId: operation.id,
      type: "resolve_carrier_selection",
      payload: {
        selectedQuoteId: quote.id,
        rationale: `Opción ${index + 1} enviada automáticamente tras terminar la ronda.`
      },
      status: "pending",
      summary: `Elegir opción ${index + 1}: ${quote.carrierName} por MXN ${quote.priceMxn} para la llamada de cierre.`,
      expectedOperationVersion: operationVersion(operation),
      requestedBy: context.userId,
      createdAt: input.occurredAt
    }));
    await Promise.all(actions.map((action) => repository.saveAction(action)));
    const text = quoteSelectionMessage(operation, quotes, actions);
    const message: AgentMessage = {
      id: randomUUID(),
      conversationId: conversation.id,
      role: "assistant",
      content: text,
      citations: [],
      proposedActions: actions,
      createdAt: input.occurredAt
    };
    await repository.appendMessage(context, message);

    if (kapsoMessenger.sendInteractiveButtons) {
      await kapsoMessenger.sendInteractiveButtons({
        to: recipient,
        bodyText: text,
        buttons: actions.map((action, index) => ({
          id: `volta:approve:${action.id}`,
          title: `Elegir opción ${index + 1}`
        }))
      });
    } else {
      await kapsoMessenger.sendText({ to: recipient, text });
    }
    quoteSelectionPromptOperations.add(operation.id);
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
    try {
      await sendQuoteSelectionPrompt({
        operationId: input.operationId,
        occurredAt: input.occurredAt
      });
    } catch (error) {
      // A notification failure cannot roll back a completed carrier round.
      // The selection remains visible in Volta and the failed outbound send is
      // logged for retry/operations follow-up.
      console.error("[quotes] could not send WhatsApp selection prompt", error);
    }
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

  /**
   * Keeps the stored snapshot honest while a round is running.
   *
   * `operations.snapshot` is what every read outside this process serves, and
   * it was written only when a mandate was created or an approval decided. A
   * call that started, quoted and ended in between left no trace in it, so a
   * restart — routine on Render's free plan — brought the console back showing
   * the round frozen at "in progress" with no quotes, which is exactly what it
   * had been doing.
   *
   * Debounced: a live call publishes several events a second and each write
   * serialises the whole operation.
   */
  const PERSISTED_EVENTS = new Set<OperationEvent["type"]>([
    "call.started",
    "call.updated",
    "call.supervision.changed",
    "quote.registered",
    "deal.reviewed",
    "commitment.finalized"
  ]);
  let snapshotTimer: NodeJS.Timeout | undefined;
  scenario.store.subscribe((event) => {
    if (!PERSISTED_EVENTS.has(event.type) || snapshotTimer) return;
    snapshotTimer = setTimeout(() => {
      snapshotTimer = undefined;
      void repository
        .syncOperation(activeOrganizationId, scenario.store.getOperation())
        .catch((error: unknown) =>
          console.error("[operation] snapshot persist failed:", error)
        );
    }, 1_000);
    snapshotTimer.unref();
  });
  app.locals.operationStore = scenario.store;
  app.locals.publishShipmentEvent = publishShipmentEvent;
  app.locals.telephonyDialled = dialled;
  app.locals.confirmationCoordinator = confirmationCoordinator;
  app.locals.whatsappMessenger = kapsoMessenger;
  app.locals.ensureCarrierDirectory = () =>
    ensureCarrierDirectory(repository, activeOrganizationId);
  // The active operation lives in memory, so a restart used to wipe the
  // mandate the dispatcher had sent. Recovering the most recent one keeps the
  // console usable across deploys without ever inventing a shipment: if the
  // organization has none, the process stays empty and dialling is refused.
  app.locals.restoreActiveOperation = async () => {
    try {
      const operations = await repository.listOperations({
        organizationId: activeOrganizationId,
        userId: "system"
      });
      const latest = operations[0];
      if (!latest) {
        console.log(
          "[operation] no mandate on record; waiting for one before dialling"
        );
        return;
      }
      scenario.store.replaceOperation(latest);
      console.log(
        `[operation] restored ${latest.id}: ${latest.origin} -> ${latest.destination}`
      );
    } catch (error) {
      console.error("[operation] could not restore the last mandate:", error);
    }
  };
  app.locals.listTranscript = (callId?: string, limit?: number) =>
    repository.listTranscript(activeOrganizationId, callId, limit);
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
    session: import("@volta/contracts").CallSession,
    organizationId = activeOrganizationId
  ) => repository.saveCallSession(organizationId, session);
  const persistedCallStores = new Map<
    string,
    Promise<OperationStore | undefined>
  >();
  /**
   * An operation this instance is not currently serving, loaded into a store
   * of its own that writes every change back. Cached per operation so several
   * calls of the same round share one.
   */
  const persistedCallStore = async (
    organizationId: string,
    operationId: string
  ): Promise<OperationStore | undefined> => {
    const key = `${organizationId}:${operationId}`;
    let pending = persistedCallStores.get(key);
    if (!pending) {
      pending = (async () => {
        const operation = await repository.getOperation(
          { organizationId, userId: "twilio" },
          operationId
        );
        if (!operation) return undefined;
        const callStore = createOperationStore(operation);
        let persistence = Promise.resolve();
        callStore.subscribe((event) => {
          if (event.type === "transcript.appended") return;
          persistence = persistence
            .then(() =>
              repository.syncOperation(organizationId, callStore.getOperation())
            )
            .catch((error: unknown) =>
              console.error("[twilio] operation persistence failed:", error)
            );
        });
        return callStore;
      })();
      persistedCallStores.set(key, pending);
    }

    const callStore = await pending;
    if (!callStore) persistedCallStores.delete(key);
    return callStore;
  };

  /**
   * The shipment a call belongs to, found by its Twilio sid alone.
   *
   * The last way back when a callback carries no resolvable context. A call
   * that was adopted by an operation other than the one that dialled it —
   * which is what an inbound leg or a lost call token produces — is otherwise
   * unreachable, and the console shows it running long after it ended.
   */
  const resolveTelephonyCallBySid = async (callSid: string) => {
    const operationId = await repository.findOperationIdByCallSid(
      activeOrganizationId,
      callSid
    );
    if (!operationId) return undefined;
    if (operationId === scenario.store.getOperation().id) {
      return {
        store: scenario.store,
        context: { operationId, organizationId: activeOrganizationId },
        organizationId: activeOrganizationId
      };
    }
    const callStore = await persistedCallStore(
      activeOrganizationId,
      operationId
    );
    if (!callStore) return undefined;
    console.warn(
      `[twilio] call=${callSid} belongs to operation=${operationId}, not the one this instance is serving`
    );
    return {
      store: callStore,
      context: { operationId, organizationId: activeOrganizationId },
      organizationId: activeOrganizationId
    };
  };

  const resolveTelephonyCallContext = async (
    reference: OutboundCallReference
  ) => {
    // A callback from a previous build names the operation directly. Serving
    // it from the instance's current store is what the code did before tokens
    // existed, and it keeps a call that is already ringing alive.
    if (!reference.callToken && reference.operationId) {
      const current = scenario.store.getOperation();
      if (current.id !== reference.operationId) return undefined;
      return {
        store: scenario.store,
        context: {
          organizationId: activeOrganizationId,
          operationId: current.id
        },
        organizationId: activeOrganizationId
      };
    }

    const durableContext = await repository.getTelephonyCallContext(
      hashTelephonyCallToken(reference.callToken)
    );
    if (!durableContext) return undefined;
    const organizationId = durableContext.organizationId;
    const current = scenario.store.getOperation();
    if (
      current.id === durableContext.operationId &&
      organizationId === activeOrganizationId
    ) {
      return {
        store: scenario.store,
        context: durableContext,
        organizationId,
        carrier: durableContext.carrierId
          ? current.candidates.find(
              (candidate) => candidate.id === durableContext.carrierId
            )
          : undefined
      };
    }

    const callStore = await persistedCallStore(
      organizationId,
      durableContext.operationId
    );
    if (!callStore) return undefined;
    const operation = callStore.getOperation();
    return {
      store: callStore,
      context: durableContext,
      organizationId,
      carrier: durableContext.carrierId
        ? operation.candidates.find(
            (candidate) => candidate.id === durableContext.carrierId
          )
        : undefined
    };
  };
  app.locals.resolveTelephonyCallContext = resolveTelephonyCallContext;
  app.locals.resolveTelephonyCallBySid = resolveTelephonyCallBySid;
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

  const launchMandate = async (
    context: OrganizationContext,
    input: unknown
  ) => {
    const mandate = await persistMandate(mandatesRepository, input);
    try {
      activeOrganizationId = context.organizationId;
      const carriers = await repository.listCarriers(context.organizationId);
      const operation = createOperationFromMandate(
        mandate,
        `operation-${mandate.id}`
      );
      // A mandate created through WhatsApp must return to the same dispatcher.
      // Dashboard-created mandates use the configured operations number.
      const recipient = selectionRecipient(context);
      if (recipient) operation.mandate.escalationPhone = recipient;
      const active = carriers
        .filter((carrier) => carrier.active)
        .map(({ id, name, phone }) => ({ id, name, phone }));
      if (active.length === 0) {
        console.warn(
          "[mandates] no active carriers in the directory; falling back to the seeded pool"
        );
      }
      operation.candidates = active.length > 0 ? active : seedCarriers();
      // Persisted before the store is switched, not after.
      //
      // `replaceOperation` is what makes this instance serve the mandate, and
      // doing it first meant a failed write left the process negotiating an
      // operation that exists in no snapshot. Every call it then answered —
      // including inbound ones, which have no call context to resolve and fall
      // back to whatever the instance holds — was filed against a shipment the
      // console cannot fetch, so the floor showed a round stuck at
      // "in progress" while the real conversation happened somewhere invisible.
      await repository.syncOperation(context.organizationId, operation);
      scenario.store.replaceOperation(operation);
      const telephony = telephonyContext(scenario.store);
      telephony.resetAuction();
      console.log(
        `[mandates] dialling ${operation.candidates.length}: ${operation.candidates
          .map((candidate) => candidate.name)
          .join(", ")}`
      );
      await fanOutCalls({
        store: scenario.store,
        organizationId: context.organizationId,
        mode: env.VOLTA_MODE,
        publicBaseUrl: env.PUBLIC_BASE_URL,
        from: env.TWILIO_FROM_NUMBER,
        gateway:
          options.telephony ??
          (env.VOLTA_MODE === "live"
            ? createLiveTelephonyGateway()
            : undefined),
        createCallReference: createTelephonyCallReference,
        // Opens the agent's session while the phone rings instead of after the
        // carrier answers. This is the path the console dials from, so leaving
        // it out is what keeps the first greeting slow.
        prewarm: ({ reference, carrier }) =>
          warmOutboundCall({
            store: scenario.store,
            organizationId: context.organizationId,
            callToken: reference.callToken,
            carrier
          }),
        timeLimitSeconds: env.CALL_TIME_LIMIT_SECONDS,
        record: env.TWILIO_RECORD_CALLS,
        detectAnsweringMachine: env.TWILIO_HANGUP_ON_MACHINE,
        onDialled: (callId, carrier) => {
          telephony.dialled.set(callId, carrier);
          telephony.auction.startCall(carrier.id, callId);
        },
        onRoundReviewed: publishQuotesReady
      });
      await persistCallSessions(context);
      await persistCurrentOperation(context);
      return scenario.store.getOperation();
    } catch (error) {
      console.error("Mandate was saved but activation failed", {
        mandateId: mandate.id,
        error
      });
      throw new Error("mandate_saved_activation_failed", { cause: error });
    }
  };

  const agent = createOperationalAgent({
    repository,
    answerer,
    getCurrentOperation: () => scenario.store.getOperation(),
    executeCreateMandate: async (input, context) => {
      await launchMandate(context, input);
      return true;
    },
    resolveCarrierSelection: async (input) => {
      const recapRecipient = input.decidedBy.startsWith("whatsapp:")
        ? input.decidedBy.slice("whatsapp:".length)
        : undefined;
      try {
        await confirmationCoordinator.start(
          scenario.store.getOperation().id,
          input.selectedQuoteId,
          { recapRecipient }
        );
        return true;
      } catch (error) {
        console.error("Carrier selection confirmation failed", error);
        return false;
      }
    }
  });

  app.get("/health", (_request, response) => {
    response.status(200).json({ status: "ok", mode: env.VOLTA_MODE });
  });
  const operationReadModel = (operation: Operation): OperationReadModel => ({
    ...operation,
    pipelineStage: derivePipelineStage(operation)
  });

  const operationStoreForDashboard = async (
    context: OrganizationContext,
    operationId: string
  ) => {
    const current = scenario.store.getOperation();
    if (
      current.id === operationId &&
      context.organizationId === activeOrganizationId
    ) {
      return scenario.store;
    }
    const operation = await repository.getOperation(context, operationId);
    return operation ? createOperationStore(operation) : undefined;
  };

  app.get("/api/operation", (_request, response) => {
    response
      .status(200)
      .json(operationReadModel(scenario.store.getOperation()));
  });
  app.get("/api/operations", async (request, response) => {
    const context = contextFromRequest(request, response);
    if (!context) return;
    try {
      const operations = await repository.listOperations(context);
      const current = scenario.store.getOperation();
      // Storage may not have caught up with a round already in flight, so the
      // in-memory operation stands in for it. A process without a mandate has
      // nothing to stand in with, and pushing the placeholder would draw a
      // phantom mandate in the console's deck.
      if (
        context.organizationId === activeOrganizationId &&
        operations.length === 0 &&
        hasMandate(current)
      ) {
        operations.push(current);
      }
      response.status(200).json(operations.map(operationReadModel));
    } catch (error) {
      storageFailure(response, error);
    }
  });
  app.get("/api/operations/:operationId", async (request, response) => {
    const context = contextFromRequest(request, response);
    if (!context) return;
    try {
      const store = await operationStoreForDashboard(
        context,
        request.params.operationId
      );
      if (!store) {
        response.status(404).json({ error: "operation_not_found" });
        return;
      }
      response.status(200).json(operationReadModel(store.getOperation()));
    } catch (error) {
      storageFailure(response, error);
    }
  });
  app.get("/api/quote-extractions", async (request, response) => {
    const context = contextFromRequest(request, response);
    if (!context) return;
    try {
      response.status(200).json(await repository.listQuoteExtractions(context));
    } catch (error) {
      storageFailure(response, error);
    }
  });
  app.post("/api/mandates", async (request, response) => {
    try {
      const context = contextFromRequest(request, response);
      if (!context) return;
      const operation = await launchMandate(context, request.body);
      response.status(201).json(operationReadModel(operation));
    } catch (error) {
      if (error instanceof InvalidMandateError) {
        response.status(400).json({
          error: error.code,
          fieldErrors: error.fieldErrors
        });
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
    onCallSessionChanged: (session, organizationId) =>
      void repository.saveCallSession(
        organizationId ?? activeOrganizationId,
        session
      ),
    onTranscriptAppended: (segment) =>
      app.locals.saveTranscriptSegment(segment),
    // The console's carrier directory is what a round dials.
    listActiveCarriers: () => app.locals.listActiveCarriers(),
    listTranscript: (callId?: string, limit?: number) =>
      repository.listTranscript(activeOrganizationId, callId, limit),
    createCallReference: createTelephonyCallReference,
    resolveCallContext: resolveTelephonyCallContext,
    resolveCallBySid: resolveTelephonyCallBySid,
    onCallCompleted: (callId, operationId) => {
      if (!quoteExtractor) return;
      void (async () => {
        const segments = await repository.listTranscript(
          activeOrganizationId,
          callId
        );
        const now = new Date().toISOString();
        const result = await quoteExtractor.extract(
          segments
            .map(
              (segment) =>
                `${segment.createdAt}: ${segment.speaker}: ${segment.text}`
            )
            .join("\n")
        );
        await repository.saveQuoteExtraction({
          id: `quote-extraction-${callId}`,
          organizationId: activeOrganizationId,
          operationId,
          callId,
          finalPriceMxn: result.finalPriceMxn,
          currency: result.currency,
          agreedAt: result.agreedAt,
          summary: result.summary,
          status: result.finalPriceMxn === null ? "unavailable" : "completed",
          model: env.VOLTA_QUOTE_EXTRACTION_MODEL,
          createdAt: now,
          completedAt: now
        });
      })().catch((error) => console.error("[quote-extraction] failed", error));
    }
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
    const missing = seedCarriers().filter(
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
    onCallSessionChanged: (session, organizationId) =>
      void app.locals.saveCallSession(session, organizationId),
    onTranscriptAppended: (segment) =>
      app.locals.saveTranscriptSegment(segment),
    // The console's carrier directory is what a round dials.
    listActiveCarriers: () => app.locals.listActiveCarriers(),
    listTranscript: (callId?: string, limit?: number) =>
      app.locals.listTranscript(callId, limit),
    resolveCallContext: (reference) =>
      app.locals.resolveTelephonyCallContext(reference),
    resolveCallBySid: (callSid) =>
      app.locals.resolveTelephonyCallBySid(callSid),
    confirmationCoordinator: app.locals.confirmationCoordinator,
    whatsappMessenger: app.locals.whatsappMessenger
  });

  void app.locals.ensureCarrierDirectory?.();
  // Awaited: until this resolves the instance does not know which mandate it
  // holds, and a Twilio callback arriving in that window is filed against
  // whatever the store happens to contain.
  await app.locals.restoreActiveOperation?.();

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
