import { z } from "zod";

export const checkMandateSchema = z.object({
  price: z.number().nonnegative(),
  pickupTime: z.string().datetime({ offset: true })
});

/**
 * `id`, `callId` and `createdAt` stay optional here so existing callers can
 * supply them, but they are stripped from what the model sees and always
 * overwritten by the server. A model asked which call it is on will invent a
 * plausible id, and with several calls running that silently misattributes
 * quotes.
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

/**
 * `timestampMs` is the audio offset a commitment is anchored to. It comes from
 * counting Twilio media frames, never from the model: an invented offset makes
 * a hallucinated commitment indistinguishable from a real one in the audit
 * trail.
 */
export const commitDealSchema = z.object({
  carrierId: z.string().min(1),
  finalPrice: z.number().nonnegative(),
  pickupTime: z.string().datetime({ offset: true }),
  timestampMs: z.number().int().nonnegative().optional(),
  driverName: z.string().optional(),
  plate: z.string().optional()
});

export const requestQuoteApprovalSchema = z.object({
  quoteIds: z.array(z.string().min(1)).min(1),
  recommendedQuoteId: z.string().min(1).optional()
});

/** Takes no arguments: the caller's own identity comes from the call, not the model. */
export const getLeverageSchema = z.object({});

export const triggerEscalationSchema = z.object({
  reason: z.string().min(1),
  current_price_offered: z.number().nonnegative(),
  callId: z.string().min(1).optional()
});

type AgentToolDefinition = {
  type: "function";
  name:
    | "check_mandate"
    | "register_quote"
    | "request_quote_approval"
    | "commit_deal"
    | "trigger_escalation"
    | "get_leverage";
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

// What the model is allowed to fill in. Server-owned identity and timing
// fields are omitted so the model cannot assert them at all.
const registerQuoteModelSchema = registerQuoteSchema.omit({
  id: true,
  callId: true,
  createdAt: true
});
const commitDealModelSchema = commitDealSchema.omit({ timestampMs: true });

export const agentToolDefinitions: AgentToolDefinition[] = [
  defineTool(
    "check_mandate",
    "Comprueba si precio y ventana de recolección están autorizados.",
    checkMandateSchema
  ),
  defineTool(
    "register_quote",
    "Registra una cotización completa de un transportista.",
    registerQuoteModelSchema
  ),
  defineTool(
    "request_quote_approval",
    "Envía la ronda de cotizaciones al dispatcher para que autorice una llamada de cierre.",
    requestQuoteApprovalSchema
  ),
  defineTool(
    "commit_deal",
    "Solicita reservar un acuerdo con términos ya confirmados.",
    commitDealModelSchema
  ),
  defineTool(
    "get_leverage",
    "Devuelve las cotizaciones reales que otros transportistas ya dieron en esta operación, para usarlas como referencia al negociar. Solo devuelve ofertas que existen: si está vacío, no hay nada que citar y no debes mencionar ningún precio de terceros.",
    getLeverageSchema
  ),
  defineTool(
    "trigger_escalation",
    "Solicita intervención humana para términos no aprobados.",
    triggerEscalationSchema
  )
];
