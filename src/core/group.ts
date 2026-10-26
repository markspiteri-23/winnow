import path from "node:path";
import { similarity, type Metrics } from "./metrics.ts";
import type { Shot } from "./types.ts";
import { weight } from "./weights.ts";

/** One edge considered between neighbouring shots, kept so every grouping decision can be explained. */
export interface Link {
  from: string;
  to: string;
  /** Seconds between the two (after camera offsets); null when ordered by filename number. */
  seconds: number | null;
  /** Filename number gap; null when ordered by time. */
  numberGap: number | null;
  /** Layout similarity -1..1; null when either shot could not be analysed. */
  similarity: number | null;
  joined: boolean;
  reason: string;
}

export interface Group {
  id: string;
  shotIDs: string[];
  /** Chosen in Phase 9; null until then. */
  bestID: string | null;
}

export interface GroupOptions {
  /** Seconds added to each camera's clock, keyed by camera model, to line up multi-camera shoots. */
  cameraOffsets?: Record<string, number>;
  maxGapSeconds?: number;
  minSimilarity?: number;
  maxNumberGap?: number;
}

export interface GroupResult {
  groups: Group[];
  links: Link[];
}

export type GroupMetrics = Pick<Metrics, "thumb" | "width" | "height">;

/**
 * Wall-clock time in ms, ignoring any recorded UTC offset: one camera's clock is consistent with itself,
 * but some of its files carry an offset and some do not.
 */
export function wallClockMs(iso: string): number | null {
  const ms = Date.parse(`${iso.replace(/(Z|[+-]\d\d:\d\d)$/, "")}Z`);
  return Number.isFinite(ms) ? ms : null;
}

/** Last run of digits in the file name (IMG_0412.ARW -> 412), or null. */
export function fileNumber(file: string): number | null {
  const m = /(\d+)(?!.*\d)/.exec(path.parse(file).name);
  return m ? Number(m[1]) : null;
}

interface Item {
  shot: Shot;
  m: GroupMetrics | undefined;
  ms: number | null;
  num: number | null;
}

/**
 * Splits shots into bursts / near-duplicate groups. Shots are ordered by capture time (or filename number
 * when the date is missing) and each joins its predecessor's group only if it is close in time, has the same
 * orientation AND a similar layout. Linking only to the immediate predecessor keeps chains short: when
 * unsure, split. RAW+JPEG pairs are already one Shot, so they can never group with themselves.
 */
export function groupShots(shots: Shot[], metrics: Map<string, GroupMetrics>, opts: GroupOptions = {}): GroupResult {
  const maxGap = opts.maxGapSeconds ?? weight("groupMaxGapSeconds");
  const minSim = opts.minSimilarity ?? weight("groupMinSimilarity");
  const maxNum = opts.maxNumberGap ?? weight("groupMaxNumberGap");
  const offsets = opts.cameraOffsets ?? {};

  const items: Item[] = shots.map((shot) => {
    const wall = shot.captureDate ? wallClockMs(shot.captureDate) : null;
    const offset = (shot.cameraModel && offsets[shot.cameraModel]) || 0;
    return { shot, m: metrics.get(shot.id), ms: wall === null ? null : wall + offset * 1000, num: fileNumber(shot.id) };
  });
  const byName = (a: Item, b: Item): number => a.shot.id.localeCompare(b.shot.id, undefined, { numeric: true });
  const dated = items.filter((i) => i.ms !== null).sort((a, b) => a.ms! - b.ms! || byName(a, b));
  const undated = items.filter((i) => i.ms === null).sort(byName);

  const groups: Group[] = [];
  const links: Link[] = [];
  const start = (item: Item): void => {
    groups.push({ id: `g${groups.length + 1}`, shotIDs: [item.shot.id], bestID: null });
  };

  const walk = (list: Item[], byTime: boolean): void => {
    list.forEach((cur, i) => {
      const prev = list[i - 1];
      if (!prev) return start(cur);
      const seconds = byTime ? (cur.ms! - prev.ms!) / 1000 : null;
      const sameDir = path.dirname(cur.shot.id) === path.dirname(prev.shot.id);
      const numberGap = !byTime && sameDir && cur.num !== null && prev.num !== null ? Math.abs(cur.num - prev.num) : null;
      const sim = cur.m && prev.m ? similarity(cur.m.thumb, prev.m.thumb) : null;
      const landscape = (m: GroupMetrics): boolean => m.width >= m.height;
      let reason: string | null = null;
      if (sim === null) reason = "not analysed";
      else if (byTime && seconds! > maxGap) reason = `${seconds!.toFixed(1)}s apart > ${maxGap}s`;
      else if (!byTime && (numberGap === null || numberGap > maxNum)) reason = "no date and file numbers not consecutive";
      else if (landscape(cur.m!) !== landscape(prev.m!)) reason = "landscape vs portrait";
      else if (sim < minSim) reason = `different layout (similarity ${sim} < ${minSim})`;
      const joined = reason === null;
      const gap = byTime ? `${seconds!.toFixed(1)}s apart` : `file numbers ${numberGap} apart`;
      links.push({ from: prev.shot.id, to: cur.shot.id, seconds, numberGap, similarity: sim, joined, reason: reason ?? `${gap}, similarity ${sim}` });
      if (joined) groups.at(-1)!.shotIDs.push(cur.shot.id);
      else start(cur);
    });
  };
  walk(dated, true);
  walk(undated, false);
  return { groups, links };
}
