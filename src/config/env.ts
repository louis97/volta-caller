import { z } from "zod";

const envSchema = z
  .object({
    PORT: z.coerce.number().default(3001),
    VOLTA_MODE: z.enum(["mock", "live"]).default("mock"),
    TWILIO_ACCOUNT_SID: z.string().min(1).optional(),
    TWILIO_AUTH_TOKEN: z.string().min(1).optional(),
    TWILIO_FROM_NUMBER: z.string().min(1).optional(),
    OPENAI_API_KEY: z.string().min(1).optional(),
    OPENAI_REALTIME_MODEL: z.string().min(1).default("gpt-realtime"),
    /** Public https origin exposed by ngrok, e.g. https://abc123.ngrok.app */
    PUBLIC_BASE_URL: z.string().url().optional(),
    /** Public wss origin exposed by ngrok, e.g. wss://abc123.ngrok.app */
    PUBLIC_WS_URL: z.string().url().optional(),
    SUPERVISOR_PHONE: z.string().min(1).optional(),
    /**
     * Hard ceiling per outbound call. A leg left open by a bug drains prepaid
     * balance silently, so paid accounts should keep this on. Trial accounts
     * reject the parameter, so 0 omits it entirely.
     */
    CALL_TIME_LIMIT_SECONDS: z.coerce.number().int().nonnegative().default(0),
    /**
     * Dual-channel recording is what lets a commitment link to the moment it
     * was agreed. Trial accounts cannot use it: Twilio rejects the whole
     * request with "trial accounts have limited parameter access".
     * Turn this on after upgrading.
     */
    TWILIO_RECORD_CALLS: z
      .enum(["true", "false"])
      .default("false")
      .transform((value) => value === "true")
  })
  .superRefine((value, context) => {
    if (
      Boolean(value.TWILIO_ACCOUNT_SID) !== Boolean(value.TWILIO_AUTH_TOKEN)
    ) {
      context.addIssue({
        code: "custom",
        message:
          "TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN must be provided together"
      });
    }

    if (value.VOLTA_MODE !== "live") return;

    // Fail loudly at boot instead of mid-call: a missing var here surfaces as a
    // dead WebSocket at 3am otherwise.
    const requiredForLive = [
      "TWILIO_ACCOUNT_SID",
      "TWILIO_AUTH_TOKEN",
      "TWILIO_FROM_NUMBER",
      "OPENAI_API_KEY",
      "PUBLIC_WS_URL"
    ] as const;

    for (const key of requiredForLive) {
      if (!value[key]) {
        context.addIssue({
          code: "custom",
          message: `${key} is required when VOLTA_MODE=live`
        });
      }
    }
  });

export type Env = z.infer<typeof envSchema>;

export function loadEnv(values: NodeJS.ProcessEnv = process.env): Env {
  return envSchema.parse(values);
}

export const env = loadEnv();
