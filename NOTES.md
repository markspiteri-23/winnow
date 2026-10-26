# Notes

## Phase log

### Phase 0: Scaffold + CI
- Strict TS 7.0.2 (native Go compiler, platform binary via optionalDeps), vitest 5, Node 24; `tsc --noEmit` only, no build step yet.
- Dev dep `tsx` added because PLAN Phase 0 "done when" uses `npx tsx`; imports use `.ts` extensions (`allowImportingTsExtensions`).
- `scripts/check-security.mjs` scans `src/` + Electron config files for webSecurity:false, nodeIntegration(InWorker):true, contextIsolation:false, sandbox:false.
- `weights.json` is `{ values: {} }`; `validateWeights()` enforces numeric `value` + non-empty `calibratedOn`. No thresholds yet (none calibrated).

### Phase 1: Packaging smoke test
- Electron 44.9.3 (44.7.0 had a high advisory), electron-vite 5.0.0 + vite 7.3.7 (electron-vite 6 was 12 days old), electron-builder 26.17.0. `vite` added as electron-vite peer dep.
- Preload lives in `src/preload` and is built as CJS (`index.cjs`) because sandboxed preloads cannot be ESM. Main is ESM.
- asarUnpack: sharp, @img/*, exiftool-vendored.{pl,exe}; exiftool-vendored rewrites app.asar -> app.asar.unpacked itself. Mac `identity: null` (unsigned).
- `npm test` = `vitest run --dir src`; Playwright e2e in `e2e/` runs against `release/` (`npm run build && npm run package && npm run test:e2e`). Smoke scan runs on the main thread (workers come in Phase 9). `probeImage` in image.ts is temporary until `loadOriented` (Phase 3).
- Phase touched ~15 files (mostly config); not split because packaging and its test only make sense together.

### Phase 2: Scan, pairing, EXIF
- `src/core/scan.ts`: recursive scan (skips dot-files incl. macOS `._*`), pairs by folder + lowercased basename; >1 RAW or >1 JPEG per key is split into single-file shots. Shot id = primary file path (RAW first); EXIF read from RAW, JPEG partner only if RAW fails.
- Date = SubSecDateTimeOriginal ?? DateTimeOriginal ?? CreateDate as ISO string (offset only if recorded); null if year < 1990 or > now + 2 days. Corrupt = exiftool MIMEType not `image/*` (exiftool does not error on junk, it reports TXT).
- Shots whose files are all unreadable are left out of `shots` (so never touched) and listed in `errors`.
- Scan time, 1000 generated 1600px JPEGs, M-series Mac, maxProcs=3: 3.46 s (3.5 ms/file). `npx tsx scripts/bench-scan.ts 1000`.
- Test gotcha: exiftool refuses to write a JPEG named .ARW, so fixtures are written as .jpg then renamed.

### Phase 3: Previews + `loadOriented` (real-ARW check PENDING: needs `$WINNOW_FIXTURES`)
- `src/core/preview.ts`: chain JpgFromRaw -> camera JPEG of the pair -> PreviewImage -> ThumbnailImage; RAW extracts cached as `<sha1(path+mtime+size)>.<tag>.jpg` in `cacheDir()/previews` (`src/core/paths.ts`). JPEG-only shots use the original file in place (read-only). `winnow previews <folder>`.
- `loadOriented(file, orientation)` ignores the file's own tag and applies the RAW's. Gotcha: sharp does NOT honour flip/flop vs rotate chain order (docs say flip after rotate; observed differs), so mirror and rotate run as two pipelines. Tests check all 8 against libvips autoOrient.
- `previewMinLongSide` = 1000 is PROVISIONAL, not measured; recalibrate in Phase 4. Guard test scans `src/` for `sharp(` outside image.ts (test files exempt: they generate images).
- Real ARW: `WINNOW_FIXTURES=... npx vitest run src/core/preview.test.ts` prints source and size; not yet run.

### Phase 4: Sharpness + exposure (real-fixture checks PENDING: needs `$WINNOW_FIXTURES`)
- `src/core/metrics.ts`: preview -> `loadOriented` greyscale at `analysisMaxSide` -> [1 2 1] blur -> Sobel energy per 64px tile; sharpness = sqrt of p90 tile energy minus the analytic noise energy (5.47 * sigma^2). Noise = Immerkaer sigma, median of the flattest 25% of tiles. Exposure = % luma <= 3, % >= 252, mean luma. `winnow metrics <folder> [--json]`.
- Generated 1200x800 blocks (sharp / blur(4) / blur(4)+noise sigma 12): sharpness 103.5 / 24.4 / 29.6 (34.5 uncorrected); noise 0.06 / 0.32 / 7.6 (downscale averages some noise away).
- Gotchas: sharp's greyscale raw output keeps 3 channels (metrics read channel 0). Fine uniform texture (sand, foliage at distance) reads as noise and loses sharpness; exposure is on luma, so a single blown channel is missed.
- Preview vs full res: `WINNOW_FIXTURES=... npx tsx scripts/compare-sharpness.ts 10` (full = embedded/camera JPEG at native size; sharp cannot decode RAW). Not yet run; blurry-below-sharp ranking on real fixtures also not yet checked.
- All 6 analysis values in weights.json are PROVISIONAL; previewMinLongSide still not recalibrated (needs the comparison above).

## Measured values

| Weight | Value | Measured on | Notes |
| --- | --- | --- | --- |
| previewMinLongSide | 1000 | not measured (provisional) | Recalibrate in Phase 4 |
| analysisMaxSide | 1024 | not measured (provisional) | Phase 4 |
| sharpnessTileSize | 64 | not measured (provisional) | px at analysisMaxSide |
| sharpnessPercentile | 90 | not measured (provisional) | |
| noiseFlatTileFraction | 0.25 | not measured (provisional) | |
| shadowClipLevel | 3 | not measured (provisional) | luma 0-255 |
| highlightClipLevel | 252 | not measured (provisional) | luma 0-255 |
