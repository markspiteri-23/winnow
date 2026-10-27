import type { FaucetApi } from "../preload/index.ts";
import type { FaceRequest, FaceResponse } from "./face-worker.ts";

declare global {
  interface Window {
    faucet: FaucetApi;
  }
}

const out = document.getElementById("result");
if (out) {
  window.faucet
    .smoke()
    .then((result) => {
      out.textContent = JSON.stringify(result, null, 2);
      out.dataset["status"] = "done";
    })
    .catch((err: unknown) => {
      out.textContent = String(err);
      out.dataset["status"] = "error";
    });
}

// Face harness: run the face landmarker worker over the images main prepared, then let main judge the detections.
async function faceSpike(): Promise<unknown> {
  const { images, errors } = await window.faucet.faceSpikeImages();
  const worker = new Worker(new URL("./face-worker.ts", import.meta.url), { type: "module" });
  const pending = new Map<number, (r: FaceResponse) => void>();
  const ready = new Promise<FaceResponse>((resolve) => {
    worker.onmessage = (e: MessageEvent<FaceResponse>) => {
      const r = e.data;
      if (r.kind === "ready" || (r.kind === "error" && r.id === undefined)) resolve(r);
      else pending.get(r.id ?? -1)?.(r);
    };
    worker.onerror = (e) => resolve({ kind: "error", error: e.message });
  });
  const init = await ready;
  if (init.kind === "error") throw new Error(init.error);
  const results = [];
  for (const [id, img] of images.entries()) {
    const r = await new Promise<FaceResponse>((resolve) => {
      pending.set(id, resolve);
      worker.postMessage({ id, width: img.width, height: img.height, channels: img.channels, data: img.data } satisfies FaceRequest);
    });
    results.push({ file: img.file, width: img.width, height: img.height, ...r });
  }
  worker.terminate();
  const report = await window.faucet.faceReport(results.map((r) => ({ file: r.file, faces: r.kind === "result" ? r.faces : [] })));
  return { init, results, report, errors };
}

const face = document.getElementById("face");
if (face) {
  faceSpike()
    .then((result) => {
      face.textContent = JSON.stringify(result, null, 2);
      face.dataset["status"] = "done";
    })
    .catch((err: unknown) => {
      face.textContent = String(err);
      face.dataset["status"] = "error";
    });
}
