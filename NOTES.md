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

### Phase 3: Previews + `loadOriented`
- `src/core/preview.ts`: chain JpgFromRaw -> camera JPEG of the pair -> PreviewImage -> ThumbnailImage; RAW extracts cached as `<sha1(path+mtime+size)>.<tag>.jpg` in `cacheDir()/previews` (`src/core/paths.ts`). JPEG-only shots use the original file in place (read-only). `faucet previews <folder>`.
- `loadOriented(file, orientation)` ignores the file's own tag and applies the RAW's. Gotcha: sharp does NOT honour flip/flop vs rotate chain order (docs say flip after rotate; observed differs), so mirror and rotate run as two pipelines. Tests check all 8 against libvips autoOrient.
- `previewMinLongSide` = 1000 is PROVISIONAL, not measured; recalibrate in Phase 4. Guard test scans `src/` for `sharp(` outside image.ts (test files exempt: they generate images).
- Real ARW check passed 2026-10-26: 26 ILCE-6000 ARWs, all PreviewImage 1616x1080 (no JpgFromRaw in A6000 files), none lowConfidence.

### Phase 4: Sharpness + exposure
- `src/core/metrics.ts`: preview -> `loadOriented` greyscale at `analysisMaxSide` -> [1 2 1] blur -> Sobel energy per 64px tile; sharpness = sqrt of p90 tile energy minus the analytic noise energy (5.47 * sigma^2). Noise = Immerkaer sigma, median of the flattest 25% of tiles. Exposure = % luma <= 3, % >= 252, mean luma. `faucet metrics <folder> [--json]`.
- Generated 1200x800 blocks (sharp / blur(4) / blur(4)+noise sigma 12): sharpness 103.5 / 24.4 / 29.6 (34.5 uncorrected); noise 0.06 / 0.32 / 7.6 (downscale averages some noise away).
- Gotchas: sharp's greyscale raw output keeps 3 channels (metrics read channel 0). Fine uniform texture (sand, foliage at distance) reads as noise and loses sharpness; exposure is on luma, so a single blown channel is missed.
- Preview vs full res: `FAUCET_FIXTURES=... npx tsx scripts/compare-sharpness.ts 10` (full = embedded/camera JPEG at native size; sharp cannot decode RAW). Not yet run; blurry-below-sharp ranking on real fixtures also not yet checked.
- Real run 2026-10-26 (26 A6000 ARWs + 12 JPEGs, 11 of them Lightroom exports): 0 errors, 6.9 s. Preview (1024) vs native preview (1616) Spearman 0.952 on 10 ARWs; true full-res not testable (A6000 embeds no full-size JPEG). Lowest sharpness = the 3 ISO 3200 night ARWs (17-32), but they are also dark (luma 41-59), so blur vs dark scene is not yet separated. Labelled by eye: Test-2.ARW sharp stars 24.8 > Test-3.ARW star trails (same sky, 30 s apart) 17.1.
- `scripts/make-fixtures.ts` writes labelled variants of 7 real sources to `$FAUCET_FIXTURES/generated` (+ manifest.json): noisy (sharp), defocus 2/5, 15px motion, night (x0.35, blur 2, noise 8). Fixture-gated test in metrics.test.ts: every blurry variant < every sharp frame of its source; passes on all 7.
- Gotcha for Phase 9: Tenengrad scales with contrast, so a sharp star field (24.8) scores below heavily defocused daylight frames (38-68). Never compare sharpness across scenes; only within a group.
- Noise reads ~1 or less even at ISO 3200-6400: camera previews are denoised and the 1024 downscale averages noise away, so the correction rarely matters on real files.
- All 6 analysis values in weights.json are PROVISIONAL; previewMinLongSide 1000 is fine for A6000 (1616 px previews) but not calibrated across cameras.

### Rename: Winnow -> Faucet
- Case-preserving rename everywhere: CLI `faucet`, productName/appId `Faucet`/`org.faucet.app`, preload global `window.faucet`, IPC `faucet:*`, env `FAUCET_FIXTURES`/`FAUCET_SMOKE_DIR`, cache dir `.../faucet` (old `~/Library/Caches/winnow` is orphaned; safe to delete by hand).
- GitHub repo is still `markspiteri-23/winnow`; not renamed.

### Phase 5: Autofocus-point sharpness (dead end, nothing built)
- a6000 ARWs (26, exiftool 13 via exiftool-vendored): AFPointSelected `n/a`, AFPointsUsed and FocalPlaneAFPointsUsed `(none)`, no FocusLocation, FlexibleSpotPosition `0 0` in every file (modes seen: Multi, Wide, Tracking, Face Tracking, Manual).
- Only FocusMode/AFAreaMode and FocusPosition2 (a distance step, not a frame position) exist, so no AF region can be located. Revisit only for other cameras (e.g. newer Sony FocusLocation, Canon/Nikon AF point tags).

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
