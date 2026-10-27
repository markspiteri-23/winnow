import path from "node:path";
import type { Group } from "./group.ts";
import { weight } from "./weights.ts";

/** Normalised 0-1 box in the upright frame. */
export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** One raw detection from the face landmarker worker (renderer). */
export interface DetectedFace {
  /** Box of all landmarks. */
  box: Box;
  /** "full" = found on the whole frame, "tile" = only on a crop (small face, less trusted). */
  pass: "full" | "tile";
  /** Blendshape scores 0-1; high = closed. Left/right are the subject's own. */
  eyeBlinkLeft: number;
  eyeBlinkRight: number;
  /** Boxes of the eye contour landmarks. */
  leftEye: Box;
  rightEye: Box;
}

export type EyeState = "open" | "closed" | "unknown";

export interface Face {
  box: Box;
  pass: DetectedFace["pass"];
  /** Long side of the face box in px at the analysed size. */
  sizePx: number;
  /** 1 - the less-closed eye's blink score: 1 = wide open, 0 = both shut. */
  eyesOpen: number;
  eyes: EyeState;
  /** Narrower eye width / wider eye width: ~1 facing the camera, low for a half-turned face or profile. */
  frontal: number;
  /** Luma std dev in the eye regions; low = eyes hidden (sunglasses, deep shadow). */
  eyeContrast: number;
  /** % clipped pixels in the eye regions (glare on glasses). */
  eyeGlarePct: number;
  /** Tenengrad (RMS Sobel) inside the face box; compare within the same person only. */
  sharpness: number;
  /** Same person across the group's frames ("p1", "p2", ...); set by `compareFaces`. */
  person: string | null;
  /** Best `eyesOpen` of the same person in another frame of the group, if matched. */
  siblingEyesOpen: number | null;
  reasons: string[];
}

export interface IgnoredFace {
  box: Box;
  sizePx: number;
  reason: string;
}

export interface ShotFacesInput {
  shotId: string;
  faces: Face[];
  ignored: IgnoredFace[];
}

export interface ShotFaces extends ShotFacesInput {
  faceCount: number;
  /** At least one face and every face reads open. */
  allEyesOpen: boolean;
  /** At least one face reads closed. */
  anyEyesClosed: boolean;
  /** A closed face whose same person has open eyes in another frame of the group (the only blink Phase 9 may reject). */
  blinkVsSibling: boolean;
  reasons: string[];
}

export interface Luma {
  data: Float32Array;
  width: number;
  height: number;
}

const round = (v: number, d = 2): number => Math.round(v * 10 ** d) / 10 ** d;

/** Pixel rectangle of a normalised box grown by `pad` (fraction of its own size), clamped to the image. */
function pixelRect(b: Box, img: Luma, pad = 0): { x0: number; y0: number; x1: number; y1: number } {
  const px = b.w * pad;
  const py = b.h * pad;
  return {
    x0: Math.max(0, Math.floor((b.x - px) * img.width)),
    y0: Math.max(0, Math.floor((b.y - py) * img.height)),
    x1: Math.min(img.width, Math.ceil((b.x + b.w + px) * img.width)),
    y1: Math.min(img.height, Math.ceil((b.y + b.h + py) * img.height)),
  };
}

/** RMS Sobel gradient inside the box (interior pixels only). */
export function regionSharpness(img: Luma, b: Box): number {
  const { x0, y0, x1, y1 } = pixelRect(b, img);
  const w = img.width;
  const at = (x: number, y: number): number => img.data[y * w + x]!;
  let energy = 0;
  let n = 0;
  for (let y = Math.max(y0, 1); y < Math.min(y1, img.height - 1); y++) {
    for (let x = Math.max(x0, 1); x < Math.min(x1, w - 1); x++) {
      const gx = at(x + 1, y - 1) + 2 * at(x + 1, y) + at(x + 1, y + 1) - at(x - 1, y - 1) - 2 * at(x - 1, y) - at(x - 1, y + 1);
      const gy = at(x - 1, y + 1) + 2 * at(x, y + 1) + at(x + 1, y + 1) - at(x - 1, y - 1) - 2 * at(x, y - 1) - at(x + 1, y - 1);
      energy += gx * gx + gy * gy;
      n++;
    }
  }
  return n === 0 ? 0 : round(Math.sqrt(energy / n));
}

/** Luma std dev and % clipped pixels inside both eye contour boxes (unpadded: padding would add the skin-vs-lens edge of sunglasses). */
export function eyeRegionStats(img: Luma, eyes: Box[]): { contrast: number; glarePct: number } {
  const hi = weight("highlightClipLevel");
  let sum = 0;
  let sq = 0;
  let clipped = 0;
  let n = 0;
  for (const eye of eyes) {
    const { x0, y0, x1, y1 } = pixelRect(eye, img);
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const v = img.data[y * img.width + x]!;
        sum += v;
        sq += v * v;
        if (v >= hi) clipped++;
        n++;
      }
    }
  }
  if (n === 0) return { contrast: 0, glarePct: 0 };
  const mean = sum / n;
  return { contrast: round(Math.sqrt(Math.max(0, sq / n - mean * mean))), glarePct: round((100 * clipped) / n) };
}

/**
 * Filters detections and reads each face's eyes. Conservative: anything doubtful (profile, hidden or glared eyes,
 * a score between the open and closed cut-offs) is "unknown", never "closed".
 */
export function measureFaces(detected: DetectedFace[], img: Luma): { faces: Face[]; ignored: IgnoredFace[] } {
  const minSize = weight("faceMinSizePx");
  const minAspect = weight("faceTileMinAspect");
  const openMax = weight("eyeOpenMaxBlink");
  const closedMin = weight("eyeClosedMinBlink");
  const minFrontal = weight("faceMinFrontal");
  const minContrast = weight("eyeMinContrast");
  const maxGlare = weight("eyeMaxGlarePct");

  const faces: Face[] = [];
  const ignored: IgnoredFace[] = [];
  for (const d of detected) {
    const wPx = d.box.w * img.width;
    const hPx = d.box.h * img.height;
    const sizePx = Math.round(Math.max(wPx, hPx));
    const aspect = hPx / Math.max(1, wPx);
    if (sizePx < minSize) {
      ignored.push({ box: d.box, sizePx, reason: `face ${sizePx}px < ${minSize}px` });
      continue;
    }
    // Small-face pass only: real faces are taller than wide; the tile false positives (goose, paint plate) were not.
    if (d.pass === "tile" && aspect < minAspect) {
      ignored.push({ box: d.box, sizePx, reason: `small-face detection with aspect ${round(aspect)} < ${minAspect}, likely not a face` });
      continue;
    }
    if (!Number.isFinite(d.eyeBlinkLeft) || !Number.isFinite(d.eyeBlinkRight)) {
      ignored.push({ box: d.box, sizePx, reason: "no eye scores" });
      continue;
    }

    const blink = Math.min(d.eyeBlinkLeft, d.eyeBlinkRight);
    const lw = d.leftEye.w * img.width;
    const rw = d.rightEye.w * img.width;
    const frontal = round(Math.min(lw, rw) / Math.max(1e-6, lw, rw));
    const { contrast, glarePct } = eyeRegionStats(img, [d.leftEye, d.rightEye]);
    const reasons: string[] = [];
    let eyes: EyeState;
    if (glarePct > maxGlare) {
      eyes = "unknown";
      reasons.push(`glare over the eyes (${glarePct}% clipped > ${maxGlare}%)`);
    } else if (contrast < minContrast) {
      eyes = "unknown";
      reasons.push(`eyes not visible (eye contrast ${contrast} < ${minContrast}): sunglasses or shadow?`);
    } else if (blink <= openMax) {
      eyes = "open";
      reasons.push(`eyes open (blink ${round(blink)} <= ${openMax})`);
    } else if (blink < closedMin) {
      eyes = "unknown";
      reasons.push(`eyes half closed or unclear (blink ${round(blink)} between ${openMax} and ${closedMin})`);
    } else if (frontal < minFrontal) {
      eyes = "unknown";
      reasons.push(`eyes read closed (blink ${round(blink)}) but face is turned (frontal ${frontal} < ${minFrontal})`);
    } else {
      eyes = "closed";
      reasons.push(`eyes closed (both blink >= ${closedMin}: ${round(d.eyeBlinkLeft)}/${round(d.eyeBlinkRight)})`);
    }
    faces.push({
      box: d.box,
      pass: d.pass,
      sizePx,
      eyesOpen: round(1 - blink),
      eyes,
      frontal,
      eyeContrast: contrast,
      eyeGlarePct: glarePct,
      sharpness: regionSharpness(img, d.box),
      person: null,
      siblingEyesOpen: null,
      reasons,
    });
  }
  return { faces, ignored };
}

const centre = (b: Box): [number, number] => [b.x + b.w / 2, b.y + b.h / 2];
const side = (b: Box): number => Math.max(b.w, b.h);

/** Same person in two frames of a burst: centres close relative to face size and similar size. */
function samePerson(a: Box, b: Box): number | null {
  const [ax, ay] = centre(a);
  const [bx, by] = centre(b);
  const scale = (side(a) + side(b)) / 2;
  const dist = Math.hypot(ax - bx, ay - by) / scale;
  const ratio = Math.max(side(a), side(b)) / Math.min(side(a), side(b));
  if (dist > weight("faceMatchMaxDistance") || ratio > weight("faceMatchMaxSizeRatio")) return null;
  return dist;
}

/**
 * Matches each face to the same person in the other frames of its group, then sets the shot flags.
 * When two frames each hold exactly one face it is taken as the same person (a burst re-frames, so positions move);
 * otherwise faces are matched by position and size, and an unmatched face is never compared.
 */
export function compareFaces(groups: Group[], shots: ShotFacesInput[]): ShotFaces[] {
  const byId = new Map(shots.map((s) => [s.shotId, s]));
  const out: ShotFaces[] = [];
  for (const g of groups) {
    const members = g.shotIDs.map((id) => byId.get(id)).filter((s): s is ShotFacesInput => s !== undefined);
    const faces = members.map((m) => m.faces.map((f) => ({ ...f, reasons: [...f.reasons] })));
    const people: { id: string; seen: { shot: number; face: Face }[] }[] = [];
    const single = members.every((m) => m.faces.length <= 1);
    for (const [si, list] of faces.entries()) {
      const taken = new Set<number>();
      for (const face of list) {
        let best: { p: number; d: number } | null = null;
        for (const [pi, p] of people.entries()) {
          if (taken.has(pi) || p.seen.some((s) => s.shot === si)) continue;
          const last = p.seen[p.seen.length - 1]!.face;
          const d = single ? 0 : samePerson(face.box, last.box);
          if (d !== null && (best === null || d < best.d)) best = { p: pi, d };
        }
        if (best === null) {
          people.push({ id: `p${people.length + 1}`, seen: [{ shot: si, face }] });
          taken.add(people.length - 1);
        } else {
          people[best.p]!.seen.push({ shot: si, face });
          taken.add(best.p);
        }
      }
    }
    for (const p of people) {
      for (const s of p.seen) {
        s.face.person = p.id;
        const others = p.seen.filter((o) => o.shot !== s.shot);
        if (others.length === 0) {
          if (s.face.eyes === "closed") s.face.reasons.push("no other frame of this person to compare");
          continue;
        }
        const bestOther = others.reduce((a, b) => (b.face.eyesOpen > a.face.eyesOpen ? b : a));
        s.face.siblingEyesOpen = bestOther.face.eyesOpen;
        if (s.face.eyes === "closed") {
          const open = others.find((o) => o.face.eyes === "open");
          s.face.reasons.push(
            open
              ? `same person has eyes open in ${path.basename(members[open.shot]!.shotId)}`
              : "no frame in the group has this person's eyes open",
          );
        }
      }
    }
    for (const [si, m] of members.entries()) {
      const list = faces[si]!;
      const closed = list.filter((f) => f.eyes === "closed");
      const blinkVsSibling = closed.some((f) => people.some((p) => p.id === f.person && p.seen.some((o) => o.face !== f && o.face.eyes === "open")));
      const reasons: string[] = [];
      if (list.length === 0) reasons.push(m.ignored.length ? `no usable face (${m.ignored.length} ignored)` : "no faces");
      else if (closed.length) reasons.push(`${closed.length} of ${list.length} faces with eyes closed${blinkVsSibling ? ", open in another frame" : ""}`);
      else if (list.every((f) => f.eyes === "open")) reasons.push(`all ${list.length} faces with eyes open`);
      else reasons.push(`${list.filter((f) => f.eyes === "unknown").length} of ${list.length} faces with eyes unclear`);
      out.push({
        shotId: m.shotId,
        faces: list,
        ignored: m.ignored,
        faceCount: list.length,
        allEyesOpen: list.length > 0 && list.every((f) => f.eyes === "open"),
        anyEyesClosed: closed.length > 0,
        blinkVsSibling,
        reasons,
      });
    }
  }
  return out;
}
