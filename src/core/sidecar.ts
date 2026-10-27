import { randomBytes } from "node:crypto";
import { copyFile, readdir, rename as fsRename, rm } from "node:fs/promises";
import path from "node:path";
import type { ExifTool } from "exiftool-vendored";
import type { FileError, Shot, Verdict } from "./types.ts";

/** adobe = `IMG_1.xmp` (default); darktable = `IMG_1.ARW.xmp`. An existing sidecar's convention always wins. */
export type SidecarStyle = "adobe" | "darktable";

export type SidecarAction = "create" | "update" | "unchanged" | "refused";

export interface SidecarTarget {
  rating: number;
  /** Undefined = leave the label alone. */
  label?: string;
}

export interface SidecarResult {
  shotId: string;
  sidecar: string;
  action: SidecarAction;
  target: SidecarTarget;
  /** True only after the file was actually written (`apply`). */
  written: boolean;
  reason?: string;
}

export interface SidecarOptions {
  style?: SidecarStyle;
  /** Without it nothing is written: the results say what would happen. */
  apply?: boolean;
  /** Injected for tests (simulated Windows locks). */
  rename?: (from: string, to: string) => Promise<void>;
  retry?: { attempts: number; delayMs: number };
}

/** PLAN decision 3: pick = 4 stars + Green label, reject = rating -1 (label untouched). Kept shots get no sidecar. */
export function sidecarTarget(v: Verdict): SidecarTarget | null {
  if (v.verdict === "pick") return { rating: 4, label: "Green" };
  if (v.verdict === "reject") return { rating: -1 };
  return null;
}

const LOCK_CODES = new Set(["EBUSY", "EPERM", "EACCES"]);

/** Retries fs calls that fail because another program (Lightroom, antivirus, Explorer preview) holds the file. */
export async function withLockRetry<T>(fn: () => Promise<T>, attempts = 6, delayMs = 100): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code ?? "";
      if (i >= attempts || !LOCK_CODES.has(code)) throw e;
      await new Promise((r) => setTimeout(r, delayMs * 2 ** (i - 1)));
    }
  }
}

/** Case-insensitive directory listing: lowercased name -> real name. */
async function listing(dir: string, cache: Map<string, Map<string, string>>): Promise<Map<string, string>> {
  let names = cache.get(dir);
  if (!names) {
    names = new Map((await readdir(dir)).map((n) => [n.toLowerCase(), n]));
    cache.set(dir, names);
  }
  return names;
}

/** The sidecar path for a shot: an existing one (either convention, any case) wins, else the chosen style. */
export async function sidecarPath(shot: Shot, style: SidecarStyle, cache = new Map<string, Map<string, string>>()): Promise<{ path: string; exists: boolean }> {
  const dir = path.dirname(shot.id);
  const names = await listing(dir, cache);
  const adobe = `${path.parse(shot.id).name}.xmp`;
  const darktable = shot.files.map((f) => `${path.basename(f.path)}.xmp`);
  const preferred = style === "adobe" ? [adobe, ...darktable] : [...darktable, adobe];
  for (const name of preferred) {
    const real = names.get(name.toLowerCase());
    if (real) return { path: path.join(dir, real), exists: true };
  }
  return { path: path.join(dir, preferred[0] ?? adobe), exists: false };
}

async function readExisting(file: string, et: ExifTool): Promise<{ rating?: number; label?: string }> {
  const tags = (await et.readRaw(file, { readArgs: ["-XMP:all", "-G1", "-n"] })) as Record<string, unknown>;
  const problems = [...((tags["errors"] as string[] | undefined) ?? []), ...((tags["warnings"] as string[] | undefined) ?? [])];
  if (problems.length) throw new Error(`unparsable sidecar: ${problems.join("; ")}`);
  const rating = tags["XMP-xmp:Rating"];
  const label = tags["XMP-xmp:Label"];
  return { ...(typeof rating === "number" ? { rating } : {}), ...(label != null ? { label: String(label) } : {}) };
}

/**
 * Writes Rating/Label into each shot's sidecar, merging with what is there. Every other property is preserved
 * (exiftool rewrites only the named tags). Order: `.xmp.bak` copy, write a temp copy beside it, rename over the
 * sidecar (atomic, retried on Windows locks). Unparsable sidecars are refused and left untouched.
 * Never touches originals: the target always ends in `.xmp`.
 */
export async function writeSidecars(
  shots: Shot[],
  verdicts: Verdict[],
  et: ExifTool,
  opts: SidecarOptions = {},
): Promise<{ results: SidecarResult[]; errors: FileError[] }> {
  const style = opts.style ?? "adobe";
  const rename = opts.rename ?? fsRename;
  const { attempts, delayMs } = opts.retry ?? { attempts: 6, delayMs: 100 };
  const byId = new Map(shots.map((s) => [s.id, s]));
  const cache = new Map<string, Map<string, string>>();
  const results: SidecarResult[] = [];
  const errors: FileError[] = [];

  for (const v of verdicts) {
    const shot = byId.get(v.shotId);
    const target = sidecarTarget(v);
    if (!shot || !target) continue;
    let sidecar = "";
    try {
      const found = await sidecarPath(shot, style, cache);
      sidecar = found.path;
      if (path.extname(sidecar).toLowerCase() !== ".xmp") throw new Error("refusing to write a non-.xmp file");
      let action: SidecarAction = "create";
      if (found.exists) {
        let current;
        try {
          current = await readExisting(sidecar, et);
        } catch (e) {
          results.push({ shotId: v.shotId, sidecar, action: "refused", target, written: false, reason: (e as Error).message });
          continue;
        }
        const same = current.rating === target.rating && (target.label === undefined || current.label === target.label);
        action = same ? "unchanged" : "update";
      }
      const result: SidecarResult = { shotId: v.shotId, sidecar, action, target, written: false };
      results.push(result);
      if (!opts.apply || action === "unchanged") continue;

      const tmp = `${sidecar}.${process.pid}-${randomBytes(4).toString("hex")}.tmp.xmp`;
      try {
        if (found.exists) {
          await withLockRetry(() => copyFile(sidecar, `${sidecar}.bak`), attempts, delayMs);
          await copyFile(sidecar, tmp);
        }
        const tags: Record<string, string | number> = { "XMP-xmp:Rating": target.rating };
        if (target.label !== undefined) tags["XMP-xmp:Label"] = target.label;
        try {
          await et.write(tmp, tags, { writeArgs: ["-overwrite_original"] });
        } catch (e) {
          // The sidecar read without warnings but exiftool cannot rewrite it (e.g. not XMP at all): refuse it.
          if (!found.exists) throw e;
          result.action = "refused";
          result.reason = `unparsable sidecar: ${(e as Error).message}`;
          continue;
        }
        await withLockRetry(() => rename(tmp, sidecar), attempts, delayMs);
        result.written = true;
      } catch (e) {
        result.reason = (e as Error).message;
        throw e;
      } finally {
        if (!result.written) await rm(tmp, { force: true });
      }
    } catch (e) {
      errors.push({ path: sidecar || v.shotId, error: (e as Error).message });
    }
  }
  return { results, errors };
}
