import { contextBridge, ipcRenderer } from "electron";
import type { SmokeResult } from "../core/smoke.ts";

const api = {
  smoke: (): Promise<SmokeResult> => ipcRenderer.invoke("faucet:smoke"),
};

export type FaucetApi = typeof api;

contextBridge.exposeInMainWorld("faucet", api);
