import path from "node:path";
import type { Group } from "./group.ts";
import type { SidecarResult } from "./sidecar.ts";
import type { Shot, Verdict } from "./types.ts";

function cell(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

/** One row per shot, in group order: everything XMP cannot carry (group, score, reasons). Paths relative to `root`. */
export function cullCsv(root: string, shots: Shot[], groups: Group[], verdicts: Verdict[], sidecars: SidecarResult[] = []): string {
  const byShot = new Map(shots.map((s) => [s.id, s]));
  const verdict = new Map(verdicts.map((v) => [v.shotId, v]));
  const sidecar = new Map(sidecars.map((s) => [s.shotId, s]));
  const rows = [["group", "shot", "files", "verdict", "score", "best", "rating", "label", "sidecar", "reasons"]];
  for (const g of groups) {
    for (const id of g.shotIDs) {
      const v = verdict.get(id);
      const s = sidecar.get(id);
      const files = byShot.get(id)?.files.map((f) => path.relative(root, f.path)) ?? [];
      rows.push([
        g.id,
        path.relative(root, id),
        files.join(";"),
        v?.verdict ?? "",
        v ? v.score.toFixed(3) : "",
        g.bestID === id ? "yes" : "",
        s ? String(s.target.rating) : "",
        s?.target.label ?? "",
        s ? path.relative(root, s.sidecar) : "",
        v?.reasons.join("; ") ?? "",
      ]);
    }
  }
  // CRLF + BOM so Excel on Windows opens it as UTF-8 with correct rows.
  return "﻿" + rows.map((r) => r.map(cell).join(",")).join("\r\n") + "\r\n";
}
