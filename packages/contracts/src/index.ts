/**
 * Exact payload accepted from the dashboard when a dispatcher creates a mandate.
 * The API owns the conversion to the canonical `Mandate` model below.
 */
export type CreateMandateRequest = {
  budget_cap: number;
  destination_datetime: string;
  destination_place: string;
  type_of_content: string;
  weight: number;
  measures: string;
  pickup_address: string;
  pickup_datetime: string;
};

/**
 * Canonical operational mandate. This is the only mandate representation that
 * agent tools, state transitions, and read models may consume.
 */
export type Mandate = {
  budgetCapMxn: number;
  destinationDatetime: string;
  destinationPlace: string;
  typeOfContent: string;
  weightKg: number;
  measures: string;
  pickupAddress: string;
  pickupDatetime: string;
  /** System routing detail; it is not supplied by the dashboard manifest. */
  escalationPhone: string;
};

export type CarrierCandidate = {
  id: string;
  name: string;
  phone: string;
};

export type Carrier = CarrierCandidate & {
  organizationId: string;
  lanes: string[];
  active: boolean;
  createdAt: string;
};

export type Quote = {
  id: string;
  carrierId: string;
  carrierName: string;
  priceMxn: number;
  etaMinutes: number;
  pickupTime: string;
  callId: string;
  createdAt: string;
};

/**
 * A dispatcher-owned authorization for Volta to place the second, closing
 * call. Quotes are market intelligence; this record is the only authority to
 * turn one of them into a booking attempt.
 */
export type ApprovalRequest = {
  id: string;
  operationId: string;
  type: "carrier_selection" | "revised_terms";
  status: "pending" | "approved" | "declined";
  quoteIds: string[];
  recommendedQuoteId?: string;
  selectedQuoteId?: string;
  proposedTerms?: {
    carrierId: string;
    finalPriceMxn: number;
    pickupTime: string;
  };
  decidedBy?: string;
  createdAt: string;
  decidedAt?: string;
  decisionHistory?: Array<{
    action: "approve" | "decline";
    selectedQuoteId?: string;
    decidedBy: string;
    decidedAt: string;
    undoneBy?: string;
    undoneAt?: string;
  }>;
};

export type ClosingAuthorization = {
  approvalId: string;
  quoteId: string;
  carrierId: string;
  finalPriceMxn: number;
  pickupTime: string;
  authorizedBy: string;
  authorizedAt: string;
};

export type CallSession = {
  id: string;
  callSid?: string;
  operationId: string;
  carrierId?: string;
  driverName?: string;
  direction: "inbound" | "outbound";
  status: "pending" | "in_progress" | "completed" | "failed" | "transferred";
  audioUrl?: string;
  transcript?: string;
  quoteId?: string;
  endedReason?: string;
  startedAt: string;
  endedAt?: string;
};

export type Commitment = {
  id: string;
  carrierId: string;
  callId: string;
  finalPriceMxn: number;
  pickupTime: string;
  driverName?: string;
  plate?: string;
  audioTimestampUrl: string;
  recapStatus: "pending" | "sent" | "failed";
  recapMessageId?: string;
  finalizedAt: string;
};

export type CallBrief = {
  id: string;
  callId: string;
  carrierId?: string;
  summary: string;
  quotedPriceMxn?: number;
  objections: string[];
  actions: string[];
  outcome: "quoted" | "committed" | "escalated" | "unavailable" | "failed";
  createdAt: string;
};

export type Escalation = {
  id: string;
  operationId: string;
  callId?: string;
  reason: string;
  attemptedPriceMxn?: number;
  attemptedPickupTime?: string;
  status: "requested" | "transferred" | "resolved";
  requestedAt: string;
};

export type OperationStatus =
  | "open"
  | "negotiating"
  | "awaiting_approval"
  | "awaiting_client_selection"
  | "carrier_selected"
  | "confirming_selected_carrier"
  | "committed"
  | "selection_expired"
  | "confirmation_failed"
  | "incident_monitoring"
  | "escalated"
  | "failed";

export type ClientSelection = {
  quoteId: string;
  selectedAt: string;
  expiresAt: string;
};

export type ReviewedDeal = {
  quoteId: string;
  callId: string;
  mandateDecision: "APPROVED" | "REJECTED" | "REQUIRES_ESCALATION";
  reviewedAt: string;
};

export type Incident = {
  id: string;
  operationId: string;
  callerName: string;
  carrierId: string;
  truckPlate?: string;
  processStage: string;
  issue: string;
  delayMinutes: number;
  revisedEta: string;
  feasibility: "achievable" | "unachievable";
  createdAt: string;
  /** The caller identity recorded after exception-call verification. */
  verifiedCallerIdentity: string;
};

export type DashboardNotification = {
  operationId: string;
  incidentId: string;
  message: string;
  createdAt: string;
};

export type Operation = {
  id: string;
  containerId: string;
  shipper: string;
  origin: string;
  destination: string;
  status: OperationStatus;
  mandate: Mandate;
  candidates: CarrierCandidate[];
  callSessions: CallSession[];
  quotes: Quote[];
  approvals: ApprovalRequest[];
  closingAuthorization?: ClosingAuthorization;
  selectedCarrierId?: string;
  confirmationCallId?: string;
  commitment?: Commitment;
  callBriefs: CallBrief[];
  escalations: Escalation[];
  reviewedDeals: ReviewedDeal[];
  selection?: ClientSelection;
  incidents: Incident[];
  dashboardNotifications: DashboardNotification[];
};

/**
 * Persisted read projection for operation lists and detail views. The
 * canonical aggregate retains its source facts; this field is derived from
 * them and indexed by storage for pipeline queries.
 */
export type PipelineStage =
  | "open"
  | "calling"
  | "quoting"
  | "awaiting_approval"
  | "closing"
  | "committed"
  | "escalated"
  | "failed";

export type OperationReadModel = Operation & {
  pipelineStage: PipelineStage;
};

export type OperationEvent =
  | { type: "mandate.created"; operationId: string; mandate: Mandate }
  | { type: "quote.registered"; operationId: string; quote: Quote }
  | { type: "call.started"; operationId: string; callSession: CallSession }
  | { type: "call.updated"; operationId: string; callSession: CallSession }
  | {
      type: "approval.requested";
      operationId: string;
      approval: ApprovalRequest;
    }
  | {
      type: "approval.resolved";
      operationId: string;
      approval: ApprovalRequest;
    }
  | {
      type: "approval.reopened";
      operationId: string;
      approval: ApprovalRequest;
    }
  | {
      type: "commitment.finalized";
      operationId: string;
      commitment: Commitment;
    }
  | {
      type: "escalation.requested";
      operationId: string;
      escalation: Escalation;
    }
  | {
      type: "deal.reviewed";
      operationId: string;
      reviewedDeal: ReviewedDeal;
    }
  | {
      type: "selection.created";
      operationId: string;
      selection: ClientSelection;
    }
  | {
      type: "confirmation.failed";
      operationId: string;
      reason: string;
    }
  | {
      type: "incident.updated";
      operationId: string;
      incident: Incident;
    }
  | {
      type: "dashboard.notification.created";
      operationId: string;
      notification: DashboardNotification;
    };

export type EvidenceSourceType =
  | "operation"
  | "shipment_event"
  | "quote"
  | "approval"
  | "call"
  | "transcript"
  | "commitment"
  | "escalation";

export type EvidenceCitation = {
  id: string;
  sourceType: EvidenceSourceType;
  sourceId: string;
  operationId: string;
  title: string;
  excerpt: string;
  occurredAt: string;
  href: string;
};

export type ShipmentEvent = {
  id: string;
  organizationId: string;
  operationId: string;
  type:
    | "created"
    | "pickup_scheduled"
    | "at_origin"
    | "picked_up"
    | "in_transit"
    | "checkpoint"
    | "delivered"
    | "exception";
  label: string;
  location?: string;
  source: string;
  occurredAt: string;
  receivedAt: string;
  metadata?: Record<string, unknown>;
};

export type TranscriptSegment = {
  id: string;
  organizationId: string;
  operationId: string;
  callId: string;
  speaker: "agent" | "carrier" | "dispatcher" | "unknown";
  text: string;
  startMs: number;
  endMs: number;
  createdAt: string;
};

export type ProposedAction = {
  id: string;
  organizationId: string;
  conversationId: string;
  operationId: string;
  type: "close_approved_deal";
  status:
    "pending" | "approved" | "declined" | "executed" | "failed" | "expired";
  summary: string;
  expectedOperationVersion: string;
  requestedBy: string;
  decidedBy?: string;
  createdAt: string;
  decidedAt?: string;
  executedAt?: string;
  failureReason?: string;
};

export type AgentMessage = {
  id: string;
  conversationId: string;
  role: "assistant" | "user";
  content: string;
  citations: EvidenceCitation[];
  proposedActions: ProposedAction[];
  createdAt: string;
};

export type AgentConversation = {
  id: string;
  organizationId: string;
  createdBy: string;
  title: string;
  messages: AgentMessage[];
  createdAt: string;
  updatedAt: string;
};
