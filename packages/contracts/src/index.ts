export type Mandate = {
  maxPriceMxn: number;
  pickupTime: string;
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

export type Operation = {
  id: string;
  containerId: string;
  shipper: string;
  origin: string;
  destination: string;
  status: "open" | "negotiating" | "committed" | "escalated" | "failed";
  mandate: Mandate;
  candidates: CarrierCandidate[];
  quotes: Quote[];
  selectedCarrierId?: string;
  commitment?: Commitment;
  callBriefs: CallBrief[];
  escalations: Escalation[];
};

export type OperationEvent =
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
    };
