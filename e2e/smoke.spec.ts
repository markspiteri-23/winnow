import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import sharp from "sharp";
import type { SmokeResult } from "../src/core/smoke.ts";

/** Finds the electron-builder `--dir` output for this OS. */
function packagedExecutable(): string {
  const release = path.resolve("release");
  if (process.platform === "win32") return path.join(release, "win-unpacked", "Winnow.exe");
  if (process.platform === "darwin") {
    const dir = readdirSync(release).find((d) => d.startsWith("mac"));
    if (dir) return path.join(release, dir, "Winnow.app", "Contents", "MacOS", "Winnow");
  }
  throw new Error(`No packaged app for ${process.platform} in ${release}`);
}

test("packaged app loads sharp + exiftool and scans a generated folder", async () => {
  const exe = packagedExecutable();
  expect(existsSync(exe), `missing ${exe}; run npm run build && npm run package`).toBe(true);

  const dir = mkdtempSync(path.join(tmpdir(), "winnow-e2e-"));
  await sharp({ create: { width: 80, height: 60, channels: 3, background: { r: 20, g: 20, b: 20 } } })
    .jpeg()
    .toFile(path.join(dir, "dark.jpg"));
  writeFileSync(path.join(dir, "broken.jpg"), "not a jpeg");

  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  env["WINNOW_SMOKE_DIR"] = dir;

  const app = await electron.launch({ executablePath: exe, env });
  try {
    expect(await app.evaluate(({ app }) => app.isPackaged)).toBe(true);
    const win = await app.firstWindow();
    const result = win.locator("#result[data-status='done']");
    await expect(result).toBeVisible({ timeout: 30_000 });
    const data = JSON.parse((await result.textContent()) ?? "") as SmokeResult;

    expect(data.versions.sharp).toMatch(/^\d+\.\d+/);
    expect(data.versions.exiftool).toMatch(/^\d+\.\d+/);
    expect(data.files).toEqual([
      expect.objectContaining({ file: "broken.jpg", ok: false }),
      expect.objectContaining({ file: "dark.jpg", ok: true, probe: expect.objectContaining({ width: 80, height: 60 }) }),
    ]);
    await win.screenshot({ path: path.join("test-results", `smoke-${process.platform}.png`) });
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
