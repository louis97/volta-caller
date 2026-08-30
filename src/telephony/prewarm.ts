import { env } from "../config/env";
import type { OperationStore } from "../core/state";
import { createRealtimeSessionConfig } from "./mediaStream";
import { createRealtimeSocket, type ClosableRelaySocket } from "./sockets";
import type { OutboundCallContext } from "./orchestrator";

/**
 * A Realtime session opened while the phone is still ringing.
 *
 * Everything the agent needs before it can speak — the WebSocket handshake to
 * OpenAI, the session configuration, the per-call briefing — used to happen
 * after the carrier picked up, in series. That is what made the first greeting
 * arrive seconds late on a call whose every later turn was fluent. Ringing is
 * dead time nobody is listening to, so the cost belongs there.
 *
 * Keyed by call token because that is the only identifier that exists both
 * when we dial and when Twilio opens the media WebSocket: the call sid does
 * not reach us until the stream's `start` event, which is already too late.
 */

/** Long enough for a healthy handshake, short enough not to delay a round. */
const READY_TIMEOUT_MS = 3_000;
/**
 * A session nobody claimed. Twilio stops ringing at 60s, so anything still
 * here after this never got answered and is billing for nothing.
 */
const WARM_TTL_MS = 90_000;
/** Answer timestamps outlive the longest call we allow. */
const ANSWER_TTL_MS = 180_000;

export type WarmCallContext = {
  store: OperationStore;
  context: OutboundCallContext;
  organizationId?: string;
  carrier?: { id: string; name: string };
};

export type WarmSession = {
  realtime: ClosableRelaySocket;
  /** OpenAI acknowledged the configuration before we dialled. */
  ready: boolean;
  /**
   * The call's identity, captured at dial time. Reading it from here is what
   * keeps Postgres out of the WebSocket upgrade, which the carrier waits on.
   */
  context?: WarmCallContext;
};

type WarmEntry = WarmSession & {
  expiry: NodeJS.Timeout;
  /** Cleared when OpenAI hangs up on us; a dead socket must not be handed on. */
  alive: boolean;
};

const sessions = new Map<string, WarmEntry>();
const answers = new Map<string, { at: number; expiry: NodeJS.Timeout }>();

/** Tokens are long and random; the first characters are enough to correlate. */
function short(callToken: string): string {
  return callToken.slice(0, 8);
}

/**
 * Opens and configures a Realtime session, resolving once OpenAI has
 * acknowledged it. The caller is expected to dial only after awaiting this:
 * doing both at once leaves a race that a carrier answering on the first ring
 * — or voicemail picking up instantly — loses.
 */
export async function prewarmRealtimeSession(input: {
  callToken: string;
  instructions: string;
  context?: WarmCallContext;
  readyTimeoutMs?: number;
  ttlMs?: number;
}): Promise<void> {
  const { callToken, instructions } = input;
  if (!callToken || !env.OPENAI_API_KEY) return;

  // A second warm-up for the same token would orphan the first socket.
  discardWarmSession(callToken, "superseded");

  const startedAt = Date.now();
  const realtime = createRealtimeSocket({
    apiKey: env.OPENAI_API_KEY,
    model: env.OPENAI_REALTIME_MODEL,
    onClose: () => {
      const entry = sessions.get(callToken);
      if (entry) entry.alive = false;
    }
  });

  const expiry = setTimeout(() => {
    console.warn(
      `[prewarm] nobody claimed token=${short(callToken)}; closing the session`
    );
    discardWarmSession(callToken, "expired");
  }, input.ttlMs ?? WARM_TTL_MS);
  // A session waiting on a call that never connects must not hold the process.
  expiry.unref();

  sessions.set(callToken, {
    realtime,
    ready: false,
    ...(input.context ? { context: input.context } : {}),
    alive: true,
    expiry
  });

  // The definitive configuration, not a placeholder: the carrier is already
  // known at dial time, so there is no second update to send once the call
  // connects and nothing left to do on `start` but ask for the greeting.
  realtime.send(
    JSON.stringify({
      type: "session.update",
      session: { ...createRealtimeSessionConfig({}), instructions }
    })
  );

  const outcome = await waitForSessionReady(
    realtime,
    input.readyTimeoutMs ?? READY_TIMEOUT_MS
  );
  const elapsedMs = Date.now() - startedAt;
  const entry = sessions.get(callToken);

  if (outcome === "ready") {
    if (entry) entry.ready = true;
    console.log(`[prewarm] ready in ${elapsedMs}ms token=${short(callToken)}`);
    return;
  }

  // Every remaining outcome still dials. Blocking a round on OpenAI would
  // turn a slow greeting into no call at all, and the cold path fails in
  // exactly the same way this one would.
  if (outcome === "timeout") {
    console.warn(
      `[prewarm] not ready after ${elapsedMs}ms token=${short(callToken)}; dialling anyway`
    );
    return;
  }
  console.error(
    `[prewarm] session ${outcome} after ${elapsedMs}ms token=${short(callToken)}; dialling anyway`
  );
}

/**
 * Claims the session for a call that just connected. Removing it from the pool
 * hands ownership to the media relay, which is what closes the socket when the
 * leg ends.
 */
export function takeWarmSession(callToken: string): WarmSession | undefined {
  const entry = sessions.get(callToken);
  if (!entry) return undefined;

  clearTimeout(entry.expiry);
  sessions.delete(callToken);

  if (!entry.alive) {
    console.warn(
      `[prewarm] token=${short(callToken)} warmed a session OpenAI already closed`
    );
    return undefined;
  }
  return {
    realtime: entry.realtime,
    ready: entry.ready,
    context: entry.context
  };
}

/** Reads the warmed context without claiming the session. */
export function warmCallContext(
  callToken: string
): WarmCallContext | undefined {
  const entry = sessions.get(callToken);
  return entry?.alive ? entry.context : undefined;
}

export function discardWarmSession(callToken: string, reason: string): void {
  const entry = sessions.get(callToken);
  if (!entry) return;

  clearTimeout(entry.expiry);
  sessions.delete(callToken);
  entry.realtime.close();
  console.log(`[prewarm] discarded token=${short(callToken)} (${reason})`);
}

/**
 * When the carrier picked up, as seen from Twilio's TwiML request. This is the
 * anchor the only latency that matters is measured from: how long the person
 * who answered waits in silence before Volta says anything.
 */
export function markCallAnswered(callToken: string): void {
  if (!callToken) return;
  const existing = answers.get(callToken);
  if (existing) clearTimeout(existing.expiry);

  const expiry = setTimeout(() => answers.delete(callToken), ANSWER_TTL_MS);
  expiry.unref();
  answers.set(callToken, { at: Date.now(), expiry });
}

export function answeredAt(callToken: string): number | undefined {
  return answers.get(callToken)?.at;
}

type ReadyOutcome = "ready" | "timeout" | "rejected" | "closed";

function waitForSessionReady(
  socket: ClosableRelaySocket,
  timeoutMs: number
): Promise<ReadyOutcome> {
  return new Promise<ReadyOutcome>((resolve) => {
    let settled = false;
    const settle = (outcome: ReadyOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(outcome);
    };

    const timer = setTimeout(() => settle("timeout"), timeoutMs);
    timer.unref();

    // `session.updated`, not the socket opening: an open socket says nothing
    // about whether OpenAI accepted the configuration, and a rejected one
    // reads on a live call as an agent that never speaks.
    //
    // The relay exposes no way to detach a listener, and this socket goes on
    // to carry the call's audio: without the early return every base64 frame
    // of the conversation would be parsed here for nothing.
    socket.on("message", (raw) => {
      if (settled) return;
      const type = eventType(raw);
      if (type === "session.updated") settle("ready");
      else if (type === "error") settle("rejected");
    });
    socket.on("close", () => settle("closed"));
  });
}

function eventType(raw: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const type = (parsed as { type?: unknown }).type;
    return typeof type === "string" ? type : undefined;
  } catch {
    return undefined;
  }
}
