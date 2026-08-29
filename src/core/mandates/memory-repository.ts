import type { CreateMandateRequest } from "@volta/contracts";

import type { MandateRecord, MandatesRepository } from "./types";

export function createMemoryMandatesRepository(): MandatesRepository {
  const records: MandateRecord[] = [];

  return {
    async create(input: CreateMandateRequest): Promise<MandateRecord> {
      const timestamp = new Date().toISOString();
      const record: MandateRecord = {
        id: crypto.randomUUID(),
        ...input,
        created_at: timestamp,
        updated_at: timestamp
      };
      records.unshift(record);
      return structuredClone(record);
    },
    async findById(id: string): Promise<MandateRecord | null> {
      const record = records.find((candidate) => candidate.id === id);
      return record ? structuredClone(record) : null;
    },
    async list(): Promise<MandateRecord[]> {
      return structuredClone(records);
    }
  };
}
