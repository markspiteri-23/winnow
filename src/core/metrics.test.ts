import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hamming, measureShot, measureShots, type Metrics } from "./metrics.ts";

const tmp = mkdtempSync(path.join(tmpdir(), "faucet-metrics-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const W = 1200;
const H = 800;

// Seeded PRNG so the generated images are identical on every OS.
function rng(seed: number): () => number {
  return () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
}

/** Hard-edged grey blocks on a mid background: lots of crisp detail. */
function scene(): Buffer {
  const buf = Buffer.alloc(W * H, 120);
  const rand = rng(7);
  for (let k = 0; k < 400; k++) {
    const bw = 10 + Math.floor(rand() * 80);
    const bh = 10 + Math.floor(rand() * 80);
    const x0 = Math.floor(rand() * (W - bw));
    const y0 = Math.floor(rand() * (H - bh));
    const v = 30 + Math.floor(rand() * 190);
    for (let y = y0; y < y0 + bh; y++) buf.fill(v, y * W + x0, y * W + x0 + bw);
  }
  return buf;
}

function addNoise(buf: Buffer, sigma: number): Buffer {
  const rand = rng(99);
  const out = Buffer.alloc(buf.length);
  for (let i = 0; i < buf.length; i++) {
    const g = Math.sqrt(-2 * Math.log(rand() || 1e-9)) * Math.cos(2 * Math.PI * rand());
    out[i] = Math.max(0, Math.min(255, Math.round(buf[i]! + g * sigma)));
  }
  return out;
}

const raw = { width: W, height: H, channels: 1 as const };

async function save(name: string, buf: Buffer): Promise<string> {
  const file = path.join(tmp, name);
  await sharp(buf, { raw }).png().toFile(file);
  return file;
}

async function measure(file: string): Promise<Metrics> {
  return measureShot({ shotId: file, path: file, orientation: 1, lowConfidence: false });
}

describe("sharpness", () => {
  let sharpM: Metrics;
  let blurredM: Metrics;
  let noisyM: Metrics;

  beforeAll(async () => {
    const base = scene();
    const blurred = await sharp(base, { raw }).blur(4).raw().toBuffer();
    sharpM = await measure(await save("sharp.png", base));
    blurredM = await measure(await save("blurred.png", blurred));
    noisyM = await measure(await save("blurred-noisy.png", addNoise(blurred, 12)));
  });

  it("ranks sharp > blurred", () => {
    expect(sharpM.sharpness).toBeGreaterThan(blurredM.sharpness);
  });

  it("ranks sharp > blurred + noisy, and noise does not lift a blurred frame", () => {
    expect(sharpM.sharpness).toBeGreaterThan(noisyM.sharpness);
    expect(noisyM.sharpnessRaw).toBeGreaterThan(noisyM.sharpness);
    expect(noisyM.sharpness).toBeLessThan(blurredM.sharpness * 1.5);
  });

  it("estimates noise close to the added sigma", () => {
    expect(blurredM.noise).toBeLessThan(2);
    // The block edges are blurred away first; downscale to 1024 averages a little noise out.
    expect(noisyM.noise).toBeGreaterThan(7);
    expect(noisyM.noise).toBeLessThan(14);
  });

  it("analyses a downscaled image", () => {
    expect(Math.max(sharpM.width, sharpM.height)).toBe(1024);
  });
});

describe("hash", () => {
  it("keeps near-duplicates close and different scenes far apart", async () => {
    const base = scene();
    const a = await measure(await save("h-a.png", base));
    const noisy = await measure(await save("h-noisy.png", addNoise(base, 6)));
    const flipped = await measure(await save("h-flip.png", await sharp(base, { raw }).flop().raw().toBuffer()));
    expect(a.hash).toMatch(/^[0-9a-f]{16}$/);
    expect(hamming(a.hash, a.hash)).toBe(0);
    expect(hamming(a.hash, noisy.hash)).toBeLessThanOrEqual(4);
    expect(hamming(a.hash, flipped.hash)).toBeGreaterThan(16);
  });
});

describe("exposure", () => {
  const flat = async (name: string, v: number): Promise<Metrics> => measure(await save(name, Buffer.alloc(W * H, v)));

  it("reports crushed shadows, clipped highlights and mean luma", async () => {
    const black = await flat("black.png", 0);
    const white = await flat("white.png", 255);
    const grey = await flat("grey.png", 128);
    expect(black.exposure).toEqual({ shadowsPct: 100, highlightsPct: 0, meanLuma: 0 });
    expect(white.exposure).toEqual({ shadowsPct: 0, highlightsPct: 100, meanLuma: 255 });
    expect(grey.exposure).toEqual({ shadowsPct: 0, highlightsPct: 0, meanLuma: 128 });
  });

  it("measures a half-clipped frame", async () => {
    const buf = Buffer.alloc(W * H, 128);
    buf.fill(255, 0, (W * H) / 2);
    const m = await measure(await save("half.png", buf));
    expect(m.exposure.highlightsPct).toBeCloseTo(50, 0);
  });
});

describe("measureShots", () => {
  it("records a bad file and keeps going", async () => {
    const good = await save("ok.png", scene());
    const bad = path.join(tmp, "missing.jpg");
    const res = await measureShots([
      { shotId: bad, path: bad, orientation: null, lowConfidence: false },
      { shotId: good, path: good, orientation: null, lowConfidence: true },
    ]);
    expect(res.errors.map((e) => e.path)).toEqual([bad]);
    expect(res.metrics).toHaveLength(1);
    expect(res.metrics[0]!.lowConfidence).toBe(true);
  });
});

// Real-photo check: only when $FAUCET_FIXTURES is set (never in CI). Variants come from scripts/make-fixtures.ts.
const fixtures = process.env.FAUCET_FIXTURES;
const manifestPath = path.join(fixtures ?? "", "generated", "manifest.json");
describe.skipIf(!fixtures || !existsSync(manifestPath))("real-photo blur variants", () => {
  it("ranks every sharp frame of a scene above every blurry one (incl. dark noisy night)", async () => {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { source: string; file: string; label: string }[];
    const bySource = new Map<string, { file: string; label: string; sharpness: number }[]>();
    for (const m of manifest) {
      const file = path.join(path.dirname(manifestPath), m.file);
      const { sharpness } = await measure(file);
      bySource.set(m.source, [...(bySource.get(m.source) ?? []), { file: m.file, label: m.label, sharpness }]);
    }
    for (const [source, frames] of bySource) {
      const minSharp = Math.min(...frames.filter((f) => f.label === "sharp").map((f) => f.sharpness));
      const blurry = frames.filter((f) => f.label === "blurry");
      for (const f of blurry) expect(f.sharpness, `${source}: ${f.file}`).toBeLessThan(minSharp);
    }
  }, 120_000);
});
