import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { exiftool } from "exiftool-vendored";
import sharp from "sharp";
import { afterAll, describe, expect, it } from "vitest";
import { smokeScan } from "./smoke.ts";

const dir = mkdtempSync(path.join(tmpdir(), "faucet-smoke-"));

afterAll(async () => {
  await exiftool.end();
  rmSync(dir, { recursive: true, force: true });
});

describe("smokeScan", () => {
  it("reads generated JPEGs and records a broken file without aborting", async () => {
    await sharp({ create: { width: 64, height: 48, channels: 3, background: { r: 255, g: 255, b: 255 } } })
      .jpeg()
      .toFile(path.join(dir, "a.jpg"));
    writeFileSync(path.join(dir, "B.JPG"), "not a jpeg");

    const result = await smokeScan(dir, exiftool);

    expect(result.versions.exiftool).toMatch(/^\d+\.\d+/);
    expect(result.files).toHaveLength(2);
    const [broken, good] = result.files;
    expect(broken).toMatchObject({ file: "B.JPG", ok: false });
    expect(good).toMatchObject({ file: "a.jpg", ok: true, mimeType: "image/jpeg", probe: { width: 64, height: 48 } });
    expect(good?.probe?.meanBrightness).toBeGreaterThan(240);
  });
});
