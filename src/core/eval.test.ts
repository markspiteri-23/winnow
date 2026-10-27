import path from "node:path";
import { describe, expect, it } from "vitest";
import { evaluate, regressions, validateLabels, type EvalRun, type LabelsFile } from "./eval.ts";
import type { Shot, VerdictKind } from "./types.ts";

const root = path.resolve("fixtures");
const at = (...p: string[]): string => path.join(root, ...p);

function shot(id: string, ...extra: string[]): Shot {
  const files = [id, ...extra].map((p) => ({ path: p, kind: p.toLowerCase().endsWith(".arw") ? ("raw" as const) : ("jpeg" as const) }));
  return { id, files, captureDate: null, cameraModel: null, iso: null, orientation: null, width: null, height: null, lowConfidence: false };
}

/** One run: groups given as lists of [file, verdict]. */
function run(...groups: [Shot, VerdictKind][][]): EvalRun {
  return {
    shots: groups.flat().map(([s]) => s),
    groups: groups.map((g, i) => ({ id: `g${i}`, shotIDs: g.map(([s]) => s.id), bestID: null })),
    verdicts: groups.flatMap((g, i) => g.map(([s, v]) => ({ shotId: s.id, groupId: `g${i}`, verdict: v, score: 0, reasons: ["test"] }))),
  };
}

describe("validateLabels", () => {
  it("accepts a valid file and rejects bad entries", () => {
    expect(validateLabels({ photos: { "a/b.jpg": { label: "pick", set: "tune" } } }).photos["a/b.jpg"]?.label).toBe("pick");
    expect(() => validateLabels({})).toThrow(/photos/);
    expect(() => validateLabels({ photos: { x: { label: "keep", set: "tune" } } })).toThrow(/label/);
    expect(() => validateLabels({ photos: { x: { label: "pick" } } })).toThrow(/set/);
  });
});

describe("evaluate", () => {
  const a = shot(at("burst", "A.ARW"), at("burst", "a.jpg"));
  const b = shot(at("burst", "B.ARW"));
  const c = shot(at("burst", "C.ARW"));
  const single = shot(at("burst", "S.ARW"));
  const runs = [run([[a, "pick"], [b, "reject"], [c, "reject"]], [[single, "none"]])];

  it("counts caught rejects, surfaced picks and false rejects per set", () => {
    const labels: LabelsFile = {
      photos: {
        "burst/A.jpg": { label: "pick", set: "tune" }, // JPEG half of a pair resolves to the shot; case-insensitive
        "burst/B.ARW": { label: "reject", set: "tune" },
        "burst/C.ARW": { label: "pick", set: "holdout" }, // a loved photo rejected
        "burst/S.ARW": { label: "pick", set: "holdout" }, // alone in its group: surfaced
        "burst/gone.ARW": { label: "reject", set: "holdout" },
      },
    };
    const r = evaluate(labels, root, runs);
    expect(r.tune).toMatchObject({ labelled: 2, rejects: { total: 1, caught: 1, rate: 1 }, picks: { total: 1, surfaced: 1, rate: 1 } });
    expect(r.tune.falseRejects.count).toBe(0);
    expect(r.holdout.picks).toEqual({ total: 2, surfaced: 1, rate: 0.5 });
    expect(r.holdout.rejects).toEqual({ total: 1, caught: 0, rate: 0 });
    expect(r.holdout.falseRejects).toEqual({ count: 1, ofPicks: 1, shots: ["burst/C.ARW"] });
    expect(r.holdout.missing).toEqual(["burst/gone.ARW"]);
  });

  it("does not count a non-best pick in a multi-frame group as surfaced", () => {
    const r = evaluate({ photos: { "burst/B.ARW": { label: "pick", set: "tune" } } }, root, [run([[a, "pick"], [b, "none"]])]);
    expect(r.tune.picks.surfaced).toBe(0);
    expect(r.tune.falseRejects.count).toBe(0);
  });
});

describe("regressions", () => {
  const base = evaluate({ photos: { "x/A.ARW": { label: "pick", set: "holdout" } } }, root, [run([[shot(at("x", "A.ARW")), "none"]])]).holdout;
  const tol = { rateDrop: 0.05, falseRejects: 0 };

  it("passes when nothing got worse and fails on any new false reject or a rate drop", () => {
    expect(regressions(base, base, tol)).toEqual([]);
    const worse = { ...base, picks: { total: 1, surfaced: 0, rate: 0 }, falseRejects: { count: 1, ofPicks: 1, shots: ["x/A.ARW"] } };
    const found = regressions(worse, base, tol);
    expect(found).toHaveLength(2);
    expect(found[1]).toMatch(/false rejects: 1 vs baseline 0/);
  });
});
