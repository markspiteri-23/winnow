// Times scanFolder on N generated JPEG pairs-worth of files. Usage: npx tsx scripts/bench-scan.ts [count]
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ExifTool } from "exiftool-vendored";
import sharp from "sharp";
import { scanFolder } from "../src/core/scan.ts";

const count = Number(process.argv[2] ?? 1000);
const dir = mkdtempSync(path.join(tmpdir(), "faucet-bench-"));
const et = new ExifTool();
try {
  const seed = path.join(dir, "seed.jpg");
  await sharp({ create: { width: 1600, height: 1067, channels: 3, background: "#777" } }).jpeg().toFile(seed);
  await et.write(seed, { DateTimeOriginal: "2024:05:01 10:00:00", SubSecTimeOriginal: "12", Model: "Bench", ISO: 100 }, { writeArgs: ["-overwrite_original"] });
  for (let i = 0; i < count; i++) copyFileSync(seed, path.join(dir, `IMG_${String(i).padStart(5, "0")}.jpg`));
  rmSync(seed);
  const start = performance.now();
  const result = await scanFolder(dir, et);
  const ms = performance.now() - start;
  console.log(`${result.shots.length} shots, ${result.errors.length} errors in ${(ms / 1000).toFixed(2)}s (${(ms / count).toFixed(1)} ms/file, maxProcs=${et.options.maxProcs})`);
} finally {
  await et.end();
  rmSync(dir, { recursive: true, force: true });
}
