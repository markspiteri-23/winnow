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

## Measured values

| Weight | Value | Measured on | Notes |
| --- | --- | --- | --- |
