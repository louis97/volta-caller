import { describe, expect, it } from "vitest";

import {
  CENTRAL_BRAIN_INSTRUCTIONS,
  MAX_CONVERSATION_HISTORY
} from "../../src/agent/operationalAgent";

describe("central brain mandate intake", () => {
  it("uses the same eight required fields as CreateMandateRequest", () => {
    for (const field of [
      "presupuesto máximo en MXN",
      "fecha y hora de entrega",
      "lugar de entrega",
      "tipo de contenido",
      "peso en kg",
      "medidas",
      "dirección de recolección",
      "fecha y hora de recolección"
    ]) {
      expect(CENTRAL_BRAIN_INSTRUCTIONS).toContain(field);
    }
    expect(CENTRAL_BRAIN_INSTRUCTIONS).toContain(
      "pregunta solo por campos faltantes o ambiguos"
    );
    expect(CENTRAL_BRAIN_INSTRUCTIONS).toContain("no exijas BL, booking, DO");
  });

  it("retains enough conversation turns to finish a voice intake", () => {
    expect(MAX_CONVERSATION_HISTORY).toBeGreaterThanOrEqual(16);
  });
});
