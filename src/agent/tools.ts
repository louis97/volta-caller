import { z } from "zod";

export const checkMandateSchema = z.object({
  price: z.number().nonnegative(),
  pickupTime: z.string().datetime({ offset: true })
});

/**
 * `id`, `callId` and `createdAt` are stripped from what the model sees and
 * always overwritten by the server. A model asked which call it is on will
 * invent a plausible id, and with several calls running that silently
 * misattributes quotes between carriers.
 */
export const registerQuoteSchema = z.object({
  id: z.string().min(1).optional(),
  carrierId: z.string().min(1),
  carrierName: z.string().min(1),
  priceMxn: z.number().nonnegative(),
  etaMinutes: z.number().int().nonnegative(),
  pickupTime: z.string().datetime({ offset: true }),
  callId: z.string().min(1).optional(),
  createdAt: z.string().datetime({ offset: true }).optional()
});

/** Takes no arguments: the caller's identity comes from the call, not the model. */
export const getLeverageSchema = z.object({});

export const reviewDealSchema = z.object({
  quoteId: z.string().min(1),
  reviewedAt: z.string().datetime({ offset: true })
});

export const confirmSelectedDealSchema = z.object({
  quoteId: z.string().min(1),
  carrierId: z.string().min(1),
  finalPrice: z.number().nonnegative(),
  pickupTime: z.string().datetime({ offset: true }),
  destinationDatetime: z.string().datetime({ offset: true }),
  typeOfContent: z.string().min(1),
  weightKg: z.number().positive(),
  measures: z.string().min(1),
  /**
   * Audio offset the commitment is anchored to. Counted from Twilio media
   * frames server-side: an invented offset makes a hallucinated commitment
   * indistinguishable from a real one in the audit trail.
   */
  timestampMs: z.number().int().nonnegative().optional(),
  driverName: z.string().min(1).optional(),
  plate: z.string().min(1).optional(),
  callId: z.string().min(1).optional()
});

export const triggerEscalationSchema = z.object({
  reason: z.string().min(1),
  current_price_offered: z.number().nonnegative(),
  callId: z.string().min(1).optional()
});

export const recordIncidentSchema = z.object({
  callerName: z.string().min(1),
  carrierId: z.string().min(1),
  truckPlate: z.string().min(1).optional(),
  processStage: z.string().min(1),
  issue: z.string().min(1),
  delayMinutes: z.number().int().nonnegative(),
  revisedEta: z.string().datetime({ offset: true })
});

export const updateOperationStatusSchema = z.object({
  incidentId: z.string().min(1)
});

export const notifyDashboardSchema = z.object({
  incidentId: z.string().min(1)
});

export type AgentToolName =
  | "check_mandate"
  | "get_leverage"
  | "register_quote"
  | "review_deal"
  | "confirm_selected_deal"
  | "record_incident"
  | "update_operation_status"
  | "notify_dashboard"
  | "trigger_escalation";

export type AgentToolDefinition = {
  type: "function";
  name: AgentToolName;
  description: string;
  parameters: Record<string, unknown>;
};

function defineTool(
  name: AgentToolName,
  description: string,
  schema: z.ZodObject
): AgentToolDefinition {
  return {
    type: "function",
    name,
    description,
    parameters: z.toJSONSchema(schema)
  };
}

export const checkMandateTool = defineTool(
  "check_mandate",
  "Check whether a proposed price and pickup time comply with the shipment mandate.",
  checkMandateSchema
);

// Identity and timing are stripped from what the model may fill in, so it
// cannot assert them at all; the server supplies them from the live call.
export const registerQuoteTool = defineTool(
  "register_quote",
  "Record a carrier's complete factual quote.",
  registerQuoteSchema.omit({ id: true, callId: true, createdAt: true })
);

export const getLeverageTool = defineTool(
  "get_leverage",
  "Return the quotes other carriers have actually given on this operation, to use as a reference when negotiating. Only real offers are returned: if it is empty, there is nothing to cite and no third-party price may be mentioned.",
  getLeverageSchema
);

export const reviewDealTool = defineTool(
  "review_deal",
  "Publish a completed carrier quote and its mandate evaluation for client review.",
  reviewDealSchema
);

export const confirmSelectedDealTool = defineTool(
  "confirm_selected_deal",
  "Finalize only the client-selected quote after the carrier confirms every original term unchanged.",
  confirmSelectedDealSchema.omit({ timestampMs: true, callId: true })
);

export const triggerEscalationTool = defineTool(
  "trigger_escalation",
  "Request human intervention for pressure, contradictions, or unsupported exceptions.",
  triggerEscalationSchema
);

export const recordIncidentTool = defineTool(
  "record_incident",
  "Record verified operational facts reported during this exception call.",
  recordIncidentSchema
);

export const updateOperationStatusTool = defineTool(
  "update_operation_status",
  "Set incident monitoring only for a recorded incident whose ETA meets the destination deadline.",
  updateOperationStatusSchema
);

export const notifyDashboardTool = defineTool(
  "notify_dashboard",
  "Notify the dashboard once for a recorded incident whose ETA misses the destination deadline.",
  notifyDashboardSchema
);

export const agentToolDefinitions: AgentToolDefinition[] = [
  checkMandateTool,
  getLeverageTool,
  registerQuoteTool,
  reviewDealTool,
  confirmSelectedDealTool,
  triggerEscalationTool
];
