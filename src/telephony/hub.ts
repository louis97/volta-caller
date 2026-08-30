/**
 * Audio switchboard for a live call.
 *
 * Handing a call to a person never tears down the carrier's leg: Twilio keeps
 * streaming to us and we decide who the caller hears. That makes the handover
 * a routing change rather than a telephony operation, so it cannot drop the
 * call, it is instant, and control can come back to the agent afterwards.
 *
 *   carrier audio  -> always to the agent  (transcript never stops)
 *   agent audio    -> to the carrier only while routeTo is AGENT
 *   human audio    -> to the carrier only while routeTo is HUMAN
 */
export type CallBridge = {
  readonly callSid: string;
  /**
   * Plays audio to the carrier. Base64 mu-law, as Twilio sends it. Refused
   * unless the caller currently holds the floor: being connected is not the
   * same as having been handed the call, and a supervisor listening in must
   * not be audible to the carrier.
   */
  sendToCarrier(payload: string, from: "agent" | "human"): void;
  /** Discards whatever the carrier has buffered, so nobody talks over. */
  clearCarrier(): void;
  attachSupervisor(send: (payload: string) => void): void;
  detachSupervisor(): void;
  hasSupervisor(): boolean;
  /** Mirrors the carrier to the supervisor so they hear the conversation. */
  toSupervisor(payload: string): void;
};

const bridges = new Map<string, CallBridge>();

export function openBridge(input: {
  callSid: string;
  sendToCarrier: (payload: string) => void;
  clearCarrier: () => void;
  /** Who the carrier should be hearing right now. */
  floor: () => "AGENT" | "HUMAN";
}): CallBridge {
  let supervisor: ((payload: string) => void) | undefined;

  const bridge: CallBridge = {
    callSid: input.callSid,
    sendToCarrier(payload, from) {
      const holder = input.floor() === "HUMAN" ? "human" : "agent";
      if (from !== holder) return;
      input.sendToCarrier(payload);
    },
    clearCarrier: input.clearCarrier,
    attachSupervisor(send) {
      supervisor = send;
    },
    detachSupervisor() {
      supervisor = undefined;
    },
    hasSupervisor: () => supervisor !== undefined,
    toSupervisor(payload) {
      supervisor?.(payload);
    }
  };

  bridges.set(input.callSid, bridge);
  return bridge;
}

export function getBridge(callSid: string): CallBridge | undefined {
  return bridges.get(callSid);
}

export function closeBridge(callSid: string): void {
  bridges.delete(callSid);
}
