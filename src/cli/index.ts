import { readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { ExifTool } from "exiftool-vendored";
import { cullCsv } from "../core/csv.ts";
import { cull, type CullResult } from "../core/cull.ts";
import { runEval, validateLabels, type EvalReport, type SetReport } from "../core/eval.ts";
import { groupShots, type GroupResult } from "../core/group.ts";
import { measureShots, type MetricsResult } from "../core/metrics.ts";
import { cacheDir } from "../core/paths.ts";
import { previewShots, type PreviewResult } from "../core/preview.ts";
import { scanFolder, type ScanResult } from "../core/scan.ts";
import { writeSidecars, type SidecarResult, type SidecarStyle } from "../core/sidecar.ts";
import type { FileError } from "../core/types.ts";

const HELP = `faucet - local photo culler (no cloud)

Usage:
  faucet scan <folder> [--json]       List shots (RAW+JPEG pairs collapsed) with EXIF
  faucet previews <folder> [--json]   Extract/cache the best preview per shot and report its size
  faucet metrics <folder> [--json]    Sharpness, noise and exposure per shot (from its preview)
  faucet groups <folder> [--json]     Group bursts / near-duplicates, with the reason for every split or join
  faucet cull <folder> [--json]       Pick / reject / keep per shot, judged within its group, with reasons
                                      (cached; Ctrl+C cancels, rerun resumes; no eye checks: faces need the app)
                                      Shows the XMP sidecars it would write (pick = 4 stars + Green, reject = -1)
  faucet eval <fixtures> [--json]     Score cull against your labels (<fixtures>/labels.json), tune and hold-out apart

Options:
  --json     Machine-readable output
  --apply    Write sidecars (default is dry-run). Only Rating/Label change; old sidecar kept as .xmp.bak
  --sidecar adobe|darktable   New sidecar name: IMG_1.xmp (default) or IMG_1.ARW.xmp; existing ones are followed
  --csv <file.csv>       Also export picks/rejects with groups, scores and reasons (written even in dry-run)
  --labels <file.json>   Labels for eval (default <fixtures>/labels.json)
  --offsets <file.json>  Per-camera clock offsets in seconds, e.g. {"ILCE-6000": -3600}
  -h, --help Show this help
`;

function render(header: string[], rows: string[][]): string[] {
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]?.length ?? 0)));
  const line = (r: string[]): string => r.map((c, i) => c.padEnd(widths[i] ?? 0)).join("  ").trimEnd();
  return [line(header), ...rows.map(line)];
}

function table(result: ScanResult, seconds: number): string {
  const rows = result.shots.map((s) => [
    path.relative(result.root, s.id),
    s.files.map((f) => f.kind).join("+"),
    s.captureDate ?? "-",
    s.cameraModel ?? "-",
    s.iso?.toString() ?? "-",
    s.orientation?.toString() ?? "-",
    s.width && s.height ? `${s.width}x${s.height}` : "-",
  ]);
  const out = render(["shot", "files", "captured", "camera", "iso", "orient", "size"], rows);
  for (const e of result.errors) out.push(`error: ${path.relative(result.root, e.path)}: ${e.error}`);
  const files = result.shots.reduce((n, s) => n + s.files.length, 0);
  out.push(`${result.shots.length} shots (${files} files), ${result.errors.length} errors, ${seconds.toFixed(2)}s`);
  return out.join("\n") + "\n";
}

function previewTable(scan: ScanResult, result: PreviewResult, seconds: number): string {
  const rows = result.previews.map((p) => [
    path.relative(scan.root, p.shotId),
    p.source,
    `${p.width}x${p.height}`,
    p.lowConfidence ? "low" : "ok",
  ]);
  const out = render(["shot", "preview", "size", "confidence"], rows);
  for (const e of [...scan.errors, ...result.errors]) out.push(`error: ${path.relative(scan.root, e.path)}: ${e.error}`);
  const low = result.previews.filter((p) => p.lowConfidence).length;
  out.push(`${result.previews.length} previews (${low} low confidence), ${scan.errors.length + result.errors.length} errors, ${seconds.toFixed(2)}s`);
  return out.join("\n") + "\n";
}

function metricsTable(root: string, result: MetricsResult, seconds: number): string {
  const rows = result.metrics.map((m) => [
    path.relative(root, m.shotId),
    m.sharpness.toFixed(1),
    m.sharpnessRaw.toFixed(1),
    m.noise.toFixed(1),
    m.exposure.shadowsPct.toFixed(1),
    m.exposure.highlightsPct.toFixed(1),
    m.exposure.meanLuma.toFixed(0),
    m.lowConfidence ? "low" : "ok",
  ]);
  const out = render(["shot", "sharp", "sharpRaw", "noise", "shadow%", "clip%", "luma", "confidence"], rows);
  for (const e of result.errors) out.push(`error: ${path.relative(root, e.path)}: ${e.error}`);
  out.push(`${result.metrics.length} shots measured, ${result.errors.length} errors, ${seconds.toFixed(2)}s`);
  return out.join("\n") + "\n";
}

function groupsTable(root: string, result: GroupResult, errors: string[], seconds: number): string {
  const groupOf = new Map(result.groups.flatMap((g) => g.shotIDs.map((id) => [id, g.id] as const)));
  const linkTo = new Map(result.links.map((l) => [l.to, l]));
  const order = result.groups.flatMap((g) => g.shotIDs);
  const rows = order.map((id) => {
    const l = linkTo.get(id);
    return [groupOf.get(id) ?? "-", path.relative(root, id), l ? (l.joined ? "joined" : "new group") : "first", l?.reason ?? ""];
  });
  const out = render(["group", "shot", "decision", "reason"], rows);
  out.push(...errors);
  const multi = result.groups.filter((g) => g.shotIDs.length > 1).length;
  out.push(`${order.length} shots in ${result.groups.length} groups (${multi} with 2+ shots), ${errors.length} errors, ${seconds.toFixed(2)}s`);
  return out.join("\n") + "\n";
}

function cullTable(result: CullResult): string {
  const verdict = new Map(result.verdicts.map((v) => [v.shotId, v]));
  const rows = result.groups.flatMap((g) =>
    g.shotIDs.map((id) => {
      const v = verdict.get(id);
      return [g.id, path.relative(result.root, id), v?.verdict ?? "-", v ? v.score.toFixed(2) : "-", v?.reasons.join("; ") ?? ""];
    }),
  );
  const out = render(["group", "shot", "verdict", "score", "reasons"], rows);
  for (const e of result.errors) out.push(`error: ${path.relative(result.root, e.path)}: ${e.error}`);
  const count = (k: string): number => result.verdicts.filter((v) => v.verdict === k).length;
  const { shots, cached, seconds } = result.stats;
  if (result.cancelled) out.push(`cancelled: ${cached + result.stats.measured} of ${shots} shots measured and cached; rerun to resume`);
  else out.push(`${shots} shots in ${result.groups.length} groups: ${count("pick")} pick, ${count("reject")} reject, ${count("none")} kept; ${cached} cached, ${result.errors.length} errors, ${seconds.toFixed(2)}s`);
  return out.join("\n") + "\n";
}

function sidecarTable(root: string, results: SidecarResult[], errors: FileError[], applied: boolean): string {
  const rows = results.map((r) => [
    r.action,
    path.relative(root, r.sidecar),
    `rating ${r.target.rating}${r.target.label ? `, label ${r.target.label}` : ""}`,
    r.reason ?? "",
  ]);
  const out = rows.length ? render(["sidecar", "file", "value", "note"], rows) : [];
  for (const e of errors) out.push(`error: ${path.relative(root, e.path)}: ${e.error}`);
  const count = (k: string): number => results.filter((r) => r.action === k).length;
  const summary = `${count("create")} create, ${count("update")} update, ${count("unchanged")} unchanged, ${count("refused")} refused, ${errors.length} errors`;
  if (applied) out.push(`sidecars written: ${results.filter((r) => r.written).length} (${summary})`);
  else out.push(`dry run, nothing written (${summary}); pass --apply to write`);
  return out.join("\n") + "\n";
}

function evalTable(report: EvalReport, errors: string[]): string {
  const pct = (r: number | null): string => (r === null ? "-" : `${(r * 100).toFixed(0)}%`);
  const row = (name: string, r: SetReport): string[] => [
    name,
    r.labelled.toString(),
    `${r.rejects.caught}/${r.rejects.total} (${pct(r.rejects.rate)})`,
    `${r.picks.surfaced}/${r.picks.total} (${pct(r.picks.rate)})`,
    `${r.falseRejects.count} (${r.falseRejects.ofPicks} picks)`,
    r.missing.length.toString(),
  ];
  const out = render(["set", "labelled", "rejects caught", "picks surfaced", "false rejects", "missing"], [row("tune", report.tune), row("holdout", report.holdout)]);
  for (const [name, r] of [["tune", report.tune], ["holdout", report.holdout]] as const) {
    for (const s of r.falseRejects.shots) out.push(`false reject (${name}): ${s}`);
    for (const s of r.missing) out.push(`missing (${name}): ${s}`);
  }
  out.push(...errors);
  return out.join("\n") + "\n";
}

export async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      help: { type: "boolean", short: "h" },
      json: { type: "boolean" },
      apply: { type: "boolean" },
      offsets: { type: "string" },
      labels: { type: "string" },
      sidecar: { type: "string" },
      csv: { type: "string" },
    },
  });
  const [command, folder] = positionals;
  if (values.help || !command) {
    process.stdout.write(HELP);
    return 0;
  }
  if (!["scan", "previews", "metrics", "groups", "cull", "eval"].includes(command) || !folder) {
    process.stderr.write(`faucet: unknown command or missing folder\n\n${HELP}`);
    return 2;
  }
  const style = values.sidecar ?? "adobe";
  if (style !== "adobe" && style !== "darktable") {
    process.stderr.write(`faucet: --sidecar must be adobe or darktable\n`);
    return 2;
  }
  if (values.csv !== undefined && path.extname(values.csv).toLowerCase() !== ".csv") {
    process.stderr.write(`faucet: --csv needs a .csv file name\n`);
    return 2;
  }
  const root = path.resolve(folder);
  if (!statSync(root, { throwIfNoEntry: false })?.isDirectory()) {
    process.stderr.write(`faucet: not a folder: ${root}\n`);
    return 2;
  }
  const et = new ExifTool();
  try {
    if (command === "eval") {
      const labels = validateLabels(JSON.parse(readFileSync(values.labels ?? path.join(root, "labels.json"), "utf8")));
      const { report, errors } = await runEval(root, labels, et);
      const errLines = errors.map((e) => `error: ${path.relative(root, e.path)}: ${e.error}`);
      process.stdout.write(values.json ? JSON.stringify({ ...report, errors }, null, 2) + "\n" : evalTable(report, errLines));
      return 0;
    }
    if (command === "cull") {
      const cameraOffsets = values.offsets ? (JSON.parse(readFileSync(values.offsets, "utf8")) as Record<string, number>) : undefined;
      const abort = new AbortController();
      const onSigint = (): void => abort.abort();
      process.once("SIGINT", onSigint);
      const tty = process.stderr.isTTY && !values.json;
      try {
        const result = await cull(root, et, {
          signal: abort.signal,
          ...(cameraOffsets ? { cameraOffsets } : {}),
          onProgress: (done, total) => {
            if (tty) process.stderr.write(`\r${done}/${total} shots${done === total ? "\n" : ""}`);
          },
        });
        if (result.cancelled) {
          process.stdout.write(values.json ? JSON.stringify(result, null, 2) + "\n" : cullTable(result));
          return 130;
        }
        const apply = values.apply === true;
        const sidecars = await writeSidecars(result.shots, result.verdicts, et, { style: style as SidecarStyle, apply });
        if (values.csv) writeFileSync(values.csv, cullCsv(root, result.shots, result.groups, result.verdicts, sidecars.results));
        const json = { ...result, sidecars: { applied: apply, ...sidecars } };
        process.stdout.write(values.json ? JSON.stringify(json, null, 2) + "\n" : cullTable(result) + sidecarTable(root, sidecars.results, sidecars.errors, apply));
        return 0;
      } finally {
        process.off("SIGINT", onSigint);
      }
    }
    const start = performance.now();
    const result = await scanFolder(root, et);
    if (command === "metrics" || command === "groups") {
      const previews = await previewShots(result.shots, et, cacheDir());
      const orientation = new Map(result.shots.map((s) => [s.id, s.orientation]));
      const measured = await measureShots(
        previews.previews.map((p) => ({ shotId: p.shotId, path: p.path, orientation: orientation.get(p.shotId) ?? null, lowConfidence: p.lowConfidence })),
      );
      const seconds = (performance.now() - start) / 1000;
      const errors = [...result.errors, ...previews.errors, ...measured.errors];
      if (command === "groups") {
        const cameraOffsets = values.offsets ? (JSON.parse(readFileSync(values.offsets, "utf8")) as Record<string, number>) : {};
        const byShot = new Map(measured.metrics.map((m) => [m.shotId, m]));
        const grouped = groupShots(result.shots, byShot, { cameraOffsets });
        const done = (performance.now() - start) / 1000;
        const errLines = errors.map((e) => `error: ${path.relative(root, e.path)}: ${e.error}`);
        process.stdout.write(values.json ? JSON.stringify({ root, ...grouped, errors }, null, 2) + "\n" : groupsTable(root, grouped, errLines, done));
        return 0;
      }
      const text = metricsTable(root, { metrics: measured.metrics, errors }, seconds);
      process.stdout.write(values.json ? JSON.stringify({ root, metrics: measured.metrics, errors }, null, 2) + "\n" : text);
      return 0;
    }
    if (command === "previews") {
      const previews = await previewShots(result.shots, et, cacheDir());
      const seconds = (performance.now() - start) / 1000;
      const json = { root, previews: previews.previews, errors: [...result.errors, ...previews.errors] };
      process.stdout.write(values.json ? JSON.stringify(json, null, 2) + "\n" : previewTable(result, previews, seconds));
      return 0;
    }
    const seconds = (performance.now() - start) / 1000;
    process.stdout.write(values.json ? JSON.stringify(result, null, 2) + "\n" : table(result, seconds));
    return 0;
  } finally {
    await et.end();
  }
}

process.exitCode = await main(process.argv.slice(2));
