import type { Server } from "node:http";

import express, { type Express } from "express";
import twilio from "twilio";
import { WebSocketServer } from "ws";

import { executeToolCall } from "../agent/interpreter";
import { buildCallInstructions } from "../agent/prompt";
import { env } from "../config/env";
import type { OperationStore } from "../core/state";
import { auctionFromOperation, type Auction } from "./auction";
import { fanOutCalls } from "./orchestrator";
import { attachMediaStreamRelay } from "./mediaStream";
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

export type TelephonyDependencies = {
  store: OperationStore;
  organizationId?: string;
  dialled?: Map<string, { id: string; name: string }>;
  onCallSessionChanged?: (
    session: import("@volta/contracts").CallSession
  ) => void;
  /**
   * Durable home for an utterance. The store keeps transcript in memory for
   * the live floor; without this it dies with the process and the
   * transcript_segments table stays empty.
   */
  onTranscriptAppended?: (
    segment: import("@volta/contracts").TranscriptSegment
  ) => void;
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

function mediaStreamUrl(): string {
  if (!env.PUBLIC_WS_URL) throw new Error("public_ws_url_missing");
  return `${env.PUBLIC_WS_URL.replace(/\/$/, "")}${MEDIA_STREAM_PATH}`;
}

export function mountTelephonyRoutes(
  app: Express,
  dependencies: TelephonyDependencies
): void {
  const { store } = dependencies;
  const context = telephonyContext(store);
  const dialled = dependencies.dialled ?? context.dialled;
  store.subscribe((event) => {
    if (event.type === "call.started" || event.type === "call.updated")
      dependencies.onCallSessionChanged?.(event.callSession);
  });
  const twiml = express.urlencoded({ extended: false });

  // Twilio fetches these when a call connects; both directions share one relay.
  app.post(
    ["/twiml/outbound", "/twiml/inbound"],
    twiml,
    (_request, response) => {
      response.type("text/xml").send(createInboundTwiML(mediaStreamUrl()));
    }
  );

  // Diagnostic only: a TwiML with no media stream. If a call reaches this and
  // speaks, the account and the public URL are fine and the stream itself is
  // what the account refuses.
  app.post("/twiml/say", twiml, (_request, response) => {
    response
      .type("text/xml")
      .send(
        '<?xml version="1.0" encoding="UTF-8"?><Response><Say voice="Polly.Mia" language="es-MX">Prueba de Volta. Si escuchas esto, el camino de voz funciona.</Say><Pause length="2"/></Response>'
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
    context.resetAuction();
    dialled.clear();
    await fanOutCalls({
      store,
      mode: env.VOLTA_MODE,
      publicBaseUrl: env.PUBLIC_BASE_URL,
      from: env.TWILIO_FROM_NUMBER,
      gateway:
        env.VOLTA_MODE === "live" ? createLiveTelephonyGateway() : undefined,
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
   * Hands a live call to a person. The agent leg is never dropped: this marks
   * intent and state, and the audio hub routes the caller to the supervisor.
   * Until the hub lands the state is recorded so the board can already show
   * and drive the handover.
   */
  app.post("/api/calls/:callId/takeover", jsonBody, (request, response) => {
    const reason =
      typeof (request.body as { reason?: unknown } | undefined)?.reason ===
      "string"
        ? (request.body as { reason: string }).reason
        : undefined;

    try {
      const callSession = store.setCallSupervision(
        String(request.params.callId),
        {
          state: "briefing_supervisor",
          reason,
          requestedAt: new Date().toISOString()
        }
      );
      response.status(202).json(callSession);
    } catch {
      response.status(404).json({ error: "call_session_not_found" });
    }
  });

  /** The supervisor is on the line; the caller now hears them. */
  app.post("/api/calls/:callId/connect", (request, response) => {
    try {
      const runtime = context.registry.byCallSid(String(request.params.callId));
      if (runtime) runtime.routeTo = "HUMAN";
      const callSession = store.setCallSupervision(
        String(request.params.callId),
        {
          state: "human",
          takenOverAt: new Date().toISOString()
        }
      );
      response.status(200).json(callSession);
    } catch {
      response.status(404).json({ error: "call_session_not_found" });
    }
  });

  /** Gives the conversation back to Volta without ending the call. */
  app.post("/api/calls/:callId/handback", (request, response) => {
    try {
      const runtime = context.registry.byCallSid(String(request.params.callId));
      if (runtime) runtime.routeTo = "AGENT";
      const callSession = store.setCallSupervision(
        String(request.params.callId),
        {
          state: "returned_to_agent",
          returnedAt: new Date().toISOString()
        }
      );
      response.status(200).json(callSession);
    } catch {
      response.status(404).json({ error: "call_session_not_found" });
    }
  });

  app.get("/api/transcript", (request, response) => {
    const callId =
      typeof request.query.callId === "string"
        ? request.query.callId
        : undefined;
    response.status(200).json(store.getTranscript(callId));
  });

  app.get("/api/auction", (_request, response) => {
    response.status(200).json({
      status: context.auction.status(),
      standings: context.auction.standings()
    });
  });

  app.post("/twiml/status", twiml, (request, response) => {
    const callSid =
      typeof request.body.CallSid === "string"
        ? request.body.CallSid
        : undefined;
    const callStatus =
      typeof request.body.CallStatus === "string"
        ? request.body.CallStatus
        : undefined;
    const session = store
      .getOperation()
      .callSessions.find((item) => item.callSid === callSid);
    if (session && callStatus)
      store.updateCallSession(
        session.id,
        mapTwilioStatus(callStatus as Parameters<typeof mapTwilioStatus>[0])
      );
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

    try {
      const gateway = createTwilioGateway({ client: getTwilioClient() });
      const session = await gateway.createOutboundCall({
        operationId: store.getOperation().id,
        to,
        from: env.TWILIO_FROM_NUMBER ?? "",
        twimlUrl: `${(env.PUBLIC_BASE_URL ?? "").replace(/\/$/, "")}${twimlPath}`,
        ...(env.CALL_TIME_LIMIT_SECONDS > 0
          ? { timeLimitSeconds: env.CALL_TIME_LIMIT_SECONDS }
          : {}),
        record: env.TWILIO_RECORD_CALLS
      });
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

export function attachTelephonyWebSockets(
  server: Server,
  dependencies: TelephonyDependencies
): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (request, socket, head) => {
    const { pathname } = new URL(request.url ?? "/", "http://localhost");
    if (pathname !== MEDIA_STREAM_PATH) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (client) => {
      wss.emit("connection", client, request);
    });
  });

  wss.on("connection", (client) => {
    console.log("[twilio] media stream connected");
    openMediaStreamSession(
      toRelaySocket(client, { label: "twilio" }),
      dependencies
    );
  });

  return wss;
}

function openMediaStreamSession(
  twilioSocket: ClosableRelaySocket,
  dependencies: TelephonyDependencies
): void {
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

  const realtime = createRealtimeSocket({
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
    onStart: ({ streamSid, callSid }) => {
      const carrier = callSid ? dialled.get(callSid) : undefined;
      runtime = registry.open({
        callSid: callSid ?? streamSid,
        streamSid,
        operationId: store.getOperation().id,
        carrierId: carrier?.id,
        carrierName: carrier?.name,
        direction: "outbound",
        startedAt: new Date().toISOString()
      });
      const session = store
        .getOperation()
        .callSessions.find((item) => item.callSid === (callSid ?? streamSid));
      if (session)
        store.updateCallSession(session.id, {
          status: "in_progress",
          startedAt: runtime.startedAt
        });
      console.log(
        `[call] started stream=${streamSid} call=${callSid ?? "?"} carrier=${carrier?.name ?? "unknown"}`
      );
      return runtime;
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
    instructionsFor: (call) =>
      buildCallInstructions(store.getOperation(), call.carrierName),
    executeToolCall: (request) => {
      const current = runtime;
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
        mode: "negotiation" as const,
        finalizeConfirmation: async () => {}
      });
    }
  });

  // Neither side owns the other: closing one must tear down the other, or the
  // Realtime session keeps billing after the caller hangs up.
  twilioSocket.on("close", () => {
    if (runtime) {
      registry.close(runtime.streamSid);
      const session = store
        .getOperation()
        .callSessions.find((item) => item.callSid === runtime?.callSid);
      if (session && session.status === "in_progress")
        store.updateCallSession(session.id, {
          status: "completed",
          endedAt: new Date().toISOString()
        });
    }
    realtime.close();
  });
  realtime.on("close", () => twilioSocket.close());
}
