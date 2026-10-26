import weightsJson from "../../weights.json" with { type: "json" };

export interface Weight {
  value: number;
  calibratedOn: string;
}

export interface WeightsFile {
  values: Record<string, Weight>;
}

/** Throws unless every entry has a numeric `value` and a non-empty `calibratedOn` note. */
export function validateWeights(data: unknown): WeightsFile {
  if (typeof data !== "object" || data === null || !("values" in data)) {
    throw new Error("weights: missing 'values' object");
  }
  const values = (data as { values: unknown }).values;
  if (typeof values !== "object" || values === null || Array.isArray(values)) {
    throw new Error("weights: 'values' must be an object");
  }
  for (const [key, entry] of Object.entries(values)) {
    const e = entry as Partial<Weight> | null;
    if (typeof e?.value !== "number" || !Number.isFinite(e.value)) {
      throw new Error(`weights: '${key}' needs a finite numeric 'value'`);
    }
    if (typeof e.calibratedOn !== "string" || e.calibratedOn.trim() === "") {
      throw new Error(`weights: '${key}' needs a 'calibratedOn' note`);
    }
  }
  return { values: values as Record<string, Weight> };
}

const loaded = validateWeights(weightsJson);

/** Value of a named weight from weights.json; throws if it is missing. */
export function weight(name: string): number {
  const w = loaded.values[name];
  if (!w) throw new Error(`weights: no entry '${name}'`);
  return w.value;
}
