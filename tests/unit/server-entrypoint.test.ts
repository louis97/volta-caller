import { pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

import { isMainModule } from "../../src/server";

describe("isMainModule", () => {
  it("recognizes a Windows entrypoint path", () => {
    expect(
      isMainModule(
        pathToFileURL("C:\\repo\\src\\server.ts").href,
        "C:\\repo\\src\\server.ts"
      )
    ).toBe(true);
  });
});
