import { readdirSync } from "node:fs";
import path from "node:path";
import type { ExifTool } from "exiftool-vendored";
import { imageLibVersions, loadOriented, probeImage, type ImageProbe } from "./image.ts";
import { cacheDir } from "./paths.ts";
import { previewShots } from "./preview.ts";
import { scanFolder } from "./scan.ts";
import type { FileError } from "./types.ts";

export interface SmokeFile {
  file: string;
  ok: boolean;
  probe?: ImageProbe;
  mimeType?: string;
  error?: string;
}

export interface SmokeResult {
  versions: { sharp: string; vips: string; exiftool: string };
  files: SmokeFile[];
}

/** Reads every JPEG in `folder` with sharp and exiftool. A failure on one file is recorded, never thrown. */
export async function smokeScan(folder: string | undefined, et: ExifTool): Promise<SmokeResult> {
  const versions = { ...imageLibVersions(), exiftool: await et.version() };
  if (!folder) return { versions, files: [] };
  const names = readdirSync(folder)
    .filter((n) => /\.jpe?g$/i.test(n))
    .sort();
  const files: SmokeFile[] = [];
  for (const name of names) {
    const full = path.join(folder, name);
    try {
      const probe = await probeImage(full);
      const tags = await et.read(full);
      files.push({ file: name, ok: true, probe, ...(tags.MIMEType ? { mimeType: tags.MIMEType } : {}) });
    } catch (err) {
      files.push({ file: name, ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return { versions, files };
}

export interface SpikeImage {
  file: string;
  width: number;
  height: number;
  channels: number;
  /** Interleaved 8-bit samples, upright. */
  data: Uint8Array;
}

/** Phase 7 face spike only: upright downscaled previews of every shot in `folder`. */
export async function faceSpikeImages(
  folder: string | undefined,
  et: ExifTool,
  maxSide: number,
): Promise<{ images: SpikeImage[]; errors: FileError[] }> {
  if (!folder) return { images: [], errors: [] };
  const scan = await scanFolder(folder, et);
  const previews = await previewShots(scan.shots, et, cacheDir());
  const orientation = new Map(scan.shots.map((s) => [s.id, s.orientation]));
  const images: SpikeImage[] = [];
  const errors = [...scan.errors, ...previews.errors];
  for (const p of previews.previews) {
    try {
      const px = await loadOriented(p.path, orientation.get(p.shotId) ?? null, { maxSide });
      const file = path.relative(folder, p.shotId);
      images.push({ file, width: px.width, height: px.height, channels: px.channels, data: new Uint8Array(px.data) });
    } catch (err) {
      errors.push({ path: p.shotId, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return { images, errors };
}
