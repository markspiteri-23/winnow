import { describe, expect, it } from "vitest";
import { fileNumber, groupShots, wallClockMs, type GroupMetrics } from "./group.ts";
import { layoutThumb, similarity } from "./metrics.ts";
import type { Shot } from "./types.ts";

const W = 160;
const H = 120;

// Seeded PRNG so the generated scenes are identical on every OS.
function rng(seed: number): () => number {
  return () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
}

/** Random blocky scene; `shift` moves it sideways a little, like a burst frame with slight camera motion. */
function scene(seed: number, shift = 0, w = W, h = H): GroupMetrics {
  const rand = rng(seed);
  const luma = new Float32Array(w * h).fill(100);
  for (let k = 0; k < 12; k++) {
    const bw = 10 + Math.floor(rand() * 50);
    const bh = 10 + Math.floor(rand() * 40);
    const x0 = Math.floor(rand() * (w - bw));
    const y0 = Math.floor(rand() * (h - bh));
    const v = Math.floor(rand() * 255);
    for (let y = y0; y < y0 + bh; y++) for (let x = x0 + shift; x < Math.min(w, x0 + bw + shift); x++) luma[y * w + x] = v;
  }
  return { thumb: layoutThumb(luma, w, h), width: w, height: h };
}

function shot(id: string, captureDate: string | null, cameraModel = "ILCE-6000"): Shot {
  return { id, files: [{ path: id, kind: "raw" }], captureDate, cameraModel, iso: 100, orientation: 1, width: 6000, height: 4000, lowConfidence: false };
}

const t = (s: number): string => `2026-07-19T12:00:${String(s).padStart(2, "0")}.000`;

describe("groupShots", () => {
  it("groups a burst, keeps a different scene and a later shot of the same scene apart", () => {
    const shots = [shot("a1.ARW", t(0)), shot("a2.ARW", t(0)), shot("a3.ARW", t(1)), shot("b1.ARW", t(3)), shot("a4.ARW", "2026-07-19T12:05:00.000")];
    const m = new Map<string, GroupMetrics>([
      ["a1.ARW", scene(1)], ["a2.ARW", scene(1, 2)], ["a3.ARW", scene(1, 4)], ["b1.ARW", scene(2)], ["a4.ARW", scene(1)],
    ]);
    const { groups, links } = groupShots(shots, m);
    expect(groups.map((g) => g.shotIDs)).toEqual([["a1.ARW", "a2.ARW", "a3.ARW"], ["b1.ARW"], ["a4.ARW"]]);
    expect(links.find((l) => l.to === "b1.ARW")?.reason).toMatch(/different layout/);
    expect(links.find((l) => l.to === "a4.ARW")?.reason).toMatch(/apart > /);
  });

  it("orders by sub-second time, not by name", () => {
    const shots = [shot("x2.ARW", "2026-07-19T12:00:00.500"), shot("x1.ARW", "2026-07-19T12:00:00.100")];
    const m = new Map([["x1.ARW", scene(5)], ["x2.ARW", scene(5, 1)]]);
    expect(groupShots(shots, m).groups[0]!.shotIDs).toEqual(["x1.ARW", "x2.ARW"]);
  });

  it("splits landscape from portrait even with similar content", () => {
    const shots = [shot("p1.ARW", t(0)), shot("p2.ARW", t(1))];
    const m = new Map([["p1.ARW", scene(3)], ["p2.ARW", scene(3, 0, H, W)]]);
    const { groups, links } = groupShots(shots, m);
    expect(groups).toHaveLength(2);
    expect(links[0]!.reason).toBe("landscape vs portrait");
  });

  it("falls back to consecutive file numbers when dates are missing", () => {
    const shots = [shot("IMG_0101.ARW", null), shot("IMG_0102.ARW", null), shot("IMG_0105.ARW", null)];
    const m = new Map([["IMG_0101.ARW", scene(4)], ["IMG_0102.ARW", scene(4, 2)], ["IMG_0105.ARW", scene(4, 3)]]);
    expect(groupShots(shots, m).groups.map((g) => g.shotIDs)).toEqual([["IMG_0101.ARW", "IMG_0102.ARW"], ["IMG_0105.ARW"]]);
  });

  it("applies per-camera clock offsets for multi-camera shoots", () => {
    const shots = [shot("c1.ARW", t(0), "A"), shot("c2.ARW", "2026-07-19T13:00:01.000", "B")];
    const m = new Map([["c1.ARW", scene(6)], ["c2.ARW", scene(6, 1)]]);
    expect(groupShots(shots, m).groups).toHaveLength(2);
    expect(groupShots(shots, m, { cameraOffsets: { B: -3600 } }).groups).toHaveLength(1);
  });

  it("keeps a RAW+JPEG pair as one shot in one group, and an unanalysed shot alone", () => {
    const pair: Shot = { ...shot("p.ARW", t(0)), files: [{ path: "p.ARW", kind: "raw" }, { path: "p.jpg", kind: "jpeg" }] };
    const { groups, links } = groupShots([pair, shot("q.ARW", t(0))], new Map([["p.ARW", scene(7)]]));
    expect(groups.map((g) => g.shotIDs)).toEqual([["p.ARW"], ["q.ARW"]]);
    expect(links[0]!.reason).toBe("not analysed");
  });
});

describe("helpers", () => {
  it("compares wall-clock time whether or not an offset was recorded", () => {
    expect(wallClockMs("2026-07-19T12:02:40.000+01:00")).toBe(wallClockMs("2026-07-19T12:02:40.000"));
    expect(wallClockMs("garbage")).toBeNull();
  });

  it("reads the trailing file number", () => {
    expect(fileNumber("DSC09876.ARW")).toBe(9876);
    expect(fileNumber("Test.ARW")).toBeNull();
  });

  it("rates a flat frame as dissimilar to everything", () => {
    const flat = layoutThumb(new Float32Array(W * H).fill(50), W, H);
    expect(similarity(flat, scene(1).thumb)).toBe(0);
  });
});
