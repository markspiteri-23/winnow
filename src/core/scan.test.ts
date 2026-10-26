import { copyFileSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { exiftool, type WriteTags } from "exiftool-vendored";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pairFiles, scanFolder } from "./scan.ts";

const root = mkdtempSync(path.join(tmpdir(), "faucet-scan-"));
const sub = path.join(root, "day2");

/** Writes a small JPEG with the given EXIF. Written as .jpg first so exiftool accepts it, then renamed. */
async function jpeg(file: string, tags: WriteTags): Promise<void> {
  const tmp = `${file}.tmp.jpg`;
  await sharp({ create: { width: 60, height: 40, channels: 3, background: "#808080" } }).jpeg().toFile(tmp);
  if (Object.keys(tags).length > 0) await exiftool.write(tmp, tags, { writeArgs: ["-overwrite_original"] });
  renameSync(tmp, file);
}

beforeAll(async () => {
  mkdirSync(sub);
  // RAW+JPEG pair with different case. The "RAW" is a JPEG copy; exiftool reads it by content.
  await jpeg(path.join(root, "IMG_1.ARW"), {
    DateTimeOriginal: "2024:05:01 10:00:00",
    SubSecTimeOriginal: "45",
    Model: "ILCE-7M4",
    ISO: 3200,
    "Orientation#": 6,
  });
  await jpeg(path.join(root, "img_1.jpg"), { DateTimeOriginal: "2024:05:01 10:00:00", "Orientation#": 1 });
  await jpeg(path.join(sub, "no_date.JPG"), { Model: "ILCE-7M4" });
  await jpeg(path.join(sub, "old_date.jpeg"), { DateTimeOriginal: "1970:01:01 00:00:00" });
  await jpeg(path.join(sub, "future.jpg"), { DateTimeOriginal: "2099:01:01 00:00:00" });
  writeFileSync(path.join(sub, "corrupt.jpg"), "not a jpeg");
  copyFileSync(path.join(root, "img_1.jpg"), path.join(root, "._IMG_1.jpg"));
  writeFileSync(path.join(root, "notes.txt"), "ignored");
});

afterAll(async () => {
  await exiftool.end();
  rmSync(root, { recursive: true, force: true });
});

describe("pairFiles", () => {
  it("pairs RAW+JPEG case-insensitively, RAW first", () => {
    const a = path.join("x", "IMG_1.ARW");
    const b = path.join("x", "img_1.jpg");
    expect(pairFiles([b, a])).toEqual([
      [
        { path: a, kind: "raw" },
        { path: b, kind: "jpeg" },
      ],
    ]);
  });

  it("does not pair across folders", () => {
    expect(pairFiles([path.join("x", "A.ARW"), path.join("y", "A.JPG")])).toHaveLength(2);
  });

  it("splits ambiguous keys rather than merging", () => {
    const shots = pairFiles([path.join("x", "A.JPG"), path.join("x", "a.jpg"), path.join("x", "a.arw")]);
    expect(shots).toHaveLength(3);
    expect(shots.every((s) => s.length === 1)).toBe(true);
  });
});

describe("scanFolder", () => {
  it("collapses pairs, reads EXIF, handles bad dates and records corrupt files", async () => {
    const result = await scanFolder(root, exiftool);
    const byName = new Map(result.shots.map((s) => [path.basename(s.id), s]));

    expect([...byName.keys()].sort()).toEqual(["IMG_1.ARW", "future.jpg", "no_date.JPG", "old_date.jpeg"]);

    const pair = byName.get("IMG_1.ARW");
    expect(pair?.files.map((f) => f.kind)).toEqual(["raw", "jpeg"]);
    expect(pair).toMatchObject({
      captureDate: "2024-05-01T10:00:00.450",
      cameraModel: "ILCE-7M4",
      iso: 3200,
      orientation: 6, // from the RAW, not the JPEG
      width: 60,
      height: 40,
      lowConfidence: false,
    });

    expect(byName.get("no_date.JPG")?.captureDate).toBeNull();
    expect(byName.get("old_date.jpeg")?.captureDate).toBeNull();
    expect(byName.get("future.jpg")?.captureDate).toBeNull();

    expect(result.errors).toEqual([{ path: path.join(sub, "corrupt.jpg"), error: expect.stringMatching(/not a recognised image/) }]);
  });
});
