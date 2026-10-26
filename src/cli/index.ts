import { statSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { ExifTool } from "exiftool-vendored";
import { measureShots, type MetricsResult } from "../core/metrics.ts";
import { cacheDir } from "../core/paths.ts";
import { previewShots, type PreviewResult } from "../core/preview.ts";
import { scanFolder, type ScanResult } from "../core/scan.ts";

const HELP = `faucet - local photo culler (no cloud)

Usage:
  faucet scan <folder> [--json]       List shots (RAW+JPEG pairs collapsed) with EXIF
  faucet previews <folder> [--json]   Extract/cache the best preview per shot and report its size
  faucet metrics <folder> [--json]    Sharpness, noise and exposure per shot (from its preview)

Options:
  --json     Machine-readable output
  --apply    Write sidecars (default is dry-run)
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

export async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      help: { type: "boolean", short: "h" },
      json: { type: "boolean" },
      apply: { type: "boolean" },
    },
  });
  const [command, folder] = positionals;
  if (values.help || !command) {
    process.stdout.write(HELP);
    return 0;
  }
  if (!["scan", "previews", "metrics"].includes(command) || !folder) {
    process.stderr.write(`faucet: unknown command or missing folder\n\n${HELP}`);
    return 2;
  }
  const root = path.resolve(folder);
  if (!statSync(root, { throwIfNoEntry: false })?.isDirectory()) {
    process.stderr.write(`faucet: not a folder: ${root}\n`);
    return 2;
  }
  const et = new ExifTool();
  try {
    const start = performance.now();
    const result = await scanFolder(root, et);
    if (command === "metrics") {
      const previews = await previewShots(result.shots, et, cacheDir());
      const orientation = new Map(result.shots.map((s) => [s.id, s.orientation]));
      const measured = await measureShots(
        previews.previews.map((p) => ({ shotId: p.shotId, path: p.path, orientation: orientation.get(p.shotId) ?? null, lowConfidence: p.lowConfidence })),
      );
      const seconds = (performance.now() - start) / 1000;
      const errors = [...result.errors, ...previews.errors, ...measured.errors];
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
