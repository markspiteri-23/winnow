# Winnow (working name)

Cross-platform (macOS + Windows) desktop photo culler. Scans a folder of RAW/JPEG shots, groups near-duplicates, flags blur / bad exposure / closed eyes, suggests the best frame per group, and writes the result as XMP sidecars so Lightroom, Bridge, darktable etc. pick it up. Local only, no cloud, no LLM calls.

## Stack
- TypeScript (strict), Node 22, ONE package, npm. Exact versions pinned (`save-exact=true`), lockfile committed.
- Layout: `src/core` (pure logic, never imports Electron), `src/cli`, `src/main` (Electron main), `src/renderer` (React)
- Allowed deps: `exiftool-vendored`, `sharp`, `vitest`, `@playwright/test` (dev, Electron launch tests), `electron`, `electron-vite`, `electron-builder`, `react`. Face/eye model choice is made in the Phase 7 spike. Anything else: ask first.
- Builds: electron-builder -> macOS `.dmg`, Windows NSIS `.exe`, produced by GitHub Actions on macOS + Windows runners.

## How to work (token budget is tight)
1. Do ONLY the phase I name from PLAN.md. Never start the next one.
2. Read only files the phase needs. Do not scan the whole repo.
3. Verify with `npm test` and `npx tsc --noEmit`. No UI screenshots unless the phase says so.
4. Keep diffs small. No refactors, renames or "improvements" outside the phase.
5. If a decision is ambiguous, pick the simplest option, note it in NOTES.md, and continue. Ask only if it blocks.
6. If a phase would touch more than ~8 files, stop at green tests and tell me so I can split it.
7. Before building on any new library call, run a one-line script that exercises it, and read the library's bundled type definitions. Never rely on memory for APIs.
8. CI failures: read with `gh run view <id> --log-failed | tail -80`. Never read a full log.
9. When done: tick the phase in PLAN.md, add a max-5-line entry to NOTES.md (what exists, gotchas, thresholds chosen), commit with a message naming the phase, push to main, and report the CI result using rule 8. Then stop.

## Cross-platform rules (I develop on a Mac; Windows is only tested by CI)
- Paths: `node:path` and `node:url` only. Never concatenate paths with `/` or `\`.
- Treat filesystems as case-insensitive (pair `IMG_1.ARW` with `img_1.jpg`).
- npm scripts must be Node-based, no bash-only syntax, no `rm -rf`, no `cp`.
- Every test must pass on macOS and Windows CI. Unit tests use generated images (sharp), never real photos.
- Real-photo tests run only when `WINNOW_FIXTURES` is set and are skipped in CI.
- No new native dependencies without asking. A build break on one OS costs a whole session.
- Native binaries (sharp, exiftool) are unpacked from the asar. Test the PACKAGED app, not only dev mode.
- Do not upgrade dependencies outside a task that says so.

## Image and analysis rules
- Only `loadOriented()` in `src/core/image.ts` may load pixels. It applies EXIF orientation taken from the RAW's EXIF, not the embedded preview's. A test fails if `sharp(` is used elsewhere.
- A `Shot` = RAW+JPEG pair collapsed into one object BEFORE any grouping or scoring.
- Analyse downscaled previews in worker threads, never full-size images on the main thread.
- Open originals read-only. A failure on one file is recorded in the result and never aborts a run.
- Wherever a group exists, judge frames RELATIVE to their group siblings (same burst, same ISO, same person), not by absolute thresholds.
- Be conservative: when unsure, keep the photo. Split groups rather than merge. Reject a blink only if another frame in the group has open eyes.
- Mark `lowConfidence` when the preview is too small; skip blur-based auto-rejects for those shots.

## Electron security (non-negotiable)
- `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`, never `webSecurity: false`.
- Narrow preload API only. Thumbnails are served through a custom protocol limited to the cache folder.
- A CI script fails the build if forbidden settings appear.

## Hard rules
- NEVER modify, move or delete original photos. Output = sidecars or new files only. Writing is dry-run unless `--apply` is passed. Only exception: the opt-in JPEG-embed mode in PLAN.md Phase 12, which needs a backup copy and explicit confirmation.
- Sidecars: change only `xmp:Rating` and `xmp:Label`, preserve every other property (a test must prove it), write `.xmp.bak` first, write atomically (temp file then rename), retry if the file is locked, refuse to touch a sidecar that cannot be parsed.
- Test photos live OUTSIDE the repo at `$WINNOW_FIXTURES`. Never commit photos. Keep a hold-out set that is never tuned against.
- Every verdict carries human-readable `reasons`. No black-box scores.
- Thresholds/weights live in `weights.json`, each with a `calibratedOn` note, and a measured-values table in NOTES.md. Calibrate on fixtures, never guess.

## Core types (keep stable, JSON-serialisable)
`Shot` (files[], captureDate with sub-seconds, cameraModel, iso, orientation, width, height, previewPath?, lowConfidence) -> `Metrics` (sharpness, noise, exposure, hash, faces[]) -> `Group` (shotIDs, bestID) -> `Verdict` (pick | reject | none, reasons[], score)

## Conventions
- Results cache: small helper in `src/core/paths.ts` (macOS `~/Library/Caches/winnow`, Windows `%LOCALAPPDATA%\winnow\cache`), keyed by path + mtime + size. No extra dependency.
- CLI output: human table by default, `--json` for machine output.
- Licence: MIT. Third-party licences listed in `THIRD_PARTY_LICENSES.md`.
