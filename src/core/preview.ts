import { createHash } from "node:crypto";
import { existsSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import type { ExifTool } from "exiftool-vendored";
import { imageSize } from "./image.ts";
import type { FileError, Shot } from "./types.ts";
import { weight } from "./weights.ts";

/** Where a preview came from, best first. "jpeg" = the shot's own (camera) JPEG, used as-is. */
export type PreviewSource = "JpgFromRaw" | "jpeg" | "PreviewImage" | "ThumbnailImage";
type EmbeddedTag = Exclude<PreviewSource, "jpeg">;

export interface PreviewInfo {
  shotId: string;
  source: PreviewSource;
  path: string;
  width: number;
  height: number;
  lowConfidence: boolean;
}

export interface PreviewResult {
  previews: PreviewInfo[];
  errors: FileError[];
}

const CHAIN: PreviewSource[] = ["JpgFromRaw", "jpeg", "PreviewImage", "ThumbnailImage"];

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Cache file for an embedded preview, keyed by RAW path + mtime + size. */
function cachePath(dir: string, raw: string, tag: EmbeddedTag): string {
  const st = statSync(raw);
  const key = createHash("sha1").update(`${raw}\0${st.mtimeMs}\0${st.size}`).digest("hex");
  return path.join(dir, `${key}.${tag}.jpg`);
}

/** Extracts `tag` from the RAW into the cache (temp file, then rename). Throws if the tag is absent. */
async function extractCached(et: ExifTool, raw: string, tag: EmbeddedTag, dir: string): Promise<string> {
  const dest = cachePath(dir, raw, tag);
  if (existsSync(dest)) return dest;
  const tmp = `${dest}.${process.pid}.tmp.jpg`;
  rmSync(tmp, { force: true });
  await et.extractBinaryTag(tag, raw, tmp);
  renameSync(tmp, dest);
  return dest;
}

/**
 * Finds the best preview for one shot: full-size embedded JPEG, the camera JPEG, medium preview, thumbnail.
 * Originals are only read. Sets `shot.previewPath` and `shot.lowConfidence` (preview long side too small).
 */
export async function previewShot(shot: Shot, et: ExifTool, cacheRoot: string): Promise<PreviewInfo> {
  const raw = shot.files.find((f) => f.kind === "raw")?.path;
  const jpeg = shot.files.find((f) => f.kind === "jpeg")?.path;
  const dir = path.join(cacheRoot, "previews");
  mkdirSync(dir, { recursive: true });
  const failures: string[] = [];
  for (const source of CHAIN) {
    try {
      let file: string;
      if (source === "jpeg") {
        if (!jpeg) continue;
        file = jpeg;
      } else {
        if (!raw) continue;
        file = await extractCached(et, raw, source, dir);
      }
      const { width, height } = await imageSize(file);
      const lowConfidence = Math.max(width, height) < weight("previewMinLongSide");
      shot.previewPath = file;
      shot.lowConfidence = lowConfidence;
      return { shotId: shot.id, source, path: file, width, height, lowConfidence };
    } catch (err) {
      failures.push(`${source}: ${message(err)}`);
    }
  }
  shot.lowConfidence = true;
  throw new Error(`no usable preview (${failures.join("; ")})`);
}

/** Previews for every shot. A shot without a usable preview is recorded in `errors`, never aborts the run. */
export async function previewShots(shots: Shot[], et: ExifTool, cacheRoot: string): Promise<PreviewResult> {
  const previews: PreviewInfo[] = [];
  const errors: FileError[] = [];
  await Promise.all(
    shots.map(async (shot) => {
      try {
        previews.push(await previewShot(shot, et, cacheRoot));
      } catch (err) {
        errors.push({ path: shot.id, error: message(err) });
      }
    }),
  );
  previews.sort((a, b) => a.shotId.localeCompare(b.shotId));
  errors.sort((a, b) => a.path.localeCompare(b.path));
  return { previews, errors };
}
