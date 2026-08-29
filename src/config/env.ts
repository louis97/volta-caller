import { z } from "zod";

const envSchema = z
  .object({
    PORT: z.coerce.number().default(3001),
    VOLTA_MODE: z.enum(["mock", "live"]).default("mock"),
    TWILIO_ACCOUNT_SID: z.string().min(1).optional(),
    TWILIO_AUTH_TOKEN: z.string().min(1).optional(),
    OPENAI_API_KEY: z.string().min(1).optional(),
    SUPABASE_URL: z.string().url().optional(),
    SUPABASE_PUBLISHABLE_KEY: z.string().min(1).optional(),
    SUPABASE_SERVICE_ROLE_KEY: z.string().min(1).optional(),
    VOLTA_COPILOT_MODEL: z.string().min(1).default("gpt-5")
  })
  .superRefine((value, context) => {
    if (Boolean(value.TWILIO_ACCOUNT_SID) !== Boolean(value.TWILIO_AUTH_TOKEN)) {
      context.addIssue({
        code: "custom",
        message: "TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN must be provided together"
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
  });

export type Env = z.infer<typeof envSchema>;

export function loadEnv(values: NodeJS.ProcessEnv = process.env): Env {
  return envSchema.parse(values);
}

export const env = loadEnv();
