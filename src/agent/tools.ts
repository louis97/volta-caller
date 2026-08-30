import { z } from "zod";

export const checkMandateSchema = z.object({
  price: z.number().nonnegative(),
  pickupTime: z.string().datetime({ offset: true })
});

export const registerQuoteSchema = z.object({
  id: z.string().min(1),
  carrierId: z.string().min(1),
  carrierName: z.string().min(1),
  priceMxn: z.number().nonnegative(),
  etaMinutes: z.number().int().nonnegative(),
  pickupTime: z.string().datetime({ offset: true }),
  callId: z.string().min(1),
  createdAt: z.string().datetime({ offset: true })
});

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
  timestampMs: z.number().int().nonnegative(),
  driverName: z.string().min(1).optional(),
  plate: z.string().min(1).optional(),
  callId: z.string().min(1)
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

export const registerQuoteTool = defineTool(
  "register_quote",
  "Record a carrier's complete factual quote and call reference.",
  registerQuoteSchema
);

export const reviewDealTool = defineTool(
  "review_deal",
  "Publish a completed carrier quote and its mandate evaluation for client review.",
  reviewDealSchema
);

export const confirmSelectedDealTool = defineTool(
  "confirm_selected_deal",
  "Finalize only the client-selected quote after the carrier confirms every original term unchanged.",
  confirmSelectedDealSchema
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
  registerQuoteTool,
  reviewDealTool,
  confirmSelectedDealTool,
  triggerEscalationTool
];
