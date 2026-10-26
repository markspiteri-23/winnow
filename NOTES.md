# Notes

## Phase log

### Phase 0: Scaffold + CI
- Strict TS 7.0.2 (native Go compiler, platform binary via optionalDeps), vitest 5, Node 24; `tsc --noEmit` only, no build step yet.
- Dev dep `tsx` added because PLAN Phase 0 "done when" uses `npx tsx`; imports use `.ts` extensions (`allowImportingTsExtensions`).
- `scripts/check-security.mjs` scans `src/` + Electron config files for webSecurity:false, nodeIntegration(InWorker):true, contextIsolation:false, sandbox:false.
- `weights.json` is `{ values: {} }`; `validateWeights()` enforces numeric `value` + non-empty `calibratedOn`. No thresholds yet (none calibrated).

## Measured values

| Weight | Value | Measured on | Notes |
| --- | --- | --- | --- |
