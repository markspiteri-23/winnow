// Paints synthetic sunglasses and glare over the eyes of real faces, so the "unknown, never closed" rules can be checked.
// Usage: FAUCET_FIXTURES=/path npx tsx scripts/make-face-fixtures.ts <detections.json> <folder> [file ...]
// <detections.json> = the face harness output (test-results/face-fixtures-<os>.json) for <folder>.
// Writes $FAUCET_FIXTURES/generated-faces/<file>-<variant>.jpg, upright at the detector's size. Originals are only read.
import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { ExifTool } from "exiftool-vendored";
import sharp from "sharp";
import type { Box, DetectedFace } from "../src/core/faces.ts";
import { loadOriented } from "../src/core/image.ts";
import { cacheDir } from "../src/core/paths.ts";
import { previewShot } from "../src/core/preview.ts";
import { scanFolder } from "../src/core/scan.ts";

const root = process.env.FAUCET_FIXTURES;
if (!root) throw new Error("set FAUCET_FIXTURES");
const [detectionsFile, folder, ...only] = process.argv.slice(2);
if (!detectionsFile || !folder) throw new Error("usage: make-face-fixtures.ts <detections.json> <folder> [file ...]");
const harness = JSON.parse(readFileSync(detectionsFile, "utf8")) as { results: { file: string; width: number; faces?: DetectedFace[] }[] };
const out = path.join(root, "generated-faces");
mkdirSync(out, { recursive: true });

/** One ellipse per eye, the eye box grown by `pad`, as an SVG overlay. */
function eyes(faces: DetectedFace[], w: number, h: number, pad: number, fill: string): Buffer {
  const ell = (b: Box): string =>
    `<ellipse cx="${(b.x + b.w / 2) * w}" cy="${(b.y + b.h / 2) * h}" rx="${(b.w / 2) * (1 + pad) * w}" ry="${Math.max(b.h / 2, b.w / 3) * (1 + pad) * h}" fill="${fill}"/>`;
  const shapes = faces.flatMap((f) => [ell(f.leftEye), ell(f.rightEye)]).join("");
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">${shapes}</svg>`);
}

const et = new ExifTool();
try {
  const scan = await scanFolder(folder, et);
  for (const r of harness.results) {
    if (!r.faces?.length || (only.length && !only.includes(r.file))) continue;
    const shot = scan.shots.find((s) => path.relative(folder, s.id) === r.file);
    if (!shot) continue;
    const preview = await previewShot(shot, et, cacheDir());
    const px = await loadOriented(preview.path, shot.orientation, { maxSide: r.width });
    const base = sharp(px.data, { raw: { width: px.width, height: px.height, channels: px.channels as 3 } });
    const name = path.parse(r.file).name;
    const variants = {
      sunglasses: eyes(r.faces, px.width, px.height, 0.6, "rgb(18,18,22)"),
      glare: eyes(r.faces, px.width, px.height, 0.3, "rgb(255,255,255)"),
    };
    for (const [variant, svg] of Object.entries(variants)) {
      const file = path.join(out, `${name}-${variant}.jpg`);
      await base.clone().composite([{ input: svg }]).jpeg({ quality: 92 }).toFile(file);
      console.log(file);
    }
  }
} finally {
  await et.end();
}
