import sharp from "sharp";

export interface ImageProbe {
  width: number;
  height: number;
  meanBrightness: number;
}

export function imageLibVersions(): { sharp: string; vips: string } {
  return { sharp: sharp.versions.sharp ?? "unknown", vips: sharp.versions.vips };
}

/** Phase 1 packaging smoke check only. Phase 3 replaces pixel loading with `loadOriented()`. */
export async function probeImage(file: string): Promise<ImageProbe> {
  const img = sharp(file);
  const meta = await img.metadata();
  const stats = await img.resize(32).greyscale().stats();
  return { width: meta.width, height: meta.height, meanBrightness: Math.round(stats.channels[0]?.mean ?? 0) };
}
