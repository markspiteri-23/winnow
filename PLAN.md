# Faucet: product + phase plan (macOS + Windows)

## Pitch
Point it at a shoot folder. It groups the near-duplicates, throws out the obvious losers (blurry, missed focus, blown exposure, blinks), suggests the best frame in each group, and lets you confirm or override with the keyboard. Output is XMP sidecars, so your photos and your catalog stay untouched.

Mirrors the three signals Lightroom's Assisted Culling exposes (subject sharpness, eye sharpness, eyes open) plus duplicate grouping.

## Honest positioning
- v1 promise: "removes the obvious 60% and suggests a best frame per burst". NOT "picks your best photo". Judging expression, composition and moment needs trained models.
- Prior art exists: Facet (Python, large local gallery/culling server), Selects (Python + React desktop app), Nitido (browser PWA), Cullify (small prototype). Faucet's bet: a small installable desktop app for Mac and Windows, fast start, keyboard-first review, safe sidecar output. Plausible gap, not proven.

## Scope
In v1: folder scan, RAW+JPEG pairing, burst/duplicate groups, sharpness, exposure, face + eyes-open, per-group pick, review UI, XMP ratings/labels, explainable reasons, installers for macOS and Windows.
Out of v1: cloud, LLM per-photo calls, aesthetic scoring, catalog editing, Linux builds, HEIC, video, editing.

## Stack decision
TypeScript + Electron, one package, shared core used by CLI and app. One language and toolchain keeps token cost down. `exiftool-vendored` gives EXIF, embedded RAW previews and XMP on both OSes. `sharp` gives prebuilt image processing on both. GitHub Actions builds and tests on real macOS and Windows runners. Cost: ~100MB+ installers and a bundled face model. Rejected: Swift + Vision (Mac only), Tauri (Rust compile-fix loops burn usage), Python + Qt (heavy packaging).

## Three principles that remove many problems at once
1. **Compare within the group.** Judge each frame against its burst siblings, not a fixed threshold. This cancels ISO noise, lens and camera differences and reduces calibration work.
2. **Prove packaging on day one.** Phase 1 ships an empty packaged app that loads sharp and exiftool on both CI OSes, before any feature exists.
3. **Cull before import.** Recommend running Faucet before Lightroom imports the shoot, so sidecars already exist when Lightroom first sees the photos. Avoids refresh and metadata-conflict problems.

## Decisions to confirm before Phase 0 (defaults in bold)
1. Stack: **TypeScript + Electron**.
2. Primary test camera: **Sony ARW + JPEG**.
3. Pick mapping in XMP: **pick = 4 stars + Green label, reject = rating -1**. Lightroom's Pick flag is catalog-only as far as I know. CSV export covers the rest.
4. Licence: **MIT**.
5. Who tests on real Windows before release? (PC, VM, or a friend.) Needed in Phase 19.
6. Sidecar naming: **Adobe style `name.xmp`**; darktable style `name.ARW.xmp` as a setting.

## Remaining risks that fixes only reduce
- Windows UI correctness (CI sees crashes and screenshots, not taste).
- Face/eye detection may not run on both OSes. Plan degrades: ship v1 without eye detection.
- Blink and grouping heuristics will never be perfect. Conservative defaults, manual overrides.
- Unsigned installers show OS warnings.
- Open-source maintenance load for cameras you don't own.

## Fixtures
- CI/unit tests: generated images only (sharp makes blurred, noisy, clipped, near-duplicate, rotated images). No photos in git.
- Real set outside the repo at `$FAUCET_FIXTURES`, ~60 photos: 2 bursts of 5+, 3 blink shots, 5 deliberately blurry (include one blurry high-ISO night shot), 3 over/under-exposed, 1 bokeh portrait, 1 group shot, 5 singles you love. Mark ~40 as "tune" and ~20 as "hold-out" in Phase 10. Later add photos from friends with other cameras.

## Phases
Each phase = one fresh Claude Code session. Run `/clear` before starting. Size: S small, M medium. Tick when done. If a phase overruns, stop at green tests and split.

Calibration: note your usage meter before and after Phases 0 and 1. That shows what a "small phase" costs on your plan.

Cut list if budget runs short (in order): Phase 5, Phase 12 embed mode, Phase 16 slider. Everything else is core.

### [x] Phase 0 (S): Scaffold + CI
Build: strict TS, vitest, `tsc --noEmit` script, `src/core` + `src/cli`, one test, `.gitignore`, MIT licence, README stub, `weights.json` (every value has `calibratedOn`), `NOTES.md`, `THIRD_PARTY_LICENSES.md` stub, `.npmrc` with `save-exact=true`, `.github/dependabot.yml` (monthly npm, no auto-merge). Node script that fails if `webSecurity: false` or `nodeIntegration: true` appears. GitHub Actions on macos-latest and windows-latest: `npm ci`, `tsc --noEmit`, `npm test`, security script.
Done when: both CI jobs green, `npx tsx src/cli/index.ts --help` works.
Prompt: "Do Phase 0 from PLAN.md."

### [x] Phase 1 (M): Packaging smoke test
Build: minimal Electron app (contextIsolation, sandbox, preload) that loads sharp and exiftool-vendored, processes a generated image, shows versions. electron-builder config with sharp and exiftool unpacked from the asar. CI builds the PACKAGED app on both OSes; a Playwright Electron test launches that build, scans a generated folder, asserts the result, and saves a screenshot as a CI artifact.
Done when: packaged build passes on both OSes. Any native-module problem is fixed HERE, before features. Mac architecture choice is deferred to Phase 17.
Prompt: "Do Phase 1 from PLAN.md. Packaging smoke test only, no features."

### [x] Phase 2 (S): Scan, pairing, EXIF
Build: recursive scan of supported files (ARW, CR2, CR3, NEF, DNG, JPG). Collapse RAW+JPEG pairs (case-insensitive basename) into one `Shot`. Via exiftool: sub-second capture time, camera model, ISO, EXIF orientation, dimensions. Missing or implausible date handled as null. Originals opened read-only; one bad file is recorded, never aborts. `faucet scan <folder>`.
Done when: tests on generated JPEGs cover pairing, case-insensitivity, missing dates, corrupt file; report scan time for 1000 files.
Prompt: "Do Phase 2 from PLAN.md."

### [ ] Phase 3 (M): Previews + `loadOriented`
Build: preview fallback chain (full-size embedded JPEG, then medium preview, then thumbnail), saved to cache. `lowConfidence` when the preview's long side is below a `weights.json` value. `loadOriented()` in `src/core/image.ts` as the ONLY pixel loader, using orientation from the RAW's EXIF. Test all 8 orientations with generated images. Test that fails if `sharp(` appears outside `image.ts`.
Done when: orientation tests pass on both OSes; a real ARW fixture yields a usable preview and reports its size.
Prompt: "Do Phase 3 from PLAN.md."

### [ ] Phase 4 (M): Sharpness + exposure
Build: downscale, light blur, then tile-based gradient (Tenengrad) sharpness; Shot sharpness = high percentile of tiles. Noise estimate from flat regions, used to correct sharpness. Exposure = % crushed shadows, % clipped highlights, mean luma. `faucet metrics <folder> [--json]`. Compare preview-based vs full-resolution sharpness on 10 real fixtures and record it in NOTES.md.
Done when: generated-image test asserts order sharp > blurred AND sharp > blurred+noisy; real blurry fixtures (including the noisy night shot) rank below sharp ones.
Prompt: "Do Phase 4 from PLAN.md. Metrics module and CLI command only."

### [ ] Phase 5 (S, optional): Autofocus-point sharpness
Build: spike first. Check whether your a6000 ARW files expose the focus point through exiftool (tags vary by brand). If yes, also measure sharpness in a region around that point and add it to Metrics. If no, record that in NOTES.md and stop.
Done when: either the AF region metric works on fixtures, or the dead end is recorded.
Prompt: "Do Phase 5 from PLAN.md. Spike first, stop if no focus-point tags exist."

### [ ] Phase 6 (M): Burst / duplicate grouping
Build: dHash per Shot; sort by sub-second capture time; time-gap + Hamming distance join a group; single-link clustering; prefer splitting over merging. Fallback to sequential filename numbers when dates are missing or implausible. Per-camera time offset in config (keyed by camera model) for multi-camera shoots. `faucet groups <folder> [--json]`.
Done when: fixture bursts group correctly, singles stay alone, RAW+JPEG pairs never group with themselves. Print distances for same-burst vs different-scene pairs, pick the threshold from data, record it.
Prompt: "Do Phase 6 from PLAN.md."

### [ ] Phase 7 (S): Face/eyes spike + licence check
Build: nothing shipped. Evaluate at most two options that run headless on both OSes with a bundled model: MediaPipe face landmarker (WASM, no native module) and onnxruntime-node (prebuilt binaries). Downscale before detection, run in a worker. Prove one on 5 fixtures (a blink, a group shot) inside the PACKAGED app test on both CI OSes. Record code licence, model and training-data licence, model size, speed per photo in NOTES.md and THIRD_PARTY_LICENSES.md. Note bundle-vs-download-on-first-run.
Done when: one option is chosen with evidence, licence compatible with MIT. If neither works on Windows, STOP and tell me: v1 ships without eye detection.
Prompt: "Do Phase 7 from PLAN.md. Spike only, no integration."

### [ ] Phase 8 (M): Face integration
Build: per Shot faceCount, per-face eyes-open score, `allEyesOpen`, `anyEyesClosed`, face-region sharpness. Ignore faces below a minimum size and low-confidence detections; sunglasses, profiles and glare yield "unknown", never "closed". Match each face to the same person's other frames in the burst and judge relative to them. Flags only, no rejects yet.
Done when: the 3 blink fixtures flag correctly, group shot reports per-face results, no-face photos unaffected, thresholds calibrated and recorded.
Prompt: "Do Phase 8 from PLAN.md."

### [ ] Phase 9 (M): Scoring, cache, workers
Build: scores relative to group siblings (rank or z-score within group). Conservative hard-rejects: severe blur (skipped when `lowConfidence`), heavy clipping, eyes closed only if another frame in the group has them open. Best-per-group pick. `reasons[]` on every verdict. Cache keyed by path+mtime+size with correct invalidation. Worker pool with modest concurrency, progress, cancel, resume. One failing file never aborts. `faucet cull <folder> [--json]`.
Done when: fixtures look sane; second run near-instant; benchmark on 2,000 generated images recorded with a time budget in NOTES.md.
Prompt: "Do Phase 9 from PLAN.md."

### [ ] Phase 10 (S): Eval harness
Build: `labels.json` (your pick/reject per fixture, each marked `tune` or `holdout`). `faucet eval` reports % of your rejects caught, % of your picks surfaced as group-best, false-reject count, separately for tune and hold-out. Commit baseline numbers (JSON only, no photos). Regression script fails if hold-out gets worse than baseline beyond a tolerance. Script that fails a release tag if any `weights.json` value lacks `calibratedOn`.
Done when: baseline recorded; tune weights on the tune set only. False rejects of photos you love are the metric that matters most.
Prompt: "Do Phase 10 from PLAN.md."

### [ ] Phase 11 (M): XMP sidecar writer + CSV
Build: write/merge sidecars (Rating, Label only). Default `name.xmp`, optional `name.ARW.xmp` setting, and follow the convention of an existing sidecar if one is present. `.xmp.bak` first, atomic write, retry on Windows locks, refuse unparsable sidecars. Dry-run default, `--apply` to write. `--csv` export of picks/rejects for anything XMP can't carry.
Done when: a test proves an existing sidecar's other properties survive unchanged (runs on both OSes), plus tests for lock retry and unparsable files.
MILESTONE: the CLI is a useful tool on both OSes here. Use it on a real shoot before building UI.
Prompt: "Do Phase 11 from PLAN.md."

### [ ] Phase 12 (S, partly optional): Interop checks + JPEG embed mode
Build: manually verify in Lightroom (Read Metadata from Files), Bridge and darktable that ratings and labels appear; record what Lightroom does with reject (-1) and labels. Test whether Lightroom ignores a sidecar for a JPEG-only shoot. If it does, add opt-in `--embed-jpeg`: backup copy first, explicit confirmation, clear warning. This is the only feature allowed to touch originals.
Done when: findings recorded in NOTES.md and README draft notes. Skip the embed mode if Lightroom reads JPEG sidecars fine.
Prompt: "Do Phase 12 from PLAN.md." (You do the manual app checks; Claude implements any fix.)

### [ ] Phase 13 (M): Electron shell + group grid
Build: electron-vite app. Security config exactly as in CLAUDE.md. Thumbnails via a custom protocol limited to the cache folder, small thumbnails cached on disk. Folder chosen with the OS dialog. Run cull with progress and cancel over IPC. Virtualised grid of groups with best frame marked and verdict badges. Read-only.
Done when: opens fixtures, scrolls smoothly with 1000+ thumbnails, cancel works, security script and packaged-app Playwright test pass on both OSes.
Prompt: "Do Phase 13 from PLAN.md. Thin UI, all logic stays in src/core."

### [ ] Phase 14 (M): Review flow
Build: keyboard flow: arrows move, P pick, X reject, U clear, Space toggles 100% zoom, C compares two frames, Return accepts group and advances. Ctrl on Windows, Cmd on macOS where a modifier is needed. Overrides persist. Reasons shown for the focused photo.
Done when: you can cull a 100-photo folder with no mouse.
Prompt: "Do Phase 14 from PLAN.md."

### [ ] Phase 15 (M): Group editing + apply + undo
Build: manually merge and split groups in the UI. "Write sidecars" button with a summary and undo (restore `.xmp.bak`). After applying, a dialog with exact "Read Metadata from Files" steps for Lightroom. First-run screen recommends "cull before import". Handle the card or drive disappearing mid-run, read-only media, and network folders (copy to local cache before analysis).
Done when: merge/split changes persist, apply and undo work on a generated folder, removing a folder mid-run shows a clear error.
Prompt: "Do Phase 15 from PLAN.md."

### [ ] Phase 16 (S, partly optional): Settings + diagnostics
Build: sensitivity slider mapped to weights.json; sidecar naming setting; "Copy diagnostics" button (OS, app and library versions, camera models seen, recent error log; folder paths redacted, shown to you before copying).
Done when: slider visibly changes verdict counts on fixtures; diagnostics text contains no full paths.
Prompt: "Do Phase 16 from PLAN.md."

### [ ] Phase 17 (M): Release packaging
Build: finalise electron-builder. Decide macOS universal vs separate arm64/x64 builds, test the choice. CI uploads installers as artifacts and runs the Playwright test against the PACKAGED builds with screenshots saved. Verify sharp/exiftool unpacked. Windows CI test with a generated deep path; add the `\\?\` prefix if it fails. Release workflow that attaches installers to a GitHub Release on tag. Confirm versions are pinned.
Done when: tagging a version produces a `.dmg` and an `.exe` on the release page; you install the `.dmg` and it works.
Expect overrun; split rather than push on.
Prompt: "Do Phase 17 from PLAN.md. Packaging and release workflow only."

### [ ] Phase 18 (S): Docs + project hygiene
Build: README with screenshots: unsigned-app steps (macOS: Privacy & Security, Open Anyway; Windows: More info, Run anyway), build from source, the cull-before-import workflow, Lightroom steps, sidecar naming options, tested-cameras list, "maintained as time allows". Final `THIRD_PARTY_LICENSES.md`. Issue template asking for camera model and the diagnostics export. Check SignPath Foundation eligibility for free Windows signing (verify, don't assume). Confirm Dependabot config.
Done when: a stranger can follow the README on either OS.
Prompt: "Do Phase 18 from PLAN.md."

### [ ] Phase 19 (S): Windows tester + wider photo check (mostly you)
Build: a real Windows tester installs the `.exe`, scans and culls a folder, reports problems with diagnostics. Add photos from friends with other cameras to the hold-out set and run `faucet eval`. Fix what breaks in small follow-up phases. Decide on signing.
Done when: the Windows tester completes a cull, and hold-out results are recorded.
Prompt: only for fixes, one issue at a time.

## After v1 (backlog)
- Subject detection so sharpness is measured on the subject
- Optional aesthetic/expression model, only if eval shows heuristics plateau
- Learn weights from your overrides
- HEIC support, Linux build, WASM LibRaw for full RAW decoding
- Learned image embeddings if hashes prove too weak for grouping
- Burst story view

## Usage tips
- One phase per session, `/clear` between them, `/compact` if a phase runs long.
- Opus for Phases 4, 6-10 and 14 (judgement, calibration). Phases 0, 2, 11 and 18 are mechanical and should be fine on Sonnet if you want to stretch your budget.
- Paste the phase prompt verbatim. No "also while you're there" extras.
- If a phase touches more than ~8 files, stop, commit at green tests, split.
- CI failures: paste only the failing excerpt, never the whole log.
