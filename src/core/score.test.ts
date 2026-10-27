import { describe, expect, it } from "vitest";
import type { ShotFaces } from "./faces.ts";
import type { Group } from "./group.ts";
import { scoreGroups, type ScoreMetrics } from "./score.ts";
import { weight } from "./weights.ts";

const THUMB = Array.from({ length: 256 }, (_, i) => ((i * 37) % 17) - 8);
const OTHER = Array.from({ length: 256 }, (_, i) => ((i * 11) % 7) - 3);

function m(shotId: string, sharpness: number, opts: { clip?: number; shadows?: number; thumb?: number[]; low?: boolean } = {}): ScoreMetrics {
  return {
    shotId,
    sharpness,
    exposure: { highlightsPct: opts.clip ?? 0, shadowsPct: opts.shadows ?? 0, meanLuma: 120 },
    thumb: opts.thumb ?? THUMB,
    lowConfidence: opts.low ?? false,
  };
}
const group = (...ids: string[]): Group => ({ id: "g1", shotIDs: ids, bestID: null });
const run = (ms: ScoreMetrics[], faces?: Map<string, ShotFaces>) => {
  const g = group(...ms.map((x) => x.shotId));
  const verdicts = scoreGroups([g], new Map(ms.map((x) => [x.shotId, x])), faces);
  return { g, v: new Map(verdicts.map((x) => [x.shotId, x])) };
};

describe("scoreGroups", () => {
  it("picks the sharpest frame and rejects one far softer than it", () => {
    const ratio = weight("blurRejectRatio");
    const { g, v } = run([m("a", 100), m("b", 100 * (ratio - 0.05)), m("c", 85)]);
    expect(g.bestID).toBe("a");
    expect(v.get("a")).toMatchObject({ verdict: "pick" });
    expect(v.get("b")).toMatchObject({ verdict: "reject", reasons: [expect.stringMatching(/^blurry/)] });
    expect(v.get("c")).toMatchObject({ verdict: "none" });
    for (const x of v.values()) expect(x.reasons.length).toBeGreaterThan(0);
  });

  it("does not blur-reject a low-confidence preview or a differently framed frame", () => {
    const { v } = run([m("a", 100), m("low", 20, { low: true }), m("other", 20, { thumb: OTHER })]);
    expect(v.get("low")).toMatchObject({ verdict: "none", reasons: expect.arrayContaining([expect.stringMatching(/preview too small/)]) });
    expect(v.get("other")).toMatchObject({ verdict: "none", reasons: expect.arrayContaining([expect.stringMatching(/framing differs/)]) });
  });

  it("rejects heavy clipping only when a sibling is better exposed", () => {
    const pct = weight("clipRejectPct");
    expect(run([m("a", 100, { clip: pct + 5 }), m("b", 99, { clip: 2 })]).v.get("a")?.verdict).toBe("reject");
    expect(run([m("a", 100, { shadows: pct + 5 }), m("b", 99, { shadows: pct })]).v.get("a")?.verdict).not.toBe("reject");
    const single = run([m("solo", 100, { clip: 90 })]).v.get("solo");
    expect(single).toMatchObject({ verdict: "none", reasons: expect.arrayContaining([expect.stringMatching(/single shot/)]) });
  });

  it("rejects a blink only when the same person has open eyes in another frame", () => {
    const blink = (shotId: string, vsSibling: boolean): ShotFaces =>
      ({ shotId, faces: [], ignored: [], faceCount: 1, allEyesOpen: false, anyEyesClosed: true, blinkVsSibling: vsSibling, reasons: ["1 of 1 faces with eyes closed"] });
    expect(run([m("a", 100), m("b", 100)], new Map([["b", blink("b", true)]])).v.get("b")?.verdict).toBe("reject");
    const kept = run([m("a", 100), m("b", 100)], new Map([["b", blink("b", false)]])).v.get("b");
    expect(kept?.verdict).toBe("none");
  });

  it("never rejects every frame of a group", () => {
    const pct = weight("clipRejectPct");
    const faces = new Map<string, ShotFaces>([
      ["b", { shotId: "b", faces: [], ignored: [], faceCount: 1, allEyesOpen: false, anyEyesClosed: true, blinkVsSibling: true, reasons: [] }],
    ]);
    // a: badly exposed vs b; b: blink vs a.
    const { v } = run([m("a", 100, { clip: pct + 10 }), m("b", 100, { clip: 1 })], faces);
    expect([...v.values()].filter((x) => x.verdict === "reject")).toHaveLength(1);
    expect([...v.values()].filter((x) => x.verdict === "pick")).toHaveLength(1);
  });

  it("keeps singles and unanalysed shots, never picks or rejects them", () => {
    const g = group("x", "y");
    const verdicts = scoreGroups([g, { id: "g2", shotIDs: ["z"], bestID: null }], new Map([["y", m("y", 50)], ["z", m("z", 5)]]));
    expect(verdicts.map((x) => [x.shotId, x.verdict])).toEqual([["x", "none"], ["y", "none"], ["z", "none"]]);
    expect(verdicts[0]?.reasons).toEqual(["not analysed: kept"]);
  });
});
