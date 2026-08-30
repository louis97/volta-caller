import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import type {
  AgentConversation,
  AgentMessage,
  CallSession,
  Carrier,
  EvidenceCitation,
  Operation,
  ProposedAction,
  ShipmentEvent,
  QuoteExtraction,
  TranscriptSegment
} from "@volta/contracts";
import { Pool } from "pg";
import { derivePipelineStage } from "../core/pipeline";
import type { TelephonyCallContextRecord } from "../core/telephonyContext";

import {
  type AgentRepository,
  type CreateConversationInput,
  type InboundMessageClaim,
  type OrganizationContext,
  eventCitation,
  operationCitations,
  operationVersion,
  rankCitations,
  transcriptCitation
} from "../agent/repository";

export class PostgresAgentRepository implements AgentRepository {
  private readonly pool: Pool;
  private initialization?: Promise<void>;

  constructor(connectionString: string) {
    this.pool = new Pool({ connectionString });
  }

  async syncOperation(organizationId: string, operation: Operation) {
    await this.initialize();
    await this.pool.query(
      `INSERT INTO operations (organization_id, id, version, snapshot, pipeline_stage)
       VALUES ($1, $2, $3, $4::jsonb, $5)
       ON CONFLICT (organization_id, id) DO UPDATE
       SET version = EXCLUDED.version,
           snapshot = EXCLUDED.snapshot,
           pipeline_stage = EXCLUDED.pipeline_stage,
           updated_at = now()`,
      [
        organizationId,
        operation.id,
        operationVersion(operation),
        JSON.stringify(operation),
        derivePipelineStage(operation)
      ]
    );
    await Promise.all(
      operation.callSessions.map((callSession) =>
        this.saveCallSession(organizationId, callSession)
      )
    );
  }

  async listOperations(context: OrganizationContext) {
    await this.initialize();
    const result = await this.pool.query<{ snapshot: Operation }>(
      `SELECT snapshot FROM operations
       WHERE organization_id = $1
       ORDER BY updated_at DESC`,
      [context.organizationId]
    );
    return result.rows.map(({ snapshot }) => snapshot);
  }

  async getOperation(context: OrganizationContext, operationId: string) {
    await this.initialize();
    const result = await this.pool.query<{ snapshot: Operation }>(
      `SELECT snapshot FROM operations
       WHERE organization_id = $1 AND id = $2`,
      [context.organizationId, operationId]
    );
    return result.rows[0]?.snapshot;
  }

  async saveCallSession(organizationId: string, callSession: CallSession) {
    await this.initialize();
    await this.pool.query(
      `INSERT INTO call_sessions (organization_id, id, operation_id, carrier_id, driver_name, direction, status, audio_url, quote_id, ended_reason, started_at, ended_at, call_sid, supervision)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb)
       ON CONFLICT (organization_id, id) DO UPDATE SET carrier_id = EXCLUDED.carrier_id, driver_name = EXCLUDED.driver_name, status = EXCLUDED.status, audio_url = EXCLUDED.audio_url, quote_id = EXCLUDED.quote_id, ended_reason = EXCLUDED.ended_reason, started_at = EXCLUDED.started_at, ended_at = EXCLUDED.ended_at, call_sid = EXCLUDED.call_sid, supervision = EXCLUDED.supervision`,
      [
        organizationId,
        callSession.id,
        callSession.operationId,
        callSession.carrierId ?? null,
        callSession.driverName ?? null,
        callSession.direction,
        callSession.status,
        callSession.audioUrl ?? null,
        callSession.quoteId ?? null,
        callSession.endedReason ?? null,
        callSession.startedAt,
        callSession.endedAt ?? null,
        callSession.callSid ?? null,
        callSession.supervision ? JSON.stringify(callSession.supervision) : null
      ]
    );
  }

  /**
   * Matches the sid or the generated id, because a call is known by both: the
   * round that dialled it names it one way and every Twilio callback the
   * other.
   */
  async findOperationIdByCallSid(organizationId: string, callSid: string) {
    await this.initialize();
    const result = await this.pool.query<{ operation_id: string }>(
      `SELECT operation_id FROM call_sessions
       WHERE organization_id = $1 AND (call_sid = $2 OR id = $2)
       ORDER BY started_at DESC
       LIMIT 1`,
      [organizationId, callSid]
    );
    return result.rows[0]?.operation_id;
  }

  async saveTelephonyCallContext(context: TelephonyCallContextRecord) {
    await this.initialize();
    await this.pool.query(
      `INSERT INTO telephony_call_contexts
       (token_hash, organization_id, operation_id, carrier_id, created_at, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (token_hash) DO NOTHING`,
      [
        context.tokenHash,
        context.organizationId,
        context.operationId,
        context.carrierId ?? null,
        context.createdAt,
        context.expiresAt
      ]
    );
  }

  async getTelephonyCallContext(tokenHash: string) {
    await this.initialize();
    const result = await this.pool.query<TelephonyCallContextRow>(
      `SELECT token_hash, organization_id, operation_id, carrier_id,
              created_at, expires_at
       FROM telephony_call_contexts
       WHERE token_hash = $1 AND expires_at > now()`,
      [tokenHash]
    );
    const row = result.rows[0];
    if (!row) return undefined;
    return {
      tokenHash: row.token_hash,
      organizationId: row.organization_id,
      operationId: row.operation_id,
      carrierId: row.carrier_id ?? undefined,
      createdAt: iso(row.created_at),
      expiresAt: iso(row.expires_at)
    } satisfies TelephonyCallContextRecord;
  }

  async listCarriers(organizationId: string) {
    await this.initialize();
    const result = await this.pool.query<CarrierRow>(
      `SELECT organization_id, id, name, phone, lanes, active, created_at FROM carriers WHERE organization_id = $1 ORDER BY created_at DESC`,
      [organizationId]
    );
    return result.rows.map(carrierFromRow);
  }

  async createCarrier(carrier: Carrier) {
    await this.initialize();
    await this.pool.query(
      `INSERT INTO carriers (organization_id, id, name, phone, lanes, active, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        carrier.organizationId,
        carrier.id,
        carrier.name,
        carrier.phone,
        carrier.lanes,
        carrier.active,
        carrier.createdAt
      ]
    );
    return carrier;
  }

  async updateCarrier(
    organizationId: string,
    carrierId: string,
    patch: Partial<Pick<Carrier, "name" | "phone" | "lanes" | "active">>
  ) {
    await this.initialize();
    const result = await this.pool.query<CarrierRow>(
      `UPDATE carriers SET name = coalesce($3, name), phone = coalesce($4, phone), lanes = coalesce($5, lanes), active = coalesce($6, active) WHERE organization_id = $1 AND id = $2 RETURNING organization_id, id, name, phone, lanes, active, created_at`,
      [
        organizationId,
        carrierId,
        patch.name ?? null,
        patch.phone ?? null,
        patch.lanes ?? null,
        patch.active ?? null
      ]
    );
    return result.rows[0] ? carrierFromRow(result.rows[0]) : undefined;
  }

  async createConversation(input: CreateConversationInput) {
    await this.initialize();
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
    await this.pool.query(
      `INSERT INTO agent_conversations
       (organization_id, id, created_by, title, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $5)`,
      [
        conversation.organizationId,
        conversation.id,
        conversation.createdBy,
        conversation.title,
        now
      ]
    );
    return conversation;
  }

  async getConversation(context: OrganizationContext, conversationId: string) {
    await this.initialize();
    const conversationResult = await this.pool.query<ConversationRow>(
      `SELECT id, organization_id, created_by, title, created_at, updated_at
       FROM agent_conversations
       WHERE organization_id = $1 AND id = $2`,
      [context.organizationId, conversationId]
    );
    const row = conversationResult.rows[0];
    if (!row) return undefined;
    const messages = await this.pool.query<MessageRow>(
      `SELECT id, conversation_id, role, content, citations,
              proposed_actions, created_at
       FROM agent_messages
       WHERE organization_id = $1 AND conversation_id = $2
       ORDER BY created_at`,
      [context.organizationId, conversationId]
    );
    return {
      id: row.id,
      organizationId: row.organization_id,
      createdBy: row.created_by,
      title: row.title,
      messages: messages.rows.map(messageFromRow),
      createdAt: iso(row.created_at),
      updatedAt: iso(row.updated_at)
    } satisfies AgentConversation;
  }

  async listConversations(context: OrganizationContext) {
    await this.initialize();
    const result = await this.pool.query<ConversationRow>(
      `SELECT id, organization_id, created_by, title, created_at, updated_at
       FROM agent_conversations
       WHERE organization_id = $1
       ORDER BY updated_at DESC
       LIMIT 50`,
      [context.organizationId]
    );
    return result.rows.map((row) => ({
      id: row.id,
      organizationId: row.organization_id,
      createdBy: row.created_by,
      title: row.title,
      messages: [],
      createdAt: iso(row.created_at),
      updatedAt: iso(row.updated_at)
    }));
  }

  async renameConversation(
    context: OrganizationContext,
    conversationId: string,
    title: string
  ) {
    await this.initialize();
    const result = await this.pool.query<ConversationRow>(
      `UPDATE agent_conversations
       SET title = $3, updated_at = now()
       WHERE organization_id = $1 AND id = $2
       RETURNING id, organization_id, created_by, title, created_at, updated_at`,
      [context.organizationId, conversationId, title]
    );
    const row = result.rows[0];
    return row
      ? {
          id: row.id,
          organizationId: row.organization_id,
          createdBy: row.created_by,
          title: row.title,
          messages: [],
          createdAt: iso(row.created_at),
          updatedAt: iso(row.updated_at)
        }
      : undefined;
  }

  async deleteConversation(
    context: OrganizationContext,
    conversationId: string
  ) {
    await this.initialize();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const existing = await client.query(
        `SELECT 1 FROM agent_conversations
         WHERE organization_id = $1 AND id = $2
         FOR UPDATE`,
        [context.organizationId, conversationId]
      );
      if (existing.rowCount !== 1) {
        await client.query("COMMIT");
        return false;
      }
      await client.query(
        `DELETE FROM agent_actions
         WHERE organization_id = $1 AND conversation_id = $2`,
        [context.organizationId, conversationId]
      );
      await client.query(
        `DELETE FROM agent_messages
         WHERE organization_id = $1 AND conversation_id = $2`,
        [context.organizationId, conversationId]
      );
      await client.query(
        `DELETE FROM agent_conversations
         WHERE organization_id = $1 AND id = $2`,
        [context.organizationId, conversationId]
      );
      await client.query("COMMIT");
      return true;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async appendMessage(context: OrganizationContext, message: AgentMessage) {
    await this.initialize();
    const result = await this.pool.query(
      `INSERT INTO agent_messages
       (organization_id, id, conversation_id, role, content, citations,
        proposed_actions, created_at)
       SELECT $1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8
       WHERE EXISTS (
         SELECT 1 FROM agent_conversations
         WHERE organization_id = $1 AND id = $3
       )`,
      [
        context.organizationId,
        message.id,
        message.conversationId,
        message.role,
        message.content,
        JSON.stringify(message.citations),
        JSON.stringify(message.proposedActions),
        message.createdAt
      ]
    );
    if (result.rowCount !== 1) throw new Error("conversation_not_found");
    await this.pool.query(
      `UPDATE agent_conversations SET updated_at = $3
       WHERE organization_id = $1 AND id = $2`,
      [context.organizationId, message.conversationId, message.createdAt]
    );
  }

  async searchEvidence(context: OrganizationContext, question: string) {
    await this.initialize();
    const term = strongestTerm(question);
    const operationRows = await this.pool.query<{ snapshot: Operation }>(
      `SELECT snapshot
       FROM operations
       WHERE organization_id = $1
         AND ($2 = '' OR snapshot::text ILIKE '%' || $2 || '%')
       ORDER BY updated_at DESC
       LIMIT 100`,
      [context.organizationId, term]
    );
    const eventRows = await this.pool.query<ShipmentEventRow>(
      `SELECT organization_id, id, operation_id, type, label, location,
              source, occurred_at, received_at, metadata
       FROM shipment_events
       WHERE organization_id = $1
         AND ($2 = '' OR label ILIKE '%' || $2 || '%'
              OR coalesce(location, '') ILIKE '%' || $2 || '%'
              OR operation_id ILIKE '%' || $2 || '%')
       ORDER BY occurred_at DESC
       LIMIT 100`,
      [context.organizationId, term]
    );
    const transcriptRows = await this.pool.query<TranscriptRow>(
      `SELECT organization_id, id, operation_id, call_id, speaker, text,
              start_ms, end_ms, created_at
       FROM transcript_segments
       WHERE organization_id = $1
         AND ($2 = '' OR search_vector @@ websearch_to_tsquery('spanish', $2)
              OR text ILIKE '%' || $2 || '%'
              OR operation_id ILIKE '%' || $2 || '%')
       ORDER BY created_at DESC
       LIMIT 100`,
      [context.organizationId, term]
    );
    const citations = [
      ...operationRows.rows.flatMap(({ snapshot }) =>
        operationCitations(snapshot)
      ),
      ...eventRows.rows.map((row) => eventCitation(eventFromRow(row))),
      ...transcriptRows.rows.map((row) =>
        transcriptCitation(transcriptFromRow(row))
      )
    ];
    return rankCitations(citations, question).slice(0, 24);
  }

  async getEvidence(
    context: OrganizationContext,
    sourceType: string,
    sourceId: string
  ) {
    await this.initialize();
    if (sourceType === "shipment_event") {
      const result = await this.pool.query<ShipmentEventRow>(
        `SELECT organization_id, id, operation_id, type, label, location,
                source, occurred_at, received_at, metadata
         FROM shipment_events
         WHERE organization_id = $1 AND id = $2`,
        [context.organizationId, sourceId]
      );
      return result.rows[0]
        ? eventCitation(eventFromRow(result.rows[0]))
        : undefined;
    }
    if (sourceType === "transcript") {
      const result = await this.pool.query<TranscriptRow>(
        `SELECT organization_id, id, operation_id, call_id, speaker, text,
                start_ms, end_ms, created_at
         FROM transcript_segments
         WHERE organization_id = $1 AND id = $2`,
        [context.organizationId, sourceId]
      );
      return result.rows[0]
        ? transcriptCitation(transcriptFromRow(result.rows[0]))
        : undefined;
    }
    const operationResult = await this.pool.query<{ snapshot: Operation }>(
      `SELECT snapshot FROM operations
       WHERE organization_id = $1 AND snapshot::text ILIKE '%' || $2 || '%'
       ORDER BY updated_at DESC LIMIT 1`,
      [context.organizationId, sourceId]
    );
    return operationResult.rows
      .flatMap(({ snapshot }) => operationCitations(snapshot))
      .find(
        (item) => item.sourceType === sourceType && item.sourceId === sourceId
      );
  }

  async addShipmentEvent(event: ShipmentEvent) {
    await this.initialize();
    await this.pool.query(
      `INSERT INTO shipment_events
       (organization_id, id, operation_id, type, label, location, source,
        occurred_at, received_at, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)
       ON CONFLICT (organization_id, id) DO UPDATE
       SET type = EXCLUDED.type, label = EXCLUDED.label,
           location = EXCLUDED.location, source = EXCLUDED.source,
           occurred_at = EXCLUDED.occurred_at,
           received_at = EXCLUDED.received_at,
           metadata = EXCLUDED.metadata`,
      [
        event.organizationId,
        event.id,
        event.operationId,
        event.type,
        event.label,
        event.location ?? null,
        event.source,
        event.occurredAt,
        event.receivedAt,
        JSON.stringify(event.metadata ?? {})
      ]
    );
  }

  async saveQuoteExtraction(extraction: QuoteExtraction) {
    await this.initialize();
    await this.pool.query(
      `INSERT INTO quote_extractions (organization_id, id, operation_id, call_id, quote_id, final_price_mxn, currency, agreed_at, summary, status, model, created_at, completed_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       ON CONFLICT (organization_id, id) DO UPDATE SET final_price_mxn=EXCLUDED.final_price_mxn, currency=EXCLUDED.currency, agreed_at=EXCLUDED.agreed_at, summary=EXCLUDED.summary, status=EXCLUDED.status, completed_at=EXCLUDED.completed_at`,
      [
        extraction.organizationId,
        extraction.id,
        extraction.operationId,
        extraction.callId,
        extraction.quoteId ?? null,
        extraction.finalPriceMxn,
        extraction.currency,
        extraction.agreedAt,
        extraction.summary,
        extraction.status,
        extraction.model,
        extraction.createdAt,
        extraction.completedAt ?? null
      ]
    );
  }

  async listQuoteExtractions(context: OrganizationContext) {
    await this.initialize();
    const result = await this.pool.query<QuoteExtraction>(
      `SELECT id, organization_id AS "organizationId", operation_id AS "operationId", call_id AS "callId", quote_id AS "quoteId", final_price_mxn AS "finalPriceMxn", currency, agreed_at AS "agreedAt", summary, status, model, created_at AS "createdAt", completed_at AS "completedAt" FROM quote_extractions WHERE organization_id=$1 ORDER BY created_at DESC`,
      [context.organizationId]
    );
    return result.rows;
  }

  async listShipmentEvents(context: OrganizationContext) {
    await this.initialize();
    const result = await this.pool.query<ShipmentEventRow>(
      `SELECT organization_id, id, operation_id, type, label, location, source,
              occurred_at, received_at, metadata
       FROM shipment_events
       WHERE organization_id = $1
       ORDER BY occurred_at DESC`,
      [context.organizationId]
    );
    return result.rows.map(eventFromRow);
  }

  async listTranscript(
    organizationId: string,
    callId?: string,
    limit = 500
  ): Promise<TranscriptSegment[]> {
    await this.initialize();
    // Bounded, newest first, then put back in reading order. Unbounded, this
    // returned the organization's entire history on every load of the call
    // floor, which is why the console kept getting slower as the day went on.
    const { rows } = await this.pool.query<{
      id: string;
      operation_id: string;
      call_id: string;
      speaker: string;
      text: string;
      start_ms: number;
      end_ms: number;
      created_at: Date;
    }>(
      callId
        ? `select * from (
             select * from transcript_segments
             where organization_id=$1 and call_id=$2
             order by created_at desc limit $3
           ) recent order by start_ms asc`
        : `select * from (
             select * from transcript_segments
             where organization_id=$1
             order by created_at desc limit $2
           ) recent order by created_at asc`,
      callId ? [organizationId, callId, limit] : [organizationId, limit]
    );

    return rows.map((row) => ({
      id: row.id,
      organizationId,
      operationId: row.operation_id,
      callId: row.call_id,
      speaker: row.speaker as TranscriptSegment["speaker"],
      text: row.text,
      startMs: row.start_ms,
      endMs: row.end_ms,
      createdAt: new Date(row.created_at).toISOString()
    }));
  }

  async addTranscriptSegments(segments: TranscriptSegment[]) {
    await this.initialize();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      for (const segment of segments) {
        await client.query(
          `INSERT INTO transcript_segments
           (organization_id, id, operation_id, call_id, speaker, text,
            start_ms, end_ms, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
           ON CONFLICT (organization_id, id) DO UPDATE
           SET speaker = EXCLUDED.speaker, text = EXCLUDED.text,
               start_ms = EXCLUDED.start_ms, end_ms = EXCLUDED.end_ms,
               created_at = EXCLUDED.created_at`,
          [
            segment.organizationId,
            segment.id,
            segment.operationId,
            segment.callId,
            segment.speaker,
            segment.text,
            segment.startMs,
            segment.endMs,
            segment.createdAt
          ]
        );
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async saveAction(action: ProposedAction) {
    await this.initialize();
    await this.pool.query(
      `INSERT INTO agent_actions
       (organization_id, id, conversation_id, operation_id, type, payload,
        status, summary, expected_operation_version, requested_by, decided_by,
        created_at, decided_at, executed_at, failure_reason)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10, $11, $12, $13, $14, $15)
       ON CONFLICT (organization_id, id) DO UPDATE
       SET payload = EXCLUDED.payload, status = EXCLUDED.status,
           decided_by = EXCLUDED.decided_by,
           decided_at = EXCLUDED.decided_at, executed_at = EXCLUDED.executed_at,
           failure_reason = EXCLUDED.failure_reason`,
      actionValues(action)
    );
  }

  async getAction(context: OrganizationContext, actionId: string) {
    await this.initialize();
    const result = await this.pool.query<ActionRow>(
      `SELECT * FROM agent_actions
       WHERE organization_id = $1 AND id = $2`,
      [context.organizationId, actionId]
    );
    return result.rows[0] ? actionFromRow(result.rows[0]) : undefined;
  }

  async updateAction(action: ProposedAction) {
    await this.saveAction(action);
  }

  async claimInboundMessage(
    channel: string,
    messageId: string
  ): Promise<InboundMessageClaim> {
    await this.initialize();
    const inserted = await this.pool.query(
      `INSERT INTO inbound_message_receipts
       (channel, message_id, status, claimed_at)
       VALUES ($1, $2, 'processing', now())
       ON CONFLICT (channel, message_id) DO NOTHING
       RETURNING message_id`,
      [channel, messageId]
    );
    if (inserted.rowCount === 1) return "claimed";

    const reclaimed = await this.pool.query(
      `UPDATE inbound_message_receipts
       SET claimed_at = now()
       WHERE channel = $1 AND message_id = $2
         AND status = 'processing'
         AND claimed_at < now() - interval '2 minutes'
       RETURNING message_id`,
      [channel, messageId]
    );
    if (reclaimed.rowCount === 1) return "claimed";

    const existing = await this.pool.query<{ status: InboundMessageClaim }>(
      `SELECT status FROM inbound_message_receipts
       WHERE channel = $1 AND message_id = $2`,
      [channel, messageId]
    );
    return existing.rows[0]?.status === "completed"
      ? "completed"
      : "processing";
  }

  async completeInboundMessage(channel: string, messageId: string) {
    await this.initialize();
    await this.pool.query(
      `UPDATE inbound_message_receipts
       SET status = 'completed', completed_at = now()
       WHERE channel = $1 AND message_id = $2`,
      [channel, messageId]
    );
  }

  async releaseInboundMessage(channel: string, messageId: string) {
    await this.initialize();
    await this.pool.query(
      `DELETE FROM inbound_message_receipts
       WHERE channel = $1 AND message_id = $2 AND status = 'processing'`,
      [channel, messageId]
    );
  }

  private initialize() {
    this.initialization ??= this.runMigrations();
    return this.initialization;
  }

  private async runMigrations() {
    const migrations = [
      "001_agent_knowledge.sql",
      "002_mandates_security.sql",
      "003_carriers_and_pipeline.sql",
      "004_agent_action_payload.sql",
      "005_inbound_message_receipts.sql",
      "006_telephony_call_contexts.sql",
      "007_quote_extractions.sql",
      "008_call_session_identity.sql"
    ];
    for (const migration of migrations) {
      const sql = await readFile(
        new URL(`./migrations/${migration}`, import.meta.url),
        "utf8"
      );
      await this.pool.query(sql);
    }
  }
}

type ConversationRow = {
  id: string;
  organization_id: string;
  created_by: string;
  title: string;
  created_at: Date | string;
  updated_at: Date | string;
};

type TelephonyCallContextRow = {
  token_hash: string;
  organization_id: string;
  operation_id: string;
  carrier_id: string | null;
  created_at: Date | string;
  expires_at: Date | string;
};

type MessageRow = {
  id: string;
  conversation_id: string;
  role: AgentMessage["role"];
  content: string;
  citations: EvidenceCitation[];
  proposed_actions: ProposedAction[];
  created_at: Date | string;
};

type ShipmentEventRow = {
  organization_id: string;
  id: string;
  operation_id: string;
  type: ShipmentEvent["type"];
  label: string;
  location: string | null;
  source: string;
  occurred_at: Date | string;
  received_at: Date | string;
  metadata: Record<string, unknown>;
};

type TranscriptRow = {
  organization_id: string;
  id: string;
  operation_id: string;
  call_id: string;
  speaker: TranscriptSegment["speaker"];
  text: string;
  start_ms: number;
  end_ms: number;
  created_at: Date | string;
};

type ActionRow = {
  organization_id: string;
  id: string;
  conversation_id: string;
  operation_id: string;
  type: ProposedAction["type"];
  payload: ProposedAction["payload"];
  status: ProposedAction["status"];
  summary: string;
  expected_operation_version: string;
  requested_by: string;
  decided_by: string | null;
  created_at: Date | string;
  decided_at: Date | string | null;
  executed_at: Date | string | null;
  failure_reason: string | null;
};

type CarrierRow = {
  organization_id: string;
  id: string;
  name: string;
  phone: string;
  lanes: string[];
  active: boolean;
  created_at: Date | string;
};

function messageFromRow(row: MessageRow): AgentMessage {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    role: row.role,
    content: row.content,
    citations: row.citations,
    proposedActions: row.proposed_actions,
    createdAt: iso(row.created_at)
  };
}

function eventFromRow(row: ShipmentEventRow): ShipmentEvent {
  return {
    id: row.id,
    organizationId: row.organization_id,
    operationId: row.operation_id,
    type: row.type,
    label: row.label,
    location: row.location ?? undefined,
    source: row.source,
    occurredAt: iso(row.occurred_at),
    receivedAt: iso(row.received_at),
    metadata: row.metadata
  };
}

function transcriptFromRow(row: TranscriptRow): TranscriptSegment {
  return {
    id: row.id,
    organizationId: row.organization_id,
    operationId: row.operation_id,
    callId: row.call_id,
    speaker: row.speaker,
    text: row.text,
    startMs: row.start_ms,
    endMs: row.end_ms,
    createdAt: iso(row.created_at)
  };
}

function actionFromRow(row: ActionRow): ProposedAction {
  const common = {
    id: row.id,
    organizationId: row.organization_id,
    conversationId: row.conversation_id,
    operationId: row.operation_id,
    status: row.status,
    summary: row.summary,
    expectedOperationVersion: row.expected_operation_version,
    requestedBy: row.requested_by,
    decidedBy: row.decided_by ?? undefined,
    createdAt: iso(row.created_at),
    decidedAt: row.decided_at ? iso(row.decided_at) : undefined,
    executedAt: row.executed_at ? iso(row.executed_at) : undefined,
    failureReason: row.failure_reason ?? undefined
  };
  if (row.type === "create_mandate") {
    return {
      ...common,
      type: row.type,
      payload: row.payload as Extract<
        ProposedAction,
        { type: "create_mandate" }
      >["payload"]
    };
  }
  return {
    ...common,
    type: row.type,
    payload: row.payload as Extract<
      ProposedAction,
      { type: "resolve_carrier_selection" }
    >["payload"]
  };
}

function carrierFromRow(row: CarrierRow): Carrier {
  return {
    organizationId: row.organization_id,
    id: row.id,
    name: row.name,
    phone: row.phone,
    lanes: row.lanes,
    active: row.active,
    createdAt: iso(row.created_at)
  };
}

function actionValues(action: ProposedAction) {
  return [
    action.organizationId,
    action.id,
    action.conversationId,
    action.operationId,
    action.type,
    JSON.stringify(action.payload),
    action.status,
    action.summary,
    action.expectedOperationVersion,
    action.requestedBy,
    action.decidedBy ?? null,
    action.createdAt,
    action.decidedAt ?? null,
    action.executedAt ?? null,
    action.failureReason ?? null
  ];
}

function strongestTerm(question: string) {
  return (
    question
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .split(/[^a-zA-Z0-9-]+/)
      .filter((term) => term.length > 3)
      .sort((left, right) => right.length - left.length)[0]
      ?.slice(0, 120) ?? ""
  );
}

function iso(value: Date | string) {
  return value instanceof Date ? value.toISOString() : value;
}
