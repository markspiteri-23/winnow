import { readdirSync } from "node:fs";
import path from "node:path";
import type { ExifTool } from "exiftool-vendored";
import { cull, type CullOptions } from "./cull.ts";
import type { Group } from "./group.ts";
import type { FileError, Shot, Verdict, VerdictKind } from "./types.ts";

export type EvalSet = "tune" | "holdout";

/** Your own call on one fixture. `none` = neither a pick nor a reject (a keeper that need not be the group's best). */
export interface LabelEntry {
  label: VerdictKind;
  set: EvalSet;
  note?: string;
}

/** `$FAUCET_FIXTURES/labels.json`. Keys are paths relative to the fixtures root with `/` separators (case-insensitive). */
export interface LabelsFile {
  photos: Record<string, LabelEntry>;
}

export interface SetReport {
  labelled: number;
  /** Labelled photos the run never produced a verdict for (missing file, failed analysis). */
  missing: string[];
  rejects: { total: number; caught: number; rate: number | null };
  /** A pick is surfaced when it is its group's pick, or alone in its group and not rejected. */
  picks: { total: number; surfaced: number; rate: number | null };
  /** Photos you did not reject that the run rejected; `ofPicks` = how many of them you picked. */
  falseRejects: { count: number; ofPicks: number; shots: string[] };
}

export interface EvalReport {
  tune: SetReport;
  holdout: SetReport;
}

/** One cull run's output, enough to score labels against. */
export type EvalRun = { shots: Shot[]; groups: Group[]; verdicts: Verdict[] };

const KINDS = new Set(["pick", "reject", "none"]);
const SETS = new Set(["tune", "holdout"]);
const keyOf = (rel: string): string => rel.split(/[\\/]/).join("/").toLowerCase();

/** Throws unless every entry has a valid `label` and `set`. */
export function validateLabels(data: unknown): LabelsFile {
  const photos = (data as { photos?: unknown } | null)?.photos;
  if (typeof photos !== "object" || photos === null || Array.isArray(photos)) throw new Error("labels: missing 'photos' object");
  for (const [key, entry] of Object.entries(photos)) {
    const e = entry as Partial<LabelEntry> | null;
    if (!KINDS.has(e?.label as string)) throw new Error(`labels: '${key}' needs label pick | reject | none`);
    if (!SETS.has(e?.set as string)) throw new Error(`labels: '${key}' needs set tune | holdout`);
  }
  return { photos: photos as Record<string, LabelEntry> };
}

const rate = (n: number, total: number): number | null => (total ? Math.round((n / total) * 1000) / 1000 : null);

/** Scores the runs against your labels, separately for the tune and hold-out sets. */
export function evaluate(labels: LabelsFile, fixturesRoot: string, runs: EvalRun[]): EvalReport {
  // Any file of a shot (RAW or JPEG of a pair) resolves to that shot's verdict and group size.
  const byFile = new Map<string, { verdict: Verdict; groupSize: number }>();
  for (const run of runs) {
    const verdicts = new Map(run.verdicts.map((v) => [v.shotId, v]));
    const size = new Map(run.groups.flatMap((g) => g.shotIDs.map((id) => [id, g.shotIDs.length] as const)));
    for (const shot of run.shots) {
      const verdict = verdicts.get(shot.id);
      if (!verdict) continue;
      for (const f of shot.files) byFile.set(keyOf(path.relative(fixturesRoot, f.path)), { verdict, groupSize: size.get(shot.id) ?? 1 });
    }
  }
  const report = (set: EvalSet): SetReport => {
    const r: SetReport = {
      labelled: 0,
      missing: [],
      rejects: { total: 0, caught: 0, rate: null },
      picks: { total: 0, surfaced: 0, rate: null },
      falseRejects: { count: 0, ofPicks: 0, shots: [] },
    };
    for (const [rel, e] of Object.entries(labels.photos).sort(([a], [b]) => a.localeCompare(b))) {
      if (e.set !== set) continue;
      r.labelled++;
      const hit = byFile.get(keyOf(rel));
      if (e.label === "reject") r.rejects.total++;
      if (e.label === "pick") r.picks.total++;
      if (!hit) {
        r.missing.push(rel);
        continue;
      }
      const got = hit.verdict.verdict;
      if (e.label === "reject" && got === "reject") r.rejects.caught++;
      if (e.label === "pick" && (got === "pick" || (hit.groupSize === 1 && got !== "reject"))) r.picks.surfaced++;
      if (e.label !== "reject" && got === "reject") {
        r.falseRejects.count++;
        if (e.label === "pick") r.falseRejects.ofPicks++;
        r.falseRejects.shots.push(rel);
      }
    }
    r.rejects.rate = rate(r.rejects.caught, r.rejects.total);
    r.picks.rate = rate(r.picks.surfaced, r.picks.total);
    return r;
  };
  return { tune: report("tune"), holdout: report("holdout") };
}

export interface Tolerance {
  /** Largest allowed drop in a catch/surface rate (0-1). */
  rateDrop: number;
  /** Largest allowed increase in false rejects. */
  falseRejects: number;
}

/** Ways `current` is worse than `baseline` beyond the tolerance; empty when it is not. */
export function regressions(current: SetReport, baseline: SetReport, tol: Tolerance): string[] {
  const out: string[] = [];
  const cmp = (name: string, now: number | null, was: number | null): void => {
    if (was !== null && (now === null || was - now > tol.rateDrop)) out.push(`${name}: ${now ?? "n/a"} vs baseline ${was} (allowed drop ${tol.rateDrop})`);
  };
  cmp("rejects caught", current.rejects.rate, baseline.rejects.rate);
  cmp("picks surfaced", current.picks.rate, baseline.picks.rate);
  if (current.falseRejects.count - baseline.falseRejects.count > tol.falseRejects) {
    out.push(`false rejects: ${current.falseRejects.count} vs baseline ${baseline.falseRejects.count} (${current.falseRejects.shots.join(", ")})`);
  }
  return out;
}

/**
 * Culls every top-level folder of the fixtures root that holds a labelled photo, each on its own
 * (so generated variants never group with the real shots they were made from), then scores the labels.
 */
export async function runEval(
  fixturesRoot: string,
  labels: LabelsFile,
  et: ExifTool,
  opts: Pick<CullOptions, "cache" | "previewRoot" | "onProgress"> = {},
): Promise<{ report: EvalReport; errors: FileError[] }> {
  const root = path.resolve(fixturesRoot);
  const tops = new Set(Object.keys(labels.photos).map((k) => keyOf(k).split("/")[0]));
  const folders = readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory() && tops.has(d.name.toLowerCase()));
  const runs: EvalRun[] = [];
  const errors: FileError[] = [];
  for (const d of folders) {
    const result = await cull(path.join(root, d.name), et, opts);
    runs.push(result);
    errors.push(...result.errors);
  }
  return { report: evaluate(labels, root, runs), errors };
}
