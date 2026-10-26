import { readdirSync } from "node:fs";
import path from "node:path";
import type { ExifTool } from "exiftool-vendored";
import { imageLibVersions, probeImage, type ImageProbe } from "./image.ts";

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
