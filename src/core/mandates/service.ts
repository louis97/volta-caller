import type { CreateMandateRequest } from "@volta/contracts";
import { z } from "zod";

import type { MandateRecord, MandatesRepository } from "./types";

const dateTime = z.string().datetime({ offset: true });

const createMandateSchema = z
  .object({
    budget_cap: z.number().finite().positive(),
    destination_datetime: dateTime,
    destination_place: z.string().trim().min(1),
    type_of_content: z.string().trim().min(1),
    weight: z.number().finite().positive(),
    measures: z.string().trim().min(1),
    pickup_address: z.string().trim().min(1),
    pickup_datetime: dateTime
  })
  .superRefine((value, context) => {
    if (
      Date.parse(value.pickup_datetime) >=
      Date.parse(value.destination_datetime)
    ) {
      context.addIssue({
        code: "custom",
        message: "pickup_datetime must be before destination_datetime",
        path: ["pickup_datetime"]
      });
    }
  });

export class InvalidMandateError extends Error {
  readonly code = "invalid_mandate";

  constructor() {
    super("The mandate payload is invalid");
  }
}

export async function createMandate(
  repository: MandatesRepository,
  input: unknown
): Promise<MandateRecord> {
  const parsed = createMandateSchema.safeParse(input);
  if (!parsed.success) throw new InvalidMandateError();
  return repository.create(parsed.data satisfies CreateMandateRequest);
}

export function getMandate(
  repository: MandatesRepository,
  id: string
): Promise<MandateRecord | null> {
  return repository.findById(id);
}

export function listMandates(
  repository: MandatesRepository
): Promise<MandateRecord[]> {
  return repository.list();
}
