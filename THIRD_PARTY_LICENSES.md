# Third-party licences

Runtime components bundled with Faucet and their licences. Phase 17 completes this for release (full licence texts).

| Component | Licence |
| --- | --- |
| Electron (includes Chromium, see `LICENSES.chromium.html` in the app) | MIT |
| sharp | Apache-2.0 |
| libvips (`@img/sharp-libvips-*`, dynamically linked) | LGPL-3.0-or-later |
| exiftool-vendored, exiftool-vendored.pl / .exe | MIT |
| ExifTool by Phil Harvey (bundled in exiftool-vendored.pl / .exe) | Perl terms: Artistic License or GPL |
| @mediapipe/tasks-vision 1.1.1 (JS + WASM, bundled into the renderer) | Apache-2.0 |
| MediaPipe `face_landmarker.task` v1 float16 (BlazeFace short-range, Face Mesh V2, Blendshape V2; `resources/models`) | Apache-2.0 per each model card; trained on Google's consented in-house images, data not distributed |
