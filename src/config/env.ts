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
     */
    TWILIO_RECORD_CALLS: z
      .enum(["true", "false"])
      .default("false")
      .transform((value) => value === "true"),
    SUPABASE_URL: z.string().url().optional(),
    SUPABASE_PUBLISHABLE_KEY: z.string().min(1).optional(),
    SUPABASE_SERVICE_ROLE_KEY: z.string().min(1).optional(),
    VOLTA_COPILOT_MODEL: z.string().min(1).default("gpt-5.4-mini"),
    DATABASE_URL: z.string().url().optional(),
    VOLTA_DEFAULT_ORGANIZATION_ID: z
      .string()
      .min(1)
      .default("textiles-pacifico"),
    VOLTA_INTERNAL_API_KEY: z.string().min(16).optional(),
    KAPSO_API_KEY: z.string().min(1).optional(),
    KAPSO_PHONE_NUMBER_ID: z.string().min(1).optional(),
    KAPSO_WEBHOOK_SECRET: z.string().min(1).optional()
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

    const hasSupabaseKey = Boolean(
      value.SUPABASE_PUBLISHABLE_KEY || value.SUPABASE_SERVICE_ROLE_KEY
    );
    if (Boolean(value.SUPABASE_URL) !== hasSupabaseKey) {
      context.addIssue({
        code: "custom",
        message:
          "SUPABASE_URL and either SUPABASE_PUBLISHABLE_KEY or SUPABASE_SERVICE_ROLE_KEY must be provided together"
      });
    }
    const kapsoValues = [
      value.KAPSO_API_KEY,
      value.KAPSO_PHONE_NUMBER_ID,
      value.KAPSO_WEBHOOK_SECRET
    ];
    if (kapsoValues.some(Boolean) && !kapsoValues.every(Boolean)) {
      context.addIssue({
        code: "custom",
        message:
          "KAPSO_API_KEY, KAPSO_PHONE_NUMBER_ID and KAPSO_WEBHOOK_SECRET must be provided together"
      });
    }
  });

export type Env = z.infer<typeof envSchema>;

export function loadEnv(values: NodeJS.ProcessEnv = process.env): Env {
  return envSchema.parse(values);
}

export const env = loadEnv();

/**
 * Variables placing a real call needs. Reported as a boot warning rather than
 * a schema failure: live mode is also used for work that never touches
 * telephony, but a missing one of these otherwise surfaces much later as a
 * dead WebSocket mid-call.
 */
export function missingTelephonyConfig(value: Env = env): string[] {
  if (value.VOLTA_MODE !== "live") return [];

  return (
    [
      "TWILIO_ACCOUNT_SID",
      "TWILIO_AUTH_TOKEN",
      "TWILIO_FROM_NUMBER",
      "OPENAI_API_KEY",
      "PUBLIC_WS_URL"
    ] as const
  ).filter((key) => !value[key]);
}
