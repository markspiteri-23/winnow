/// <reference types="vite/client" />
// Phase 7 spike: MediaPipe face landmarker in a module Web Worker (WASM, CPU delegate).
// MediaPipe feeds images through WebGL, so it cannot run in a Node worker_thread; a renderer worker has OffscreenCanvas.
import { FaceLandmarker } from "@mediapipe/tasks-vision";
import loaderUrl from "@mediapipe/tasks-vision/vision_wasm_module_internal.js?url";
import wasmUrl from "@mediapipe/tasks-vision/vision_wasm_module_internal.wasm?url";
import modelUrl from "../../resources/models/face_landmarker.task?url";

export interface FaceRequest {
  id: number;
  width: number;
  height: number;
  channels: number;
  data: Uint8Array;
}

export interface SpikeFace {
  /** Normalised 0-1 bounding box of the landmarks. */
  box: { x: number; y: number; w: number; h: number };
  /** "full" = found on the whole frame, "tile" = only on a crop (small face). */
  pass: "full" | "tile";
  /** Blendshape scores 0-1; high = closed. Left/right are the subject's own. */
  eyeBlinkLeft: number;
  eyeBlinkRight: number;
}

export type FaceResponse =
  | { kind: "ready"; initMs: number }
  | { kind: "result"; id: number; ms: number; faces: SpikeFace[] }
  | { kind: "error"; id?: number; error: string };

const ctx = self as unknown as {
  postMessage(msg: FaceResponse): void;
  onmessage: ((e: MessageEvent<FaceRequest>) => void) | null;
};

type Box = SpikeFace["box"];

function toRgba(req: FaceRequest): ImageData {
  const n = req.width * req.height;
  const out = new Uint8ClampedArray(n * 4);
  const c = req.channels;
  for (let i = 0; i < n; i++) {
    const s = i * c;
    const grey = c < 3;
    out[i * 4] = req.data[s] ?? 0;
    out[i * 4 + 1] = req.data[grey ? s : s + 1] ?? 0;
    out[i * 4 + 2] = req.data[grey ? s : s + 2] ?? 0;
    out[i * 4 + 3] = 255;
  }
  return new ImageData(out, req.width, req.height);
}

function blink(categories: { categoryName: string; score: number }[], name: string): number {
  return categories.find((c) => c.categoryName === name)?.score ?? Number.NaN;
}

function crop(img: ImageData, x0: number, y0: number, w: number, h: number): ImageData {
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    const from = ((y0 + y) * img.width + x0) * 4;
    out.set(img.data.subarray(from, from + w * 4), y * w * 4);
  }
  return new ImageData(out, w, h);
}

function iou(a: Box, b: Box): number {
  const ix = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
  const iy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  const inter = ix * iy;
  return inter / (a.w * a.h + b.w * b.h - inter);
}

/** Faces in `img`, boxes mapped into the full frame (offset/size in px). */
function detectIn(lm: FaceLandmarker, img: ImageData, ox: number, oy: number, fw: number, fh: number, pass: SpikeFace["pass"]): SpikeFace[] {
  const res = lm.detect(img);
  return res.faceLandmarks.map((pts, i): SpikeFace => {
    const xs = pts.map((p) => (ox + p.x * img.width) / fw);
    const ys = pts.map((p) => (oy + p.y * img.height) / fh);
    const x = Math.min(...xs);
    const y = Math.min(...ys);
    const cats = res.faceBlendshapes[i]?.categories ?? [];
    return {
      box: { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y },
      pass,
      eyeBlinkLeft: blink(cats, "eyeBlinkLeft"),
      eyeBlinkRight: blink(cats, "eyeBlinkRight"),
    };
  });
}

/**
 * The bundled detector is BlazeFace short-range (192 px input, trained on large faces), so small faces are missed.
 * Second pass: overlapping tiles of a third of the long side; tile faces that overlap a full-frame face are dropped.
 */
function detectTiled(lm: FaceLandmarker, img: ImageData): SpikeFace[] {
  const faces = detectIn(lm, img, 0, 0, img.width, img.height, "full");
  const tile = Math.round(Math.max(img.width, img.height) / 3);
  const step = Math.round(tile / 2);
  for (let y = 0; y < img.height; y += step) {
    for (let x = 0; x < img.width; x += step) {
      const w = Math.min(tile, img.width - x);
      const h = Math.min(tile, img.height - y);
      if (w < step || h < step) continue;
      for (const f of detectIn(lm, crop(img, x, y, w, h), x, y, img.width, img.height, "tile")) {
        if (faces.every((g) => iou(f.box, g.box) < 0.3)) faces.push(f);
      }
    }
  }
  return faces;
}

const t0 = performance.now();
const ready = FaceLandmarker.createFromOptions(
  { wasmLoaderPath: new URL(loaderUrl, self.location.href).href, wasmBinaryPath: new URL(wasmUrl, self.location.href).href },
  {
    baseOptions: { modelAssetPath: new URL(modelUrl, self.location.href).href, delegate: "CPU" },
    runningMode: "IMAGE",
    numFaces: 20,
    outputFaceBlendshapes: true,
  },
);
ready.then(
  () => ctx.postMessage({ kind: "ready", initMs: Math.round(performance.now() - t0) }),
  (err: unknown) => ctx.postMessage({ kind: "error", error: String(err) }),
);

ctx.onmessage = (e) => {
  const req = e.data;
  ready
    .then((lm) => {
      const start = performance.now();
      const faces = detectTiled(lm, toRgba(req));
      ctx.postMessage({ kind: "result", id: req.id, ms: Math.round(performance.now() - start), faces });
    })
    .catch((err: unknown) => ctx.postMessage({ kind: "error", id: req.id, error: String(err) }));
};
