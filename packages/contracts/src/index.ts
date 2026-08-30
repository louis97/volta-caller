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

export type OperationStatus =
  | "open"
  | "negotiating"
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
  quotes: Quote[];
  selectedCarrierId?: string;
  commitment?: Commitment;
  callBriefs: CallBrief[];
  escalations: Escalation[];
  reviewedDeals: ReviewedDeal[];
  selection?: ClientSelection;
  incidents: Incident[];
  dashboardNotifications: DashboardNotification[];
};

export type OperationEvent =
  | { type: "mandate.created"; operationId: string; mandate: Mandate }
  | { type: "quote.registered"; operationId: string; quote: Quote }
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
