import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import sharp from "sharp";

// The MediaPipe face landmarker loads and runs inside the PACKAGED app on both OSes, and main judges its detections.

function packagedExecutable(): string {
  const release = path.resolve("release");
  if (process.platform === "win32") return path.join(release, "win-unpacked", "Faucet.exe");
  const dir = readdirSync(release).find((d) => d.startsWith("mac"));
  return path.join(release, dir ?? "mac", "Faucet.app", "Contents", "MacOS", "Faucet");
}

interface ShotFaces {
  file: string;
  faceCount: number;
  allEyesOpen: boolean;
  anyEyesClosed: boolean;
  blinkVsSibling: boolean;
  faces: { eyes: string }[];
}

interface Harness {
  init: { kind: string; initMs?: number };
  results: { kind: string; file: string; ms: number; faces: unknown[] }[];
  report: { shots: ShotFaces[]; errors: unknown[] };
}

async function runSpike(faceDir: string, outName: string): Promise<Harness> {
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
    expect(data.report.errors).toEqual([]);
    expect(data.report.shots).toEqual([
      expect.objectContaining({ file: "grey.jpg", faceCount: 0, allEyesOpen: false, anyEyesClosed: false, blinkVsSibling: false }),
    ]);
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
  const byFile = new Map(data.report.shots.map((r) => [r.file, r]));
  const shot = (f: string): ShotFaces | undefined => byFile.get(f);
  const eyes = (f: string): string[] => shot(f)?.faces.map((x) => x.eyes) ?? [];
  // Labelled by eye; thresholds in weights.json (Phase 8).
  expect(shot("Test-26.ARW")).toMatchObject({ faceCount: 1, anyEyesClosed: true, blinkVsSibling: true }); // eyes closed, looking down
  expect(shot("Test-25.ARW")).toMatchObject({ faceCount: 1, allEyesOpen: true }); // same burst, same person, eyes open (small face)
  expect(shot("Test-12.jpg")).toMatchObject({ faceCount: 1, allEyesOpen: true }); // close portrait
  expect(eyes("Test-9.jpg")).toEqual(["open", "open"]); // two people
  expect(shot("Test-10.jpg")).toMatchObject({ faceCount: 2, anyEyesClosed: false }); // two people, one half-turned (tile pass)
});
