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

## Measured values

| Weight | Value | Measured on | Notes |
| --- | --- | --- | --- |
