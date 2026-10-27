import path from "node:path";
import type { ShotFaces } from "./faces.ts";
import type { Group } from "./group.ts";
import { similarity, type Metrics } from "./metrics.ts";
import type { Verdict } from "./types.ts";
import { weight } from "./weights.ts";

export type ScoreMetrics = Pick<Metrics, "shotId" | "sharpness" | "exposure" | "thumb" | "lowConfidence">;

const round = (v: number, d = 2): number => Math.round(v * 10 ** d) / 10 ** d;
const name = (id: string): string => path.basename(id);
const clipped = (m: ScoreMetrics): number => Math.max(m.exposure.highlightsPct, m.exposure.shadowsPct);

/**
 * Verdicts for every shot, judged only against its group siblings. Conservative:
 * - blur rejects need a much sharper, similar-looking sibling and a trustworthy preview;
 * - exposure rejects need heavy clipping AND a sibling with under half of it;
 * - blink rejects need the same person with open eyes in another frame (`blinkVsSibling`);
 * - singles are never rejected, and a group is never rejected entirely.
 * Sets `bestID` on each group (highest score among the non-rejected).
 */
export function scoreGroups(groups: Group[], metrics: Map<string, ScoreMetrics>, faces: Map<string, ShotFaces> = new Map()): Verdict[] {
  const blurRatio = weight("blurRejectRatio");
  const blurSim = weight("blurRejectMinSimilarity");
  const clipPct = weight("clipRejectPct");
  const wSharp = weight("scoreWeightSharpness");
  const wExp = weight("scoreWeightExposure");
  const wEyes = weight("scoreWeightEyes");
  const out: Verdict[] = [];

  for (const g of groups) {
    const members = g.shotIDs.map((id) => metrics.get(id)).filter((m): m is ScoreMetrics => m !== undefined);
    const missing = g.shotIDs.filter((id) => !metrics.has(id));
    for (const id of missing) out.push({ shotId: id, groupId: g.id, verdict: "none", score: 0, reasons: ["not analysed: kept"] });
    if (members.length === 0) continue;

    const sharpest = members.reduce((a, b) => (b.sharpness > a.sharpness ? b : a));
    const maxSharp = Math.max(sharpest.sharpness, 1e-6);
    const leastClipped = Math.min(...members.map(clipped));
    const multi = members.length > 1;

    const rows = members.map((m) => {
      const reasons: string[] = [];
      const rejects: string[] = [];
      const ratio = m.sharpness / maxSharp;
      const f = faces.get(m.shotId);
      const eyes = f && f.faces.length ? f.faces.reduce((s, x) => s + x.eyesOpen, 0) / f.faces.length : 1;
      const exposure = 1 - Math.min(1, clipped(m) / clipPct);
      const score = round(wSharp * ratio + wExp * exposure + wEyes * eyes, 3);

      if (multi && m !== sharpest) {
        const sim = similarity(m.thumb, sharpest.thumb);
        const vs = `${round(m.sharpness, 1)} vs ${round(sharpest.sharpness, 1)} in ${name(sharpest.shotId)}`;
        if (ratio > blurRatio) {
          if (ratio < 0.9) reasons.push(`a little softer than the sharpest frame (${vs})`);
        } else if (m.lowConfidence) reasons.push(`softer (${vs}) but preview too small to judge blur: kept`);
        else if (sim < blurSim) reasons.push(`softer (${vs}) but framing differs (similarity ${sim} < ${blurSim}): kept`);
        else rejects.push(`blurry: sharpness ${round(ratio * 100, 0)}% of the sharpest frame (${vs})`);
      }
      if (clipped(m) >= clipPct) {
        const what = m.exposure.highlightsPct >= m.exposure.shadowsPct ? `${m.exposure.highlightsPct}% highlights clipped` : `${m.exposure.shadowsPct}% shadows crushed`;
        if (multi && leastClipped * 2 < clipped(m)) rejects.push(`badly exposed: ${what}, a sibling has ${round(leastClipped, 1)}%`);
        else reasons.push(`${what}, but no better-exposed sibling: kept`);
      }
      if (f?.blinkVsSibling) rejects.push(`eyes closed: ${f.reasons.join("; ")}`);
      else if (f?.anyEyesClosed) reasons.push("eyes closed, but not open in any other frame: kept");
      return { m, score, reasons, rejects };
    });

    // Never reject the whole group: keep the best-scoring frame if every one would go.
    if (rows.every((r) => r.rejects.length > 0)) {
      const keep = rows.reduce((a, b) => (b.score > a.score ? b : a));
      keep.reasons.push(`would be rejected (${keep.rejects.join("; ")}) but it is the best of a group that would otherwise lose every frame`);
      keep.rejects = [];
    }
    const kept = rows.filter((r) => r.rejects.length === 0);
    const best = kept.reduce((a, b) => (b.score > a.score ? b : a));
    g.bestID = best.m.shotId;
    const runnerUp = kept.filter((r) => r !== best).reduce((a, b) => Math.max(a, b.score), 0);

    for (const r of rows) {
      let verdict: Verdict["verdict"] = "none";
      const reasons = [...r.rejects, ...r.reasons];
      if (r.rejects.length) verdict = "reject";
      else if (!multi) reasons.unshift("single shot: nothing to compare, kept");
      else if (r === best) {
        verdict = "pick";
        reasons.unshift(kept.length > 1 ? `best of ${members.length} (score ${r.score} vs next ${runnerUp})` : `only frame kept of ${members.length}`);
      } else reasons.unshift(`kept, not the best of ${members.length} (score ${r.score} vs ${best.score} for ${name(best.m.shotId)})`);
      out.push({ shotId: r.m.shotId, groupId: g.id, verdict, score: r.score, reasons });
    }
  }
  return out;
}
