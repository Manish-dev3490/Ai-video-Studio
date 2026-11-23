# AI Video Studio Local Video Engine

This package turns a validated, approved storyboard into a clean narrated MP4 and a separate WebVTT caption file. It uses reusable React/Remotion templates and local Kokoro CPU inference. The original `video-engine-poc/` and approved `docs/` remain independent and unchanged.

The engine implements Phase 2 media generation only. It provides no authentication, owner-authorized asset service, MongoDB queue, quotas, cancellation service or automated retention cleanup. It does not call Gemini or generate a storyboard from a prompt.

## Supported profile

| Setting | Initial implementation |
| --- | --- |
| Input | Canonical schema version 1, status `APPROVED`, 2–18 unique scenes |
| Templates | `TITLE`, `STEPS`, `STACK_QUEUE`, `FLOWCHART`, `KEY_POINTS` |
| Mode and language | Faceless English, educational motion graphics |
| Narration | Local Kokoro, `af_heart`, CPU, q8, natural speed `1` |
| Video | 1280×720, 30 FPS, H.264, yuv420p, AAC 48 kHz |
| Targets | 30, 60 and 90 seconds, with the approved ±5-second tolerance |
| Captions | Separate UTF-8 WebVTT, derived from the measured speech timeline |
| Concurrency | One Remotion frame-rendering slot; run acceptance jobs sequentially |

Known but unimplemented templates, character mode, Hindi, vertical layouts, extra voices and cloud TTS fallback are rejected or remain gated. The MP4 contains no burned-in captions; use the VTT alongside it for a player captions toggle.

## Prerequisites

- Node.js 22.13 or newer within 22.x, or Node.js 24 or newer, matching `package.json`.
- An installed Chrome executable. Windows defaults to `C:\Program Files\Google\Chrome\Application\chrome.exe`; another supported host must pass its browser path explicitly. Rendering does not download a browser.
- Dependencies installed in this package, including Remotion's platform FFmpeg/FFprobe binaries. A separate global FFmpeg, Python installation or NVIDIA GPU is unnecessary for this CPU profile.
- Network access once to acquire the locked dependencies and pinned model assets; generation then uses local files.

The actual acceptance environment and performance measurements belong in the Phase 2 validation report. Cross-platform performance and 60/90-second timing must be measured rather than extrapolated from the old prototype.

## Isolated dependency setup

From the repository root:

```powershell
cd packages/video-engine
npm ci --ignore-scripts --cache .cache/npm
```

Use this package's lockfile and local cache. This setup leaves the prototype's package manifest, lockfile and installed dependencies alone. All Remotion packages are pinned to the same version.

If the Windows npm shim points to a missing npm CLI, the npm bundled with the installed Node distribution can be invoked directly:

```powershell
node "C:/Program Files/nodejs/node_modules/npm/bin/npm-cli.js" ci --ignore-scripts --cache .cache/npm
```

That path is installation-specific. There is no need to change global npm configuration for this package.

## Acquire and verify Kokoro

Run from `packages/video-engine`:

```powershell
node scripts/setup-kokoro.js
node scripts/setup-kokoro.js --verify-only
```

Acquisition downloads `config.json`, tokenizer files and `onnx/model_quantized.onnx` from the pinned `onnx-community/Kokoro-82M-v1.0-ONNX` revision:

```text
1939ad2a8e416c0acfeecc08a694d14ef25f2231
```

The default model directory is `.cache/kokoro/<revision>/`. A checksum manifest records the downloaded files and the `af_heart` voice bundled with `kokoro-js`. Verification checks those files without downloading replacements. Missing or changed assets fail explicitly; they do not trigger cloud narration.

The setup command is the acquisition boundary. During narration the provider disables remote model resolution, loads the local q8 model and packaged voice, and blocks HTTP(S) fetch attempts. The speech child exits before browser rendering starts so the ONNX model does not remain resident throughout video composition.

## Render from the command line

Choose a fresh output directory for every attempt. The three manually authored fixtures are separate scripts with increasing explanatory depth:

```powershell
node scripts/render.js --input fixtures/event-loop-30.json --output-dir ../../artifacts/phase2/manual-30-001
node scripts/render.js --input fixtures/event-loop-60.json --output-dir ../../artifacts/phase2/manual-60-001
node scripts/render.js --input fixtures/event-loop-90.json --output-dir ../../artifacts/phase2/manual-90-001
```

The commands run sequentially. Output is structured stage/progress JSON. A successful run finishes with local `COMPLETED` and paths to both artifacts. Existing final media and existing preparation directories are preserved rather than overwritten.

Optional paths use `--model-dir <local-model-directory>` and `--browser <installed-chrome-executable>`. There is no CLI flag for changing the tested voice, speeding narration up, enabling cloud fallback or skipping technical validation.

Separate preparation and rendering when inspecting speech/timing or recovering after a browser-only failure:

```powershell
node scripts/render.js --input fixtures/event-loop-30.json --output-dir ../../artifacts/phase2/prepared-30-001 --prepare-only
node scripts/render.js --output-dir ../../artifacts/phase2/prepared-30-001 --render-only
```

Render-only mode rechecks the frozen storyboard, source WAVs, metadata, timeline, captions and input props before using the preparation. It does not accept a replacement storyboard or narration file. Changed preparation fails integrity checks; create a new approved attempt instead.

## Use the JavaScript API

From an ESM script in the repository root:

```javascript
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {
  renderExplainer,
  prepareVideo,
  renderPrepared,
} from './packages/video-engine/src/index.js';

const storyboard = JSON.parse(await readFile(
  './packages/video-engine/fixtures/event-loop-30.json', 'utf8',
));

const result = await renderExplainer({
  storyboard,
  outputDir: path.resolve('./artifacts/phase2/api-30-001'),
  onProgress: event => console.log(event),
});

console.log(result.videoPath, result.captionPath, result.validation.passed);
```

`prepareVideo(options)` and `renderPrepared({outputDir, ...options})` expose the same split workflow as the CLI. The output directory is absolute in the API. The CLI resolves its input/output arguments relative to its working directory. Internally resolved output cannot target `docs/`, `review/`, `video-engine-poc/` or `.git/`.

The Node validators read the canonical scene/job schemas under `review/phase-1-contracts/`; keep that repository layout with the package. Browser components do not import filesystem or Ajv code. Input approval flags in local JSON are a QA convention, not server authentication or proof of resource ownership.

## Timing and caption behavior

Each scene is synthesized separately. The provider returns WAV audio and real PCM chunk boundaries with the corresponding transcript. The pipeline verifies source hashes, sample counts, signal levels and FFprobe durations before building a single shared timeline.

- Speech durations become integer milliseconds, with frame counts rounded upward to avoid cutting words.
- Initial scene lead/tail pauses are six frames each. Additional target padding is bounded to two seconds total and half a second per scene; a larger mismatch is never filled with arbitrary silence.
- A duration outside ±5 seconds raises nonretryable `DURATION_REVISION_REQUIRED`. Revise the narration and approve a new fixture/version; the engine never truncates speech or changes its speed to force a match.
- Caption cues use actual synthesized chunk timings. There is no estimated word highlighting or transcription claim.
- WebVTT text is escaped as literal content, and the written sidecar is checked against the exact frame-derived transcript/timing map.

The fixture scripts are manual local acceptance inputs, not Gemini-generated output. If measurements require a script correction, keep the previous input/audio evidence and bump the fixture revision before a new preparation.

The accepted 30/60/90 fixtures pass real browser layout checks. Additional maximum-length stress inputs with long unbroken labels can overflow the estimated text boxes, particularly headings and dense flowcharts. The current text-fit estimator is not a guarantee for every schema-valid string. Add browser-measured fitting or explicit input-density limits before exposing unrestricted visual editing. Newline whitespace is collapsed for display without changing the frozen input or narration.

## Output and evidence

Successful runs retain:

| File or directory | Purpose |
| --- | --- |
| `video.mp4` | Validated clean narrated video |
| `captions.vtt` | Separate selectable/downloadable captions |
| `storyboard.json`, `timeline.json`, `input-props.json` | Frozen approved input and canonical measured scheduling |
| `public/narration/` | Per-scene Kokoro WAVs used for the render |
| `speech-metadata.json`, `model-manifest.json` | Actual speech/model/voice/checksum evidence |
| `preparation.json` | Preparation fingerprints, timings and reconstruction metadata |
| `bundle/` or `bundle-*` | Retained render bundle and its fingerprint |
| `render-manifest-*.json`, `render-configuration-*.json` | Actual engine/template/browser/font/encoding provenance |
| `published-export-manifest.json` | Final video/caption hashes and paired expiry metadata |
| `validation.json`, `result.json` | Technical checks, timing metrics and local outcome |

Technical validation checks codec/profile, frame count, timeline and target duration, complete decoding, audio presence, caption equivalence and codec-tolerant comparison of every scene's rendered audio against its source WAV. It also checks for saturated output samples. These checks do not establish factual correctness or substitute a human listening/visual review.

`scripts/inspect-visuals.js` captures stills and exact-frame DOM bounds from completed bundles. `scripts/inspect-layout-stress.js` captures separate synthetic maximum-density cases; these do not create an approved user revision. Their contact sheets use Sharp 0.34.5 already resolved in the pinned Transformers dependency tree, with no extra image-library installation. The restricted bundled FFmpeg build does not include a tile filter.

Artifacts are private local QA evidence, not authenticated SaaS media delivery. They inherit the host filesystem permissions. The manifest records the contract's seven-day expiry, but this package does not enforce expiry, authorize downloads or run cleanup; the result explicitly reports those service features as unimplemented. A lock prevents simultaneous rendering into one output directory; separate output directories are not coordinated by a global scheduler. Retained intermediates are useful for audit/QA and are not an active retention service. `artifacts/`, model caches and dependency directories are ignored by the repository's generated-artifact rules.

## Tests and acceptance

```powershell
npm test
```

Tests cover schema/runtime capability checks, approved-input hashing, measured timelines, duration failures, caption escaping/drift, speech chunking/WAV normalization, render-boundary layouts and pipeline argument/integrity protections. Pure unit tests do not download models or prove real inference quality. Real acceptance requires a fresh local Kokoro preparation and validated 30/60/90-second MP4/VTT outputs, with recorded environment, elapsed times and resource measurements.

## Acceptance driver and Windows resource sampling

From `packages/video-engine`, run the acceptance profiles sequentially with a new output root:

```powershell
node scripts/validate-phase2.js --output-root ../../artifacts/phase2/acceptance-001
```

The driver uses the three approved fixtures and writes each profile under `<output-root>/30`, `/60` and `/90`. `--only 60` selects one target; `--only 60,90` selects two. `--resume` preserves completed results after checking their fixture identity and artifact checksums, or resumes rendering a verified preparation. It does not repeat narration for an already prepared run. An existing incomplete speech preparation is retained as failed evidence; use a new root for a fresh attempt. Each invocation writes a uniquely named `benchmark-*.json` report. A reused result's original timing is not a new performance measurement.

For Windows process-tree measurements, use PowerShell 7 from the repository root:

```powershell
pwsh -NoProfile -File packages/video-engine/scripts/benchmark-phase2.ps1 -OutputRoot "C:\absolute\path\to\artifacts\phase2\acceptance-001" -Target 60
pwsh -NoProfile -File packages/video-engine/scripts/benchmark-phase2.ps1 -OutputRoot "C:\absolute\path\to\artifacts\phase2\acceptance-001" -Target 90
```

Replace the example with an absolute local path; run the commands sequentially. `-Target` accepts 30, 60 or 90. The wrapper always calls the driver with `--resume`; choose a new output root when a fresh preparation/render is required. Optional `-BrowserExecutable` and `-ModelDirectory` pass installed local paths through to the driver. `-TimeoutMinutes` defaults to 90 and accepts 30–1440.

Each wrapper invocation creates a new `metrics-<target>-<UTC>-<guid>/` directory containing `environment.json`, one-second `process-tree-metrics.csv`, `summary.json`, and the child's `stdout.log`/`stderr.log`. Logs are drained asynchronously and written after the child exits. Short progress is printed every 20 seconds. Sampling uses Windows Toolhelp and native physical-memory APIs without WMI/CIM. Start-time identities guard against PID reuse; timeout/error cleanup is restricted to the launched child tree.

The summary reports child wall time, sampled aggregate process-tree working set/private bytes, sampled CPU seconds, and available system memory. One-second sampling can miss brief children or peaks; summed working sets count shared pages, CPU is a sampled lower bound, and system memory includes unrelated host activity. Compare fresh runs on the same host and keep these limits with the results.

## Licensing and release checks

Retain the dependency/model notices and review the applicable terms before redistributing assets or enabling a public product:

- `kokoro-js` and Transformers.js declare Apache-2.0. Review the [Kokoro project](https://github.com/hexgrad/kokoro), [pinned ONNX conversion repository](https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/tree/1939ad2a8e416c0acfeecc08a694d14ef25f2231), upstream [Kokoro model card](https://huggingface.co/hexgrad/Kokoro-82M), and bundled voice provenance/notices.
- Remotion uses its own license. Confirm applicable commercial automation eligibility against the [official license FAQ](https://www.remotion.dev/docs/license/faq) and installed license text before public deployment.
- Bundled Inter font files declare OFL-1.1; retain their notices. Verify licensing for any additional fonts, images, music or other assets introduced later.

Model availability, third-party terms and platform compatibility require review when upgrading. The local checksum manifest pins this tested acquisition; it does not itself grant licensing rights or guarantee identical output on another runtime.
