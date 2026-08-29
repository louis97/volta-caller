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
  operationId: string;
  carrierId?: string;
  driverName?: string;
  direction: "inbound" | "outbound";
  status: "pending" | "in_progress" | "completed" | "failed" | "transferred";
  audioUrl?: string;
  transcript?: string;
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

export type Operation = {
  id: string;
  containerId: string;
  shipper: string;
  origin: string;
  destination: string;
  status:
    | "open"
    | "negotiating"
    | "awaiting_approval"
    | "committed"
    | "escalated"
    | "failed";
  mandate: Mandate;
  candidates: CarrierCandidate[];
  quotes: Quote[];
  approvals: ApprovalRequest[];
  closingAuthorization?: ClosingAuthorization;
  selectedCarrierId?: string;
  commitment?: Commitment;
  callBriefs: CallBrief[];
  escalations: Escalation[];
};

export type OperationEvent =
  | { type: "mandate.created"; operationId: string; mandate: Mandate }
  | { type: "quote.registered"; operationId: string; quote: Quote }
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
    };
