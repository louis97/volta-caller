import type { ToolCallRequest, ToolCallResult } from "../agent/interpreter";
import type { ModeConfiguration } from "../agent/modes";
import type { AgentToolDefinition } from "../agent/tools";

export type RelaySocket = {
  send(message: string): void;
  on(event: "message" | "close", listener: (message: string) => void): void;
};

export type RealtimeSessionConfig = {
  input_audio_format: "audio/pcmu";
  output_audio_format: "audio/pcmu";
  turn_detection: {
    type: "server_vad";
    silence_duration_ms: number;
  };
  interrupt_response: true;
  instructions: string;
  tools: AgentToolDefinition[];
};

export type MediaStreamRelayDependencies = {
  twilio: RelaySocket;
  realtime: RelaySocket;
  configuration: ModeConfiguration;
  executeToolCall: (request: ToolCallRequest) => Promise<ToolCallResult>;
};

export type RealtimeSocketFactory = () => RelaySocket;

export function createRealtimeSessionConfig(
  configuration: ModeConfiguration
): RealtimeSessionConfig {
  return {
    input_audio_format: "audio/pcmu",
    output_audio_format: "audio/pcmu",
    turn_detection: { type: "server_vad", silence_duration_ms: 350 },
    interrupt_response: true,
    instructions: configuration.instructions,
    tools: configuration.tools
  };
}

export function attachMediaStreamRelay({
  twilio,
  realtime,
  configuration,
  executeToolCall: runToolCall
}: MediaStreamRelayDependencies): void {
  let streamSid: string | undefined;

  realtime.send(
    JSON.stringify({
      type: "session.update",
      session: createRealtimeSessionConfig(configuration)
    })
  );

  twilio.on("message", (message) => {
    const event = parseEvent(message);
    if (!event) return;

    if (event.event === "start") {
      streamSid =
        stringValue(objectValue(event.start)?.streamSid) ??
        stringValue(event.streamSid);
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
