import { createHmac, timingSafeEqual } from "node:crypto";

export type KapsoMessenger = {
  sendText(input: { to: string; text: string }): Promise<void>;
  sendInteractiveButtons?(input: {
    to: string;
    bodyText: string;
    buttons: Array<{ id: string; title: string }>;
  }): Promise<void>;
};

export type KapsoWebhookMessage = {
  id?: string;
  type?: string;
  from?: string;
  text?: { body?: string };
  interactive?: {
    type?: string;
    button_reply?: { id?: string; title?: string };
  };
  kapso?: {
    direction?: string;
    /** LLM-ready message content supplied by Kapso, including audio transcripts. */
    content?: string;
    transcript?: { text?: string };
  };
};

export type KapsoWebhookData = {
  message?: KapsoWebhookMessage;
  conversation?: { id?: string; phone_number?: string };
};

export type KapsoWebhookPayload = KapsoWebhookData & {
  type?: string;
  batch?: boolean;
  data?: KapsoWebhookData[];
};

export function verifyKapsoSignature(
  rawBody: Buffer,
  signature: string | undefined,
  secret: string | undefined
): boolean {
  if (!signature || !secret) return false;
  const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
  const expectedBytes = Buffer.from(expected, "utf8");
  const suppliedBytes = Buffer.from(signature, "utf8");
  return (
    expectedBytes.length === suppliedBytes.length &&
    timingSafeEqual(expectedBytes, suppliedBytes)
  );
}

export function receivedKapsoMessages(
  payload: KapsoWebhookPayload
): KapsoWebhookData[] {
  return payload.batch && Array.isArray(payload.data)
    ? payload.data
    : [payload];
}

export type KapsoInboundMessage = {
  id?: string;
  from: string;
  content?: string;
  type?: string;
  actionDecision?: WhatsAppActionDecision;
};

export type WhatsAppActionDecision = {
  decision: "approve" | "decline";
  reference?: string;
};

/**
 * Accepts only explicit approval commands. A bare "sí" is intentionally not
 * actionable because it can also answer an intake question.
 */
export function whatsappActionDecision(
  content: string | undefined
): WhatsAppActionDecision | undefined {
  if (!content) return undefined;
  const normalized = content
    .trim()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
  const buttonMatch = normalized.match(
    /^volta:(approve|decline):([a-f0-9-]{36})$/
  );
  if (buttonMatch) {
    return {
      decision: buttonMatch[1] as "approve" | "decline",
      reference: buttonMatch[2]
    };
  }
  const match = normalized.match(
    /^(aprobar|apruebo|confirmar|confirmo|approve|rechazar|rechazo|decline)(?:\s+([a-z0-9-]{6,64}))?[.!]?$/
  );
  if (!match) return undefined;
  return {
    decision: /^(rechazar|rechazo|decline)$/.test(match[1])
      ? "decline"
      : "approve",
    ...(match[2] ? { reference: match[2] } : {})
  };
}

/**
 * Normalizes the inbound formats that can be understood by the operational
 * agent. For voice notes, Kapso provides speech-to-text in `transcript.text`
 * (and, for newer payloads, its LLM-ready `content` field).
 */
export function inboundKapsoMessage(
  data: KapsoWebhookData
): KapsoInboundMessage | undefined {
  const message = data.message;
  if (!message || message.kapso?.direction !== "inbound") return undefined;
  const from = message.from ?? data.conversation?.phone_number;
  if (!from) return undefined;
  const buttonReply = message.interactive?.button_reply;
  return {
    id: message.id,
    from,
    type: message.type,
    actionDecision: whatsappActionDecision(buttonReply?.id),
    content:
      message.type === "text"
        ? message.text?.body?.trim()
        : message.type === "interactive"
          ? buttonReply?.title?.trim()
          : (message.kapso?.transcript?.text?.trim() ??
            message.kapso?.content?.trim())
  };
}

/** @deprecated Use inboundKapsoMessage to handle both text and audio. */
export function inboundTextMessage(data: KapsoWebhookData) {
  const inbound = inboundKapsoMessage(data);
  if (!inbound) return undefined;
  return {
    id: inbound.id,
    from: inbound.from,
    content: inbound.content
  };
}

export function createKapsoMessenger(input: {
  apiKey: string;
  phoneNumberId: string;
  fetchFn?: typeof fetch;
}): KapsoMessenger {
  const fetchFn = input.fetchFn ?? fetch;
  const send = async (body: Record<string, unknown>) => {
    const response = await fetchFn(
      `https://api.kapso.ai/meta/whatsapp/v24.0/${encodeURIComponent(input.phoneNumberId)}/messages`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": input.apiKey
        },
        body: JSON.stringify(body)
      }
    );
    if (!response.ok) {
      throw new Error(`kapso_message_send_failed:${response.status}`);
    }
  };
  return {
    async sendText({ to, text }) {
      await send({
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: to.replace(/^\+/, ""),
        type: "text",
        text: { body: text }
      });
    },
    async sendInteractiveButtons({ to, bodyText, buttons }) {
      await send({
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: to.replace(/^\+/, ""),
        type: "interactive",
        interactive: {
          type: "button",
          body: { text: bodyText },
          action: {
            buttons: buttons.map((button) => ({
              type: "reply",
              reply: button
            }))
          }
        }
      });
    }
  };
}
