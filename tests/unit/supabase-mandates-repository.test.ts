import { expect, it } from "vitest";

import {
  createSupabaseMandatesRepository,
  type SupabaseMandatesClient
} from "../../src/core/mandates/supabase-repository";

it("maps the Supabase mandate row to the core record", async () => {
  const repository = createSupabaseMandatesRepository({
    from: () => ({
      insert: () => ({
        select: () => ({
          single: async () => ({
            data: {
              id: "d7051c6d-1111-4444-9999-0f74ae7999f7",
              budget_cap: "8700.50",
              destination_datetime: "2026-09-04T00:00:00+00:00",
              destination_place: "Guadalajara",
              type_of_content: "Textiles",
              weight: "18400.000",
              measures: "120 x 100 x 110 cm",
              pickup_address: "Manzanillo",
              pickup_datetime: "2026-09-03T16:00:00+00:00",
              created_at: "2026-09-01T15:00:00+00:00",
              updated_at: "2026-09-01T15:00:00+00:00"
            },
            error: null
          })
        })
      })
    })
  } as unknown as SupabaseMandatesClient);

  await expect(
    repository.create({
      budget_cap: 8700.5,
      destination_datetime: "2026-09-03T18:00:00-06:00",
      destination_place: "Guadalajara",
      type_of_content: "Textiles",
      weight: 18400,
      measures: "120 x 100 x 110 cm",
      pickup_address: "Manzanillo",
      pickup_datetime: "2026-09-03T10:00:00-06:00"
    })
  ).resolves.toMatchObject({ budget_cap: 8700.5, weight: 18400 });
});
