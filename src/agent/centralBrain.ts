import { randomUUID } from "node:crypto";
import type {
  AgentActivity,
  CreateMandateRequest,
  EvidenceCitation,
  Operation,
  ProposedAction
} from "@volta/contracts";
import { z } from "zod";

import { evaluateMandate } from "../core/mandate";
import { derivePipelineStage } from "../core/pipeline";
import {
  type AgentRepository,
  type OrganizationContext,
  operationCitations,
  operationVersion
} from "./repository";

const evidenceTypes = z.enum([
  "operation",
  "shipment_event",
  "quote",
  "approval",
  "call",
  "transcript",
  "commitment",
  "escalation"
]);

const searchSchema = z.object({
  query: z.string().trim().min(1).max(500),
  operationId: z.string().trim().min(1).nullable(),
  sourceTypes: z.array(evidenceTypes).max(8).nullable()
});
const operationSchema = z.object({
  operationId: z.string().trim().min(1)
});
const attentionSchema = z.object({
  operationId: z.string().trim().min(1).nullable()
});
const selectionSchema = z.object({
  approvalId: z.string().trim().min(1),
  selectedQuoteId: z.string().trim().min(1),
  rationale: z.string().trim().min(1).max(500).nullable()
});
const mandateSchema = z
  .object({
    budget_cap: z
      .number()
      .finite()
      .positive()
      .describe("Presupuesto máximo expresado exclusivamente en MXN"),
    destination_datetime: z
      .string()
      .datetime({ offset: true })
      .describe("Fecha y hora exacta de entrega en ISO 8601 con zona horaria"),
    destination_place: z.string().trim().min(1),
    type_of_content: z.string().trim().min(1),
    weight: z
      .number()
      .finite()
      .positive()
      .describe("Peso total expresado en kilogramos"),
    measures: z.string().trim().min(1),
    pickup_address: z.string().trim().min(1),
    pickup_datetime: z
      .string()
      .datetime({ offset: true })
      .describe(
        "Fecha y hora exacta de recolección en ISO 8601 con zona horaria"
      )
  })
  .superRefine((value, context) => {
    if (
      Date.parse(value.pickup_datetime) >=
      Date.parse(value.destination_datetime)
    ) {
      context.addIssue({
        code: "custom",
        message: "pickup_datetime must be before destination_datetime",
        path: ["pickup_datetime"]
      });
    }
  });
const noArgumentsSchema = z.object({});

export type CentralBrainToolResult = {
  output: unknown;
  citations: EvidenceCitation[];
  proposedAction?: ProposedAction;
};

export type CentralBrainTool = {
  name:
    | "search_operational_records"
    | "get_operation_snapshot"
    | "list_attention_items"
    | "compare_quotes"
    | "propose_create_mandate"
    | "propose_carrier_selection"
    | "propose_close_approved_deal";
  description: string;
  parameters: z.ZodType;
  activity: AgentActivity;
  execute(argumentsValue: unknown): Promise<CentralBrainToolResult>;
};

export type CentralBrainDependencies = {
  context: OrganizationContext;
  conversationId: string;
  repository: AgentRepository;
  getCurrentOperation(): Operation;
  now(): string;
};

export function createCentralBrainTools({
  context,
  conversationId,
  repository,
  getCurrentOperation,
  now
}: CentralBrainDependencies): CentralBrainTool[] {
  return [
    {
      name: "search_operational_records",
      description:
        "Busca hechos autorizados en operaciones, hitos, llamadas, transcripciones, cotizaciones, aprobaciones y compromisos.",
      parameters: searchSchema,
      activity: {
        stage: "searching_records",
        label: "Searching operational records"
      },
      async execute(argumentsValue) {
        const parsed = searchSchema.safeParse(argumentsValue);
        if (!parsed.success) return invalidArguments();
        let citations = await repository.searchEvidence(
          context,
          parsed.data.query
        );
        if (parsed.data.operationId !== null) {
          citations = citations.filter(
            (item) => item.operationId === parsed.data.operationId
          );
        }
        if (parsed.data.sourceTypes !== null) {
          citations = citations.filter((item) =>
            parsed.data.sourceTypes?.includes(item.sourceType)
          );
        }
        return {
          output: citations.map(modelEvidence),
          citations
        };
      }
    },
    {
      name: "get_operation_snapshot",
      description:
        "Obtiene el estado autoritativo de una operación concreta, incluyendo mandato, llamadas, cotizaciones y decisiones.",
      parameters: operationSchema,
      activity: {
        stage: "reviewing_operation",
        label: "Reviewing operation state"
      },
      async execute(argumentsValue) {
        const parsed = operationSchema.safeParse(argumentsValue);
        if (!parsed.success) return invalidArguments();
        const operation = await repository.getOperation(
          context,
          parsed.data.operationId
        );
        if (!operation) return notFound("operation_not_found");
        const citations = operationCitations(operation);
        return {
          output: operationSnapshot(operation),
          citations
        };
      }
    },
    {
      name: "list_attention_items",
      description:
        "Lista bloqueos y pendientes operativos: aprobaciones, escalaciones, llamadas fallidas y rondas sin oferta válida.",
      parameters: attentionSchema,
      activity: {
        stage: "reviewing_attention",
        label: "Reviewing items that need attention"
      },
      async execute(argumentsValue) {
        const parsed = attentionSchema.safeParse(argumentsValue);
        if (!parsed.success) return invalidArguments();
        let operations = await repository.listOperations(context);
        if (parsed.data.operationId !== null) {
          operations = operations.filter(
            (item) => item.id === parsed.data.operationId
          );
        }
        const items = operations.flatMap(attentionItems);
        const evidenceIds = new Set(items.map((item) => item.evidenceId));
        const citations = operations
          .flatMap(operationCitations)
          .filter((item) => evidenceIds.has(item.id));
        return { output: items, citations };
      }
    },
    {
      name: "compare_quotes",
      description:
        "Compara las cotizaciones reales de una operación contra precio, pickup y ETA del mandato.",
      parameters: operationSchema,
      activity: {
        stage: "comparing_quotes",
        label: "Comparing carrier quotes"
      },
      async execute(argumentsValue) {
        const parsed = operationSchema.safeParse(argumentsValue);
        if (!parsed.success) return invalidArguments();
        const operation = await repository.getOperation(
          context,
          parsed.data.operationId
        );
        if (!operation) return notFound("operation_not_found");
        const quotes = operation.quotes
          .map((quote) => ({
            quote,
            mandateDecision: evaluateMandate(operation.mandate, {
              price: quote.priceMxn,
              pickupTime: quote.pickupTime
            })
          }))
          .sort((left, right) => {
            const leftApproved =
              left.mandateDecision.status === "APPROVED" ? 0 : 1;
            const rightApproved =
              right.mandateDecision.status === "APPROVED" ? 0 : 1;
            return (
              leftApproved - rightApproved ||
              left.quote.priceMxn - right.quote.priceMxn ||
              // Transit time is optional; a quote without one ranks last on
              // this tiebreak rather than sorting as if it were instant.
              (left.quote.etaMinutes ?? Number.MAX_SAFE_INTEGER) -
                (right.quote.etaMinutes ?? Number.MAX_SAFE_INTEGER)
            );
          });
        const citationByQuote = new Map(
          operationCitations(operation)
            .filter((item) => item.sourceType === "quote")
            .map((item) => [item.sourceId, item])
        );
        const citations = quotes.flatMap(({ quote }) => {
          const citation = citationByQuote.get(quote.id);
          return citation ? [citation] : [];
        });
        return {
          output: quotes.map(({ quote, mandateDecision }) => ({
            id: quote.id,
            carrier: quote.carrierName,
            priceMxn: quote.priceMxn,
            etaMinutes: quote.etaMinutes,
            pickupTime: quote.pickupTime,
            mandateStatus: mandateDecision.status,
            mandateReason:
              mandateDecision.status === "APPROVED"
                ? undefined
                : mandateDecision.reason,
            evidenceId: citationByQuote.get(quote.id)?.id
          })),
          citations
        };
      }
    },
    {
      name: "propose_create_mandate",
      description:
        "Prepara para aprobación humana un mandato completo con exactamente los ocho campos de CreateMandateRequest. El presupuesto debe estar confirmado en MXN, el peso en kg y las fechas deben ser ISO 8601 exactas con zona horaria. Nunca crea la operación por sí sola.",
      parameters: mandateSchema,
      activity: {
        stage: "preparing_action",
        label: "Preparing mandate creation"
      },
      async execute(argumentsValue) {
        const parsed = mandateSchema.safeParse(argumentsValue);
        if (!parsed.success) return invalidArguments();
        const conversation = await repository.getConversation(
          context,
          conversationId
        );
        if (
          !conversation ||
          !conversation.messages.some(
            (message) =>
              message.role === "user" &&
              confirmsNumericMxnBudget(message.content, parsed.data.budget_cap)
          )
        ) {
          return {
            output: {
              error: "budget_not_confirmed",
              message:
                "Ask the user for an explicit numeric budget in MXN before proposing the mandate."
            },
            citations: []
          };
        }
        const operation = getCurrentOperation();
        const payload: CreateMandateRequest = parsed.data;
        const action: ProposedAction = {
          id: randomUUID(),
          organizationId: context.organizationId,
          conversationId,
          operationId: operation.id,
          type: "create_mandate",
          payload,
          status: "pending",
          summary: `Crear mandato ${payload.pickup_address} → ${payload.destination_place}, retiro ${payload.pickup_datetime}, entrega ${payload.destination_datetime}, tope MXN ${payload.budget_cap}.`,
          expectedOperationVersion: operationVersion(operation),
          requestedBy: context.userId,
          createdAt: now()
        };
        await repository.saveAction(action);
        return {
          output: {
            status: "approval_required",
            actionId: action.id,
            summary: action.summary,
            mandate: payload
          },
          citations: [],
          proposedAction: action
        };
      }
    },
    {
      name: "propose_carrier_selection",
      description:
        "Prepara para aprobación humana la selección de una cotización pendiente de la operación activa. Nunca selecciona por sí sola.",
      parameters: selectionSchema,
      activity: {
        stage: "preparing_action",
        label: "Preparing carrier selection"
      },
      async execute(argumentsValue) {
        const parsed = selectionSchema.safeParse(argumentsValue);
        if (!parsed.success) return invalidArguments();
        const operation = getCurrentOperation();
        const approval = operation.approvals.find(
          (item) => item.id === parsed.data.approvalId
        );
        if (!approval || approval.status !== "pending") {
          return notFound("pending_approval_not_found");
        }
        if (
          approval.type !== "carrier_selection" ||
          !approval.quoteIds.includes(parsed.data.selectedQuoteId)
        ) {
          return notFound("quote_not_allowed");
        }
        const quote = operation.quotes.find(
          (item) => item.id === parsed.data.selectedQuoteId
        );
        if (!quote) return notFound("quote_not_found");
        const action: ProposedAction = {
          id: randomUUID(),
          organizationId: context.organizationId,
          conversationId,
          operationId: operation.id,
          type: "resolve_carrier_selection",
          payload: {
            approvalId: approval.id,
            selectedQuoteId: quote.id,
            ...(parsed.data.rationale
              ? { rationale: parsed.data.rationale }
              : {})
          },
          status: "pending",
          summary: `Seleccionar ${quote.carrierName} por MXN ${quote.priceMxn} para la llamada de cierre.`,
          expectedOperationVersion: operationVersion(operation),
          requestedBy: context.userId,
          createdAt: now()
        };
        await repository.saveAction(action);
        const citations = operationCitations(operation).filter(
          (item) => item.sourceId === approval.id || item.sourceId === quote.id
        );
        return {
          output: {
            status: "approval_required",
            actionId: action.id,
            summary: action.summary
          },
          citations,
          proposedAction: action
        };
      }
    },
    {
      name: "propose_close_approved_deal",
      description:
        "Prepara para aprobación humana la llamada de cierre de términos que ya tienen autorización exacta.",
      parameters: noArgumentsSchema,
      activity: {
        stage: "preparing_action",
        label: "Preparing approved closing call"
      },
      async execute(argumentsValue) {
        const parsed = noArgumentsSchema.safeParse(argumentsValue ?? {});
        if (!parsed.success) return invalidArguments();
        const operation = getCurrentOperation();
        if (!operation.closingAuthorization || operation.commitment) {
          return notFound("closing_authorization_not_available");
        }
        const action: ProposedAction = {
          id: randomUUID(),
          organizationId: context.organizationId,
          conversationId,
          operationId: operation.id,
          type: "close_approved_deal",
          payload: {},
          status: "pending",
          summary:
            "Realizar la llamada de cierre con los términos ya autorizados.",
          expectedOperationVersion: operationVersion(operation),
          requestedBy: context.userId,
          createdAt: now()
        };
        await repository.saveAction(action);
        return {
          output: {
            status: "approval_required",
            actionId: action.id,
            summary: action.summary
          },
          citations: operationCitations(operation).filter(
            (item) =>
              item.sourceId === operation.closingAuthorization?.approvalId
          ),
          proposedAction: action
        };
      }
    }
  ];
}

function confirmsNumericMxnBudget(content: string, expected: number) {
  const normalized = content
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
  const currency = "(?:mxn|pesos?\\s+mexicanos?)";
  const patterns = [
    new RegExp(`${currency}\\s*\\$?\\s*(\\d[\\d.,\\s]*)`, "g"),
    new RegExp(`\\$?\\s*(\\d[\\d.,\\s]*)\\s*${currency}`, "g")
  ];
  return patterns.some((pattern) =>
    [...normalized.matchAll(pattern)].some((match) => {
      const amount = match[1]?.replace(/\s/g, "");
      if (!amount) return false;
      const interpretations = [
        amount,
        amount.replace(/,/g, ""),
        amount.replace(/\./g, ""),
        amount.replace(/,/g, "."),
        amount.replace(/[.,]/g, "")
      ];
      return interpretations.some((value) => Number(value) === expected);
    })
  );
}

function operationSnapshot(operation: Operation) {
  return {
    id: operation.id,
    containerId: operation.containerId,
    shipper: operation.shipper,
    route: `${operation.origin} → ${operation.destination}`,
    status: operation.status,
    pipelineStage: derivePipelineStage(operation),
    mandate: operation.mandate,
    calls: operation.callSessions,
    quotes: operation.quotes,
    approvals: operation.approvals,
    closingAuthorization: operation.closingAuthorization,
    commitment: operation.commitment,
    escalations: operation.escalations
  };
}

function attentionItems(operation: Operation) {
  const citations = operationCitations(operation);
  const items: Array<{
    operationId: string;
    type: string;
    summary: string;
    evidenceId: string;
  }> = [];
  for (const approval of operation.approvals.filter(
    (item) => item.status === "pending"
  )) {
    items.push({
      operationId: operation.id,
      type: "pending_approval",
      summary: `${approval.type} requires a dispatcher decision`,
      evidenceId: `approval:${approval.id}`
    });
  }
  for (const escalation of operation.escalations.filter(
    (item) => item.status !== "resolved"
  )) {
    items.push({
      operationId: operation.id,
      type: "open_escalation",
      summary: escalation.reason,
      evidenceId: `escalation:${escalation.id}`
    });
  }
  for (const call of operation.callSessions.filter(
    (item) => item.status === "failed"
  )) {
    const callEvidence = citations.find(
      (item) => item.sourceType === "call" && item.sourceId === call.id
    );
    items.push({
      operationId: operation.id,
      type: "failed_call",
      summary: call.endedReason ?? "Carrier call failed",
      evidenceId: callEvidence?.id ?? `operation:${operation.id}`
    });
  }
  const finishedRound =
    operation.callSessions.length > 0 &&
    operation.callSessions.every(
      (item) => item.status === "completed" || item.status === "failed"
    );
  const approvedQuotes = operation.quotes.filter(
    (quote) =>
      evaluateMandate(operation.mandate, {
        price: quote.priceMxn,
        pickupTime: quote.pickupTime
      }).status === "APPROVED"
  );
  if (finishedRound && approvedQuotes.length === 0) {
    items.push({
      operationId: operation.id,
      type: "no_valid_quote",
      summary: "The completed quote round has no mandate-compliant offer",
      evidenceId: `operation:${operation.id}`
    });
  }
  return items;
}

function modelEvidence(citation: EvidenceCitation) {
  return {
    id: citation.id,
    operationId: citation.operationId,
    sourceType: citation.sourceType,
    title: citation.title,
    excerpt: citation.excerpt,
    occurredAt: citation.occurredAt
  };
}

function invalidArguments(): CentralBrainToolResult {
  return { output: { error: "invalid_arguments" }, citations: [] };
}

function notFound(error: string): CentralBrainToolResult {
  return { output: { error }, citations: [] };
}
