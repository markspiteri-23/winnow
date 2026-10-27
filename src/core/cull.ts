import path from "node:path";
import type { ExifTool } from "exiftool-vendored";
import { MetricsCache } from "./cache.ts";
import type { ShotFaces } from "./faces.ts";
import { groupShots, type Group, type Link } from "./group.ts";
import type { Metrics } from "./metrics.ts";
import { cacheDir } from "./paths.ts";
import { measureInPool } from "./pool.ts";
import { previewShots } from "./preview.ts";
import { scanFolder } from "./scan.ts";
import { scoreGroups } from "./score.ts";
import type { FileError, Shot, Verdict } from "./types.ts";

export interface CullOptions {
  /** null disables the results cache. Default: `cacheDir()/metrics`. */
  cache?: MetricsCache | null;
  /** Root for extracted previews. Default: `cacheDir()`. */
  previewRoot?: string;
  concurrency?: number;
  signal?: AbortSignal;
  onProgress?: (done: number, total: number) => void;
  cameraOffsets?: Record<string, number>;
  /** Face results per shot id; the CLI has none (the detector runs in the app's renderer). */
  faces?: Map<string, ShotFaces>;
}

export interface CullResult {
  root: string;
  shots: Shot[];
  groups: Group[];
  links: Link[];
  verdicts: Verdict[];
  errors: FileError[];
  /** Cancelled before every shot was measured; groups and verdicts are left empty. Rerun to resume from the cache. */
  cancelled: boolean;
  stats: { shots: number; cached: number; measured: number; seconds: number };
}

/** Full analysis of a folder. Originals are only read; one failing file is recorded and never aborts the run. */
export async function cull(folder: string, et: ExifTool, opts: CullOptions = {}): Promise<CullResult> {
  const start = performance.now();
  const root = path.resolve(folder);
  const cache = opts.cache === undefined ? new MetricsCache(path.join(cacheDir(), "metrics")) : opts.cache;
  const scan = await scanFolder(root, et);
  const errors: FileError[] = [...scan.errors];

  const metrics = new Map<string, Metrics>();
  const todo: Shot[] = [];
  for (const shot of scan.shots) {
    const hit = cache?.get(shot);
    if (hit) {
      metrics.set(shot.id, hit);
      shot.lowConfidence = hit.lowConfidence;
    } else todo.push(shot);
  }
  const cached = metrics.size;
  opts.onProgress?.(cached, scan.shots.length);

  const previews = await previewShots(todo, et, opts.previewRoot ?? cacheDir());
  errors.push(...previews.errors);
  const byId = new Map(todo.map((s) => [s.id, s]));
  const pooled = await measureInPool(
    previews.previews.map((p) => ({ shotId: p.shotId, path: p.path, orientation: byId.get(p.shotId)?.orientation ?? null, lowConfidence: p.lowConfidence })),
    {
      ...(opts.concurrency === undefined ? {} : { concurrency: opts.concurrency }),
      ...(opts.signal ? { signal: opts.signal } : {}),
      onProgress: (done) => opts.onProgress?.(cached + done, scan.shots.length),
      onResult: (m) => {
        const shot = byId.get(m.shotId);
        if (shot) cache?.set(shot, m);
      },
    },
  );
  for (const m of pooled.metrics) metrics.set(m.shotId, m);
  errors.push(...pooled.errors);

  const stats = (): CullResult["stats"] => ({
    shots: scan.shots.length,
    cached,
    measured: pooled.metrics.length,
    seconds: Math.round(performance.now() - start) / 1000,
  });
  if (pooled.cancelled) {
    return { root, shots: scan.shots, groups: [], links: [], verdicts: [], errors, cancelled: true, stats: stats() };
  }
  const grouped = groupShots(scan.shots, metrics, opts.cameraOffsets ? { cameraOffsets: opts.cameraOffsets } : {});
  const verdicts = scoreGroups(grouped.groups, metrics, opts.faces);
  return { root, shots: scan.shots, groups: grouped.groups, links: grouped.links, verdicts, errors, cancelled: false, stats: stats() };
}
