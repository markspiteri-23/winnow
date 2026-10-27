import { describe, expect, it } from "vitest";
import { compareFaces, measureFaces, regionSharpness, type Box, type DetectedFace, type Luma } from "./faces.ts";
import type { Group } from "./group.ts";
import { weight } from "./weights.ts";

const W = 400;
const H = 300;

// Seeded PRNG so the generated images are identical on every OS.
function rng(seed: number): () => number {
  return () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
}

/** Random texture everywhere (std dev ~70), so eye regions read as visible unless painted over. */
function textured(seed = 1): Luma {
  const rand = rng(seed);
  const data = new Float32Array(W * H);
  for (let i = 0; i < data.length; i++) data[i] = 20 + rand() * 220;
  return { data, width: W, height: H };
}

function paint(img: Luma, b: Box, value: number): void {
  for (let y = Math.floor(b.y * H); y < Math.ceil((b.y + b.h) * H); y++) {
    for (let x = Math.floor(b.x * W); x < Math.ceil((b.x + b.w) * W); x++) img.data[y * W + x] = value;
  }
}

/** A face of `px` x `px * aspect` pixels at (x, y) px, eyes in the upper half. */
function face(x: number, y: number, px: number, opts: Partial<DetectedFace> & { aspect?: number; eyeWidths?: [number, number] } = {}): DetectedFace {
  const w = px / W;
  const h = (px * (opts.aspect ?? 1.1)) / H;
  const [lw, rw] = opts.eyeWidths ?? [0.25, 0.25];
  const bx = x / W;
  const by = y / H;
  return {
    box: { x: bx, y: by, w, h },
    pass: opts.pass ?? "full",
    eyeBlinkLeft: opts.eyeBlinkLeft ?? 0.05,
    eyeBlinkRight: opts.eyeBlinkRight ?? 0.05,
    rightEye: opts.rightEye ?? { x: bx + 0.15 * w, y: by + 0.35 * h, w: rw * w, h: 0.1 * h },
    leftEye: opts.leftEye ?? { x: bx + 0.6 * w, y: by + 0.35 * h, w: lw * w, h: 0.1 * h },
  };
}

const eyes = (d: DetectedFace[], img = textured()) => measureFaces(d, img).faces.map((f) => f.eyes);

describe("measureFaces", () => {
  it("reads open, closed and in-between eyes with the calibrated cut-offs", () => {
    const open = weight("eyeOpenMaxBlink");
    const closed = weight("eyeClosedMinBlink");
    expect(eyes([face(20, 20, 120, { eyeBlinkLeft: open, eyeBlinkRight: 0.9 })])).toEqual(["open"]); // the less-closed eye decides
    expect(eyes([face(20, 20, 120, { eyeBlinkLeft: closed, eyeBlinkRight: 0.95 })])).toEqual(["closed"]);
    expect(eyes([face(20, 20, 120, { eyeBlinkLeft: (open + closed) / 2, eyeBlinkRight: 0.95 })])).toEqual(["unknown"]);
  });

  it("never calls a turned face closed", () => {
    const d = face(20, 20, 120, { eyeBlinkLeft: 0.9, eyeBlinkRight: 0.9, eyeWidths: [0.25, 0.1] });
    const [f] = measureFaces([d], textured()).faces;
    expect(f?.eyes).toBe("unknown");
    expect(f?.reasons.join()).toMatch(/turned/);
  });

  it("calls hidden or glared eyes unknown, even when they read closed", () => {
    const d = face(20, 20, 120, { eyeBlinkLeft: 0.9, eyeBlinkRight: 0.9 });
    const shades = textured();
    paint(shades, d.leftEye, 15);
    paint(shades, d.rightEye, 15);
    const glare = textured();
    paint(glare, d.leftEye, 255);
    paint(glare, d.rightEye, 255);
    expect(eyes([d], shades)).toEqual(["unknown"]);
    expect(eyes([d], glare)).toEqual(["unknown"]);
    expect(measureFaces([d], shades).faces[0]?.reasons.join()).toMatch(/sunglasses/);
    expect(measureFaces([d], glare).faces[0]?.reasons.join()).toMatch(/glare/);
  });

  it("ignores tiny faces and wide small-face detections, keeps wide full-frame faces", () => {
    const tiny = face(10, 10, weight("faceMinSizePx") - 5);
    const wideTile = face(150, 10, 60, { pass: "tile", aspect: 0.85 });
    const wideFull = face(250, 10, 60, { pass: "full", aspect: 0.85 });
    const r = measureFaces([tiny, wideTile, wideFull], textured());
    expect(r.faces.map((f) => f.box)).toEqual([wideFull.box]);
    expect(r.ignored.map((i) => i.reason)).toEqual([expect.stringMatching(/px </), expect.stringMatching(/aspect/)]);
  });

  it("measures face-region sharpness: texture beats a flat patch", () => {
    const img = textured();
    const flat: Box = { x: 0.5, y: 0.5, w: 0.2, h: 0.2 };
    paint(img, flat, 128);
    expect(regionSharpness(img, { x: 0.1, y: 0.1, w: 0.2, h: 0.2 })).toBeGreaterThan(100);
    expect(regionSharpness(img, { x: 0.52, y: 0.52, w: 0.16, h: 0.16 })).toBe(0);
  });
});

function shot(shotId: string, detected: DetectedFace[]) {
  return { shotId, ...measureFaces(detected, textured()) };
}
const group = (...ids: string[]): Group => ({ id: ids[0]!, shotIDs: ids, bestID: null });
const closedFace = (x: number, y: number) => face(x, y, 100, { eyeBlinkLeft: 0.9, eyeBlinkRight: 0.92 });

describe("compareFaces", () => {
  it("flags a blink against the same person's open eyes in the burst, even when re-framed", () => {
    const r = compareFaces([group("a", "b")], [shot("a", [closedFace(200, 150)]), shot("b", [face(40, 20, 70)])]);
    const [a, b] = r;
    expect(a).toMatchObject({ faceCount: 1, anyEyesClosed: true, allEyesOpen: false, blinkVsSibling: true });
    expect(a?.faces[0]).toMatchObject({ person: "p1", siblingEyesOpen: 0.95 });
    expect(a?.faces[0]?.reasons.join()).toMatch(/open in b/);
    expect(b).toMatchObject({ allEyesOpen: true, anyEyesClosed: false, blinkVsSibling: false });
  });

  it("flags closed eyes but not a sibling blink when no frame has them open", () => {
    const [a] = compareFaces([group("a")], [shot("a", [closedFace(50, 50)])]);
    expect(a).toMatchObject({ anyEyesClosed: true, blinkVsSibling: false });
    expect(a?.faces[0]?.reasons.join()).toMatch(/no other frame/);
  });

  it("matches people by position in multi-face frames, whatever their order", () => {
    const left = (x: number, closed = false) => (closed ? closedFace(x, 40) : face(x, 40, 100));
    const right = (x: number) => face(x, 40, 100);
    const r = compareFaces(
      [group("a", "b")],
      [shot("a", [left(20, true), right(260)]), shot("b", [right(250), left(30)])],
    );
    const [a, b] = r;
    expect(a?.faces.map((f) => f.person)).toEqual(["p1", "p2"]);
    expect(b?.faces.map((f) => f.person)).toEqual(["p2", "p1"]);
    expect(a).toMatchObject({ faceCount: 2, anyEyesClosed: true, blinkVsSibling: true });
    expect(b).toMatchObject({ faceCount: 2, allEyesOpen: true });
  });

  it("does not compare faces that do not line up", () => {
    const r = compareFaces([group("a", "b")], [shot("a", [closedFace(10, 10), face(150, 10, 100)]), shot("b", [face(290, 190, 100)])]);
    expect(r[0]).toMatchObject({ anyEyesClosed: true, blinkVsSibling: false });
    expect(r[1]?.faces[0]?.person).toBe("p3");
  });

  it("leaves no-face shots unflagged", () => {
    const [a] = compareFaces([group("a")], [shot("a", [])]);
    expect(a).toMatchObject({ faceCount: 0, allEyesOpen: false, anyEyesClosed: false, blinkVsSibling: false, reasons: ["no faces"] });
  });
});
