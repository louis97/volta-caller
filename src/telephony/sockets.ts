import { WebSocket } from "ws";

import type { RelaySocket } from "./mediaStream";

export type ClosableRelaySocket = RelaySocket & { close(): void };

/**
 * Adapts a `ws` socket to the RelaySocket contract used by the media relay.
 *
 * Messages sent before the socket opens are queued instead of dropped:
 * `attachMediaStreamRelay` pushes `session.update` synchronously when it
 * attaches, which would otherwise be lost against a still-connecting socket
 * and leave the Realtime session unconfigured (no VAD, no tools, wrong codec).
 */
export function toRelaySocket(socket: WebSocket): ClosableRelaySocket {
  const pending: string[] = [];

  socket.on("open", () => {
    while (pending.length > 0) {
      const message = pending.shift();
      if (message !== undefined) socket.send(message);
    }
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
};

export function createRealtimeSocket({
  apiKey,
  model,
  baseUrl = "wss://api.openai.com/v1/realtime"
}: RealtimeSocketOptions): ClosableRelaySocket {
  const socket = new WebSocket(
    `${baseUrl}?model=${encodeURIComponent(model)}`,
    {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "OpenAI-Beta": "realtime=v1"
      }
    }
  );

  return toRelaySocket(socket);
}
