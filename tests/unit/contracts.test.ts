import {
  THURSDAY_PICKUP,
  createOperationFromMandate,
  seedOperation
} from "../../src/core/seed";
import { expect, it } from "vitest";

it("seeds three carrier candidates under one Textiles Pacífico operation", () => {
  const operation = seedOperation();

  expect(operation.containerId).toBe("MSCU-TP-001");
  expect(operation.mandate.budgetCapMxn).toBe(9000);
  expect(operation.candidates).toHaveLength(3);
  expect(operation.mandate.pickupDatetime).toBe(THURSDAY_PICKUP);
});

it("maps the dashboard manifest into the canonical operation mandate", () => {
  const operation = createOperationFromMandate(
    {
      budget_cap: 9000,
      destination_datetime: "2026-09-03T18:00:00-06:00",
      destination_place: "Textiles Pacífico, Guadalajara, Jalisco",
      type_of_content: "Textiles",
      weight: 18400,
      measures: "120 × 100 × 110 cm",
      pickup_address: "Terminal de Contenedores, Manzanillo, Colima",
      pickup_datetime: THURSDAY_PICKUP
    },
    "operation-mandate-1"
  );

  expect(operation).toMatchObject({
    id: "operation-mandate-1",
    origin: "Terminal de Contenedores, Manzanillo, Colima",
    destination: "Textiles Pacífico, Guadalajara, Jalisco",
    mandate: {
      budgetCapMxn: 9000,
      pickupDatetime: THURSDAY_PICKUP,
      weightKg: 18400
    }
  });
});
