// Fails (exit 1) if forbidden Electron settings appear in source or config.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scanDirs = ["src"];
const scanFiles = ["package.json", "electron.vite.config.ts", "electron-builder.yml", "electron-builder.json"];
const exts = new Set([".ts", ".tsx", ".js", ".mjs", ".cjs", ".json", ".yml", ".yaml"]);

const forbidden = [
  { name: "webSecurity: false", re: /["']?webSecurity["']?\s*:\s*false/ },
  { name: "nodeIntegration: true", re: /["']?nodeIntegration["']?\s*:\s*true/ },
  { name: "nodeIntegrationInWorker: true", re: /["']?nodeIntegrationInWorker["']?\s*:\s*true/ },
  { name: "contextIsolation: false", re: /["']?contextIsolation["']?\s*:\s*false/ },
  { name: "sandbox: false", re: /["']?sandbox["']?\s*:\s*false/ },
];

function* walk(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name !== "node_modules") yield* walk(full);
    } else if (exts.has(path.extname(e.name))) {
      yield full;
    }
  }
}

const files = [
  ...scanDirs.flatMap((d) => [...walk(path.join(root, d))]),
  ...scanFiles.map((f) => path.join(root, f)),
];

const hits = [];
for (const file of files) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    continue;
  }
  text.split(/\r?\n/).forEach((line, i) => {
    for (const rule of forbidden) {
      if (rule.re.test(line)) hits.push(`${path.relative(root, file)}:${i + 1}: ${rule.name}`);
    }
  });
}

if (hits.length > 0) {
  console.error("Forbidden Electron settings found:\n" + hits.join("\n"));
  process.exit(1);
}
console.log(`check-security: OK (${files.length} paths checked)`);
