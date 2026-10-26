import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp, { type Sharp } from "sharp";
import { afterAll, describe, expect, it } from "vitest";
import { loadOriented } from "./image.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = mkdtempSync(path.join(tmpdir(), "winnow-image-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

// Upright 40x20 test card: one colour per quadrant.
const W = 40;
const H = 20;
const TL = [255, 0, 0];
const TR = [0, 255, 0];
const BL = [0, 0, 255];
const BR = [255, 255, 0];

function uprightCard(): Buffer {
  const buf = Buffer.alloc(W * H * 3);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const c = y < H / 2 ? (x < W / 2 ? TL : TR) : x < W / 2 ? BL : BR;
      buf.set(c, (y * W + x) * 3);
    }
  }
  return buf;
}

/**
 * Stores the upright card the way a camera would for EXIF orientation `o` (mirror, then rotate, as two
 * pipelines because sharp ignores their chain order). The autoOrient check below verifies it independently.
 */
async function stored(o: number): Promise<Sharp> {
  const inverse: Record<number, [("flip" | "flop" | undefined)?, number?]> = {
    2: ["flop"], 3: [undefined, 180], 4: ["flip"], 5: ["flip", 90], 6: [undefined, 270], 7: ["flop", 90], 8: [undefined, 90],
  };
  const [mirror, angle] = inverse[o] ?? [];
  let img = sharp(uprightCard(), { raw: { width: W, height: H, channels: 3 } });
  if (mirror) img = img[mirror]();
  const { data, info } = await img.raw().toBuffer({ resolveWithObject: true });
  const out = sharp(data, { raw: { width: info.width, height: info.height, channels: 3 } });
  return angle ? out.rotate(angle) : out;
}

function pixel(p: { data: Buffer; width: number; channels: number }, x: number, y: number): number[] {
  const i = (y * p.width + x) * p.channels;
  return [...p.data.subarray(i, i + 3)];
}

function expectUpright(p: { data: Buffer; width: number; height: number; channels: number }): void {
  expect([p.width, p.height]).toEqual([W, H]);
  const near = (got: number[], want: number[]): void => got.forEach((v, i) => expect(Math.abs(v - (want[i] ?? 0))).toBeLessThan(40));
  near(pixel(p, W / 4, H / 4), TL);
  near(pixel(p, (3 * W) / 4, H / 4), TR);
  near(pixel(p, W / 4, (3 * H) / 4), BL);
  near(pixel(p, (3 * W) / 4, (3 * H) / 4), BR);
}

describe("loadOriented", () => {
  for (let o = 1; o <= 8; o++) {
    it(`orientation ${o} comes out upright, ignoring the file's own (wrong) tag`, async () => {
      // Sanity: libvips' own auto-orient agrees that our stored image + tag o is upright.
      const tagged = path.join(tmp, `tagged-${o}.jpg`);
      await (await stored(o)).jpeg({ quality: 95 }).withMetadata({ orientation: o }).toFile(tagged);
      const auto = await sharp(tagged).autoOrient().raw().toBuffer({ resolveWithObject: true });
      expectUpright({ data: auto.data, width: auto.info.width, height: auto.info.height, channels: auto.info.channels });

      // Like an embedded preview: same pixels, but its own tag says something else.
      const wrong = path.join(tmp, `wrong-${o}.jpg`);
      await (await stored(o)).jpeg({ quality: 95 }).withMetadata({ orientation: (o % 8) + 1 }).toFile(wrong);
      expectUpright(await loadOriented(wrong, o));
    });
  }

  it("treats null orientation as upright and downscales without enlarging", async () => {
    const file = path.join(tmp, "plain.jpg");
    await (await stored(1)).jpeg().toFile(file);
    const small = await loadOriented(file, null, { maxSide: 20, greyscale: true });
    expect([small.width, small.height, small.channels]).toEqual([20, 10, 1]);
    const same = await loadOriented(file, 6, { maxSide: 1000 });
    expect([same.width, same.height]).toEqual([H, W]);
  });
});

describe("pixel loading rule", () => {
  it("no source file outside image.ts calls sharp(", () => {
    const src = path.resolve(here, "..");
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walk(full);
        else if (/\.(m|c)?tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) && full !== path.join(here, "image.ts")) {
          if (readFileSync(full, "utf8").includes("sharp(")) offenders.push(path.relative(src, full));
        }
      }
    };
    walk(src);
    expect(offenders).toEqual([]);
  });
});
