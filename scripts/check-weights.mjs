// Fails (exit 1) if any weights.json value lacks a numeric value or a calibratedOn note.
// With --release (CI on a version tag) it also fails on notes still marked PROVISIONAL.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const file = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "weights.json");
const release = process.argv.includes("--release");
const values = JSON.parse(readFileSync(file, "utf8")).values ?? {};
const problems = [];
for (const [key, e] of Object.entries(values)) {
  if (typeof e?.value !== "number" || !Number.isFinite(e.value)) problems.push(`${key}: no numeric value`);
  if (typeof e?.calibratedOn !== "string" || e.calibratedOn.trim() === "") problems.push(`${key}: no calibratedOn note`);
  else if (release && /PROVISIONAL/i.test(e.calibratedOn)) problems.push(`${key}: still PROVISIONAL`);
}
for (const p of problems) console.error(`check-weights: ${p}`);
console.log(problems.length ? `check-weights: FAILED (${problems.length})` : `check-weights: ${Object.keys(values).length} weights OK`);
process.exit(problems.length ? 1 : 0);
