import { mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { exiftool } from "exiftool-vendored";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cacheDir } from "./paths.ts";
import { previewShots } from "./preview.ts";
import { scanFolder } from "./scan.ts";
import { weight } from "./weights.ts";

const root = mkdtempSync(path.join(tmpdir(), "faucet-preview-"));
const photos = path.join(root, "photos");
const cache = path.join(root, "cache");

async function jpeg(file: string, width: number, height: number): Promise<void> {
  await sharp({ create: { width, height, channels: 3, background: "#808080" } }).jpeg().toFile(file);
}

/** A fake RAW: a JPEG with an embedded ThumbnailImage, renamed to .ARW (exiftool reads by content). */
async function rawWithThumbnail(file: string): Promise<void> {
  const tmp = `${file}.tmp.jpg`;
  const thumb = `${file}.thumb.jpg`;
  await jpeg(tmp, 800, 600);
  await jpeg(thumb, 160, 120);
  await exiftool.write(tmp, {}, { writeArgs: [`-ThumbnailImage<=${thumb}`, "-overwrite_original"] });
  rmSync(thumb);
  renameSync(tmp, file);
}

beforeAll(async () => {
  mkdirSync(photos);
  await jpeg(path.join(photos, "jpeg_only.jpg"), 1600, 1000);
  await rawWithThumbnail(path.join(photos, "thumb_only.ARW"));
  await rawWithThumbnail(path.join(photos, "paired.ARW"));
  await jpeg(path.join(photos, "PAIRED.jpg"), 1200, 800);
  writeFileSync(path.join(photos, "broken.ARW"), "x".repeat(2000));
});

afterAll(async () => {
  await exiftool.end();
  rmSync(root, { recursive: true, force: true });
});

describe("previewShots", () => {
  it("walks the fallback chain, flags small previews and records failures", async () => {
    const scan = await scanFolder(photos, exiftool);
    const { previews, errors } = await previewShots(scan.shots, exiftool, cache);
    const by = (name: string) => previews.find((p) => path.basename(p.shotId) === name);

    expect(by("jpeg_only.jpg")).toMatchObject({ source: "jpeg", width: 1600, height: 1000, lowConfidence: false });
    expect(by("jpeg_only.jpg")?.path).toBe(path.join(photos, "jpeg_only.jpg"));
    // Camera JPEG beats the RAW's thumbnail.
    expect(by("paired.ARW")).toMatchObject({ source: "jpeg", width: 1200, lowConfidence: false });
    // Only a thumbnail: usable but low confidence, and cached outside the photo folder.
    const thumb = by("thumb_only.ARW");
    expect(thumb).toMatchObject({ source: "ThumbnailImage", width: 160, height: 120, lowConfidence: true });
    expect(path.dirname(thumb?.path ?? "")).toBe(path.join(cache, "previews"));
    expect(scan.shots.find((s) => s.id === thumb?.shotId)).toMatchObject({ previewPath: thumb?.path, lowConfidence: true });
    // broken.ARW is already rejected by the scan; nothing else fails.
    expect(errors).toEqual([]);
    expect(160).toBeLessThan(weight("previewMinLongSide"));
  });

  it("reuses the cache and never touches the photo folder", async () => {
    const before = readdirSync(photos).sort();
    const scan = await scanFolder(photos, exiftool);
    const first = await previewShots(scan.shots, exiftool, cache);
    const cached = first.previews.find((p) => p.source === "ThumbnailImage")?.path ?? "";
    const mtime = statSync(cached).mtimeMs;
    await previewShots(scan.shots, exiftool, cache);
    expect(statSync(cached).mtimeMs).toBe(mtime);
    expect(readdirSync(photos).sort()).toEqual(before);
  });

  it("records a shot with no usable preview instead of aborting", async () => {
    const shot = {
      id: path.join(photos, "broken.ARW"),
      files: [{ path: path.join(photos, "broken.ARW"), kind: "raw" as const }],
      captureDate: null, cameraModel: null, iso: null, orientation: null, width: null, height: null, lowConfidence: false,
    };
    const { previews, errors } = await previewShots([shot], exiftool, cache);
    expect(previews).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.error).toMatch(/no usable preview/);
    expect(shot.lowConfidence).toBe(true);
  });
});

describe("cacheDir", () => {
  it("follows each OS convention", () => {
    expect(cacheDir("darwin", {}, "/Users/a")).toBe(path.join("/Users/a", "Library", "Caches", "faucet"));
    expect(cacheDir("win32", { LOCALAPPDATA: "C:\\Users\\a\\AppData\\Local" }, "C:\\Users\\a")).toBe(
      "C:\\Users\\a\\AppData\\Local\\faucet\\cache",
    );
  });
});

// Real-photo check: only when $FAUCET_FIXTURES is set (never in CI).
const fixtures = process.env.FAUCET_FIXTURES;
describe.skipIf(!fixtures)("real ARW fixture", () => {
  it("yields a usable preview and reports its size", async () => {
    const scan = await scanFolder(fixtures ?? "", exiftool);
    const shot = scan.shots.find((s) => s.files.some((f) => f.kind === "raw" && /\.arw$/i.test(f.path)));
    expect(shot, "no .ARW in $FAUCET_FIXTURES").toBeDefined();
    const rawOnly = { ...shot!, files: shot!.files.filter((f) => f.kind === "raw") };
    const { previews, errors } = await previewShots([rawOnly], exiftool, path.join(root, "fixture-cache"));
    expect(errors).toEqual([]);
    const p = previews[0]!;
    console.log(`ARW preview: ${path.basename(rawOnly.id)} ${p.source} ${p.width}x${p.height} lowConfidence=${p.lowConfidence}`);
    expect(p.lowConfidence).toBe(false);
  });
});
