import type { Server } from "node:http";

import express, { type Express } from "express";
import twilio from "twilio";
import { WebSocketServer, type WebSocket } from "ws";

import type { CallSession, CallSupervision } from "@volta/contracts";

import { executeToolCall } from "../agent/interpreter";
import { createModeConfiguration } from "../agent/modes";
import { buildCallInstructions, buildConfirmationCallInstructions } from "../agent/prompt";
import { createCommitmentFinalizer, whatsappRecapGateway } from "../audit/commitment";
import { env } from "../config/env";
import { hasMandate } from "../core/emptyOperation";
import type { ConfirmationCoordinator } from "../core/confirmation";
import type { OperationStore } from "../core/state";
import type { KapsoMessenger } from "../whatsapp/kapso";
import { auctionFromOperation, type Auction } from "./auction";
import { closeBridge, getBridge, openBridge } from "./hub";
import {
  getTurnTuning,
  HANDSET_PRESET,
  SPEAKERPHONE_PRESET,
  setTurnTuning,
  type TurnTuning
} from "./tuning";
import {
  fanOutCalls,
  type OutboundCallContext,
  type OutboundCallReference,
  withCallContext
} from "./orchestrator";
import { attachMediaStreamRelay } from "./mediaStream";
import {
  answeredAt,
  discardWarmSession,
  markCallAnswered,
  takeWarmSession,
  warmCallContext,
  warmOutboundCall,
  type WarmSession
} from "./prewarm";
import {
  callClockMs,
  createCallRegistry,
  type CallRegistry,
  type CallRuntime
} from "./registry";
import {
  createRealtimeSocket,
  toRelaySocket,
  type ClosableRelaySocket
} from "./sockets";
import {
  createInboundTwiML,
  createTwilioGateway,
  mapTwilioStatus,
  type TwilioCallClient
} from "./twilio";

export const MEDIA_STREAM_PATH = "/media-stream";
export const SUPERVISOR_STREAM_PATH = "/supervisor-stream";

/** Twilio statuses after which no media stream is coming. */
const TERMINAL_CALL_STATUSES = new Set([
  "completed",
  "busy",
  "no-answer",
  "failed",
  "canceled"
]);

function escapeXmlText(value: string): string {
  return value.replace(/[<>&'"]/g, (character) => {
    const entities: Record<string, string> = {
      "<": "&lt;",
      ">": "&gt;",
      "&": "&amp;",
      "'": "&apos;",
      '"': "&quot;"
    };
    return entities[character]!;
  });
}

export type TelephonyDependencies = {
  store: OperationStore;
  organizationId?: string;
  dialled?: Map<string, { id: string; name: string }>;
  onCallSessionChanged?: (
    session: import("@volta/contracts").CallSession,
    organizationId?: string
  ) => void;
  /**
   * Durable home for an utterance. The store keeps transcript in memory for
   * the live floor; without this it dies with the process and the
   * transcript_segments table stays empty.
   */
  onTranscriptAppended?: (
    segment: import("@volta/contracts").TranscriptSegment
  ) => void;
  /**
   * The editable carrier directory. When it holds active carriers they are
   * who a round dials, which is what the console's directory screen already
   * promises.
   */
  listActiveCarriers?: () => Promise<
    Array<{ id: string; name: string; phone: string }>
  >;
  /** Durable transcript, so any instance can serve a call it did not handle. */
  listTranscript?: (
    callId?: string,
    limit?: number
  ) => Promise<Array<import("@volta/contracts").TranscriptSegment>>;
  /** Persists a one-time random identity before Twilio is allowed to dial. */
  createCallReference?: (
    context: OutboundCallContext
  ) => Promise<OutboundCallReference>;
  /**
   * Rehydrates the exact operation named in an outbound callback. Render can
   * restart or route the WebSocket to another process, where the local store
   * and `dialled` map belong to a different round.
   */
  resolveCallContext?: (
    reference: OutboundCallReference
  ) => Promise<ResolvedTelephonyCallContext | undefined>;
  /**
   * The shipment a call belongs to, found by its Twilio sid alone. The last
   * way back when a callback carries no resolvable context — an inbound leg,
   * or an outbound one whose call token was lost — and the only thing that
   * closes a call this instance is not the one serving.
   */
  resolveCallBySid?: (
    callSid: string
  ) => Promise<ResolvedTelephonyCallContext | undefined>;
  callContext?: OutboundCallContext & {
    carrier?: { id: string; name: string };
  };
  onCallCompleted?: (callId: string, operationId: string) => void;
  /**
   * When a call sid belongs to a client-selected quote's confirmation
   * callback, this switches the live agent to the confirmation script
   * instead of the default negotiation one.
   */
  confirmationCoordinator?: ConfirmationCoordinator;
  /** Sends the booking recap once a confirmation call closes the deal. */
  whatsappMessenger?: KapsoMessenger;
};

export type ResolvedTelephonyCallContext = {
  store: OperationStore;
  context: OutboundCallContext;
  organizationId?: string;
  carrier?: { id: string; name: string };
};

/**
 * The auction and the call registry are the shared context of a negotiation
 * round: every leg must read and write the same one, or a quote taken on one
 * call is invisible to the agent negotiating on another and get_leverage
 * silently returns nothing.
 *
 * Keyed by store rather than passed around, because the routes and the
 * WebSocket handler are wired separately and nothing at those call sites can
 * enforce that they were handed the same instance.
 */
export type TelephonyContext = {
  registry: CallRegistry;
  dialled: Map<string, { id: string; name: string }>;
  auction: Auction;
  /** Starts a fresh round; quotes from the previous one stop counting. */
  resetAuction(): void;
};

const contextsByStore = new WeakMap<OperationStore, TelephonyContext>();

export function telephonyContext(store: OperationStore): TelephonyContext {
  const existing = contextsByStore.get(store);
  if (existing) return existing;

  const context: TelephonyContext = {
    registry: createCallRegistry(),
    dialled: new Map(),
    auction: auctionFromOperation(store.getOperation()),
    resetAuction() {
      context.auction = auctionFromOperation(store.getOperation());
      context.dialled.clear();
    }
  };

  // Subscribed once per store, so a quote is recorded exactly once however
  // many calls are in flight.
  store.subscribe((event) => {
    if (event.type === "quote.registered")
      context.auction.recordQuote(event.quote);
  });

  contextsByStore.set(store, context);
  return context;
}

function getTwilioClient(): TwilioCallClient {
  if (!env.TWILIO_ACCOUNT_SID || !env.TWILIO_AUTH_TOKEN) {
    throw new Error("twilio_credentials_missing");
  }
  return twilio(
    env.TWILIO_ACCOUNT_SID,
    env.TWILIO_AUTH_TOKEN
  ) as unknown as TwilioCallClient;
}

export function createLiveTelephonyGateway() {
  return createTwilioGateway({ client: getTwilioClient() });
}

/**
 * Every live call needs a CallSession, whatever opened it: the floor renders
 * from sessions, and a transcript whose call has no session is invisible.
 *
 * A round dialled through fanOutCalls already created one and stamped it with
 * the Twilio sid; this adopts it. Anything else — a single test call, an
 * inbound call — gets one created here, keyed by the sid so the transcript
 * lines up with it.
 */
function bindCallSession(
  store: OperationStore,
  input: {
    callSid: string;
    carrier?: { id: string; name: string };
    direction: "inbound" | "outbound";
  }
): string {
  // Matched on both identifiers. A round keys its session by a generated id
  // and keeps the sid alongside; a session opened here uses the sid for both.
  // Checking only `callSid` meant the second stream of the same call opened a
  // duplicate session, and the console kept rendering the first one — which
  // nothing ever completed.
  const existing = store
    .getOperation()
    .callSessions.find(
      (session) =>
        session.callSid === input.callSid || session.id === input.callSid
    );

  if (existing) {
    store.updateCallSession(existing.id, {
      status: "in_progress",
      ...(existing.callSid ? {} : { callSid: input.callSid })
    });
    return existing.id;
  }

  // Nothing in this operation dialled this call: an inbound leg, or an
  // outbound one whose context could not be resolved. Adopting it is still the
  // right call — the carrier is on the line — but it has to be visible, since
  // an adoption into the wrong operation is what hides a whole conversation
  // from the console.
  console.warn(
    `[call] adopting ${input.direction} call=${input.callSid} into operation=${store.getOperation().id}; no session dialled it`
  );

  store.openCallSession({
    id: input.callSid,
    callSid: input.callSid,
    operationId: store.getOperation().id,
    carrierId: input.carrier?.id,
    driverName: input.carrier?.name,
    direction: input.direction,
    status: "in_progress",
    startedAt: new Date().toISOString()
  });
  return input.callSid;
}

/**
 * The call session the console is talking about.
 *
 * Sessions opened by a round carry a generated id and the Twilio sid in
 * separate fields; ones bound by the media stream use the sid for both. The
 * console sends whichever it has, so both have to resolve — matching only the
 * id is what made every takeover button return 404 and look dead.
 */
function findCallSession(
  store: OperationStore,
  callId: string
): CallSession | undefined {
  const sessions = store.getOperation().callSessions;
  return (
    sessions.find((session) => session.callSid === callId) ??
    sessions.find((session) => session.id === callId)
  );
}

/**
 * A supervision change the console can see. A change that finds no session
 * publishes no event, which leaves the board showing the agent in charge of a
 * call a person is already on.
 */
function setSupervisionFor(
  store: OperationStore,
  callId: string,
  supervision: CallSupervision
): CallSession | undefined {
  const session = findCallSession(store, callId);
  if (!session) {
    console.error(
      `[takeover] no call session for call=${callId}. Known: ${store
        .getOperation()
        .callSessions.map((item) => item.callSid ?? item.id)
        .join(", ")}`
    );
    return undefined;
  }
  return store.setCallSupervision(session.id, supervision);
}

function mediaStreamUrl(
  reference?: OutboundCallReference,
  direction?: "inbound"
): string {
  if (!env.PUBLIC_WS_URL) throw new Error("public_ws_url_missing");
  const url = `${env.PUBLIC_WS_URL.replace(/\/$/, "")}${MEDIA_STREAM_PATH}`;
  if (reference) return withCallContext(url, reference);
  return direction === "inbound" ? `${url}?direction=inbound` : url;
}

export function callContextFromUrl(
  url: URL
): OutboundCallReference | undefined {
  const callToken = url.searchParams.get("callToken")?.trim();
  if (callToken) return { callToken };

  // Callbacks for a call placed by an earlier build carry `operationId`
  // instead. Twilio keeps using the URL it was given when the call started, so
  // a deploy in the middle of a round leaves legs whose callbacks speak the
  // previous shape — refusing them drops calls that are already ringing.
  const operationId = url.searchParams.get("operationId")?.trim();
  return operationId ? { callToken: "", operationId } : undefined;
}

export function withResolvedCallContext(
  dependencies: TelephonyDependencies,
  resolved: ResolvedTelephonyCallContext
): TelephonyDependencies {
  return {
    ...dependencies,
    store: resolved.store,
    dialled: undefined,
    organizationId:
      resolved.organizationId ??
      resolved.context.organizationId ??
      dependencies.organizationId,
    callContext: { ...resolved.context, carrier: resolved.carrier }
  };
}

export async function resolveCallDependencies(
  dependencies: TelephonyDependencies,
  reference: OutboundCallReference
): Promise<TelephonyDependencies> {
  const resolved = await dependencies.resolveCallContext?.(reference);
  if (!resolved) throw new Error("telephony_call_context_not_found");
  return withResolvedCallContext(dependencies, resolved);
}

export function mountTelephonyRoutes(
  app: Express,
  dependencies: TelephonyDependencies
): void {
  const { store } = dependencies;
  const context = telephonyContext(store);
  const dialled = dependencies.dialled ?? context.dialled;
  store.subscribe((event) => {
    // Supervision belongs here too. Leaving it out meant a takeover lived only
    // in this process's memory: nothing was written, so the console reloaded
    // straight back to "Volta speaking" for a call a person was already on,
    // and the button read as dead.
    if (
      event.type === "call.started" ||
      event.type === "call.updated" ||
      event.type === "call.supervision.changed"
    )
      dependencies.onCallSessionChanged?.(
        event.callSession,
        dependencies.organizationId
      );
  });
  const twiml = express.urlencoded({ extended: false });

  const warmSessionFor = (
    reference: OutboundCallReference,
    carrier?: { id: string; name: string }
  ) =>
    warmOutboundCall({
      store,
      organizationId: dependencies.organizationId,
      callToken: reference.callToken,
      carrier
    });

  const hangUp = (response: express.Response) =>
    response
      .type("text/xml")
      .send(
        '<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>'
      );
  const machineAnswered = (request: express.Request) => {
    // Detection labels a real person machine_start often enough — a short
    // "¿Aló?" and a pause reads the same as a recording — that acting on it
    // dropped whole rounds against carriers who had picked up.
    if (!env.TWILIO_HANGUP_ON_MACHINE) return false;

    const answeredBy = String(
      (request.body as { AnsweredBy?: unknown } | undefined)?.AnsweredBy ?? ""
    );
    if (!answeredBy.startsWith("machine") && answeredBy !== "fax") return false;
    console.log(`[call] ${answeredBy} answered; hanging up without an agent`);
    return true;
  };

  // Outbound calls are fail-closed: a generic callback must never inherit the
  // process's demo/current operation and speak its mandate to the carrier.
  app.post("/twiml/outbound", twiml, (request, response) => {
    const reference = callContextFromUrl(
      new URL(request.originalUrl, "http://localhost")
    );
    if (machineAnswered(request)) {
      // The warmed session has no call to serve now.
      if (reference?.callToken)
        discardWarmSession(reference.callToken, "answering machine");
      hangUp(response);
      return;
    }
    // This request is Twilio telling us the carrier picked up, which is where
    // the only latency the carrier experiences starts being counted.
    if (reference?.callToken) markCallAnswered(reference.callToken);
    // Fails open on purpose. Refusing a callback whose context cannot be read
    // hangs up on a carrier who has already answered, and a deploy landing
    // mid-round is enough to cause it. Serving the instance's current
    // operation is what this did before contexts existed; the risk it guards
    // against — speaking the wrong mandate — is real but far rarer than the
    // calls the guard was killing.
    if (!reference) {
      // The fail-open only has something to fall back to when the instance
      // actually holds a mandate. With none, opening the stream would put the
      // agent on the line with blank fields, so hanging up is the honest
      // outcome — and there was no round for this callback to belong to.
      if (!hasMandate(store.getOperation())) {
        console.warn(
          `[twilio] no call context in ${request.originalUrl} and no active mandate; hanging up`
        );
        hangUp(response);
        return;
      }
      console.warn(
        `[twilio] no call context in ${request.originalUrl}; using the active operation`
      );
    }
    response
      .type("text/xml")
      .send(
        createInboundTwiML(
          reference ? mediaStreamUrl(reference) : mediaStreamUrl()
        )
      );
  });

  // Inbound calls deliberately use the instance's active intake context. The
  // direction marker is mandatory so a context-free outbound WebSocket cannot
  // masquerade as a legitimate inbound call.
  app.post("/twiml/inbound", twiml, (request, response) => {
    if (machineAnswered(request)) {
      hangUp(response);
      return;
    }
    response
      .type("text/xml")
      .send(createInboundTwiML(mediaStreamUrl(undefined, "inbound")));
  });

  /**
   * What the supervisor hears when they pick up. Polly reads the brief while
   * they are still connecting, so they arrive knowing the case without any
   * extra text-to-speech in the path.
   */
  app.post("/twiml/supervisor", twiml, (request, response) => {
    const callSid = String(request.query.callSid ?? "");
    const brief = String(request.query.brief ?? "Entrando a la llamada.");
    const wsUrl = `${(env.PUBLIC_WS_URL ?? "").replace(/\/$/, "")}${SUPERVISOR_STREAM_PATH}?callSid=${encodeURIComponent(callSid)}`;

    response
      .type("text/xml")
      .send(
        `<?xml version="1.0" encoding="UTF-8"?><Response>` +
          `<Say voice="Polly.Joanna" language="en-US">${escapeXmlText(brief)}</Say>` +
          `<Connect><Stream url="${escapeXmlText(wsUrl)}" /></Connect>` +
          `</Response>`
      );
  });

  // Diagnostic only: a TwiML with no media stream. If a call reaches this and
  // speaks, the account and the public URL are fine and the stream itself is
  // what the account refuses.
  app.post("/twiml/say", twiml, (_request, response) => {
    response
      .type("text/xml")
      .send(
        '<?xml version="1.0" encoding="UTF-8"?><Response><Say voice="Polly.Joanna" language="en-US">Volta test call. If you can hear this, the voice path works.</Say><Pause length="2"/></Response>'
      );
  });

  // Accepts the destination as a query param as well as a JSON body: quoting a
  // JSON payload through PowerShell mangles the escaped quotes, and losing a
  // gate test to shell quoting is not a debt worth carrying.
  const readTo = (request: express.Request): string | undefined => {
    const fromQuery = request.query.to;
    if (typeof fromQuery === "string" && fromQuery.length > 0) return fromQuery;

    const body: unknown = request.body;
    if (typeof body === "object" && body !== null && "to" in body) {
      const candidate = (body as { to?: unknown }).to;
      if (typeof candidate === "string" && candidate.length > 0)
        return candidate;
    }
    return undefined;
  };

  // A body mangled by shell quoting should fall through to the query param
  // rather than surfacing as an HTML 500 page mid-gate.
  const parseJson = express.json({ strict: false });
  const jsonBody: express.RequestHandler = (request, response, next) => {
    parseJson(request, response, () => next());
  };

  /**
   * Opens a negotiation round: dials every carrier candidate at once. Quotes
   * from calls already in progress become leverage for the ones still talking,
   * which is what makes this a market rather than three separate calls.
   */
  app.post("/api/calls/negotiate", jsonBody, async (_request, response) => {
    // Nothing to negotiate until a mandate has been sent. Refusing before
    // Twilio is touched is what keeps a carrier from being called about a
    // shipment nobody asked for.
    if (!hasMandate(store.getOperation())) {
      response.status(409).json({ error: "no_active_mandate" });
      return;
    }
    context.resetAuction();
    dialled.clear();

    // A directory with no active carriers falls back to the seeded pool, so a
    // round is never silently dialled to nobody.
    let carriers: Array<{ id: string; name: string; phone: string }> = [];
    try {
      carriers = (await dependencies.listActiveCarriers?.()) ?? [];
    } catch (error) {
      console.error("[carriers] directory unavailable:", error);
    }
    if (carriers.length > 0) {
      console.log(
        `[carriers] dialling ${carriers.length} from the directory: ${carriers
          .map((carrier) => carrier.name)
          .join(", ")}`
      );
    }

    await fanOutCalls({
      store,
      organizationId: dependencies.organizationId,
      ...(carriers.length > 0 ? { carriers } : {}),
      mode: env.VOLTA_MODE,
      publicBaseUrl: env.PUBLIC_BASE_URL,
      from: env.TWILIO_FROM_NUMBER,
      gateway:
        env.VOLTA_MODE === "live" ? createLiveTelephonyGateway() : undefined,
      createCallReference: dependencies.createCallReference,
      prewarm: ({ reference, carrier }) => warmSessionFor(reference, carrier),
      timeLimitSeconds: env.CALL_TIME_LIMIT_SECONDS,
      record: env.TWILIO_RECORD_CALLS,
      detectAnsweringMachine: env.TWILIO_HANGUP_ON_MACHINE,
      onDialled: (callId, carrier) => {
        dialled.set(callId, carrier);
        context.auction.startCall(carrier.id, callId);
      }
    });
    response.status(202).json({
      status: context.auction.status(),
      operation: store.getOperation()
    });
  });

  /**
   * Hands a live call to a person: rings the supervisor and puts them into the
   * conversation. The agent leg is never dropped, and the agent keeps the
   * floor until the supervisor actually picks up — silencing it the moment the
   * button is pressed would leave the carrier listening to nothing for as long
   * as a phone rings.
   */
  app.post(
    "/api/calls/:callId/takeover",
    jsonBody,
    async (request, response) => {
      const callId = String(request.params.callId);
      const reason =
        typeof (request.body as { reason?: unknown } | undefined)?.reason ===
        "string"
          ? (request.body as { reason: string }).reason
          : undefined;

      const callSession = setSupervisionFor(store, callId, {
        state: "briefing_supervisor",
        reason,
        requestedAt: new Date().toISOString()
      });
      if (!callSession) {
        response.status(404).json({ error: "call_session_not_found" });
        return;
      }

      const callSid = callSession.callSid ?? callSession.id;
      // The bridge is the carrier's live audio socket, and it only exists in
      // the process that is actually relaying this call. When it is missing,
      // ringing the supervisor puts them on a leg with nothing on the other
      // end: they answer, hear silence and get dropped, which is exactly what
      // "the button does nothing" looked like. Transferring instead hands them
      // the call for real — Volta leaves the line, which is a worse outcome
      // than the bridge and a far better one than nobody joining.
      const bridged = getBridge(callSid) !== undefined;

      try {
        if (bridged) {
          await dialSupervisor(callSid);
        } else {
          console.warn(
            `[takeover] no live bridge for call=${callSid}; transferring instead of bridging`
          );
          if (!env.SUPERVISOR_PHONE)
            throw new Error("supervisor_phone_missing");
          // Recorded before the transfer: replacing the TwiML tears down our
          // media stream, and the close handler must not read that as the
          // call having ended.
          setSupervisionFor(store, callId, {
            state: "human",
            reason: "transferred",
            requestedAt: new Date().toISOString(),
            takenOverAt: new Date().toISOString()
          });
          await createLiveTelephonyGateway().transferToSupervisor({
            callId: callSid,
            supervisorPhone: env.SUPERVISOR_PHONE
          });
        }
      } catch (error) {
        // Leaving the board on "briefing you" for a call nobody is going to
        // join is worse than admitting the supervisor could not be reached.
        setSupervisionFor(store, callId, {
          state: "agent",
          reason: "supervisor_unreachable"
        });
        // Twilio's own code is what names the culprit — 21215 for a country
        // the account may not call, 13224 for a rejected number. Its message
        // alone sends people hunting through the console for nothing.
        const detail = error as {
          message?: string;
          code?: number;
          status?: number;
        };
        console.error(
          `[takeover] could not reach the supervisor: ${detail.message ?? "unknown"} (twilio ${detail.code ?? "-"})`
        );
        response.status(502).json({
          error: "supervisor_unreachable",
          detail: detail.message ?? "unknown",
          twilioCode: detail.code,
          twilioStatus: detail.status
        });
        return;
      }

      response
        .status(202)
        .json({ ...callSession, mode: bridged ? "bridge" : "transfer" });
    }
  );

  /**
   * Accepts a call the agent offered. Only works while the countdown is still
   * running: once it lapses the agent has already closed the conversation.
   */
  app.post("/api/calls/:callId/accept", (request, response) => {
    const callSid = String(request.params.callId);
    if (!acceptTakeover(callSid)) {
      response.status(409).json({ error: "takeover_window_closed" });
      return;
    }
    response.status(200).json(findCallSession(store, callSid) ?? { callSid });
  });

  /**
   * Moves the floor to the person by hand. The supervisor stream does this on
   * its own once they pick up, so this is the override for a leg the stream
   * never reached.
   */
  app.post("/api/calls/:callId/connect", (request, response) => {
    const callId = String(request.params.callId);
    const callSession = setSupervisionFor(store, callId, {
      state: "human",
      takenOverAt: new Date().toISOString()
    });
    if (!callSession) {
      response.status(404).json({ error: "call_session_not_found" });
      return;
    }
    const runtime = context.registry.byCallSid(
      callSession.callSid ?? callSession.id
    );
    if (runtime) runtime.routeTo = "HUMAN";
    response.status(200).json(callSession);
  });

  /** Gives the conversation back to Volta without ending the call. */
  app.post("/api/calls/:callId/handback", (request, response) => {
    const callId = String(request.params.callId);
    const callSession = setSupervisionFor(store, callId, {
      state: "returned_to_agent",
      returnedAt: new Date().toISOString()
    });
    if (!callSession) {
      response.status(404).json({ error: "call_session_not_found" });
      return;
    }
    const runtime = context.registry.byCallSid(
      callSession.callSid ?? callSession.id
    );
    if (runtime) runtime.routeTo = "AGENT";
    response.status(200).json(callSession);
  });

  app.get("/api/transcript", async (request, response) => {
    const callId =
      typeof request.query.callId === "string"
        ? request.query.callId
        : undefined;
    // Bounded on purpose. This used to hand back every utterance the
    // organization had ever recorded, which grew with each call until opening
    // the floor was visibly slow; the floor only ever renders the tail.
    const requested = Number(request.query.limit);
    const limit =
      Number.isFinite(requested) && requested > 0
        ? Math.min(2_000, Math.trunc(requested))
        : 500;
    // The store holds this process's live tail; the repository holds every
    // call ever handled, including by another instance. Merged and deduped so
    // a segment written moments ago is not missing while its insert lands.
    const live = store.getTranscript(callId);
    let stored: Array<import("@volta/contracts").TranscriptSegment> = [];
    try {
      stored = (await dependencies.listTranscript?.(callId, limit)) ?? [];
    } catch (error) {
      console.error("[transcript] read failed:", error);
    }

    const byId = new Map(stored.map((segment) => [segment.id, segment]));
    for (const segment of live) byId.set(segment.id, segment);

    response
      .status(200)
      .json(
        [...byId.values()].sort((left, right) => left.startMs - right.startMs)
      );
  });

  /**
   * Retunes turn taking for the calls placed from here on. A phone on speaker
   * in a loud room hears the agent's own voice and interrupts constantly; the
   * fix has to land between two calls, not between two deploys.
   */
  app.get("/api/telephony/tuning", (_request, response) => {
    response.status(200).json({
      current: getTurnTuning(),
      presets: { speakerphone: SPEAKERPHONE_PRESET, handset: HANDSET_PRESET }
    });
  });

  app.post("/api/telephony/tuning", jsonBody, (request, response) => {
    const body = (request.body ?? {}) as {
      preset?: unknown;
      threshold?: unknown;
      silenceMs?: unknown;
    };

    let patch: Partial<TurnTuning> = {};
    if (body.preset === "speakerphone") patch = SPEAKERPHONE_PRESET;
    else if (body.preset === "handset") patch = HANDSET_PRESET;
    else {
      if (typeof body.threshold === "number")
        patch.threshold = Math.min(1, Math.max(0, body.threshold));
      if (typeof body.silenceMs === "number")
        patch.silenceMs = Math.max(100, Math.trunc(body.silenceMs));
    }

    const applied = setTurnTuning(patch);
    console.log(
      `[tuning] threshold=${applied.threshold} silence=${applied.silenceMs}ms noise=${applied.noiseReduction}`
    );
    response.status(200).json(applied);
  });

  app.get("/api/auction", (_request, response) => {
    response.status(200).json({
      status: context.auction.status(),
      standings: context.auction.standings()
    });
  });

  app.post("/twiml/status", twiml, async (request, response) => {
    const callSid =
      typeof request.body.CallSid === "string"
        ? request.body.CallSid
        : undefined;
    const callStatus =
      typeof request.body.CallStatus === "string"
        ? request.body.CallStatus
        : undefined;
    try {
      const reference = callContextFromUrl(
        new URL(request.originalUrl, "http://localhost")
      );
      if (!reference) {
        // This is the last chance to close a call, and refusing it left the
        // floor showing a finished conversation as still in progress. The sid
        // alone is enough: it resolves in the operation this instance holds,
        // and failing that in whichever operation actually recorded the call.
        // An inbound leg has no reference at all and reaches us only here.
        console.warn(
          "[twilio] status callback has no call context; matching on the sid"
        );
        if (callSid && callStatus) {
          const patch = mapTwilioStatus(
            callStatus as Parameters<typeof mapTwilioStatus>[0]
          );
          const local = findCallSession(store, callSid);
          if (local) {
            store.updateCallSession(local.id, patch);
          } else {
            const owner = await dependencies.resolveCallBySid?.(callSid);
            const remote = owner
              ? findCallSession(owner.store, callSid)
              : undefined;
            if (owner && remote)
              owner.store.updateCallSession(remote.id, patch);
            else
              console.warn(
                `[twilio] no session anywhere for call=${callSid}; nothing to close`
              );
          }
        }
        response.sendStatus(204);
        return;
      }
      // A call that never connected leaves its warmed session with nothing to
      // serve; without this a round nobody answers keeps paying for four open
      // OpenAI sockets. A call that did connect already claimed its own, so
      // this is a no-op for the healthy path.
      if (
        reference.callToken &&
        callStatus !== undefined &&
        TERMINAL_CALL_STATUSES.has(callStatus)
      ) {
        discardWarmSession(reference.callToken, callStatus);
      }
      const resolved = await resolveCallDependencies(dependencies, reference);
      const statusStore = resolved.store;
      const session = callSid
        ? findCallSession(statusStore, callSid)
        : undefined;
      if (session && callStatus)
        statusStore.updateCallSession(
          session.id,
          mapTwilioStatus(callStatus as Parameters<typeof mapTwilioStatus>[0])
        );
    } catch (error) {
      console.error("[twilio] status context could not be resolved:", error);
    }
    response.sendStatus(204);
  });

  app.post("/api/calls/test", jsonBody, async (request, response) => {
    const to = readTo(request);

    if (to === undefined) {
      response.status(400).json({
        error: "missing_to",
        hint: 'pass ?to=+57... or {"to":"+57..."}'
      });
      return;
    }

    // ?twiml=say places the call against the diagnostic TwiML instead.
    const twimlPath =
      request.query.twiml === "say" ? "/twiml/say" : "/twiml/outbound";

    // The diagnostic path speaks a fixed line and needs no shipment; the agent
    // path would have to invent one.
    if (twimlPath === "/twiml/outbound" && !hasMandate(store.getOperation())) {
      response.status(409).json({ error: "no_active_mandate" });
      return;
    }

    try {
      const gateway = createTwilioGateway({ client: getTwilioClient() });
      const operation = store.getOperation();
      const carrier = operation.candidates.find(
        (candidate) => candidate.phone === to
      );
      const reference =
        twimlPath === "/twiml/outbound"
          ? await dependencies.createCallReference?.({
              operationId: operation.id,
              carrierId: carrier?.id,
              organizationId: dependencies.organizationId
            })
          : undefined;
      if (twimlPath === "/twiml/outbound" && !reference) {
        throw new Error("telephony_call_context_persistence_missing");
      }
      if (reference) await warmSessionFor(reference, carrier);
      const session = await gateway.createOutboundCall({
        operationId: store.getOperation().id,
        carrierId: carrier?.id,
        to,
        from: env.TWILIO_FROM_NUMBER ?? "",
        twimlUrl: reference
          ? withCallContext(
              `${(env.PUBLIC_BASE_URL ?? "").replace(/\/$/, "")}${twimlPath}`,
              reference
            )
          : `${(env.PUBLIC_BASE_URL ?? "").replace(/\/$/, "")}${twimlPath}`,
        ...(env.CALL_TIME_LIMIT_SECONDS > 0
          ? { timeLimitSeconds: env.CALL_TIME_LIMIT_SECONDS }
          : {}),
        record: env.TWILIO_RECORD_CALLS
      });
      // Open the session as soon as it rings, not when audio arrives: the
      // floor should show a line being dialled, not appear once it connects.
      store.openCallSession({
        id: session.id,
        callSid: session.id,
        operationId: store.getOperation().id,
        carrierId: carrier?.id,
        driverName: carrier?.name ?? "Test call",
        direction: "outbound",
        status: "pending",
        startedAt: session.startedAt
      });
      if (carrier)
        dialled.set(session.id, { id: carrier.id, name: carrier.name });

      response.status(201).json(session);
    } catch (error) {
      // Surface Twilio's own code: its messages alone rarely name the culprit.
      const detail = error as {
        message?: string;
        code?: number;
        status?: number;
      };
      response.status(502).json({
        error: detail.message ?? "call_failed",
        twilioCode: detail.code,
        twilioStatus: detail.status
      });
    }
  });
}

/** Everything resolved before the media socket was handed to the relay. */
type MediaStreamSetup = {
  dependencies: TelephonyDependencies;
  /** The session opened while this call was still ringing, if we got one. */
  warm?: WarmSession;
  /** When the carrier picked up, as reported by Twilio's TwiML request. */
  answeredAtMs?: number;
  /** How long the upgrade took; the carrier waits through all of it. */
  upgradeMs: number;
  /**
   * Which way the call went. Hardcoding "outbound" recorded every inbound leg
   * as a call Volta had placed, which is not what the floor should say about a
   * carrier who rang us.
   */
  direction: "inbound" | "outbound";
};

function warmLabel(warm?: WarmSession): string {
  if (!warm) return "no";
  return warm.ready ? "ready" : "pending";
}

export function attachTelephonyWebSockets(
  server: Server,
  dependencies: TelephonyDependencies
): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });
  const setupBySocket = new WeakMap<WebSocket, MediaStreamSetup>();

  server.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    const { pathname } = url;
    if (pathname !== MEDIA_STREAM_PATH && pathname !== SUPERVISOR_STREAM_PATH) {
      socket.destroy();
      return;
    }

    void (async () => {
      const upgradeStartedAt = Date.now();
      let resolved = dependencies;
      let warm: WarmSession | undefined;
      let answeredAtMs: number | undefined;

      if (pathname === MEDIA_STREAM_PATH) {
        const reference = callContextFromUrl(url);
        if (reference) {
          const { callToken } = reference;
          const warmed = callToken ? warmCallContext(callToken) : undefined;
          if (callToken) answeredAtMs = answeredAt(callToken);

          if (warmed) {
            // Captured when we dialled. Reading it from memory keeps Postgres
            // out of an upgrade the carrier is already waiting on.
            resolved = withResolvedCallContext(dependencies, warmed);
          } else {
            // Falls back rather than throwing: a context that cannot be read
            // used to abort the upgrade, which drops the audio of a call the
            // carrier already answered. The instance's active operation is a
            // worse answer than the right one and a far better answer than
            // silence.
            try {
              resolved = await resolveCallDependencies(dependencies, reference);
            } catch (error) {
              console.warn(
                `[twilio] call context unresolved (${error instanceof Error ? error.message : "unknown"}); using the active operation`
              );
            }
          }
          if (callToken) warm = takeWarmSession(callToken);
        }
      }

      // Whatever we resolved to, it has to be a real shipment. Opening the
      // relay against a mandate-less operation is the one failure mode worse
      // than silence: the agent stays on the line and negotiates a load that
      // does not exist.
      if (
        pathname === MEDIA_STREAM_PATH &&
        !hasMandate(resolved.store.getOperation())
      ) {
        console.warn(
          "[twilio] media stream refused: this instance has no mandate to negotiate"
        );
        socket.destroy();
        return;
      }

      const upgradeMs = Date.now() - upgradeStartedAt;
      const direction =
        url.searchParams.get("direction") === "inbound"
          ? "inbound"
          : "outbound";
      wss.handleUpgrade(request, socket, head, (client) => {
        setupBySocket.set(client, {
          dependencies: resolved,
          ...(warm ? { warm } : {}),
          ...(answeredAtMs === undefined ? {} : { answeredAtMs }),
          upgradeMs,
          direction
        });
        wss.emit("connection", client, request);
      });
    })().catch((error: unknown) => {
      console.error("[twilio] media context could not be resolved:", error);
      socket.destroy();
    });
  });

  wss.on("connection", (client, request) => {
    const url = new URL(request.url ?? "/", "http://localhost");

    if (url.pathname === SUPERVISOR_STREAM_PATH) {
      attachSupervisorStream(
        client,
        url.searchParams.get("callSid") ?? "",
        dependencies
      );
      return;
    }

    const setup = setupBySocket.get(client);
    if (!setup) {
      console.error("[twilio] media stream rejected: dependencies missing");
      client.close();
      return;
    }
    console.log(
      `[twilio] media stream connected (upgrade=${setup.upgradeMs}ms warm=${warmLabel(setup.warm)})`
    );
    openMediaStreamSession(toRelaySocket(client, { label: "twilio" }), setup);
  });

  return wss;
}

/**
 * A call the agent asked a person to take over.
 *
 * The offer expires: a carrier left holding while nobody watches a dashboard
 * is worse than a clean "te devuelvo la llamada", so on expiry the agent says
 * so itself and the leg ends. Keyed by call sid, which is what the console
 * sends back when someone accepts.
 */
type PendingTakeover = {
  callSid: string;
  timer: NodeJS.Timeout;
  /** Hands the conversation to the person who accepted. */
  accept(): void;
  /** Closes politely because nobody did. */
  expire(): void;
};

const pendingTakeovers = new Map<string, PendingTakeover>();

export function acceptTakeover(callSid: string): boolean {
  const pending = pendingTakeovers.get(callSid);
  if (!pending) return false;
  clearTimeout(pending.timer);
  pendingTakeovers.delete(callSid);
  pending.accept();
  return true;
}

/**
 * Offers a live call to a person and counts down. Accepting routes the caller
 * to the human; letting it lapse has the agent close the conversation itself
 * and end the leg.
 */
/**
 * Rings the supervisor and connects them into the live call. Their audio
 * arrives on its own media stream and the hub plays it to the carrier.
 */
async function dialSupervisor(callSid: string): Promise<void> {
  // Throws rather than warning: a takeover that quietly rings nobody leaves
  // the console claiming a person is joining a call they cannot hear.
  if (env.VOLTA_MODE !== "live") throw new Error("live_mode_required");
  if (!env.SUPERVISOR_PHONE) throw new Error("supervisor_phone_missing");
  if (!env.TWILIO_FROM_NUMBER) throw new Error("twilio_from_number_missing");

  const base = (env.PUBLIC_BASE_URL ?? "").replace(/\/$/, "");
  const brief =
    "You are joining a Volta call in progress. You can hear the carrier and you are live.";

  await createLiveTelephonyGateway().createOutboundCall({
    operationId: callSid,
    to: env.SUPERVISOR_PHONE,
    from: env.TWILIO_FROM_NUMBER,
    twimlUrl: `${base}/twiml/supervisor?callSid=${encodeURIComponent(callSid)}&brief=${encodeURIComponent(brief)}`
  });
  console.log(`[takeover] ringing the supervisor for call=${callSid}`);
}

function openTakeoverWindow(input: {
  store: OperationStore;
  runtime: CallRuntime;
  realtime: ClosableRelaySocket;
  hangUp: () => void;
}): void {
  const { store, runtime, realtime, hangUp } = input;
  if (pendingTakeovers.has(runtime.callSid)) return;

  const windowMs = env.TAKEOVER_WINDOW_SECONDS * 1000;
  const now = new Date();

  const setSupervision = (supervision: CallSupervision) => {
    setSupervisionFor(store, runtime.callSid, supervision);
  };

  setSupervision({
    state: "awaiting_human",
    requestedAt: now.toISOString(),
    deadlineAt: new Date(now.getTime() + windowMs).toISOString()
  });
  console.log(
    `[takeover] offered call=${runtime.callSid} for ${env.TAKEOVER_WINDOW_SECONDS}s`
  );

  const timer = setTimeout(() => {
    pendingTakeovers.delete(runtime.callSid);
    console.log(`[takeover] nobody accepted call=${runtime.callSid}; closing`);
    setSupervision({ state: "postponed", requestedAt: now.toISOString() });

    // Volta closes in its own voice rather than the line simply dying.
    realtime.send(
      JSON.stringify({
        type: "response.create",
        response: {
          instructions:
            "Close the call now, in a single short and courteous sentence: tell them you need to confirm this internally and that you will call them back. Do not negotiate further and do not ask questions."
        }
      })
    );
    // Long enough for that sentence to play out before the leg ends.
    setTimeout(hangUp, 6000);
  }, windowMs);

  pendingTakeovers.set(runtime.callSid, {
    callSid: runtime.callSid,
    timer,
    accept: () => {
      runtime.routeTo = "HUMAN";
      // The carrier must not hear the agent's half-finished sentence once the
      // person takes over; Twilio has audio buffered.
      getBridge(runtime.callSid)?.clearCarrier();
      void dialSupervisor(runtime.callSid).catch((error: unknown) =>
        console.error("[takeover] could not reach the supervisor:", error)
      );
      setSupervision({
        state: "human",
        requestedAt: now.toISOString(),
        takenOverAt: new Date().toISOString()
      });
      console.log(`[takeover] accepted call=${runtime.callSid}`);
    },
    expire: () => undefined
  });
}

/**
 * A supervisor's leg. Their audio reaches the carrier only while the hub says
 * they hold the call, so joining is never enough on its own to talk over the
 * agent.
 */
function attachSupervisorStream(
  client: WebSocket,
  callSid: string,
  dependencies: TelephonyDependencies
): void {
  const bridge = getBridge(callSid);
  if (!bridge) {
    console.warn(`[takeover] supervisor joined but call=${callSid} is gone`);
    client.close();
    return;
  }

  const { store } = dependencies;
  const { registry } = telephonyContext(store);
  let streamSid: string | undefined;
  console.log(`[takeover] supervisor is on the line for call=${callSid}`);

  client.on("message", (data: unknown) => {
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(String(data)) as Record<string, unknown>;
    } catch {
      return;
    }

    if (event.event === "start") {
      streamSid =
        (event.streamSid as string | undefined) ??
        (event.start as { streamSid?: string } | undefined)?.streamSid ??
        undefined;
      bridge.attachSupervisor((payload) => {
        if (client.readyState === 1 && streamSid) {
          client.send(
            JSON.stringify({ event: "media", streamSid, media: { payload } })
          );
        }
      });

      // The floor moves now, when there is genuinely a person to hear, rather
      // than when the button was pressed. The carrier must not hear the
      // agent's half-finished sentence either: Twilio has audio buffered.
      const runtime = registry.byCallSid(callSid);
      if (runtime) runtime.routeTo = "HUMAN";
      bridge.clearCarrier();
      setSupervisionFor(store, callSid, {
        state: "human",
        takenOverAt: new Date().toISOString()
      });
      console.log(`[takeover] the human has the floor on call=${callSid}`);
      return;
    }

    if (event.event !== "media") return;
    const payload = (event.media as { payload?: string } | undefined)?.payload;
    // Only audible once a person has actually been handed the call.
    if (payload) bridge.sendToCarrier(payload, "human");
  });

  client.on("close", () => {
    console.log(`[takeover] supervisor left call=${callSid}`);
    bridge.detachSupervisor();

    // A supervisor who hangs up first would otherwise leave the carrier on an
    // open line with a muted agent, which sounds exactly like a dropped call.
    const runtime = registry.byCallSid(callSid);
    if (runtime?.routeTo === "HUMAN") {
      runtime.routeTo = "AGENT";
      setSupervisionFor(store, callSid, {
        state: "returned_to_agent",
        returnedAt: new Date().toISOString()
      });
      console.log(`[takeover] floor returned to Volta on call=${callSid}`);
    }
  });
}

function openMediaStreamSession(
  twilioSocket: ClosableRelaySocket,
  setup: MediaStreamSetup
): void {
  const { dependencies, warm } = setup;
  const { store } = dependencies;
  const context = telephonyContext(store);
  const registry = context.registry;
  const dialled =
    dependencies.dialled ??
    new Map(
      store
        .getOperation()
        .callSessions.filter(
          (
            session
          ): session is typeof session & {
            callSid: string;
            carrierId: string;
            driverName: string;
          } =>
            Boolean(session.callSid && session.carrierId && session.driverName)
        )
        .map((session) => [
          session.callSid,
          { id: session.carrierId, name: session.driverName }
        ])
    );
  if (!env.OPENAI_API_KEY) {
    console.error("[session] OPENAI_API_KEY missing; dropping the call");
    twilioSocket.close();
    return;
  }

  // Bound when Twilio announces the stream; every tool call on this socket is
  // attributed to it, so quotes from concurrent calls cannot be confused.
  let runtime: CallRuntime | undefined;

  // The session warmed while this call was ringing is already open and already
  // briefed for this carrier. Opening a new one here is the cold path: correct,
  // but it puts the handshake back on the clock of a carrier who has answered.
  const realtime =
    warm?.realtime ??
    createRealtimeSocket({
      apiKey: env.OPENAI_API_KEY,
      model: env.OPENAI_REALTIME_MODEL
    });

  // Realtime reports rejected session config as an `error` event rather than by
  // closing, so a silent agent looks identical to a healthy one without this.
  realtime.on("message", (raw) => {
    try {
      const event: unknown = JSON.parse(raw);
      if (
        typeof event === "object" &&
        event !== null &&
        (event as { type?: unknown }).type === "error"
      ) {
        console.error("[realtime] error event:", raw.slice(0, 500));
      }
    } catch {
      // Non-JSON frames are not ours to interpret.
    }
  });

  attachMediaStreamRelay({
    twilio: twilioSocket,
    realtime,
    configuration: createModeConfiguration("negotiation"),
    sessionAlreadyConfigured: Boolean(warm),
    // The number the carrier actually experiences: how long they held a live
    // line in silence. Without it a slow greeting and a fast one look the same
    // in the logs.
    onFirstAudio: () => {
      const sinceAnswer =
        setup.answeredAtMs === undefined
          ? "unknown"
          : `${Date.now() - setup.answeredAtMs}ms`;
      console.log(
        `[latency] answer->first_audio=${sinceAnswer} (upgrade=${setup.upgradeMs}ms warm=${warmLabel(warm)})`
      );
    },
    onStart: ({ streamSid, callSid }) => {
      const carrier =
        dependencies.callContext?.carrier ??
        (callSid ? dialled.get(callSid) : undefined);

      // The switchboard for this call. Holding the carrier's socket here is
      // what lets a supervisor be routed in later without touching the leg.
      openBridge({
        callSid: callSid ?? streamSid,
        sendToCarrier: (payload) =>
          twilioSocket.send(
            JSON.stringify({ event: "media", streamSid, media: { payload } })
          ),
        clearCarrier: () =>
          twilioSocket.send(JSON.stringify({ event: "clear", streamSid })),
        floor: () => runtime?.routeTo ?? "AGENT"
      });

      runtime = registry.open({
        callSid: callSid ?? streamSid,
        streamSid,
        operationId: store.getOperation().id,
        carrierId: carrier?.id,
        carrierName: carrier?.name,
        direction: setup.direction,
        startedAt: new Date().toISOString()
      });
      // One place decides which session this call is: doing the lookup here as
      // well, on `callSid` alone, is what opened a second session for a call
      // the round had already recorded.
      bindCallSession(store, {
        callSid: callSid ?? streamSid,
        carrier,
        direction: setup.direction
      });

      console.log(
        `[call] started stream=${streamSid} call=${callSid ?? "?"} carrier=${carrier?.name ?? "unknown"} direction=${setup.direction} operation=${store.getOperation().id}`
      );
      return runtime;
    },
    // Volta only reaches the carrier while it still has the floor.
    agentHasTheFloor: () => (runtime?.routeTo ?? "AGENT") === "AGENT",
    // A supervisor who joined hears the carrier throughout.
    onCallerAudio: (payload) => {
      if (runtime) getBridge(runtime.callSid)?.toSupervisor(payload);
    },
    onTranscript: ({ speaker, text, atMs }) => {
      const call = runtime;
      if (!call) return;
      const segment = {
        id: `seg-${call.callSid}-${atMs}`,
        organizationId: dependencies.organizationId ?? "textiles-pacifico",
        operationId: call.operationId,
        callId: call.callSid,
        speaker,
        text,
        startMs: atMs,
        endMs: atMs,
        createdAt: new Date().toISOString()
      };

      store.appendTranscript(segment);
      // Persisted separately, and never in the call's way: a database that is
      // down must not take the conversation with it.
      try {
        dependencies.onTranscriptAppended?.(segment);
      } catch (error) {
        console.error("[transcript] persist failed:", error);
      }
    },
    instructionsFor: (call) => {
      const confirmationContext = dependencies.confirmationCoordinator?.getCallContext(
        call.callSid
      );
      return confirmationContext
        ? {
            ...confirmationContext.configuration,
            instructions: buildConfirmationCallInstructions({
              operation: store.getOperation(),
              quote: confirmationContext.quote,
              carrierName: call.carrierName
            })
          }
        : buildCallInstructions(store.getOperation(), call.carrierName);
    },
    executeToolCall: async (request) => {
      const current = runtime;
      const confirmationContext = current
        ? dependencies.confirmationCoordinator?.getCallContext(current.callSid)
        : undefined;

      // The agent asking for a person opens a countdown rather than parking
      // the call: someone accepts from the console, or Volta says it will call
      // back and hangs up. A carrier holding for a dashboard nobody is
      // watching is the worst of the three outcomes.
      if (request.name === "trigger_escalation" && current) {
        openTakeoverWindow({
          store,
          runtime: current,
          realtime,
          hangUp: () => twilioSocket.close()
        });
      }

      console.log(
        `[tool] ${request.name} call=${current?.callSid ?? "?"} t=${current ? callClockMs(current) : 0}ms`
      );

      return executeToolCall(request, {
        store,
        // Only quotes other carriers actually gave. Nothing here lets the
        // agent cite a price that was never offered.
        leverage: () =>
          current?.carrierId
            ? context.auction.leverageFor(current.carrierId)
            : [],
        callContext: current
          ? {
              callId: current.callSid,
              carrierId: current.carrierId,
              carrierName: current.carrierName,
              callClockMs: () => callClockMs(current)
            }
          : undefined,
        // Built per call so the recap and the audio anchor belong to this leg.
        mode: confirmationContext ? ("confirmation" as const) : ("negotiation" as const),
        finalizeConfirmation:
          confirmationContext && current
            ? (() => {
                const finalize = createCommitmentFinalizer({
                  store,
                  // Only reached when recapRecipient is set, which itself
                  // only happens for a WhatsApp-approved selection — so the
                  // real messenger is present whenever this actually sends.
                  sms: dependencies.whatsappMessenger
                    ? whatsappRecapGateway(dependencies.whatsappMessenger)
                    : {
                        send: async (message) => ({
                          id: "no-messenger",
                          ...message,
                          status: "failed" as const
                        })
                      },
                  callId: current.callSid,
                  recipient: confirmationContext.recapRecipient
                });
                return (intent: { timestampMs?: number } & Omit<
                  Parameters<typeof finalize>[0],
                  "timestampMs"
                >) => finalize({ ...intent, timestampMs: intent.timestampMs ?? 0 });
              })()
            : async () => {}
      });
    }
  });

  // Neither side owns the other: closing one must tear down the other, or the
  // Realtime session keeps billing after the caller hangs up.
  twilioSocket.on("close", () => {
    console.log(
      `[twilio] media stream closed after ${runtime ? runtime.frameCount * 20 : 0}ms of audio`
    );
    if (runtime) {
      closeBridge(runtime.callSid);
      registry.close(runtime.streamSid);
      // Matched on either identifier: the session this call was bound to may
      // be one a round opened under a generated id.
      const session = findCallSession(store, runtime.callSid);
      // A transferred call is still live — our stream ended because the TwiML
      // was replaced with a Dial, not because anyone hung up. Twilio's status
      // callback closes that one when the person actually finishes.
      const transferred = session?.supervision?.reason === "transferred";
      if (session && session.status === "in_progress" && !transferred)
        store.updateCallSession(session.id, {
          status: "completed",
          endedAt: new Date().toISOString()
        });
      dependencies.onCallCompleted?.(runtime.callSid, runtime.operationId);
    }
    realtime.close();
  });
  realtime.on("close", () => twilioSocket.close());
}
