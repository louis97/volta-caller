import type { CallSession } from "@volta/contracts";

/**
 * Everything the server knows about one live call.
 *
 * The agent never supplies these: a model asked for its own call id or audio
 * offset will invent plausible values, which is how a hallucinated commitment
 * ends up with an audit trail that looks real.
 */
export type CallRuntime = {
  readonly callSid: string;
  readonly streamSid: string;
  readonly operationId: string;
  readonly carrierId?: string;
  readonly carrierName?: string;
  readonly direction: CallSession["direction"];
  readonly startedAt: string;
  /** Twilio media frames seen so far; each is 20 ms of audio. */
  frameCount: number;
  /** Where the caller's audio is routed. Flipped by the escalation hub. */
  routeTo: "AGENT" | "HUMAN";
};

/** Twilio streams 20 ms per media frame, which is our call clock. */
export const FRAME_DURATION_MS = 20;

export function callClockMs(runtime: Pick<CallRuntime, "frameCount">): number {
  return runtime.frameCount * FRAME_DURATION_MS;
}

export type CallRegistry = {
  open(input: Omit<CallRuntime, "frameCount" | "routeTo">): CallRuntime;
  get(streamSid: string): CallRuntime | undefined;
  byCallSid(callSid: string): CallRuntime | undefined;
  close(streamSid: string): void;
  active(): CallRuntime[];
};

export function createCallRegistry(): CallRegistry {
  const byStream = new Map<string, CallRuntime>();

  return {
    open(input) {
      const runtime: CallRuntime = {
        ...input,
        frameCount: 0,
        routeTo: "AGENT"
      };
      byStream.set(input.streamSid, runtime);
      return runtime;
    },
    get: (streamSid) => byStream.get(streamSid),
    byCallSid: (callSid) =>
      [...byStream.values()].find((runtime) => runtime.callSid === callSid),
    close: (streamSid) => {
      byStream.delete(streamSid);
    },
    active: () => [...byStream.values()]
  };
}
