// Hold-out regression check: fails (exit 1) if the hold-out set scores worse than eval/baseline.json.
// Needs FAUCET_FIXTURES (with labels.json); skips with exit 0 without it, so CI never needs photos.
//   npx tsx scripts/check-eval.ts            compare against the baseline
//   npx tsx scripts/check-eval.ts --update   rewrite the baseline (both sets) from this run
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ExifTool } from "exiftool-vendored";
import { regressions, runEval, validateLabels, type EvalReport } from "../src/core/eval.ts";

const TOLERANCE = { rateDrop: 0.05, falseRejects: 0 };
const baselinePath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "eval", "baseline.json");

const fixtures = process.env.FAUCET_FIXTURES;
if (!fixtures) {
  console.log("check-eval: FAUCET_FIXTURES not set, skipped");
  process.exit(0);
}
const labels = validateLabels(JSON.parse(readFileSync(path.join(fixtures, "labels.json"), "utf8")));
const et = new ExifTool();
let report: EvalReport;
try {
  ({ report } = await runEval(fixtures, labels, et));
} finally {
  await et.end();
}

if (process.argv.includes("--update")) {
  writeFileSync(baselinePath, JSON.stringify(report, null, 2) + "\n");
  console.log(`check-eval: baseline written to ${baselinePath}`);
  process.exit(0);
}
const baseline = JSON.parse(readFileSync(baselinePath, "utf8")) as EvalReport;
const found = regressions(report.holdout, baseline.holdout, TOLERANCE);
for (const f of found) console.error(`check-eval: hold-out regression: ${f}`);
console.log(found.length ? "check-eval: FAILED" : "check-eval: hold-out not worse than baseline");
process.exit(found.length ? 1 : 0);
