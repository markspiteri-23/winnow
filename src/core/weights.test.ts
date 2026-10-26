import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { validateWeights } from "./weights.ts";

describe("validateWeights", () => {
  it("accepts the committed weights.json", () => {
    const file = fileURLToPath(new URL("../../weights.json", import.meta.url));
    expect(() => validateWeights(JSON.parse(readFileSync(file, "utf8")))).not.toThrow();
  });

  it("rejects an entry without calibratedOn", () => {
    expect(() => validateWeights({ values: { blur: { value: 1 } } })).toThrow(/calibratedOn/);
  });

  it("rejects a non-numeric value", () => {
    expect(() => validateWeights({ values: { blur: { value: "x", calibratedOn: "set A" } } })).toThrow(/value/);
  });
});
