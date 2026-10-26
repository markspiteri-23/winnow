import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import sharp from "sharp";

// Phase 7 spike: the MediaPipe face landmarker loads and runs inside the PACKAGED app on both OSes.

function packagedExecutable(): string {
  const release = path.resolve("release");
  if (process.platform === "win32") return path.join(release, "win-unpacked", "Faucet.exe");
  const dir = readdirSync(release).find((d) => d.startsWith("mac"));
  return path.join(release, dir ?? "mac", "Faucet.app", "Contents", "MacOS", "Faucet");
}

interface Face {
  eyeBlinkLeft: number;
  eyeBlinkRight: number;
}

async function runSpike(faceDir: string, outName: string): Promise<{ init: { kind: string; initMs?: number }; results: { kind: string; file: string; ms: number; faces: unknown[] }[] }> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  env["FAUCET_FACE_DIR"] = faceDir;
  const app = await electron.launch({ executablePath: packagedExecutable(), env });
  try {
    const win = await app.firstWindow();
    const face = win.locator("#face:is([data-status='done'], [data-status='error'])");
    await expect(face).toBeVisible({ timeout: 120_000 });
    const text = (await face.textContent()) ?? "";
    mkdirSync("test-results", { recursive: true });
    writeFileSync(path.join("test-results", outName), text);
    expect(await face.getAttribute("data-status"), text).toBe("done");
    return JSON.parse(text);
  } finally {
    await app.close();
  }
}

test("face landmarker runs in the packaged app on generated images", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "faucet-face-"));
  try {
    await sharp({ create: { width: 1200, height: 800, channels: 3, background: { r: 120, g: 120, b: 120 } } })
      .jpeg()
      .toFile(path.join(dir, "grey.jpg"));
    const data = await runSpike(dir, `face-${process.platform}.json`);
    expect(data.init.kind).toBe("ready");
    expect(data.results).toEqual([expect.objectContaining({ kind: "result", file: "grey.jpg", faces: [] })]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Local only: real faces, chosen in Phase 7 (see NOTES.md). Never runs in CI.
// FAUCET_FACE_FIXTURES overrides the folder (any folder of RAW/JPEG shots).
const fixtures = process.env["FAUCET_FIXTURES"];
const faceFixtures = process.env["FAUCET_FACE_FIXTURES"] ?? (fixtures ? path.join(fixtures, "faces") : "");
test("face landmarker on real fixtures", async () => {
  test.skip(!faceFixtures, "FAUCET_FIXTURES not set");
  const data = await runSpike(faceFixtures, `face-fixtures-${process.platform}.json`);
  expect(data.init.kind).toBe("ready");
  const byFile = new Map(data.results.map((r) => [r.file, r]));
  const faces = (f: string): Face[] => (byFile.get(f)?.faces ?? []) as Face[];
  const closed = (f: Face): boolean => f.eyeBlinkLeft > 0.5 && f.eyeBlinkRight > 0.5;
  // Labelled by eye. 0.5 is a spike cut-off only; Phase 8 calibrates the real one.
  expect(faces("Test-26.ARW").map(closed)).toEqual([true]); // eyes closed, looking down
  expect(faces("Test-25.ARW").map(closed)).toEqual([false]); // same person, eyes open, small face (tile pass)
  expect(faces("Test-12.jpg").map(closed)).toEqual([false]); // close portrait
  expect(faces("Test-9.jpg").map(closed)).toEqual([false, false]); // two people
  expect(faces("Test-10.jpg")).toHaveLength(2); // two people, one half-turned (tile pass)
});
