import { createHmac, timingSafeEqual } from "node:crypto";

export type KapsoMessenger = {
  sendText(input: { to: string; text: string }): Promise<void>;
};

export type KapsoWebhookMessage = {
  id?: string;
  type?: string;
  from?: string;
  text?: { body?: string };
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
};

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
  return {
    id: message.id,
    from,
    type: message.type,
    content:
      message.type === "text"
        ? message.text?.body?.trim()
        : message.kapso?.transcript?.text?.trim() ??
          message.kapso?.content?.trim()
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
  return {
    async sendText({ to, text }) {
      const response = await fetchFn(
        `https://api.kapso.ai/meta/whatsapp/v24.0/${encodeURIComponent(input.phoneNumberId)}/messages`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-api-key": input.apiKey
          },
          body: JSON.stringify({
            messaging_product: "whatsapp",
            recipient_type: "individual",
            to: to.replace(/^\+/, ""),
            type: "text",
            text: { body: text }
          })
        }
      );
      if (!response.ok) {
        throw new Error(`kapso_message_send_failed:${response.status}`);
      }
    }
  };
}
