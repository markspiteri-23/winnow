import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { exiftool } from "exiftool-vendored";
import { afterAll, describe, expect, it } from "vitest";
import { cullCsv } from "./csv.ts";
import { sidecarPath, withLockRetry, writeSidecars } from "./sidecar.ts";
import type { Shot, Verdict } from "./types.ts";

const root = mkdtempSync(path.join(tmpdir(), "faucet-sidecar-"));
let n = 0;

afterAll(async () => {
  await exiftool.end();
  rmSync(root, { recursive: true, force: true });
});

/** A fresh folder with fake originals (sidecar writing never reads them), one shot per file list. */
function folder(...shotFiles: string[][]): { dir: string; shots: Shot[] } {
  const dir = path.join(root, `case-${n++}`);
  mkdirSync(dir);
  const shots = shotFiles.map((files) => {
    const paths = files.map((f) => path.join(dir, f));
    for (const p of paths) writeFileSync(p, `original ${path.basename(p)}`);
    return {
      id: paths[0]!,
      files: paths.map((p) => ({ path: p, kind: /\.jpe?g$/i.test(p) ? ("jpeg" as const) : ("raw" as const) })),
      captureDate: null, cameraModel: null, iso: null, orientation: null, width: null, height: null, lowConfidence: false,
    };
  });
  return { dir, shots };
}

const verdict = (shot: Shot, v: Verdict["verdict"]): Verdict => ({ shotId: shot.id, groupId: "g1", verdict: v, score: 0.5, reasons: [`${v} reason`] });
const xmp = async (f: string): Promise<Record<string, unknown>> => (await exiftool.readRaw(f, { readArgs: ["-XMP:all", "-G1", "-n"] })) as Record<string, unknown>;
const hash = (f: string): string => createHash("sha256").update(readFileSync(f)).digest("hex");

/** Lightroom-style sidecar with develop settings, keywords, a title, a custom namespace and an existing rating. */
const RICH = `<x:xmpmeta xmlns:x="adobe:ns:meta/">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about="" xmlns:xmp="http://ns.adobe.com/xap/1.0/" xmlns:dc="http://purl.org/dc/elements/1.1/"
   xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/" xmlns:foo="http://example.com/foo/1.0/"
   xmp:Rating="2" xmp:Label="Red" xmp:CreatorTool="Lightroom" crs:Exposure2012="+0.50" crs:WhiteBalance="Custom" foo:Custom="kept">
   <dc:subject><rdf:Bag><rdf:li>beach</rdf:li><rdf:li>sunset</rdf:li></rdf:Bag></dc:subject>
   <dc:title><rdf:Alt><rdf:li xml:lang="x-default">Hello, "world"</rdf:li></rdf:Alt></dc:title>
  </rdf:Description>
 </rdf:RDF>
</x:xmpmeta>
`;

/** Every XMP property except the toolkit stamp exiftool adds and the two we own. */
async function otherProps(file: string): Promise<Record<string, unknown>> {
  const tags = (await exiftool.readRaw(file, { readArgs: ["-XMP:all", "-G1", "-struct", "-n"] })) as Record<string, unknown>;
  const skip = new Set(["SourceFile", "errors", "warnings", "XMP-x:XMPToolkit", "XMP-xmp:Rating", "XMP-xmp:Label"]);
  return Object.fromEntries(Object.entries(tags).filter(([k]) => !skip.has(k)));
}

describe("sidecarPath", () => {
  it("defaults to name.xmp, darktable style is name.ARW.xmp", async () => {
    const { dir, shots } = folder(["IMG_1.ARW", "IMG_1.JPG"]);
    expect(await sidecarPath(shots[0]!, "adobe")).toEqual({ path: path.join(dir, "IMG_1.xmp"), exists: false });
    expect(await sidecarPath(shots[0]!, "darktable")).toEqual({ path: path.join(dir, "IMG_1.ARW.xmp"), exists: false });
  });

  it("follows an existing sidecar's convention and case, whatever the setting", async () => {
    const { dir, shots } = folder(["IMG_2.ARW", "IMG_2.JPG"], ["IMG_3.ARW"]);
    writeFileSync(path.join(dir, "img_2.arw.XMP"), RICH);
    writeFileSync(path.join(dir, "IMG_3.XMP"), RICH);
    expect(await sidecarPath(shots[0]!, "adobe")).toEqual({ path: path.join(dir, "img_2.arw.XMP"), exists: true });
    expect(await sidecarPath(shots[1]!, "darktable")).toEqual({ path: path.join(dir, "IMG_3.XMP"), exists: true });
  });
});

describe("writeSidecars", () => {
  it("dry-run by default: reports, writes nothing", async () => {
    const { dir, shots } = folder(["A.ARW"], ["B.ARW"], ["C.ARW"]);
    const { results, errors } = await writeSidecars(shots, [verdict(shots[0]!, "pick"), verdict(shots[1]!, "reject"), verdict(shots[2]!, "none")], exiftool);
    expect(errors).toEqual([]);
    expect(results.map((r) => [path.basename(r.sidecar), r.action, r.target, r.written])).toEqual([
      ["A.xmp", "create", { rating: 4, label: "Green" }, false],
      ["B.xmp", "create", { rating: -1 }, false],
    ]);
    expect(readdirSync(dir).sort()).toEqual(["A.ARW", "B.ARW", "C.ARW"]);
  });

  it("creates new sidecars with only Rating and Label; originals untouched", async () => {
    const { dir, shots } = folder(["P.ARW", "P.JPG"], ["R.JPG"]);
    const before = shots.flatMap((s) => s.files.map((f) => hash(f.path)));
    const { results, errors } = await writeSidecars(shots, [verdict(shots[0]!, "pick"), verdict(shots[1]!, "reject")], exiftool, { apply: true });
    expect(errors).toEqual([]);
    expect(results.every((r) => r.written)).toBe(true);
    const p = await xmp(path.join(dir, "P.xmp"));
    expect(p["XMP-xmp:Rating"]).toBe(4);
    expect(p["XMP-xmp:Label"]).toBe("Green");
    const r = await xmp(path.join(dir, "R.xmp"));
    expect(r["XMP-xmp:Rating"]).toBe(-1);
    expect(r["XMP-xmp:Label"]).toBeUndefined();
    expect(shots.flatMap((s) => s.files.map((f) => hash(f.path)))).toEqual(before);
    expect(readdirSync(dir).sort()).toEqual(["P.ARW", "P.JPG", "P.xmp", "R.JPG", "R.xmp"]);
  });

  it("merges into an existing sidecar: every other property survives, .xmp.bak holds the old file", async () => {
    const { dir, shots } = folder(["S.ARW"]);
    const sidecar = path.join(dir, "S.xmp");
    writeFileSync(sidecar, RICH);
    const before = await otherProps(sidecar);
    expect(Object.keys(before).length).toBeGreaterThanOrEqual(6);

    const { results, errors } = await writeSidecars(shots, [verdict(shots[0]!, "pick")], exiftool, { apply: true });
    expect(errors).toEqual([]);
    expect(results[0]).toMatchObject({ action: "update", written: true });
    expect(await otherProps(sidecar)).toEqual(before);
    const after = await xmp(sidecar);
    expect([after["XMP-xmp:Rating"], after["XMP-xmp:Label"]]).toEqual([4, "Green"]);
    expect(readFileSync(`${sidecar}.bak`, "utf8")).toBe(RICH);
    expect(readdirSync(dir).sort()).toEqual(["S.ARW", "S.xmp", "S.xmp.bak"]);

    // Second run: nothing to change, no rewrite.
    const again = await writeSidecars(shots, [verdict(shots[0]!, "pick")], exiftool, { apply: true });
    expect(again.results[0]).toMatchObject({ action: "unchanged", written: false });
  });

  it("a reject keeps the existing label", async () => {
    const { dir, shots } = folder(["L.ARW"]);
    writeFileSync(path.join(dir, "L.xmp"), RICH);
    await writeSidecars(shots, [verdict(shots[0]!, "reject")], exiftool, { apply: true });
    const t = await xmp(path.join(dir, "L.xmp"));
    expect([t["XMP-xmp:Rating"], t["XMP-xmp:Label"]]).toEqual([-1, "Red"]);
  });

  it("refuses unparsable sidecars and leaves them byte-identical", async () => {
    const { dir, shots } = folder(["U1.ARW"], ["U2.ARW"], ["U3.ARW"]);
    const broken = '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description';
    writeFileSync(path.join(dir, "U1.xmp"), broken);
    writeFileSync(path.join(dir, "U2.xmp"), "not xml at all");
    const ok = await writeSidecars(shots, shots.map((s) => verdict(s, "pick")), exiftool, { apply: true });
    expect(ok.errors).toEqual([]);
    expect(ok.results.map((r) => [path.basename(r.sidecar), r.action, r.written])).toEqual([
      ["U1.xmp", "refused", false],
      ["U2.xmp", "refused", false],
      ["U3.xmp", "create", true],
    ]);
    expect(ok.results[0]!.reason).toMatch(/unparsable/);
    expect(readFileSync(path.join(dir, "U1.xmp"), "utf8")).toBe(broken);
    expect(readFileSync(path.join(dir, "U2.xmp"), "utf8")).toBe("not xml at all");
    expect(existsSync(path.join(dir, "U1.xmp.bak"))).toBe(false);
    expect(readdirSync(dir).filter((f) => f.includes(".tmp"))).toEqual([]);
  });

  it("retries the final rename while the sidecar is locked (Windows EBUSY)", async () => {
    const { dir, shots } = folder(["W.ARW"]);
    writeFileSync(path.join(dir, "W.xmp"), RICH);
    let calls = 0;
    const lockedTwice = async (from: string, to: string): Promise<void> => {
      if (++calls <= 2) throw Object.assign(new Error("resource busy or locked"), { code: "EBUSY" });
      await rename(from, to);
    };
    const { results, errors } = await writeSidecars(shots, [verdict(shots[0]!, "pick")], exiftool, { apply: true, rename: lockedTwice, retry: { attempts: 5, delayMs: 1 } });
    expect(errors).toEqual([]);
    expect(calls).toBe(3);
    expect(results[0]).toMatchObject({ written: true });
  });

  it("gives up on a lock that never clears: error recorded, sidecar intact, run continues", async () => {
    const { dir, shots } = folder(["X.ARW"], ["Y.ARW"]);
    writeFileSync(path.join(dir, "X.xmp"), RICH);
    const locked = async (from: string, to: string): Promise<void> => {
      if (to.endsWith("X.xmp")) throw Object.assign(new Error("operation not permitted"), { code: "EPERM" });
      await rename(from, to);
    };
    const { results, errors } = await writeSidecars(shots, shots.map((s) => verdict(s, "pick")), exiftool, { apply: true, rename: locked, retry: { attempts: 3, delayMs: 1 } });
    expect(errors).toHaveLength(1);
    expect(errors[0]!.path).toBe(path.join(dir, "X.xmp"));
    expect(results.map((r) => r.written)).toEqual([false, true]);
    expect(readFileSync(path.join(dir, "X.xmp"), "utf8")).toBe(RICH);
    expect(readdirSync(dir).filter((f) => f.includes(".tmp"))).toEqual([]);
  });
});

describe("withLockRetry", () => {
  it("does not retry other errors", async () => {
    let calls = 0;
    await expect(withLockRetry(async () => { calls++; throw Object.assign(new Error("gone"), { code: "ENOENT" }); }, 5, 1)).rejects.toThrow("gone");
    expect(calls).toBe(1);
  });
});

describe("cullCsv", () => {
  it("one row per shot with group, verdict, reasons; quotes commas and quotes", () => {
    const { dir, shots } = folder(["C1.ARW", "C1.JPG"], ["C2.ARW"]);
    const v: Verdict[] = [
      { shotId: shots[0]!.id, groupId: "g1", verdict: "pick", score: 0.91, reasons: ["sharpest in group", 'eyes "open", both'] },
      { shotId: shots[1]!.id, groupId: "g1", verdict: "reject", score: 0.2, reasons: ["blurred"] },
    ];
    const csv = cullCsv(dir, shots, [{ id: "g1", shotIDs: shots.map((s) => s.id), bestID: shots[0]!.id }], v, [
      { shotId: shots[0]!.id, sidecar: path.join(dir, "C1.xmp"), action: "create", target: { rating: 4, label: "Green" }, written: false },
    ]);
    expect(csv.startsWith("﻿")).toBe(true);
    expect(csv.slice(1).split("\r\n")).toEqual([
      "group,shot,files,verdict,score,best,rating,label,sidecar,reasons",
      'g1,C1.ARW,C1.ARW;C1.JPG,pick,0.910,yes,4,Green,C1.xmp,"sharpest in group; eyes ""open"", both"',
      "g1,C2.ARW,C2.ARW,reject,0.200,,,,,blurred",
      "",
    ]);
  });
});
