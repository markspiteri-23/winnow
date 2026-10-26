import { readdirSync } from "node:fs";
import path from "node:path";
import { ExifDateTime, type ExifTool, type Tags } from "exiftool-vendored";
import type { FileError, FileKind, Shot, ShotFile } from "./types.ts";

const KINDS: Record<string, FileKind> = {
  ".arw": "raw",
  ".cr2": "raw",
  ".cr3": "raw",
  ".nef": "raw",
  ".dng": "raw",
  ".jpg": "jpeg",
  ".jpeg": "jpeg",
};

export interface ScanResult {
  root: string;
  shots: Shot[];
  errors: FileError[];
}

export function fileKind(file: string): FileKind | undefined {
  return KINDS[path.extname(file).toLowerCase()];
}

/** Recursively lists supported photos. Skips dot-files (incl. macOS `._` files); unreadable folders are recorded. */
export function listPhotoFiles(root: string, errors: FileError[] = []): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      errors.push({ path: dir, error: message(err) });
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith(".")) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile() && fileKind(e.name)) out.push(full);
    }
  };
  walk(root);
  return out.sort();
}

/**
 * Groups files by folder + case-insensitive basename. A key with exactly one RAW and/or one JPEG
 * becomes one shot; anything more ambiguous is split into one shot per file.
 */
export function pairFiles(files: string[]): ShotFile[][] {
  const byKey = new Map<string, ShotFile[]>();
  for (const p of files) {
    const kind = fileKind(p);
    if (!kind) continue;
    const parsed = path.parse(p);
    const key = path.join(parsed.dir, parsed.name).toLowerCase();
    const list = byKey.get(key) ?? [];
    list.push({ path: p, kind });
    byKey.set(key, list);
  }
  const shots: ShotFile[][] = [];
  for (const list of byKey.values()) {
    const raws = list.filter((f) => f.kind === "raw");
    const jpegs = list.filter((f) => f.kind === "jpeg");
    if (raws.length <= 1 && jpegs.length <= 1) shots.push([...raws, ...jpegs]);
    else for (const f of list) shots.push([f]);
  }
  return shots;
}

const MIN_YEAR = 1990;
const FUTURE_SLACK_MS = 2 * 24 * 3600 * 1000;

export function captureDate(tags: Tags, now = Date.now()): string | null {
  const d = tags.SubSecDateTimeOriginal ?? tags.DateTimeOriginal ?? tags.CreateDate;
  if (!(d instanceof ExifDateTime)) return null;
  if (d.year < MIN_YEAR || d.toMillis() > now + FUTURE_SLACK_MS) return null;
  return d.toISOString() ?? null;
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function shotFromTags(files: ShotFile[], primary: ShotFile, tags: Tags): Shot {
  const orientation = num(tags.Orientation);
  return {
    id: primary.path,
    files,
    captureDate: captureDate(tags),
    cameraModel: typeof tags.Model === "string" ? tags.Model.trim() : null,
    iso: num(tags.ISO),
    orientation: orientation !== null && orientation >= 1 && orientation <= 8 ? orientation : null,
    width: num(tags.ImageWidth) ?? num(tags.ExifImageWidth),
    height: num(tags.ImageHeight) ?? num(tags.ExifImageHeight),
    lowConfidence: false,
  };
}

/** Reads metadata (read-only) for each shot, RAW first. A failing file is recorded and its partner tried. */
async function readShot(files: ShotFile[], et: ExifTool, errors: FileError[]): Promise<Shot | null> {
  for (const f of files) {
    try {
      const tags = await et.read(f.path);
      if (typeof tags.MIMEType !== "string" || !tags.MIMEType.startsWith("image/")) {
        throw new Error(`not a recognised image (${tags.FileType ?? "unknown type"})`);
      }
      return shotFromTags(files, f, tags);
    } catch (err) {
      errors.push({ path: f.path, error: message(err) });
    }
  }
  return null;
}

export async function scanFolder(root: string, et: ExifTool): Promise<ScanResult> {
  const errors: FileError[] = [];
  const groups = pairFiles(listPhotoFiles(root, errors));
  const read = await Promise.all(groups.map((g) => readShot(g, et, errors)));
  const shots = read.filter((s): s is Shot => s !== null).sort((a, b) => a.id.localeCompare(b.id));
  errors.sort((a, b) => a.path.localeCompare(b.path));
  return { root, shots, errors };
}
