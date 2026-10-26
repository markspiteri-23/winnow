import os from "node:os";
import path from "node:path";

/** Per-user cache root: macOS ~/Library/Caches/faucet, Windows %LOCALAPPDATA%\faucet\cache, else XDG. */
export function cacheDir(platform: NodeJS.Platform = process.platform, env = process.env, home = os.homedir()): string {
  if (platform === "darwin") return path.join(home, "Library", "Caches", "faucet");
  if (platform === "win32") {
    return path.win32.join(env.LOCALAPPDATA ?? path.win32.join(home, "AppData", "Local"), "faucet", "cache");
  }
  return path.join(env.XDG_CACHE_HOME ?? path.join(home, ".cache"), "faucet");
}
