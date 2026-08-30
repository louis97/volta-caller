import { createHmac } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import {
  createKapsoMessenger,
  inboundKapsoMessage,
  inboundTextMessage,
  receivedKapsoMessages,
  verifyKapsoSignature,
  whatsappActionDecision
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

  it("recognizes explicit WhatsApp approvals but rejects an ambiguous yes", () => {
    expect(whatsappActionDecision("APROBAR")).toEqual({
      decision: "approve"
    });
    expect(whatsappActionDecision("Apruebo a1b2c3d4.")).toEqual({
      decision: "approve",
      reference: "a1b2c3d4"
    });
    expect(whatsappActionDecision("RECHAZAR")).toEqual({
      decision: "decline"
    });
    expect(whatsappActionDecision("Sí")).toBeUndefined();
    expect(
      whatsappActionDecision("Sí, la dirección está correcta")
    ).toBeUndefined();
  });

  it("normalizes an interactive approval button with its action reference", () => {
    expect(
      inboundKapsoMessage({
        message: {
          id: "wamid.button-1",
          type: "interactive",
          from: "+573001112233",
          interactive: {
            type: "button_reply",
            button_reply: {
              id: "volta:approve:123e4567-e89b-12d3-a456-426614174000",
              title: "Aprobar"
            }
          },
          kapso: { direction: "inbound" }
        }
      })
    ).toEqual({
      id: "wamid.button-1",
      from: "+573001112233",
      type: "interactive",
      content: "Aprobar",
      actionDecision: {
        decision: "approve",
        reference: "123e4567-e89b-12d3-a456-426614174000"
      }
    });
  });

  it("sends native interactive reply buttons through Kapso", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 200 }));
    const messenger = createKapsoMessenger({
      apiKey: "kapso-key",
      phoneNumberId: "phone-123",
      fetchFn
    });

    await messenger.sendInteractiveButtons?.({
      to: "+573001112233",
      bodyText: "¿Apruebas el mandato?",
      buttons: [
        { id: "volta:approve:action-1", title: "Aprobar" },
        { id: "volta:decline:action-1", title: "Rechazar" }
      ]
    });

    const request = fetchFn.mock.calls[0][1] as RequestInit;
    expect(JSON.parse(request.body as string)).toEqual({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: "573001112233",
      type: "interactive",
      interactive: {
        type: "button",
        body: { text: "¿Apruebas el mandato?" },
        action: {
          buttons: [
            {
              type: "reply",
              reply: {
                id: "volta:approve:action-1",
                title: "Aprobar"
              }
            },
            {
              type: "reply",
              reply: {
                id: "volta:decline:action-1",
                title: "Rechazar"
              }
            }
          ]
        }
      }
    });
  });
});
