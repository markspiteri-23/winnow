import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { exiftool } from "exiftool-vendored";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cacheKey, MetricsCache } from "./cache.ts";
import { cull, type CullOptions } from "./cull.ts";
import { measureInPool } from "./pool.ts";
import { scanFolder } from "./scan.ts";

const dir = mkdtempSync(path.join(tmpdir(), "faucet-cull-"));
const photos = path.join(dir, "photos");
const work = path.join(dir, "work");

// Seeded PRNG so the generated scenes are identical on every OS.
function rng(seed: number): () => number {
  return () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
}

/** Hard-edged random blocks: a burst frame. `blur` makes its out-of-focus sibling with the same layout. */
async function frame(file: string, seed: number, blur: number, date: string): Promise<void> {
  const w = 1200;
  const h = 900;
  const rand = rng(seed);
  const px = Buffer.alloc(w * h * 3, 110);
  for (let k = 0; k < 40; k++) {
    const bw = 20 + Math.floor(rand() * 200);
    const bh = 20 + Math.floor(rand() * 150);
    const x0 = Math.floor(rand() * (w - bw));
    const y0 = Math.floor(rand() * (h - bh));
    const v = Math.floor(rand() * 255);
    for (let y = y0; y < y0 + bh; y++) px.fill(v, (y * w + x0) * 3, (y * w + x0 + bw) * 3);
  }
  let img = sharp(px, { raw: { width: w, height: h, channels: 3 } });
  if (blur) img = img.blur(blur);
  await img.jpeg().toFile(file);
  await exiftool.write(file, { DateTimeOriginal: date, Model: "Test" }, { writeArgs: ["-overwrite_original"] });
}

const run = (opts: CullOptions = {}) =>
  cull(photos, exiftool, { cache: new MetricsCache(path.join(work, "metrics")), previewRoot: work, concurrency: 2, ...opts });

beforeAll(async () => {
  mkdirSync(photos, { recursive: true });
  await frame(path.join(photos, "IMG_0001.jpg"), 7, 0, "2024:05:01 10:00:00");
  await frame(path.join(photos, "IMG_0002.jpg"), 7, 6, "2024:05:01 10:00:01");
  await frame(path.join(photos, "IMG_0003.jpg"), 7, 0.6, "2024:05:01 10:00:02");
  await frame(path.join(photos, "IMG_0100.jpg"), 99, 0, "2024:05:01 12:00:00");
  writeFileSync(path.join(photos, "IMG_0200.jpg"), "not a jpeg");
}, 60_000);

afterAll(async () => {
  await exiftool.end();
  rmSync(dir, { recursive: true, force: true });
});

describe("cull", () => {
  it("picks the sharp frame, rejects the out-of-focus one, records the broken file", async () => {
    const r = await run();
    expect(r.cancelled).toBe(false);
    expect(r.stats).toMatchObject({ shots: 4, cached: 0, measured: 4 });
    const v = new Map(r.verdicts.map((x) => [path.basename(x.shotId), x]));
    expect(v.get("IMG_0001.jpg")?.verdict).toBe("pick");
    expect(v.get("IMG_0002.jpg")).toMatchObject({ verdict: "reject", reasons: [expect.stringMatching(/^blurry/)] });
    expect(v.get("IMG_0003.jpg")?.verdict).toBe("none");
    expect(v.get("IMG_0100.jpg")).toMatchObject({ verdict: "none", reasons: [expect.stringMatching(/single shot/)] });
    expect(r.errors.map((e) => path.basename(e.path))).toEqual(["IMG_0200.jpg"]);
  }, 60_000);

  it("second run comes from the cache with identical verdicts; a touched file is re-measured", async () => {
    const first = await run();
    const second = await run();
    expect(second.stats).toMatchObject({ cached: 4, measured: 0 });
    expect(second.verdicts).toEqual(first.verdicts);
    const touched = path.join(photos, "IMG_0003.jpg");
    utimesSync(touched, new Date(), new Date(Date.now() + 5000));
    expect((await run()).stats).toMatchObject({ cached: 3, measured: 1 });
  }, 60_000);

  it("cancel stops the run, keeps finished results cached, and a rerun resumes", async () => {
    const cacheDir = path.join(work, "cancel-metrics");
    const abort = new AbortController();
    const cancelled = await run({
      cache: new MetricsCache(cacheDir),
      concurrency: 1,
      signal: abort.signal,
      onProgress: (done) => {
        if (done >= 1) abort.abort();
      },
    });
    expect(cancelled.cancelled).toBe(true);
    expect(cancelled.verdicts).toEqual([]);
    const resumed = await run({ cache: new MetricsCache(cacheDir) });
    expect(resumed.cancelled).toBe(false);
    expect(resumed.stats.cached).toBeGreaterThanOrEqual(1);
    expect(resumed.stats.cached + resumed.stats.measured).toBe(4);
  }, 60_000);
});

describe("cache and pool", () => {
  it("cache key changes with size or mtime, and a corrupt entry is a miss", async () => {
    const scan = await scanFolder(photos, exiftool);
    const shot = scan.shots[0]!;
    const before = cacheKey(shot);
    utimesSync(shot.id, new Date(), new Date(Date.now() + 60_000));
    expect(cacheKey(shot)).not.toBe(before);
    const cache = new MetricsCache(path.join(work, "corrupt"));
    const file = path.join(cache.dir, cacheKey(shot).slice(0, 2), `${cacheKey(shot)}.json`);
      mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, "{ truncated");
    expect(cache.get(shot)).toBeNull();
  }, 60_000);

  it("pool records a failing input without aborting the others", async () => {
    const good = { shotId: "good", path: path.join(photos, "IMG_0001.jpg"), orientation: 1, lowConfidence: false };
    const bad = { shotId: "bad", path: path.join(photos, "IMG_0200.jpg"), orientation: 1, lowConfidence: false };
    const r = await measureInPool([bad, good, good], { concurrency: 2 });
    expect(r.cancelled).toBe(false);
    expect(r.metrics.map((m) => m.shotId)).toEqual(["good", "good"]);
    expect(r.errors.map((e) => e.path)).toEqual(["bad"]);
  }, 60_000);
});
