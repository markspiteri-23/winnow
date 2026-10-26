// Phase 4 check: preview-sized vs full-resolution sharpness on real photos.
// Usage: FAUCET_FIXTURES=/path npx tsx scripts/compare-sharpness.ts [count=10]
// "Full resolution" = the full-size embedded JPEG (JpgFromRaw) or camera JPEG at native size; sharp cannot decode RAW.
import path from "node:path";
import { ExifTool } from "exiftool-vendored";
import { measureShot } from "../src/core/metrics.ts";
import { cacheDir } from "../src/core/paths.ts";
import { previewShots } from "../src/core/preview.ts";
import { scanFolder } from "../src/core/scan.ts";

const root = process.env.FAUCET_FIXTURES;
if (!root) throw new Error("set FAUCET_FIXTURES");
const count = Number(process.argv[2] ?? 10);

function ranks(values: number[]): number[] {
  const order = values.map((v, i) => [v, i] as const).sort((a, b) => a[0] - b[0]);
  const r = new Array<number>(values.length);
  order.forEach(([, i], k) => (r[i] = k));
  return r;
}

const et = new ExifTool();
try {
  const scan = await scanFolder(root, et);
  const { previews } = await previewShots(scan.shots.slice(0, count), et, cacheDir());
  const orient = new Map(scan.shots.map((s) => [s.id, s.orientation]));
  const rows: [string, number, number, number, number][] = [];
  for (const p of previews) {
    const input = { shotId: p.shotId, path: p.path, orientation: orient.get(p.shotId) ?? null, lowConfidence: p.lowConfidence };
    const small = await measureShot(input);
    const full = await measureShot(input, 0);
    rows.push([path.relative(root, p.shotId), small.sharpness, full.sharpness, small.noise, full.noise]);
    console.log(`${rows.at(-1)![0]}\t${p.source} ${p.width}x${p.height}\tpreview ${small.sharpness}\tfull ${full.sharpness}\tnoise ${small.noise}/${full.noise}`);
  }
  const a = ranks(rows.map((r) => r[1]));
  const b = ranks(rows.map((r) => r[2]));
  const n = rows.length;
  const d2 = a.reduce((s, v, i) => s + (v - b[i]!) ** 2, 0);
  console.log(`Spearman rank correlation preview vs full (n=${n}): ${(1 - (6 * d2) / (n * (n * n - 1))).toFixed(3)}`);
} finally {
  await et.end();
}
