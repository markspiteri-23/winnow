import path from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, ipcMain } from "electron";
import { exiftool } from "exiftool-vendored";
import { smokeScan } from "../core/smoke.ts";

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

ipcMain.handle("winnow:smoke", () => smokeScan(process.env["WINNOW_SMOKE_DIR"], exiftool));

app.whenReady().then(createWindow);
app.on("window-all-closed", () => app.quit());
app.on("will-quit", () => void exiftool.end());
