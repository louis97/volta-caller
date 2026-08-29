import { THURSDAY_PICKUP, seedOperation } from "../../src/core/seed";
import { expect, it } from "vitest";

it("seeds three carrier candidates under one Textiles Pacífico operation", () => {
  const operation = seedOperation();

  expect(operation.containerId).toBe("MSCU-TP-001");
  expect(operation.mandate.maxPriceMxn).toBe(9000);
  expect(operation.candidates).toHaveLength(3);
  expect(operation.mandate.pickupTime).toBe(THURSDAY_PICKUP);
});
