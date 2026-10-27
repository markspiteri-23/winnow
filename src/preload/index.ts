import { contextBridge, ipcRenderer } from "electron";
import type { FaceReport, FileFaces, SmokeResult, SpikeImage } from "../core/smoke.ts";
import type { FileError } from "../core/types.ts";

const api = {
  smoke: (): Promise<SmokeResult> => ipcRenderer.invoke("faucet:smoke"),
  // Face harness (FAUCET_FACE_DIR) until the real pipeline exists.
  faceSpikeImages: (): Promise<{ images: SpikeImage[]; errors: FileError[] }> => ipcRenderer.invoke("faucet:faceSpike"),
  faceReport: (detections: FileFaces[]): Promise<FaceReport> => ipcRenderer.invoke("faucet:faceReport", detections),
};

export type FaucetApi = typeof api;

contextBridge.exposeInMainWorld("faucet", api);
