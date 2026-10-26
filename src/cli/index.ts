import { statSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { ExifTool } from "exiftool-vendored";
import { scanFolder, type ScanResult } from "../core/scan.ts";

const HELP = `winnow - local photo culler (no cloud)

Usage:
  winnow scan <folder> [--json]   List shots (RAW+JPEG pairs collapsed) with EXIF

Options:
  --json     Machine-readable output
  --apply    Write sidecars (default is dry-run)
  -h, --help Show this help
`;

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
  const header = ["shot", "files", "captured", "camera", "iso", "orient", "size"];
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]?.length ?? 0)));
  const line = (r: string[]): string => r.map((c, i) => c.padEnd(widths[i] ?? 0)).join("  ").trimEnd();
  const out = [line(header), ...rows.map(line)];
  for (const e of result.errors) out.push(`error: ${path.relative(result.root, e.path)}: ${e.error}`);
  const files = result.shots.reduce((n, s) => n + s.files.length, 0);
  out.push(`${result.shots.length} shots (${files} files), ${result.errors.length} errors, ${seconds.toFixed(2)}s`);
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
  if (command !== "scan" || !folder) {
    process.stderr.write(`winnow: unknown command or missing folder\n\n${HELP}`);
    return 2;
  }
  const root = path.resolve(folder);
  if (!statSync(root, { throwIfNoEntry: false })?.isDirectory()) {
    process.stderr.write(`winnow: not a folder: ${root}\n`);
    return 2;
  }
  const et = new ExifTool();
  try {
    const start = performance.now();
    const result = await scanFolder(root, et);
    const seconds = (performance.now() - start) / 1000;
    process.stdout.write(values.json ? JSON.stringify(result, null, 2) + "\n" : table(result, seconds));
    return 0;
  } finally {
    await et.end();
  }
}

process.exitCode = await main(process.argv.slice(2));
