import type { ToolCallRequest, ToolCallResult } from "../agent/interpreter";
import type { ModeConfiguration } from "../agent/modes";
import { VOLTA_SYSTEM_PROMPT } from "../agent/prompt";
import { agentToolDefinitions, type AgentToolDefinition } from "../agent/tools";
import { env } from "../config/env";
import type { CallRuntime } from "./registry";

export type RelaySocket = {
  send(message: string): void;
  on(event: "message" | "close", listener: (message: string) => void): void;
};

export type TurnDetectionConfig =
  | {
      type: "server_vad";
      threshold: number;
      silence_duration_ms: number;
      prefix_padding_ms: number;
      interrupt_response: true;
    }
  | { type: "semantic_vad"; eagerness: string; interrupt_response: true };

export type RealtimeSessionConfig = {
  type: "realtime";
  audio: {
    input: {
      format: { type: "audio/pcmu" };
      transcription: { model: string };
      noise_reduction?: { type: "near_field" | "far_field" };
      turn_detection: TurnDetectionConfig;
    };
    output: {
      format: { type: "audio/pcmu" };
      voice: string;
    };
  };
  instructions: string;
  tools: AgentToolDefinition[];
};

export type MediaStreamRelayDependencies = {
  twilio: RelaySocket;
  realtime: RelaySocket;
  executeToolCall: (request: ToolCallRequest) => Promise<ToolCallResult>;
  /**
   * Called once when Twilio announces the stream. Returning a runtime lets the
   * relay keep the call clock ticking: every media frame is 20 ms of audio, and
   * counting them is what anchors a commitment to the moment it was agreed.
   */
  onStart?: (info: {
    streamSid: string;
    callSid?: string;
  }) => CallRuntime | undefined;
  /**
   * Briefing for this specific call, applied once the carrier is known. The
   * initial session.update goes out before Twilio says who we reached, so the
   * job details are sent as a second update rather than guessed at.
   */
  instructionsFor?: (runtime: CallRuntime) => string;
  /** Mode for this call; decides which tools the session exposes. */
  configuration?: ModeConfiguration;
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
/**
 * GA session shape. The Realtime Beta API is switched off server-side: sending
 * the old flat `input_audio_format` payload (or the `OpenAI-Beta` header) is
 * rejected with `beta_api_shape_disabled` and the socket closes, which on a
 * live call reads as "Volta never speaks".
 *
 * `audio/pcmu` on both ends matches what Twilio streams, so no transcoding
 * happens anywhere in the path.
 *
 * Turn taking is read from configuration: in a noisy room the default
 * sensitivity treats background chatter as an interruption and the agent
 * cannot finish a sentence, and that has to be fixable between two calls.
 */
export function createRealtimeSessionConfig(
  input:
    | ModeConfiguration
    | Partial<{
        voice: string;
        turnDetection: TurnDetectionConfig;
        noiseReduction: "near_field" | "far_field" | "none";
        /**
         * Which call this is. Each mode exposes only the tools that make sense for
         * it, so the agent cannot confirm a booking during a negotiation call: the
         * tool is not on the session at all.
         */
        configuration: ModeConfiguration;
      }> = {}
): RealtimeSessionConfig {
  // Callers pass either tuning overrides or a mode configuration directly.
  const overrides =
    "instructions" in input
      ? { configuration: input as ModeConfiguration }
      : input;
  const turnDetection: TurnDetectionConfig =
    overrides.turnDetection ??
    (env.REALTIME_TURN_DETECTION === "semantic_vad"
      ? {
          type: "semantic_vad",
          eagerness: env.REALTIME_VAD_EAGERNESS,
          interrupt_response: true
        }
      : {
          type: "server_vad",
          threshold: env.REALTIME_VAD_THRESHOLD,
          silence_duration_ms: env.REALTIME_VAD_SILENCE_MS,
          prefix_padding_ms: env.REALTIME_VAD_PREFIX_MS,
          interrupt_response: true
        });

  const noiseReduction =
    overrides.noiseReduction ?? env.REALTIME_NOISE_REDUCTION;

  return {
    type: "realtime",
    audio: {
      input: {
        format: { type: "audio/pcmu" },
        // Needed for the call brief and the audit transcript.
        transcription: { model: "whisper-1" },
        ...(noiseReduction === "none"
          ? {}
          : { noise_reduction: { type: noiseReduction } }),
        turn_detection: turnDetection
      },
      output: {
        format: { type: "audio/pcmu" },
        voice: overrides.voice ?? env.OPENAI_REALTIME_VOICE
      }
    },
    instructions: overrides.configuration?.instructions ?? VOLTA_SYSTEM_PROMPT,
    tools: overrides.configuration
      ? [...overrides.configuration.tools]
      : agentToolDefinitions
  };
}

export function attachMediaStreamRelay({
  twilio,
  realtime,
  executeToolCall: runToolCall,
  onStart,
  instructionsFor,
  configuration
}: MediaStreamRelayDependencies): void {
  let streamSid: string | undefined;
  let runtime: CallRuntime | undefined;

  realtime.send(
    JSON.stringify({
      type: "session.update",
      session: createRealtimeSessionConfig({ configuration })
    })
  );

  twilio.on("message", (message) => {
    const event = parseEvent(message);
    if (!event) return;

    if (event.event === "start") {
      streamSid =
        stringValue(objectValue(event.start)?.streamSid) ??
        stringValue(event.streamSid);

      const start = objectValue(event.start);
      if (streamSid) {
        runtime = onStart?.({
          streamSid,
          callSid: stringValue(start?.callSid)
        });
      }

      // Now that the carrier is known, replace the generic instructions with
      // the briefing for this job before the agent says anything.
      if (runtime && instructionsFor) {
        realtime.send(
          JSON.stringify({
            type: "session.update",
            session: {
              type: "realtime",
              instructions: instructionsFor(runtime)
            }
          })
        );
      }

      // Volta places the call, so Volta opens the conversation. Server VAD only
      // produces a response after it hears speech, so without this the agent
      // waits in silence for a carrier who is waiting for it to say something.
      realtime.send(JSON.stringify({ type: "response.create" }));
      return;
    }
    if (event.event !== "media") return;

    const payload = stringValue(objectValue(event.media)?.payload);
    streamSid = stringValue(event.streamSid) ?? streamSid;
    // One inbound frame is 20 ms of call audio; this is the call clock.
    if (runtime) runtime.frameCount += 1;
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
