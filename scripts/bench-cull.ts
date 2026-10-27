// Times `cull` cold (empty cache) and warm on N generated 1600x1067 JPEGs. Usage: npx tsx scripts/bench-cull.ts [count] [concurrency ...]
// 20 distinct textured scenes, copied round-robin; each scene's copies share a timestamp, so they also exercise grouping.
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
import path from "node:path";
import { ExifTool } from "exiftool-vendored";
import sharp from "sharp";
import { MetricsCache } from "../src/core/cache.ts";
import { cull } from "../src/core/cull.ts";
import { defaultConcurrency } from "../src/core/pool.ts";

const count = Number(process.argv[2] ?? 2000);
const levels = process.argv.length > 3 ? process.argv.slice(3).map(Number) : [defaultConcurrency()];
const dir = mkdtempSync(path.join(tmpdir(), "faucet-bench-cull-"));
const photos = path.join(dir, "photos");
mkdirSync(photos);
const et = new ExifTool();
try {
  const seeds: string[] = [];
  for (let s = 0; s < 20; s++) {
    const file = path.join(dir, `seed-${s}.jpg`);
    const noise = await sharp({ create: { width: 1600, height: 1067, channels: 3, background: "#777", noise: { type: "gaussian", mean: 120, sigma: 40 + s } } }).png().toBuffer();
    await sharp(noise).blur(s % 4 === 0 ? 4 : 0.5).jpeg().toFile(file);
    await et.write(file, { DateTimeOriginal: `2024:05:01 10:${String(s).padStart(2, "0")}:00`, Model: "Bench", ISO: 100 }, { writeArgs: ["-overwrite_original"] });
    seeds.push(file);
  }
  for (let i = 0; i < count; i++) copyFileSync(seeds[i % seeds.length]!, path.join(photos, `IMG_${String(i).padStart(5, "0")}.jpg`));
  console.log(`${count} files, ${availableParallelism()} CPUs`);
  for (const concurrency of levels) {
    const work = path.join(dir, `work-${concurrency}`);
    const opts = { cache: new MetricsCache(path.join(work, "metrics")), previewRoot: work, concurrency };
    const cold = await cull(photos, et, opts);
    const warm = await cull(photos, et, opts);
    const ms = (s: number): string => `${s.toFixed(1)}s (${((s * 1000) / count).toFixed(1)} ms/shot)`;
    console.log(`concurrency ${concurrency}: cold ${ms(cold.stats.seconds)}, warm ${ms(warm.stats.seconds)} [${warm.stats.cached} cached], ${cold.errors.length} errors`);
  }
} finally {
  await et.end();
  rmSync(dir, { recursive: true, force: true });
}
