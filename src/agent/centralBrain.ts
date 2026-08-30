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
    | "propose_carrier_selection";
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
        const userMessages = conversation.messages
          .filter((message) => message.role === "user")
          .map((message) => message.content);
        const missingAddress = userMessages
          .flatMap((content, messageIndex) =>
            addressesIn(content).map((address) => ({ address, messageIndex }))
          )
          .find(({ address, messageIndex }) => {
            const confirmedEndpoint = confirmedAddressEndpoint(
              userMessages,
              messageIndex
            );
            const preserved = confirmedEndpoint
              ? fieldPreservesAddress(
                  parsed.data[
                    confirmedEndpoint === "pickup"
                      ? "pickup_address"
                      : "destination_place"
                  ],
                  address
                )
              : payloadPreservesAddress(parsed.data, address);
            return (
              !preserved &&
              !payloadContainsLaterAddressReplacement(
                parsed.data,
                userMessages,
                messageIndex
              )
            );
          });
        if (missingAddress) {
          return {
            output: {
              error: "address_not_preserved",
              message: `The proposed mandate omits the still-active address "${missingAddress.address}". Preserve it in its confirmed endpoint, or ask whether a later place explicitly replaces it. Do not ask for the endpoint again if the user already confirmed it.`
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
        "Prepara para aprobación humana la selección de una cotización aprobada por el mandato de la operación activa. Nunca selecciona por sí sola.",
      parameters: selectionSchema,
      activity: {
        stage: "preparing_action",
        label: "Preparing carrier selection"
      },
      async execute(argumentsValue) {
        const parsed = selectionSchema.safeParse(argumentsValue);
        if (!parsed.success) return invalidArguments();
        const operation = getCurrentOperation();
        if (
          operation.status !== "awaiting_client_selection" &&
          operation.status !== "carrier_selected"
        ) {
          return notFound("selection_not_allowed");
        }
        const reviewedDeal = operation.reviewedDeals.find(
          (deal) =>
            deal.quoteId === parsed.data.selectedQuoteId &&
            deal.mandateDecision === "APPROVED"
        );
        if (!reviewedDeal) return notFound("quote_not_reviewed");
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
          (item) => item.sourceId === quote.id
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
  const digitsMatch = patterns.some((pattern) =>
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
  if (digitsMatch) return true;

  return spokenMxnAmounts(normalized).includes(expected);
}

const spanishNumberValues: Record<string, number> = {
  cero: 0,
  un: 1,
  uno: 1,
  una: 1,
  dos: 2,
  tres: 3,
  cuatro: 4,
  cinco: 5,
  seis: 6,
  siete: 7,
  ocho: 8,
  nueve: 9,
  diez: 10,
  once: 11,
  doce: 12,
  trece: 13,
  catorce: 14,
  quince: 15,
  dieciseis: 16,
  diecisiete: 17,
  dieciocho: 18,
  diecinueve: 19,
  veinte: 20,
  veintiuno: 21,
  veintidos: 22,
  veintitres: 23,
  veinticuatro: 24,
  veinticinco: 25,
  veintiseis: 26,
  veintisiete: 27,
  veintiocho: 28,
  veintinueve: 29,
  treinta: 30,
  cuarenta: 40,
  cincuenta: 50,
  sesenta: 60,
  setenta: 70,
  ochenta: 80,
  noventa: 90,
  cien: 100,
  ciento: 100,
  doscientos: 200,
  trescientos: 300,
  cuatrocientos: 400,
  quinientos: 500,
  seiscientos: 600,
  setecientos: 700,
  ochocientos: 800,
  novecientos: 900
};

function spokenMxnAmounts(content: string): number[] {
  const tokens = content.match(/[a-z]+/g) ?? [];
  const amounts: number[] = [];

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    const isMxn = token === "mxn";
    const isPesosMexicanos =
      (token === "peso" || token === "pesos") &&
      /^(?:mexicano|mexicanos|mexicana|mexicanas)$/.test(
        tokens[index + 1] ?? ""
      );
    if (!isMxn && !isPesosMexicanos) continue;

    const currencyEnd = isPesosMexicanos ? index + 1 : index;
    const before = contiguousNumberTokens(tokens, index - 1, -1).reverse();
    const after = contiguousNumberTokens(tokens, currencyEnd + 1, 1);
    for (const candidate of [before, after]) {
      const amount = parseSpanishCardinal(candidate);
      if (amount !== undefined) amounts.push(amount);
    }
  }

  return amounts;
}

function contiguousNumberTokens(
  tokens: string[],
  start: number,
  direction: -1 | 1
): string[] {
  const found: string[] = [];
  for (
    let index = start;
    index >= 0 && index < tokens.length && found.length < 12;
    index += direction
  ) {
    const token = tokens[index];
    if (!isSpanishNumberToken(token)) break;
    found.push(token);
  }
  return found;
}

function isSpanishNumberToken(token: string): boolean {
  return (
    token === "y" ||
    token === "mil" ||
    token === "millon" ||
    token === "millones" ||
    token in spanishNumberValues
  );
}

function parseSpanishCardinal(tokens: string[]): number | undefined {
  if (tokens.length === 0 || tokens[0] === "y" || tokens.at(-1) === "y")
    return undefined;

  let millions = 0;
  let thousands = 0;
  let current = 0;
  let consumed = false;

  for (const token of tokens) {
    if (token === "y") continue;
    if (token === "millon" || token === "millones") {
      millions += (current || 1) * 1_000_000;
      current = 0;
      consumed = true;
      continue;
    }
    if (token === "mil") {
      thousands += (current || 1) * 1_000;
      current = 0;
      consumed = true;
      continue;
    }
    const value = spanishNumberValues[token];
    if (value === undefined) return undefined;
    current += value;
    consumed = true;
  }

  return consumed ? millions + thousands + current : undefined;
}

function addressesIn(content: string): string[] {
  const normalized = content
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
  return [
    ...normalized.matchAll(
      /\b(?:carrera|calle|avenida|diagonal|transversal)\s+[^,.;\n]{2,80}/g
    )
  ].map((match) =>
    (match[0] ?? "").replace(
      /\s+(?:a\s+las|para\s+el|el\s+dia|con\s+entrega)\b.*$/,
      ""
    )
  );
}

function payloadPreservesAddress(
  payload: CreateMandateRequest,
  address: string
): boolean {
  return fieldPreservesAddress(
    `${payload.pickup_address} ${payload.destination_place}`,
    address
  );
}

function fieldPreservesAddress(field: string, address: string): boolean {
  const endpointTokens = new Set(
    normalizeForComparison(field).match(/[a-z0-9]+/g) ?? []
  );
  const significant = (address.match(/[a-z0-9]+/g) ?? []).filter(
    (token) => !["de", "del", "la", "el", "numero", "nro"].includes(token)
  );
  return (
    significant.length > 0 &&
    significant.every((token) => endpointTokens.has(token))
  );
}

type AddressEndpoint = "pickup" | "destination";

function confirmedAddressEndpoint(
  messages: string[],
  addressMessageIndex: number
): AddressEndpoint | undefined {
  for (const content of messages.slice(addressMessageIndex + 1)) {
    if (isExplicitAddressReplacement(content)) return undefined;
    const endpoint = standaloneEndpointConfirmation(content);
    if (endpoint) return endpoint;
  }
  return undefined;
}

function payloadContainsLaterAddressReplacement(
  payload: CreateMandateRequest,
  messages: string[],
  addressMessageIndex: number
): boolean {
  const laterMessages = messages.slice(addressMessageIndex + 1);
  return laterMessages.some((content, replacementIndex) => {
    if (!isExplicitAddressReplacement(content)) return false;
    const normalized = normalizeForComparison(content);
    const endpoints: Array<[AddressEndpoint, string]> = [
      ["pickup", payload.pickup_address],
      ["destination", payload.destination_place]
    ];
    return endpoints.some(([endpoint, value]) => {
      if (!normalized.includes(normalizeForComparison(value))) return false;
      const confirmedEndpoint =
        endpointMentionedIn(content) ??
        laterMessages
          .slice(replacementIndex + 1)
          .map(standaloneEndpointConfirmation)
          .find((item) => item !== undefined);
      return confirmedEndpoint === endpoint;
    });
  });
}

function isExplicitAddressReplacement(content: string): boolean {
  const normalized = normalizeForComparison(content);
  return (
    /\b(?:cambia(?:r|me|la|lo)?|reemplaza(?:r|la|lo)?|pon(?:le|la|lo)?|usa(?:r)?|deja(?:r|le)?)\b/.test(
      normalized
    ) &&
    /\b(?:direccion|destino|entrega|recoleccion|recogida|pickup|delivery)\b/.test(
      normalized
    )
  );
}

function endpointMentionedIn(content: string): AddressEndpoint | undefined {
  const normalized = normalizeForComparison(content);
  const pickup = /\b(?:recoleccion|recogida|pickup|origen)\b/.test(normalized);
  const destination = /\b(?:entrega|delivery|destino)\b/.test(normalized);
  if (pickup === destination) return undefined;
  return pickup ? "pickup" : "destination";
}

function standaloneEndpointConfirmation(
  content: string
): AddressEndpoint | undefined {
  const normalized = normalizeForComparison(content).replace(/[^a-z\s]/g, "");
  if (
    /^(?:es\s+)?(?:de\s+)?(?:recoleccion|recogida|pickup|origen)$/.test(
      normalized
    )
  ) {
    return "pickup";
  }
  if (/^(?:es\s+)?(?:de\s+)?(?:entrega|delivery|destino)$/.test(normalized)) {
    return "destination";
  }
  return undefined;
}

function normalizeForComparison(content: string): string {
  return content
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
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
    reviewedDeals: operation.reviewedDeals,
    selection: operation.selection,
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
  if (operation.status === "awaiting_client_selection") {
    const approvedCount = operation.reviewedDeals.filter(
      (deal) => deal.mandateDecision === "APPROVED"
    ).length;
    if (approvedCount > 0) {
      items.push({
        operationId: operation.id,
        type: "pending_approval",
        summary: `${approvedCount} cotización(es) aprobadas esperan la selección del cliente`,
        evidenceId: `operation:${operation.id}`
      });
    }
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
