import { contextBridge, ipcRenderer } from "electron";
import type { SmokeResult, SpikeImage } from "../core/smoke.ts";
import type { FileError } from "../core/types.ts";

const api = {
  smoke: (): Promise<SmokeResult> => ipcRenderer.invoke("faucet:smoke"),
  // Phase 7 spike only.
  faceSpikeImages: (): Promise<{ images: SpikeImage[]; errors: FileError[] }> => ipcRenderer.invoke("faucet:faceSpike"),
};

export type FaucetApi = typeof api;

contextBridge.exposeInMainWorld("faucet", api);
