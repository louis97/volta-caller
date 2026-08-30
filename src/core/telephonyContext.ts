import { createHash, randomBytes } from "node:crypto";

export const TELEPHONY_CONTEXT_TTL_MS = 24 * 60 * 60 * 1000;

export type TelephonyCallContextRecord = {
  tokenHash: string;
  organizationId: string;
  operationId: string;
  carrierId?: string;
  createdAt: string;
  expiresAt: string;
};

/**
 * A bearer token is the only operational identity exposed in Twilio URLs.
 * The database keeps only its hash, so a read-only data leak cannot be used
 * to attach a media stream to a mandate.
 */
export function createTelephonyCallToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashTelephonyCallToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function telephonyContextExpiry(
  createdAt: string,
  ttlMs = TELEPHONY_CONTEXT_TTL_MS
): string {
  return new Date(new Date(createdAt).getTime() + ttlMs).toISOString();
}
