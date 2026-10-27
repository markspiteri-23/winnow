import path from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, ipcMain } from "electron";
import { exiftool } from "exiftool-vendored";
import { faceReport, faceSpikeImages, smokeScan, type FileFaces } from "../core/smoke.ts";

const here = path.dirname(fileURLToPath(import.meta.url));

function createWindow(): void {
  const win = new BrowserWindow({
    width: 900,
    height: 640,
    webPreferences: {
      preload: path.join(here, "..", "preload", "index.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (e) => e.preventDefault());

  const devUrl = process.env["ELECTRON_RENDERER_URL"];
  if (!app.isPackaged && devUrl) void win.loadURL(devUrl);
  else void win.loadFile(path.join(here, "..", "renderer", "index.html"));
}

ipcMain.handle("faucet:smoke", () => smokeScan(process.env["FAUCET_SMOKE_DIR"], exiftool));
// Face harness (FAUCET_FACE_DIR): downscale before detection (long side 1024 px), then judge the detections.
const FACE_MAX_SIDE = 1024;
ipcMain.handle("faucet:faceSpike", () => faceSpikeImages(process.env["FAUCET_FACE_DIR"], exiftool, FACE_MAX_SIDE));
ipcMain.handle("faucet:faceReport", (_e, detections: unknown) => {
  if (!Array.isArray(detections)) throw new Error("faceReport: expected an array");
  return faceReport(process.env["FAUCET_FACE_DIR"], exiftool, FACE_MAX_SIDE, detections as FileFaces[]);
});

app.whenReady().then(createWindow);
app.on("window-all-closed", () => app.quit());
app.on("will-quit", () => void exiftool.end());
