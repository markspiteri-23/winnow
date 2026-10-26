// Makes labelled blur/noise variants of real photos, so ranking can be checked against known ground truth.
// Usage: FAUCET_FIXTURES=/path npx tsx scripts/make-fixtures.ts [relative/source/path ...]
// Writes $FAUCET_FIXTURES/generated/<source>-<variant>.jpg plus manifest.json. Originals are only read.
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ExifTool } from "exiftool-vendored";
import sharp, { type Sharp } from "sharp";
import { loadOriented } from "../src/core/image.ts";
import { cacheDir } from "../src/core/paths.ts";
import { previewShot } from "../src/core/preview.ts";
import { scanFolder } from "../src/core/scan.ts";

// Sharpest frame of distinct scenes in the 2026-10-26 set (see NOTES.md).
const DEFAULT_SOURCES = [
  "ARW/Test-12.ARW", "ARW/Test-6.ARW", "ARW/Test-25.ARW", "ARW/Test-5.ARW",
  "jpg /Test-3.jpg", "jpg /Test-5.jpg", "jpg /Test-8.jpg",
];

/** Label per variant: "sharp" frames must outrank every "blurry" frame made from the same source. */
export const VARIANTS = {
  "noisy": "sharp",
  "defocus-2": "blurry",
  "defocus-5": "blurry",
  "motion-15": "blurry",
  "night": "blurry",
} as const;

const root = process.env.FAUCET_FIXTURES;
if (!root) throw new Error("set FAUCET_FIXTURES");
const sources = process.argv.length > 2 ? process.argv.slice(2) : DEFAULT_SOURCES;
const outDir = path.join(root, "generated");
mkdirSync(outDir, { recursive: true });

// Seeded Gaussian noise so reruns produce identical files.
function addNoise(data: Buffer, sigma: number, seed: number): Buffer {
  const out = Buffer.alloc(data.length);
  for (let i = 0; i < data.length; i++) {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    const u = (seed / 2 ** 32) || 1e-9;
    seed = (seed * 1664525 + 1013904223) >>> 0;
    const g = Math.sqrt(-2 * Math.log(u)) * Math.cos((2 * Math.PI * seed) / 2 ** 32);
    out[i] = Math.max(0, Math.min(255, Math.round(data[i]! + g * sigma)));
  }
  return out;
}

const et = new ExifTool();
const manifest: { source: string; file: string; variant: string; label: string }[] = [];
try {
  const scan = await scanFolder(root, et);
  for (const rel of sources) {
    const shot = scan.shots.find((s) => path.relative(root, s.id).toLowerCase() === rel.toLowerCase());
    if (!shot) throw new Error(`not found in scan: ${rel}`);
    const preview = await previewShot(shot, et, cacheDir());
    const px = await loadOriented(preview.path, shot.orientation, { maxSide: 2000 });
    const raw = { width: px.width, height: px.height, channels: px.channels as 3 };
    const base = (): Sharp => sharp(px.data, { raw });
    const stem = rel.replace(/[\\/ ]+/g, "_").replace(/\.[^.]+$/, "");
    const write = async (variant: string, img: Sharp | Buffer): Promise<void> => {
      const file = `${stem}-${variant}.jpg`;
      const s = Buffer.isBuffer(img) ? sharp(img, { raw }) : img;
      await s.jpeg({ quality: 92 }).toFile(path.join(outDir, file));
      manifest.push({ source: rel, file, variant, label: variant === "source" ? "sharp" : VARIANTS[variant as keyof typeof VARIANTS] });
    };
    await write("source", base());
    await write("noisy", addNoise(px.data, 10, 1));
    await write("defocus-2", base().blur(2));
    await write("defocus-5", base().blur(5));
    await write("motion-15", base().convolve({ width: 15, height: 3, kernel: [...new Array(15).fill(0), ...new Array(15).fill(1), ...new Array(15).fill(0)] }));
    // Underexposed, slightly soft, high-ISO-looking frame: the "blurry noisy night shot" case.
    const night = await base().linear(0.35, 0).blur(2).raw().toBuffer();
    await write("night", addNoise(night, 8, 2));
    console.log(`${rel}: ${px.width}x${px.height} from ${preview.source}`);
  }
  writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  console.log(`${manifest.length} files in ${outDir}`);
} finally {
  await et.end();
}
