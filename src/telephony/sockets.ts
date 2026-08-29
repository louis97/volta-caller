import { WebSocket } from "ws";

import type { RelaySocket } from "./mediaStream";

export type ClosableRelaySocket = RelaySocket & { close(): void };

export type RelaySocketOptions = {
  /** Identifies the leg in logs, e.g. "twilio" or "realtime". */
  label: string;
  onClose?: (code: number, reason: string) => void;
};

/**
 * Adapts a `ws` socket to the RelaySocket contract used by the media relay.
 *
 * Messages sent before the socket opens are queued instead of dropped:
 * `attachMediaStreamRelay` pushes `session.update` synchronously when it
 * attaches, which would otherwise be lost against a still-connecting socket
 * and leave the Realtime session unconfigured (no VAD, no tools, wrong codec).
 *
 * An `error` listener is always attached: `ws` throws on an unhandled `error`
 * event, which would take the API process down with the call.
 */
export function toRelaySocket(
  socket: WebSocket,
  { label, onClose }: RelaySocketOptions
): ClosableRelaySocket {
  const pending: string[] = [];

  socket.on("open", () => {
    console.log(`[${label}] open (${pending.length} queued)`);
    while (pending.length > 0) {
      const message = pending.shift();
      if (message !== undefined) socket.send(message);
    }
  });

  socket.on("error", (error: Error) => {
    console.error(`[${label}] socket error:`, error.message);
  });

  socket.on("close", (code: number, reason: Buffer) => {
    const text = reason.toString();
    console.log(
      `[${label}] close code=${code}${text ? ` reason=${text}` : ""}`
    );
    onClose?.(code, text);
  });

  return {
    send(message: string): void {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(message);
        return;
      }
      pending.push(message);
    },
    on(event: "message" | "close", listener: (message: string) => void): void {
      if (event === "message") {
        socket.on("message", (data: unknown) => {
          listener(typeof data === "string" ? data : String(data));
        });
        return;
      }
      socket.on("close", () => listener(""));
    },
    close(): void {
      socket.close();
    }
  };
}

export type RealtimeSocketOptions = {
  apiKey: string;
  model: string;
  baseUrl?: string;
  onClose?: (code: number, reason: string) => void;
};

export function createRealtimeSocket({
  apiKey,
  model,
  baseUrl = "wss://api.openai.com/v1/realtime",
  onClose
}: RealtimeSocketOptions): ClosableRelaySocket {
  const url = `${baseUrl}?model=${encodeURIComponent(model)}`;
  console.log(`[realtime] connecting model=${model}`);

  const socket = new WebSocket(url, {
    // No `OpenAI-Beta` header: it selects the retired Beta shape, which the
    // server now rejects outright.
    headers: { Authorization: `Bearer ${apiKey}` }
  });

  // The HTTP handshake carries the real reason for a rejected upgrade; the
  // close code alone does not distinguish a bad key from a bad model.
  socket.on("unexpected-response", (_request, response) => {
    console.error(
      `[realtime] upgrade refused: HTTP ${response.statusCode} ${response.statusMessage ?? ""}`
    );
    let body = "";
    response.on("data", (chunk: Buffer) => {
      body += chunk.toString();
    });
    response.on("end", () => {
      if (body) console.error(`[realtime] body: ${body.slice(0, 400)}`);
    });
  });

  return toRelaySocket(socket, { label: "realtime", onClose });
}
