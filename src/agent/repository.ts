import { randomUUID } from "node:crypto";
import type {
  AgentConversation,
  CallSession,
  Carrier,
  AgentMessage,
  EvidenceCitation,
  Operation,
  ProposedAction,
  ShipmentEvent,
  TranscriptSegment
} from "@volta/contracts";
import { derivePipelineStage } from "../core/pipeline";

export type OrganizationContext = {
  organizationId: string;
  userId: string;
};

export type CreateConversationInput = OrganizationContext & { title?: string };

export type InboundMessageClaim = "claimed" | "processing" | "completed";

export type AgentRepository = {
  syncOperation(organizationId: string, operation: Operation): Promise<void>;
  listOperations(context: OrganizationContext): Promise<Operation[]>;
  getOperation(
    context: OrganizationContext,
    operationId: string
  ): Promise<Operation | undefined>;
  saveCallSession(
    organizationId: string,
    callSession: CallSession
  ): Promise<void>;
  listCarriers(organizationId: string): Promise<Carrier[]>;
  createCarrier(carrier: Carrier): Promise<Carrier>;
  updateCarrier(
    organizationId: string,
    carrierId: string,
    patch: Partial<Pick<Carrier, "name" | "phone" | "lanes" | "active">>
  ): Promise<Carrier | undefined>;
  createConversation(
    input: CreateConversationInput
  ): Promise<AgentConversation>;
  getConversation(
    context: OrganizationContext,
    conversationId: string
  ): Promise<AgentConversation | undefined>;
  listConversations(context: OrganizationContext): Promise<AgentConversation[]>;
  renameConversation(
    context: OrganizationContext,
    conversationId: string,
    title: string
  ): Promise<AgentConversation | undefined>;
  appendMessage(
    context: OrganizationContext,
    message: AgentMessage
  ): Promise<void>;
  searchEvidence(
    context: OrganizationContext,
    question: string
  ): Promise<EvidenceCitation[]>;
  getEvidence(
    context: OrganizationContext,
    sourceType: string,
    sourceId: string
  ): Promise<EvidenceCitation | undefined>;
  addShipmentEvent(event: ShipmentEvent): Promise<void>;
  addTranscriptSegments(segments: TranscriptSegment[]): Promise<void>;
  saveAction(action: ProposedAction): Promise<void>;
  getAction(
    context: OrganizationContext,
    actionId: string
  ): Promise<ProposedAction | undefined>;
  updateAction(action: ProposedAction): Promise<void>;
  claimInboundMessage(
    channel: string,
    messageId: string
  ): Promise<InboundMessageClaim>;
  completeInboundMessage(channel: string, messageId: string): Promise<void>;
  releaseInboundMessage(channel: string, messageId: string): Promise<void>;
};

export function operationVersion(operation: Operation): string {
  const facts = JSON.stringify({
    status: operation.status,
    pipelineStage: derivePipelineStage(operation),
    quotes: operation.quotes,
    approvals: operation.approvals,
    commitment: operation.commitment,
    escalations: operation.escalations
  });
  let hash = 2166136261;
  for (let index = 0; index < facts.length; index += 1) {
    hash ^= facts.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}

export class MemoryAgentRepository implements AgentRepository {
  private readonly operations = new Map<string, Map<string, Operation>>();
  private readonly conversations = new Map<string, AgentConversation>();
  private readonly events = new Map<string, ShipmentEvent[]>();
  private readonly transcripts = new Map<string, TranscriptSegment[]>();
  private readonly actions = new Map<string, ProposedAction>();
  private readonly carriers = new Map<string, Map<string, Carrier>>();
  private readonly inboundMessages = new Map<
    string,
    { status: "processing" | "completed"; claimedAt: number }
  >();

  async syncOperation(organizationId: string, operation: Operation) {
    const organization = this.operations.get(organizationId) ?? new Map();
    organization.set(operation.id, structuredClone(operation));
    this.operations.set(organizationId, organization);
  }

  async listOperations(context: OrganizationContext) {
    return [...(this.operations.get(context.organizationId)?.values() ?? [])]
      .map((item) => structuredClone(item))
      .sort((left, right) =>
        latestOperationTime(right).localeCompare(latestOperationTime(left))
      );
  }

  async getOperation(context: OrganizationContext, operationId: string) {
    const operation = this.operations
      .get(context.organizationId)
      ?.get(operationId);
    return operation ? structuredClone(operation) : undefined;
  }

  async saveCallSession(organizationId: string, callSession: CallSession) {
    // The operation snapshot is the read model in memory; this separate write
    // mirrors the relational persistence contract used by Postgres.
    const operation = this.operations
      .get(organizationId)
      ?.get(callSession.operationId);
    if (operation) {
      const index = operation.callSessions.findIndex(
        (item) => item.id === callSession.id
      );
      if (index === -1)
        operation.callSessions.push(structuredClone(callSession));
      else operation.callSessions[index] = structuredClone(callSession);
    }
  }

  async listCarriers(organizationId: string) {
    return [...(this.carriers.get(organizationId)?.values() ?? [])].map(
      (item) => structuredClone(item)
    );
  }

  async createCarrier(carrier: Carrier) {
    const organization =
      this.carriers.get(carrier.organizationId) ?? new Map<string, Carrier>();
    organization.set(carrier.id, structuredClone(carrier));
    this.carriers.set(carrier.organizationId, organization);
    return structuredClone(carrier);
  }

  async updateCarrier(
    organizationId: string,
    carrierId: string,
    patch: Partial<Pick<Carrier, "name" | "phone" | "lanes" | "active">>
  ) {
    const carrier = this.carriers.get(organizationId)?.get(carrierId);
    if (!carrier) return undefined;
    const updated = { ...carrier, ...structuredClone(patch) };
    this.carriers.get(organizationId)?.set(carrierId, updated);
    return structuredClone(updated);
  }

  async createConversation(input: CreateConversationInput) {
    const now = new Date().toISOString();
    const conversation: AgentConversation = {
      id: randomUUID(),
      organizationId: input.organizationId,
      createdBy: input.userId,
      title: input.title?.trim() || "Nueva consulta operativa",
      messages: [],
      createdAt: now,
      updatedAt: now
    };
    this.conversations.set(
      key(input.organizationId, conversation.id),
      conversation
    );
    return structuredClone(conversation);
  }

  async getConversation(context: OrganizationContext, conversationId: string) {
    const conversation = this.conversations.get(
      key(context.organizationId, conversationId)
    );
    return conversation ? structuredClone(conversation) : undefined;
  }

  async listConversations(context: OrganizationContext) {
    return [...this.conversations.values()]
      .filter((item) => item.organizationId === context.organizationId)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .map((item) => structuredClone(item));
  }

  async renameConversation(
    context: OrganizationContext,
    conversationId: string,
    title: string
  ) {
    const conversation = this.conversations.get(
      key(context.organizationId, conversationId)
    );
    if (!conversation) return undefined;
    conversation.title = title;
    conversation.updatedAt = new Date().toISOString();
    return structuredClone(conversation);
  }

  async appendMessage(context: OrganizationContext, message: AgentMessage) {
    const conversationKey = key(context.organizationId, message.conversationId);
    const conversation = this.conversations.get(conversationKey);
    if (!conversation) throw new Error("conversation_not_found");
    conversation.messages.push(structuredClone(message));
    conversation.updatedAt = message.createdAt;
  }

  async searchEvidence(context: OrganizationContext, question: string) {
    const operations = [
      ...(this.operations.get(context.organizationId)?.values() ?? [])
    ];
    const citations = operations.flatMap(operationCitations);
    const events = this.events.get(context.organizationId) ?? [];
    citations.push(...events.map(eventCitation));
    const transcripts = this.transcripts.get(context.organizationId) ?? [];
    citations.push(...transcripts.map(transcriptCitation));
    return rankCitations(citations, question).slice(0, 24);
  }

  async getEvidence(
    context: OrganizationContext,
    sourceType: string,
    sourceId: string
  ) {
    const all = await this.searchEvidence(context, sourceId);
    return all.find(
      (item) => item.sourceType === sourceType && item.sourceId === sourceId
    );
  }

  async addShipmentEvent(event: ShipmentEvent) {
    const events = this.events.get(event.organizationId) ?? [];
    const next = events.filter((item) => item.id !== event.id);
    next.push(structuredClone(event));
    this.events.set(event.organizationId, next);
  }

  async addTranscriptSegments(segments: TranscriptSegment[]) {
    for (const segment of segments) {
      const current = this.transcripts.get(segment.organizationId) ?? [];
      const next = current.filter((item) => item.id !== segment.id);
      next.push(structuredClone(segment));
      this.transcripts.set(segment.organizationId, next);
    }
  }

  async saveAction(action: ProposedAction) {
    this.actions.set(
      key(action.organizationId, action.id),
      structuredClone(action)
    );
  }

  async getAction(context: OrganizationContext, actionId: string) {
    const action = this.actions.get(key(context.organizationId, actionId));
    return action ? structuredClone(action) : undefined;
  }

  async updateAction(action: ProposedAction) {
    await this.saveAction(action);
  }

  async claimInboundMessage(channel: string, messageId: string) {
    const receiptKey = key(channel, messageId);
    const receipt = this.inboundMessages.get(receiptKey);
    if (receipt?.status === "completed") return "completed" as const;
    if (receipt && Date.now() - receipt.claimedAt < 120_000) {
      return "processing" as const;
    }
    this.inboundMessages.set(receiptKey, {
      status: "processing",
      claimedAt: Date.now()
    });
    return "claimed" as const;
  }

  async completeInboundMessage(channel: string, messageId: string) {
    this.inboundMessages.set(key(channel, messageId), {
      status: "completed",
      claimedAt: Date.now()
    });
  }

  async releaseInboundMessage(channel: string, messageId: string) {
    const receiptKey = key(channel, messageId);
    if (this.inboundMessages.get(receiptKey)?.status === "processing") {
      this.inboundMessages.delete(receiptKey);
    }
  }
}

export function operationCitations(operation: Operation): EvidenceCitation[] {
  const occurredAt = latestOperationTime(operation);
  const citations: EvidenceCitation[] = [
    citation({
      id: `operation:${operation.id}`,
      sourceType: "operation",
      sourceId: operation.id,
      operationId: operation.id,
      title: `${operation.containerId} · ${operation.origin} → ${operation.destination}`,
      excerpt: `Estado ${operation.status}; cliente ${operation.shipper}; presupuesto máximo MXN ${operation.mandate.budgetCapMxn}; recolección ${operation.mandate.pickupDatetime}.`,
      occurredAt
    })
  ];

  for (const quote of operation.quotes) {
    citations.push(
      citation({
        id: `quote:${quote.id}`,
        sourceType: "quote",
        sourceId: quote.id,
        operationId: operation.id,
        title: `Cotización · ${quote.carrierName}`,
        excerpt: `${quote.carrierName} ofreció MXN ${quote.priceMxn}, pickup ${quote.pickupTime} y ETA ${quote.etaMinutes} minutos.`,
        occurredAt: quote.createdAt
      })
    );
  }
  for (const approval of operation.approvals) {
    citations.push(
      citation({
        id: `approval:${approval.id}`,
        sourceType: "approval",
        sourceId: approval.id,
        operationId: operation.id,
        title: `Aprobación · ${approval.type}`,
        excerpt: `Estado ${approval.status}; cotizaciones ${approval.quoteIds.join(", ")}; decisión ${approval.decidedBy ?? "pendiente"}.`,
        occurredAt: approval.decidedAt ?? approval.createdAt
      })
    );
  }
  for (const brief of operation.callBriefs) {
    citations.push(
      citation({
        id: `call:${brief.callId}`,
        sourceType: "call",
        sourceId: brief.callId,
        operationId: operation.id,
        title: `Llamada · ${brief.callId}`,
        excerpt: `${brief.summary} Objeciones: ${brief.objections.join(", ") || "ninguna"}. Acciones: ${brief.actions.join(", ") || "ninguna"}.`,
        occurredAt: brief.createdAt
      })
    );
  }
  for (const escalation of operation.escalations) {
    citations.push(
      citation({
        id: `escalation:${escalation.id}`,
        sourceType: "escalation",
        sourceId: escalation.id,
        operationId: operation.id,
        title: `Escalación · ${escalation.reason}`,
        excerpt: `Estado ${escalation.status}; precio intentado ${escalation.attemptedPriceMxn ?? "sin dato"}; pickup ${escalation.attemptedPickupTime ?? "sin dato"}.`,
        occurredAt: escalation.requestedAt
      })
    );
  }
  if (operation.commitment) {
    citations.push(
      citation({
        id: `commitment:${operation.commitment.id}`,
        sourceType: "commitment",
        sourceId: operation.commitment.id,
        operationId: operation.id,
        title: "Compromiso confirmado",
        excerpt: `Transportista ${operation.commitment.carrierId}; MXN ${operation.commitment.finalPriceMxn}; pickup ${operation.commitment.pickupTime}; recap ${operation.commitment.recapStatus}.`,
        occurredAt: operation.commitment.finalizedAt
      })
    );
  }
  return citations;
}

export function eventCitation(event: ShipmentEvent): EvidenceCitation {
  return citation({
    id: `shipment_event:${event.id}`,
    sourceType: "shipment_event",
    sourceId: event.id,
    operationId: event.operationId,
    title: event.label,
    excerpt: `${event.type}${event.location ? ` en ${event.location}` : ""}. Fuente: ${event.source}.`,
    occurredAt: event.occurredAt
  });
}

export function transcriptCitation(
  segment: TranscriptSegment
): EvidenceCitation {
  return citation({
    id: `transcript:${segment.id}`,
    sourceType: "transcript",
    sourceId: segment.id,
    operationId: segment.operationId,
    title: `Transcript · ${segment.callId} · ${formatTimestamp(segment.startMs)}`,
    excerpt: `${segment.speaker}: ${segment.text}`,
    occurredAt: segment.createdAt,
    href: `/api/evidence/transcript/${segment.id}?t=${segment.startMs}`
  });
}

function citation(
  input: Omit<EvidenceCitation, "href"> & { href?: string }
): EvidenceCitation {
  return {
    ...input,
    href:
      input.href ??
      `/api/evidence/${input.sourceType}/${encodeURIComponent(input.sourceId)}`
  };
}

export function rankCitations(citations: EvidenceCitation[], question: string) {
  const terms = tokenize(question);
  const locationQuestion =
    /d[oó]nde|ubicaci[oó]n|parte|ruta|lleg[oó]|env[ií]o/i.test(question);
  const transcriptQuestion = /transcript|dijeron|hablaron|llamada|negoci/i.test(
    question
  );
  return citations
    .map((item) => {
      const text = normalize(
        `${item.title} ${item.excerpt} ${item.operationId}`
      );
      const termScore = terms.reduce(
        (score, term) => score + (text.includes(term) ? 4 : 0),
        0
      );
      const typeScore =
        (locationQuestion && item.sourceType === "shipment_event" ? 30 : 0) +
        (transcriptQuestion &&
        ["transcript", "call", "quote"].includes(item.sourceType)
          ? 20
          : 0) +
        (item.sourceType === "operation" ? 5 : 0);
      return { item, score: termScore + typeScore };
    })
    .sort(
      (left, right) =>
        right.score - left.score ||
        Date.parse(right.item.occurredAt) - Date.parse(left.item.occurredAt)
    )
    .map(({ item }) => item);
}

function tokenize(value: string) {
  const ignored = new Set([
    "para",
    "como",
    "cual",
    "cuales",
    "donde",
    "esta",
    "este",
    "todo",
    "envio",
    "the",
    "what",
    "where",
    "this"
  ]);
  return normalize(value)
    .split(/[^a-z0-9]+/)
    .filter((term) => term.length > 2 && !ignored.has(term));
}

function normalize(value: string) {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function latestOperationTime(operation: Operation) {
  const times = [
    ...operation.quotes.map((quote) => quote.createdAt),
    ...operation.approvals.map(
      (approval) => approval.decidedAt ?? approval.createdAt
    ),
    ...operation.callBriefs.map((brief) => brief.createdAt),
    ...operation.escalations.map((escalation) => escalation.requestedAt),
    operation.commitment?.finalizedAt
  ].filter((value): value is string => Boolean(value));
  return times.sort().at(-1) ?? operation.mandate.pickupDatetime;
}

function formatTimestamp(milliseconds: number) {
  const seconds = Math.floor(milliseconds / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function key(organizationId: string, id: string) {
  return `${organizationId}:${id}`;
}
