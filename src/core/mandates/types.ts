import type { CreateMandateRequest } from "@volta/contracts";

export type MandateRecord = CreateMandateRequest & {
  id: string;
  created_at: string;
  updated_at: string;
};

export type MandatesRepository = {
  create(input: CreateMandateRequest): Promise<MandateRecord>;
  findById(id: string): Promise<MandateRecord | null>;
  list(): Promise<MandateRecord[]>;
};
