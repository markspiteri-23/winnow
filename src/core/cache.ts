import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Metrics } from "./metrics.ts";
import type { Shot } from "./types.ts";
import { weight } from "./weights.ts";

/** Bump when metrics.ts or preview selection changes what a cached result means. */
export const ANALYSIS_VERSION = 1;

/** Weights that change measured values; scoring weights are applied after the cache, so tuning them keeps it valid. */
const ANALYSIS_WEIGHTS = [
  "previewMinLongSide", "analysisMaxSide", "sharpnessTileSize", "sharpnessPercentile",
  "noiseFlatTileFraction", "shadowClipLevel", "highlightClipLevel",
];

/**
 * Key over every file of the shot (path + mtime + size), the analysis version and analysis weights.
 * Any edit, replacement or re-pairing of a file gives a new key; stale entries are simply never read.
 */
export function cacheKey(shot: Shot): string {
  const h = createHash("sha1");
  h.update(`v${ANALYSIS_VERSION}\0${ANALYSIS_WEIGHTS.map((w) => weight(w)).join(",")}`);
  for (const f of [...shot.files].sort((a, b) => a.path.localeCompare(b.path))) {
    const st = statSync(f.path);
    h.update(`\0${f.path}\0${st.mtimeMs}\0${st.size}`);
  }
  return h.digest("hex");
}

/** One JSON file per shot under `dir`. Unreadable or corrupt entries count as misses. */
export class MetricsCache {
  readonly dir: string;

  // No parameter properties: Node's type stripping (used by the worker threads) rejects them.
  constructor(dir: string) {
    this.dir = dir;
  }

  private file(key: string): string {
    return path.join(this.dir, key.slice(0, 2), `${key}.json`);
  }

  get(shot: Shot): Metrics | null {
    try {
      const m = JSON.parse(readFileSync(this.file(cacheKey(shot)), "utf8")) as Metrics;
      return m.shotId === shot.id ? m : null;
    } catch {
      return null;
    }
  }

  /** Atomic: temp file then rename, so a cancelled run never leaves a half-written entry. */
  set(shot: Shot, m: Metrics): void {
    const dest = this.file(cacheKey(shot));
    mkdirSync(path.dirname(dest), { recursive: true });
    const tmp = `${dest}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(m));
    renameSync(tmp, dest);
  }
}
