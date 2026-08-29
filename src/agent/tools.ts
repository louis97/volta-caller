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

export const commitDealSchema = z.object({
  carrierId: z.string().min(1),
  finalPrice: z.number().nonnegative(),
  pickupTime: z.string().datetime({ offset: true }),
  timestampMs: z.number().int().nonnegative(),
  driverName: z.string().optional(),
  plate: z.string().optional()
});

export const triggerEscalationSchema = z.object({
  reason: z.string().min(1),
  current_price_offered: z.number().nonnegative(),
  callId: z.string().min(1).optional()
});

type AgentToolDefinition = {
  type: "function";
  name:
    "check_mandate" | "register_quote" | "commit_deal" | "trigger_escalation";
  description: string;
  parameters: Record<string, unknown>;
};

function defineTool(
  name: AgentToolDefinition["name"],
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

export const agentToolDefinitions: AgentToolDefinition[] = [
  defineTool(
    "check_mandate",
    "Comprueba si precio y ventana de recolección están autorizados.",
    checkMandateSchema
  ),
  defineTool(
    "register_quote",
    "Registra una cotización completa de un transportista.",
    registerQuoteSchema
  ),
  defineTool(
    "commit_deal",
    "Solicita reservar un acuerdo con términos ya confirmados.",
    commitDealSchema
  ),
  defineTool(
    "trigger_escalation",
    "Solicita intervención humana para términos no aprobados.",
    triggerEscalationSchema
  )
];
