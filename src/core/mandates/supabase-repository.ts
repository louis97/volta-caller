import { createClient } from "@supabase/supabase-js";
import type { CreateMandateRequest } from "@volta/contracts";

import type { MandateRecord, MandatesRepository } from "./types";

type SupabaseResult = {
  data: unknown;
  error: { message: string } | null;
};

export type SupabaseMandatesClient = {
  from(table: "mandates"): {
    insert(input: CreateMandateRequest): {
      select(): { single(): Promise<SupabaseResult> };
    };
    select(): {
      eq(column: "id", id: string): { maybeSingle(): Promise<SupabaseResult> };
      order(column: "created_at", options: { ascending: false }): Promise<SupabaseResult>;
    };
  };
};

export function createSupabaseMandatesRepository(
  client: SupabaseMandatesClient
): MandatesRepository {
  return {
    async create(input) {
      const result = await client.from("mandates").insert(input).select().single();
      return readRecord(result);
    },
    async findById(id) {
      const result = await client.from("mandates").select().eq("id", id).maybeSingle();
      if (result.error) throw new Error(result.error.message);
      return result.data === null ? null : mapRecord(result.data);
    },
    async list() {
      const result = await client
        .from("mandates")
        .select()
        .order("created_at", { ascending: false });
      if (result.error) throw new Error(result.error.message);
      if (!Array.isArray(result.data)) throw new Error("Invalid mandates response");
      return result.data.map(mapRecord);
    }
  };
}

export function createSupabaseMandatesRepositoryFromConfig(
  url: string,
  secretKey: string
): MandatesRepository {
  return createSupabaseMandatesRepository(
    createClient(url, secretKey) as unknown as SupabaseMandatesClient
  );
}

function readRecord(result: SupabaseResult): MandateRecord {
  if (result.error) throw new Error(result.error.message);
  return mapRecord(result.data);
}

function mapRecord(value: unknown): MandateRecord {
  if (typeof value !== "object" || value === null) {
    throw new Error("Invalid mandate response");
  }
  const row = value as Record<string, unknown>;
  return {
    id: text(row, "id"),
    budget_cap: numeric(row, "budget_cap"),
    destination_datetime: text(row, "destination_datetime"),
    destination_place: text(row, "destination_place"),
    type_of_content: text(row, "type_of_content"),
    weight: numeric(row, "weight"),
    measures: text(row, "measures"),
    pickup_address: text(row, "pickup_address"),
    pickup_datetime: text(row, "pickup_datetime"),
    created_at: text(row, "created_at"),
    updated_at: text(row, "updated_at")
  };
}

function text(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  if (typeof value !== "string") throw new Error(`Invalid mandate ${key}`);
  return value;
}

function numeric(row: Record<string, unknown>, key: string): number {
  const value = Number(row[key]);
  if (!Number.isFinite(value)) throw new Error(`Invalid mandate ${key}`);
  return value;
}
