import { createHmac } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  inboundTextMessage,
  receivedKapsoMessages,
  verifyKapsoSignature
} from "../../src/whatsapp/kapso";

describe("Kapso WhatsApp webhook helpers", () => {
  it("validates the HMAC signature against the raw payload", () => {
    const rawBody = Buffer.from('{"message":"hola"}');
    const signature = createHmac("sha256", "secret")
      .update(rawBody)
      .digest("hex");

    expect(verifyKapsoSignature(rawBody, signature, "secret")).toBe(true);
    expect(verifyKapsoSignature(rawBody, signature, "other-secret")).toBe(
      false
    );
  });

  it("normalizes an inbound text from a buffered v2 delivery", () => {
    const messages = receivedKapsoMessages({
      batch: true,
      data: [
        {
          message: {
            id: "wamid.1",
            type: "text",
            from: "+573001112233",
            text: { body: " ¿Qué necesita atención? " },
            kapso: { direction: "inbound" }
          }
        }
      ]
    });

    expect(inboundTextMessage(messages[0])).toEqual({
      id: "wamid.1",
      from: "+573001112233",
      content: "¿Qué necesita atención?"
    });
  });
});
