import { createHmac, timingSafeEqual } from "node:crypto";

export type KapsoMessenger = {
  sendText(input: { to: string; text: string }): Promise<void>;
};

export type KapsoWebhookMessage = {
  id?: string;
  type?: string;
  from?: string;
  text?: { body?: string };
  kapso?: { direction?: string };
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

export function inboundTextMessage(data: KapsoWebhookData) {
  const message = data.message;
  if (!message || message.kapso?.direction !== "inbound") return undefined;
  const from = message.from ?? data.conversation?.phone_number;
  if (!from) return undefined;
  return {
    id: message.id,
    from,
    content: message.type === "text" ? message.text?.body?.trim() : undefined
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
