import sharp from "sharp";

// The ONLY module allowed to call sharp() (image.test.ts enforces this).

export interface ImageProbe {
  width: number;
  height: number;
  meanBrightness: number;
}

export interface Pixels {
  /** Raw interleaved 8-bit samples, row-major, already in display orientation. */
  data: Buffer;
  width: number;
  height: number;
  channels: number;
}

export interface LoadOptions {
  /** Downscale so the long side is at most this many pixels (never enlarges). */
  maxSide?: number;
  greyscale?: boolean;
}

export function imageLibVersions(): { sharp: string; vips: string } {
  return { sharp: sharp.versions.sharp ?? "unknown", vips: sharp.versions.vips };
}

/** Phase 1 packaging smoke check only. */
export async function probeImage(file: string): Promise<ImageProbe> {
  const img = sharp(file);
  const meta = await img.metadata();
  const stats = await img.resize(32).greyscale().stats();
  return { width: meta.width, height: meta.height, meanBrightness: Math.round(stats.channels[0]?.mean ?? 0) };
}

/** Stored pixel size from the file header, without decoding pixels. */
export async function imageSize(file: string): Promise<{ width: number; height: number }> {
  const meta = await sharp(file).metadata();
  return { width: meta.width, height: meta.height };
}

// EXIF orientation -> mirror first, then rotate clockwise.
const ORIENT: Record<number, { mirror?: "flip" | "flop"; rotate?: number }> = {
  2: { mirror: "flop" },
  3: { rotate: 180 },
  4: { mirror: "flip" },
  5: { mirror: "flip", rotate: 90 },
  6: { rotate: 90 },
  7: { mirror: "flop", rotate: 90 },
  8: { rotate: 270 },
};

/**
 * Loads pixels and turns them upright using `orientation` (EXIF 1-8, taken from the RAW), ignoring any
 * orientation tag inside `file` itself: embedded previews often carry a wrong or missing one.
 * Mirror and rotate run in separate pipelines because sharp does not honour their chain order.
 */
export async function loadOriented(file: string, orientation: number | null, opts: LoadOptions = {}): Promise<Pixels> {
  const { mirror, rotate } = ORIENT[orientation ?? 1] ?? {};
  let img = sharp(file);
  if (mirror === "flip") img = img.flip();
  if (mirror === "flop") img = img.flop();
  if (opts.maxSide) {
    img = img.resize({ width: opts.maxSide, height: opts.maxSide, fit: "inside", withoutEnlargement: true });
  }
  if (opts.greyscale) img = img.greyscale();
  let { data, info } = await img.raw().toBuffer({ resolveWithObject: true });
  if (rotate) {
    const raw = { width: info.width, height: info.height, channels: info.channels };
    ({ data, info } = await sharp(data, { raw }).rotate(rotate).raw().toBuffer({ resolveWithObject: true }));
  }
  return { data, width: info.width, height: info.height, channels: info.channels };
}
