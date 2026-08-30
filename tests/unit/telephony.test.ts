import { describe, expect, it } from "vitest";

import {
  attachMediaStreamRelay,
  createRealtimeSessionConfig,
  type RelaySocket
} from "../../src/telephony/mediaStream";
import { createInboundTwiML } from "../../src/telephony/twilio";
import { createMockTelephonyGateway } from "../../src/mocks/telephony";

class FakeSocket implements RelaySocket {
  readonly sent: string[] = [];
  private readonly listeners = new Map<
    string,
    Array<(message: string) => void>
  >();

  send(message: string): void {
    this.sent.push(message);
  }

  on(event: "message" | "close", listener: (message: string) => void): void {
    const eventListeners = this.listeners.get(event) ?? [];
    eventListeners.push(listener);
    this.listeners.set(event, eventListeners);
  }

  receive(message: object): void {
    for (const listener of this.listeners.get("message") ?? []) {
      listener(JSON.stringify(message));
    }
  }
}

describe("telephony adapters", () => {
  it("returns a media-stream TwiML response for an inbound call", () => {
    expect(createInboundTwiML("wss://demo.ngrok.app/media-stream")).toContain(
      '<Stream url="wss://demo.ngrok.app/media-stream"'
    );
  });

  it("configures PCMU and server VAD with interruption enabled for realtime sessions", () => {
    // GA session shape. The flat Beta payload is rejected server-side with
    // `beta_api_shape_disabled`, which on a live call looks like a mute agent.
    expect(createRealtimeSessionConfig()).toMatchObject({
      type: "realtime",
      audio: {
        input: {
          format: { type: "audio/pcmu" },
          // Noise reduction and a raised threshold: on a hackathon floor the
          // default sensitivity treats room chatter as an interruption and the
          // agent never finishes a sentence.
          noise_reduction: { type: "near_field" },
          turn_detection: {
            type: "server_vad",
            threshold: 0.7,
            silence_duration_ms: 600,
            interrupt_response: true
          }
        },
        output: { format: { type: "audio/pcmu" } }
      }
    });
  });

  it("relays Twilio audio, Realtime audio, interruption, and function calls through injected sockets", async () => {
    const twilio = new FakeSocket();
    const realtime = new FakeSocket();
    const toolCalls: Array<{ name: string; arguments: unknown }> = [];

    attachMediaStreamRelay({
      twilio,
      realtime,
      executeToolCall: async (request) => {
        toolCalls.push(request);
        return { outcome: "approved" };
      }
    });

    twilio.receive({
      event: "start",
      streamSid: "MZ123",
      start: { streamSid: "MZ123", callSid: "CA123" }
    });
    twilio.receive({
      event: "media",
      streamSid: "MZ123",
      media: { payload: "twilio-pcmu" }
    });
    realtime.receive({
      type: "response.output_audio.delta",
      delta: "openai-pcmu"
    });
    realtime.receive({ type: "input_audio_buffer.speech_started" });
    realtime.receive({
      type: "response.function_call_arguments.done",
      call_id: "call-1",
      name: "check_mandate",
      arguments: JSON.stringify({
        price: 8500,
        pickupTime: "2026-09-03T10:00:00-06:00"
      })
    });
    await Promise.resolve();

    expect(realtime.sent.map((message) => JSON.parse(message))).toEqual(
      expect.arrayContaining([
        // Volta greets on stream start; server VAD would otherwise leave both
        // sides waiting for the other to speak.
        { type: "response.create" },
        { type: "input_audio_buffer.append", audio: "twilio-pcmu" },
        {
          type: "conversation.item.create",
          item: {
            type: "function_call_output",
            call_id: "call-1",
            output: JSON.stringify({ outcome: "approved" })
          }
        },
        { type: "response.create" }
      ])
    );
    expect(twilio.sent.map((message) => JSON.parse(message))).toEqual([
      { event: "media", streamSid: "MZ123", media: { payload: "openai-pcmu" } },
      { event: "clear", streamSid: "MZ123" }
    ]);
    expect(toolCalls).toEqual([
      {
        name: "check_mandate",
        arguments: { price: 8500, pickupTime: "2026-09-03T10:00:00-06:00" }
      }
    ]);
  });

  it("uses the mock gateway without connecting to Twilio", async () => {
    const gateway = createMockTelephonyGateway({
      now: () => "2026-09-01T15:00:00.000Z"
    });

    const session = await gateway.createOutboundCall({
      operationId: "operation-001",
      carrierId: "carrier-001",
      to: "+525500000000",
      from: "+525522222222",
      twimlUrl: "https://volta.example.test/twiml"
    });
    await gateway.transferToSupervisor({
      callId: session.id,
      supervisorPhone: "+525511111111"
    });

    expect(session).toMatchObject({
      direction: "outbound",
      status: "in_progress",
      startedAt: "2026-09-01T15:00:00.000Z"
    });
    expect(gateway.calls).toEqual([
      { type: "transferred", callId: session.id }
    ]);
  });
});
