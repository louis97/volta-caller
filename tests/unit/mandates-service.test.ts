import { describe, expect, it } from "vitest";

import {
  createMandate,
  getMandate,
  listMandates
} from "../../src/core/mandates/service";
import type {
  MandateRecord,
  MandatesRepository
} from "../../src/core/mandates/types";
import type { CreateMandateRequest } from "@volta/contracts";

const request: CreateMandateRequest = {
  budget_cap: 8700.5,
  destination_datetime: "2026-09-03T18:00:00-06:00",
  destination_place: "Guadalajara",
  type_of_content: "Textiles",
  weight: 18400,
  measures: "120 x 100 x 110 cm",
  pickup_address: "Manzanillo",
  pickup_datetime: "2026-09-03T10:00:00-06:00"
};

class MemoryRepository implements MandatesRepository {
  private readonly records: MandateRecord[] = [];

  async create(input: CreateMandateRequest): Promise<MandateRecord> {
    const record: MandateRecord = {
      id: `mandate-${this.records.length + 1}`,
      ...input,
      created_at: "2026-09-01T15:00:00.000Z",
      updated_at: "2026-09-01T15:00:00.000Z"
    };
    this.records.push(record);
    return record;
  }

  async findById(id: string): Promise<MandateRecord | null> {
    return this.records.find((record) => record.id === id) ?? null;
  }

  async list(): Promise<MandateRecord[]> {
    return [...this.records];
  }
}

describe("mandates service", () => {
  it("persists and returns a valid mandate", async () => {
    const repository = new MemoryRepository();

    const created = await createMandate(repository, request);

    expect(created).toMatchObject({ id: "mandate-1", budget_cap: 8700.5 });
    await expect(getMandate(repository, created.id)).resolves.toEqual(created);
    await expect(listMandates(repository)).resolves.toEqual([created]);
  });

  it("rejects a pickup time that is not before the destination time", async () => {
    await expect(
      createMandate(new MemoryRepository(), {
        ...request,
        pickup_datetime: request.destination_datetime
      })
    ).rejects.toMatchObject({ code: "invalid_mandate" });
  });
});
