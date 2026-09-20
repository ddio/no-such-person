# Third-party files

Served from this site so the page never has to contact another server. These files are **not**
covered by the repository's MIT license; they are © Google and distributed under the
[Apache License 2.0](https://www.apache.org/licenses/LICENSE-2.0).

| Path | Source |
|---|---|
| `mediapipe/` | npm [`@mediapipe/tasks-vision@1.0.1`](https://www.npmjs.com/package/@mediapipe/tasks-vision/v/1.0.1) (`vision_bundle.mjs`, `wasm/vision_wasm_internal.*`, `wasm/vision_wasm_nosimd_internal.*`) |
| `models/blaze_face_short_range.tflite` | [MediaPipe Face Detector](https://ai.google.dev/edge/mediapipe/solutions/vision/face_detector) — `face_detector/blaze_face_short_range/float16/1` |
| `models/face_landmarker.task` | [MediaPipe Face Landmarker](https://ai.google.dev/edge/mediapipe/solutions/vision/face_landmarker) — `face_landmarker/face_landmarker/float16/1` |

To upgrade MediaPipe, re-download the same paths from `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@<version>/`
and `https://storage.googleapis.com/mediapipe-models/`.
