import { createHmac } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  inboundKapsoMessage,
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

  it("uses Kapso's voice-note transcript as the agent input", () => {
    const inbound = inboundKapsoMessage({
      message: {
        id: "wamid.audio-1",
        type: "audio",
        from: "+573001112233",
        kapso: {
          direction: "inbound",
          transcript: { text: "  Muéstrame la operación más urgente  " }
        }
      }
    });

    expect(inbound).toEqual({
      id: "wamid.audio-1",
      from: "+573001112233",
      type: "audio",
      content: "Muéstrame la operación más urgente"
    });
  });
});
