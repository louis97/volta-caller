import type { ToolCallRequest, ToolCallResult } from "../agent/interpreter";
import { VOLTA_SYSTEM_PROMPT } from "../agent/prompt";
import { agentToolDefinitions } from "../agent/tools";

export type RelaySocket = {
  send(message: string): void;
  on(event: "message" | "close", listener: (message: string) => void): void;
};

export type RealtimeSessionConfig = {
  type: "realtime";
  audio: {
    input: {
      format: { type: "audio/pcmu" };
      transcription: { model: string };
      turn_detection: {
        type: "server_vad";
        silence_duration_ms: number;
        interrupt_response: true;
      };
    };
    output: {
      format: { type: "audio/pcmu" };
      voice: string;
    };
  };
  instructions: string;
  tools: typeof agentToolDefinitions;
};

export type MediaStreamRelayDependencies = {
  twilio: RelaySocket;
  realtime: RelaySocket;
  executeToolCall: (request: ToolCallRequest) => Promise<ToolCallResult>;
};

export type RealtimeSocketFactory = () => RelaySocket;

/**
 * GA session shape. The Realtime Beta API is switched off server-side: sending
 * the old flat `input_audio_format` payload (or the `OpenAI-Beta` header) is
 * rejected with `beta_api_shape_disabled` and the socket closes, which on a
 * live call reads as "Volta never speaks".
 *
 * `audio/pcmu` on both ends matches what Twilio streams, so no transcoding
 * happens anywhere in the path.
 */
export function createRealtimeSessionConfig(
  voice = "marin"
): RealtimeSessionConfig {
  return {
    type: "realtime",
    audio: {
      input: {
        format: { type: "audio/pcmu" },
        // Needed for the call brief and the audit transcript.
        transcription: { model: "whisper-1" },
        turn_detection: {
          type: "server_vad",
          silence_duration_ms: 350,
          interrupt_response: true
        }
      },
      output: { format: { type: "audio/pcmu" }, voice }
    },
    instructions: VOLTA_SYSTEM_PROMPT,
    tools: agentToolDefinitions
  };
}

export function attachMediaStreamRelay({
  twilio,
  realtime,
  executeToolCall: runToolCall
}: MediaStreamRelayDependencies): void {
  let streamSid: string | undefined;

  realtime.send(
    JSON.stringify({
      type: "session.update",
      session: createRealtimeSessionConfig()
    })
  );

  twilio.on("message", (message) => {
    const event = parseEvent(message);
    if (!event) return;

    if (event.event === "start") {
      streamSid =
        stringValue(objectValue(event.start)?.streamSid) ??
        stringValue(event.streamSid);

      // Volta places the call, so Volta opens the conversation. Server VAD only
      // produces a response after it hears speech, so without this the agent
      // waits in silence for a carrier who is waiting for it to say something.
      realtime.send(JSON.stringify({ type: "response.create" }));
      return;
    }
    if (event.event !== "media") return;

    const payload = stringValue(objectValue(event.media)?.payload);
    streamSid = stringValue(event.streamSid) ?? streamSid;
    if (payload)
      realtime.send(
        JSON.stringify({ type: "input_audio_buffer.append", audio: payload })
      );
  });

  realtime.on("message", (message) => {
    const event = parseEvent(message);
    if (!event) return;

    if (
      event.type === "response.output_audio.delta" ||
      event.type === "response.audio.delta"
    ) {
      const delta = stringValue(event.delta);
      if (delta && streamSid) {
        twilio.send(
          JSON.stringify({
            event: "media",
            streamSid,
            media: { payload: delta }
          })
        );
      }
      return;
    }

    if (
      event.type === "input_audio_buffer.speech_started" ||
      event.type === "response.cancelled"
    ) {
      if (streamSid) twilio.send(JSON.stringify({ event: "clear", streamSid }));
      return;
    }

    if (event.type === "response.function_call_arguments.done") {
      void handleFunctionCall(event, realtime, runToolCall);
    }
  });
}

export function connectRealtimeRelay(
  dependencies: Omit<MediaStreamRelayDependencies, "realtime"> & {
    socketFactory: RealtimeSocketFactory;
  }
): RelaySocket {
  const realtime = dependencies.socketFactory();
  attachMediaStreamRelay({ ...dependencies, realtime });
  return realtime;
}

async function handleFunctionCall(
  event: Record<string, unknown>,
  realtime: RelaySocket,
  runToolCall: MediaStreamRelayDependencies["executeToolCall"]
): Promise<void> {
  const callId = stringValue(event.call_id);
  const name = stringValue(event.name);
  const rawArguments = stringValue(event.arguments);
  if (!callId || !name || rawArguments === undefined) return;

  let argumentsValue: unknown;
  try {
    argumentsValue = JSON.parse(rawArguments);
  } catch {
    argumentsValue = rawArguments;
  }
  const result = await runToolCall({ name, arguments: argumentsValue });
  realtime.send(
    JSON.stringify({
      type: "conversation.item.create",
      item: {
        type: "function_call_output",
        call_id: callId,
        output: JSON.stringify(result)
      }
    })
  );
  realtime.send(JSON.stringify({ type: "response.create" }));
}

function parseEvent(message: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(message);
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}
