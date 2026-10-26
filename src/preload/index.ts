import { contextBridge, ipcRenderer } from "electron";
import type { SmokeResult } from "../core/smoke.ts";

const api = {
  smoke: (): Promise<SmokeResult> => ipcRenderer.invoke("winnow:smoke"),
};

export type WinnowApi = typeof api;

contextBridge.exposeInMainWorld("winnow", api);
