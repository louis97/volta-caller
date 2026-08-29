import { z } from "zod";

const envSchema = z
  .object({
    PORT: z.coerce.number().default(3001),
    VOLTA_MODE: z.enum(["mock", "live"]).default("mock"),
    TWILIO_ACCOUNT_SID: z.string().min(1).optional(),
    TWILIO_AUTH_TOKEN: z.string().min(1).optional(),
    OPENAI_API_KEY: z.string().min(1).optional()
  })
  .superRefine((value, context) => {
    if (Boolean(value.TWILIO_ACCOUNT_SID) !== Boolean(value.TWILIO_AUTH_TOKEN)) {
      context.addIssue({
        code: "custom",
        message: "TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN must be provided together"
      });
    }
  });

export type Env = z.infer<typeof envSchema>;

export function loadEnv(values: NodeJS.ProcessEnv = process.env): Env {
  return envSchema.parse(values);
}

export const env = loadEnv();
