import { loadOriented, type Pixels } from "./image.ts";
import type { FileError } from "./types.ts";
import { weight } from "./weights.ts";

export interface Exposure {
  /** % of pixels at or below `shadowClipLevel`. */
  shadowsPct: number;
  /** % of pixels at or above `highlightClipLevel`. */
  highlightsPct: number;
  /** Mean luma, 0-255. */
  meanLuma: number;
}

export interface Metrics {
  shotId: string;
  /** Noise-corrected RMS gradient (Tenengrad) at the `sharpnessPercentile` tile. Higher = sharper. */
  sharpness: number;
  /** Same, before noise correction. */
  sharpnessRaw: number;
  /** Estimated noise sigma in luma levels (Immerkaer, flattest tiles). */
  noise: number;
  exposure: Exposure;
  /** 64-bit difference hash (dHash) of the upright luma, 16 hex chars; near-duplicates differ in few bits. */
  hash: string;
  /** 16x16 block-mean luma, z-normalised (row-major, 2 decimals): a coarse layout fingerprint for grouping. */
  thumb: number[];
  /** Analysed size after downscale. */
  width: number;
  height: number;
  lowConfidence: boolean;
}

export interface MetricsInput {
  shotId: string;
  path: string;
  orientation: number | null;
  lowConfidence: boolean;
}

export interface MetricsResult {
  metrics: Metrics[];
  errors: FileError[];
}

/** Luma plane (first channel of a greyscale load) as floats. */
function lumaPlane(px: Pixels): Float32Array {
  const out = new Float32Array(px.width * px.height);
  for (let i = 0; i < out.length; i++) out[i] = px.data[i * px.channels] ?? 0;
  return out;
}

/** Separable [1 2 1]/4 blur, edges clamped. */
function lightBlur(src: Float32Array, w: number, h: number): Float32Array {
  const tmp = new Float32Array(src.length);
  const out = new Float32Array(src.length);
  for (let y = 0; y < h; y++) {
    const r = y * w;
    for (let x = 0; x < w; x++) {
      const l = src[r + Math.max(x - 1, 0)]!;
      const c = src[r + x]!;
      const rr = src[r + Math.min(x + 1, w - 1)]!;
      tmp[r + x] = (l + 2 * c + rr) / 4;
    }
  }
  for (let y = 0; y < h; y++) {
    const up = Math.max(y - 1, 0) * w;
    const dn = Math.min(y + 1, h - 1) * w;
    for (let x = 0; x < w; x++) out[y * w + x] = (tmp[up + x]! + 2 * tmp[y * w + x]! + tmp[dn + x]!) / 4;
  }
  return out;
}

/**
 * Expected Sobel energy (Gx^2 + Gy^2) of white noise with sigma 1 after the [1 2 1]/4 blur:
 * per axis, combined kernels are [-1 -2 0 2 1]/4 and [1 4 6 4 1]/4, so 2 * (10/16) * (70/16).
 */
const NOISE_ENERGY = 2 * (10 / 16) * (70 / 16);

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const i = Math.min(sorted.length - 1, Math.max(0, Math.round((p / 100) * (sorted.length - 1))));
  return sorted[i]!;
}

/** dHash: box-average luma into 9x8 cells, bit = left cell brighter than its right neighbour. */
export function dHash(luma: Float32Array, w: number, h: number): string {
  const cells = blockMeans(luma, w, h, 9, 8);
  let hex = "";
  for (let row = 0; row < 8; row++) {
    let byte = 0;
    for (let col = 0; col < 8; col++) byte = (byte << 1) | (cells[row * 9 + col]! > cells[row * 9 + col + 1]! ? 1 : 0);
    hex += byte.toString(16).padStart(2, "0");
  }
  return hex;
}

/** Mean luma of a `cols` x `rows` grid of blocks. */
function blockMeans(luma: Float32Array, w: number, h: number, cols: number, rows: number): Float64Array {
  const sum = new Float64Array(cols * rows);
  const count = new Float64Array(cols * rows);
  for (let y = 0; y < h; y++) {
    const r = Math.min(rows - 1, Math.floor((y * rows) / h));
    for (let x = 0; x < w; x++) {
      const c = r * cols + Math.min(cols - 1, Math.floor((x * cols) / w));
      sum[c] = sum[c]! + luma[y * w + x]!;
      count[c] = count[c]! + 1;
    }
  }
  return sum.map((v, i) => v / Math.max(1, count[i]!));
}

/** 16x16 block means, z-normalised so exposure shifts do not matter. All zeros for a flat frame. */
export function layoutThumb(luma: Float32Array, w: number, h: number): number[] {
  const m = blockMeans(luma, w, h, 16, 16);
  const mean = m.reduce((a, b) => a + b, 0) / m.length;
  const sd = Math.sqrt(m.reduce((a, b) => a + (b - mean) ** 2, 0) / m.length);
  return Array.from(m, (v) => (sd < 1e-6 ? 0 : Math.round(((v - mean) / sd) * 100) / 100));
}

/** Pearson correlation of two layout thumbs, -1..1 (0 when either is flat). */
export function similarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i]! * b[i]!;
  return Math.round((dot / a.length) * 100) / 100;
}

/** Number of differing bits between two dHash hex strings. */
export function hamming(a: string, b: string): number {
  let d = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i += 2) {
    let x = parseInt(a.slice(i, i + 2), 16) ^ parseInt(b.slice(i, i + 2), 16);
    while (x) {
      d += x & 1;
      x >>= 1;
    }
  }
  return d;
}

/** Pure analysis of a loaded image; exported for tests. */
export function analysePixels(px: Pixels): Omit<Metrics, "shotId" | "lowConfidence"> {
  const { width: w, height: h } = px;
  const luma = lumaPlane(px);
  const blurred = lightBlur(luma, w, h);
  const tile = Math.max(8, Math.round(weight("sharpnessTileSize")));

  const tileEnergy: number[] = [];
  const tileNoise: number[] = [];
  for (let ty = 0; ty + tile <= h; ty += tile) {
    for (let tx = 0; tx + tile <= w; tx += tile) {
      let energy = 0;
      let lap = 0;
      let n = 0;
      for (let y = Math.max(ty, 1); y < Math.min(ty + tile, h - 1); y++) {
        for (let x = Math.max(tx, 1); x < Math.min(tx + tile, w - 1); x++) {
          const at = (img: Float32Array, dx: number, dy: number): number => img[(y + dy) * w + x + dx]!;
          const gx = at(blurred, 1, -1) + 2 * at(blurred, 1, 0) + at(blurred, 1, 1)
            - at(blurred, -1, -1) - 2 * at(blurred, -1, 0) - at(blurred, -1, 1);
          const gy = at(blurred, -1, 1) + 2 * at(blurred, 0, 1) + at(blurred, 1, 1)
            - at(blurred, -1, -1) - 2 * at(blurred, 0, -1) - at(blurred, 1, -1);
          energy += gx * gx + gy * gy;
          // Immerkaer noise mask [1 -2 1; -2 4 -2; 1 -2 1] on the unblurred luma.
          lap += Math.abs(
            at(luma, -1, -1) - 2 * at(luma, 0, -1) + at(luma, 1, -1)
            - 2 * at(luma, -1, 0) + 4 * at(luma, 0, 0) - 2 * at(luma, 1, 0)
            + at(luma, -1, 1) - 2 * at(luma, 0, 1) + at(luma, 1, 1),
          );
          n++;
        }
      }
      if (n === 0) continue;
      tileEnergy.push(energy / n);
      tileNoise.push((Math.sqrt(Math.PI / 2) * lap) / (6 * n));
    }
  }

  // Flat tiles (lowest gradient energy) carry mostly noise, not detail.
  const order = tileEnergy.map((_, i) => i).sort((a, b) => tileEnergy[a]! - tileEnergy[b]!);
  const flat = order.slice(0, Math.max(1, Math.ceil(order.length * (weight("noiseFlatTileFraction")))));
  const noise = percentile(flat.map((i) => tileNoise[i]!), 50);

  const p = weight("sharpnessPercentile");
  const raw = percentile(tileEnergy, p);
  const corrected = percentile(tileEnergy.map((e) => Math.max(0, e - NOISE_ENERGY * noise * noise)), p);

  const lo = weight("shadowClipLevel");
  const hi = weight("highlightClipLevel");
  let shadows = 0;
  let highlights = 0;
  let sum = 0;
  for (const v of luma) {
    if (v <= lo) shadows++;
    if (v >= hi) highlights++;
    sum += v;
  }
  const total = Math.max(1, luma.length);
  const round = (v: number, d = 2): number => Math.round(v * 10 ** d) / 10 ** d;
  return {
    sharpness: round(Math.sqrt(corrected)),
    sharpnessRaw: round(Math.sqrt(raw)),
    noise: round(noise),
    hash: dHash(luma, w, h),
    thumb: layoutThumb(luma, w, h),
    exposure: {
      shadowsPct: round((100 * shadows) / total),
      highlightsPct: round((100 * highlights) / total),
      meanLuma: round(sum / total),
    },
    width: w,
    height: h,
  };
}

/**
 * Downscales the (preview) image, then measures sharpness, noise and exposure.
 * `maxSide` 0 analyses at native size (only for the preview-vs-full-res comparison script).
 */
export async function measureShot(input: MetricsInput, maxSide = Math.round(weight("analysisMaxSide"))): Promise<Metrics> {
  const px = await loadOriented(input.path, input.orientation, { maxSide, greyscale: true });
  return { shotId: input.shotId, ...analysePixels(px), lowConfidence: input.lowConfidence };
}

/** One failure is recorded and never aborts the run. Main thread for now; workers come in Phase 9. */
export async function measureShots(inputs: MetricsInput[]): Promise<MetricsResult> {
  const metrics: Metrics[] = [];
  const errors: FileError[] = [];
  for (const input of inputs) {
    try {
      metrics.push(await measureShot(input));
    } catch (err) {
      errors.push({ path: input.shotId, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return { metrics, errors };
}
