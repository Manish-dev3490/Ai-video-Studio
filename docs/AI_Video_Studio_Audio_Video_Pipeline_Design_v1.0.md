# AI Video Studio — Audio & Video Generation Pipeline Design

**Version:** 1.0 — Proposed technical design (not yet implemented or benchmarked)  
**Date:** 10 November 2026  
**Input:** Approved AI Video Studio PRD v1.0  
**Budget:** ₹0 development/PoC; public compute capacity remains unproven  
**Product:** Prompt → script → storyboard → narration + animated visuals → captions → playable 30/60/90-second MP4

## 1. Purpose and design principles

The goal is to produce coherent short-form explainer videos, not to generate an unrestricted cinematic film. AI plans content; a controlled, deterministic scene template library renders it. The system must validate AI outputs, avoid arbitrary generated code execution, and allow script review before resource-intensive work.

- **Audio-first synchronization:** The actual, measured spoken-audio duration drives animation timings, not an LLM's estimate.
- **Reproducible renders:** Versioned script, scene plan, template IDs, assets and narration should reproduce a video.
- **Controlled AI:** LLM returns structured data with known, allowlisted scene types.
- **Small, reversible stages:** Regenerate only failed/revised stages where possible.
- **Truthful failure states:** Never mark a job completed before the MP4 is probed and playable.
- **Budget-aware execution:** Limit concurrent jobs and API calls; local worker for PoC.

## 2. Logical processing pipeline

1. **Intake:** User chooses mode (Faceless or Custom Character, if available), prompt, 30/60/90-second target, language, aspect ratio and tone.
2. **Planning:** LLM drafts scene-by-scene narration with visual intents using a fixed JSON schema.
3. **Review:** User corrects script/visual plan and explicitly approves it.
4. **Narration:** TTS produces audio for each scene or bounded narration segment; export as WAV or normalize consistently.
5. **Duration measurement:** ffprobe measures actual scene audio lengths; trim leading/trailing silence if needed, but never cut spoken words.
6. **Retiming:** Scheduler assigns each scene an effective duration = narration duration + modest visual padding. If total length misses target tolerance, revise the script and regenerate affected audio or request approval. Do not truncate speech or blindly speed it up.
7. **Visual generation:** Safe template renderer maps structured scene data to React/SVG animated diagrams, text, illustrations and optional licensed images.
8. **Captions:** Generate line/segment-based captions from approved script and measured scene timings. For word-level highlighting, add a true alignment/transcription pass later; do not claim exact word timings from estimates.
9. **Composition:** Remotion places scenes, voice clips, captions and optional licensed music on a shared timeline. Transitions count toward total duration.
10. **Rendering:** Local Node worker renders MP4 (target H.264 video / AAC audio, subject to encoder availability); FFmpeg can normalize/transcode as necessary.
11. **Quality assurance:** ffprobe checks container, streams and duration; decode/playback sanity tests inspect for empty/corrupted files, missing audio and bad timing.
12. **Delivery:** Store project metadata and bounded temporary assets; expose a preview and authorized download; clean up unused intermediates.

## 3. Audio pipeline

**Input:** Approved narration text for each scene, speaker style, selected language and target duration.  
**Candidates:** Local Kokoro TTS (test English/Hindi voice quality and Intel Arc/CPU performance); a currently available free-tier Gemini Flash TTS model as fallback. Check cloud usage quotas and data policy before using personal content.  
**Output:** Per-scene audio files, measured `durationMs`, language, provider/model version, volume settings and transcription text.

Key policies:
- Generate per scene to simplify corrections and scene-level regeneration.
- Reject zero-length, silent, clipped, wrong-language or corrupt narration; retry within a cap.
- Normalize loudness across scenes and use short pauses for transitions.
- A 30/60/90-second *target* is not a license to crop the last words; script revision comes before duration enforcement.
- Avoid assuming a fixed words-per-minute rate; use a rough estimate solely when drafting and trust measured audio later.
- Keep any custom avatar's narration as a clearly synthetic voice; no imitation of a real person's voice in V1.

## 4. Video/visual pipeline

**Input:** Validated, versioned scene specifications and image assets.  
**Engine:** Remotion with React/SVG scene components; FFmpeg/ffprobe for inspection and media operations.  
**Initial allowlisted templates:**

| Template ID | Purpose | Example |
|---|---|---|
| `TITLE_CARD` | Topic introduction | “What is the Event Loop?” |
| `FLOW_DIAGRAM` | Nodes and arrows, step animation | Web API → Callback Queue |
| `STACK_QUEUE` | Push/pop sequence | Call stack, task/microtask queues |
| `PROCESS_STEPS` | Sequential explanation | Tokenize → process → predict |
| `COMPARISON` | Side-by-side concepts | Synchronous vs. asynchronous |
| `IMAGE_PRESENTER` | Authorized uploaded photo/object as a stylized presenter | Cartoon stone beside animated gravity diagram |
| `SUMMARY_CARD` | Key takeaways | Last 5 seconds |

Each scene template accepts validated parameters only (title, labels, steps, order, colors, image identifiers, timings). Do **not** directly execute model-produced JavaScript/JSX, HTML, CSS, SVG markup, file paths or shell commands. Do not allow users' URLs to be fetched without filtering and permission safeguards.

**Custom Character Mode:** This is a gated P1 feature. Validate image type/size and single-person clarity where relevant, require image rights/consent, apply simple 2D pan/zoom/bob/gesture motion and combine with narrated animations. No claim of photorealistic lip-sync or the real person's voice.

## 5. Shared data contract — illustrative structure

```json
{
  "projectId": "project_123",
  "targetDurationSec": 60,
  "language": "en",
  "aspectRatio": "16:9",
  "creationMode": "faceless",
  "scriptVersion": 1,
  "scenes": [
    {
      "id": "scene_01",
      "narrationText": "JavaScript runs synchronous code on its call stack.",
      "visualTemplate": "STACK_QUEUE",
      "visualProps": {
        "title": "Call Stack",
        "items": ["main()", "task()"]
      },
      "estimatedDurationMs": 9000,
      "audioAssetId": null,
      "measuredAudioDurationMs": null,
      "startMs": null,
      "endMs": null
    }
  ]
}
```

**Validation:** Scene count capped; scene IDs unique; narration nonempty; only known template IDs; arrays and strings length-limited; no executable instructions; total target one of {30,60,90}; language and aspect ratio allowed; uploaded assets belong to current user. The worker fills in audio durations and calculated start/end times *after* narration is generated.

## 6. Asynchronous job lifecycle

`DRAFT → SCRIPT_PENDING_APPROVAL → QUEUED → SYNTHESIZING_AUDIO → BUILDING_VISUALS → COMPOSING → RENDERING → VALIDATING → COMPLETED`

Any processing stage can transition to `FAILED` with a user-safe, actionable message. Allow bounded retries per stage with idempotent generation request IDs. Preserve approved script if a later stage fails. Store immutable render version, detailed internal logs and user-facing status separately. Limit concurrency to one local render until hardware benchmarking demonstrates more capacity.

## 7. Duration/sync policy

- Calculate each scene's timeline duration from *measured* narration plus intro/outro or transition padding.
- Include scene transition overlap in the timeline math, if used.
- Recalculate caption segment boundaries after any script/audio change.
- Target 30, 60 or 90 seconds; the approved PRD's provisional ±5-second tolerance is the initial test threshold, subject to sign-off.
- If duration is out of range, revise narration/re-render audio or obtain approval for an alternative; never silently clip spoken explanation.
- Validate sample/frame rates and avoid accumulating floating-point timestamp drift by using integer frames in the video compositor.

## 8. Proof-of-concept implementation order

### Spike A — deterministic video and audio
Create a 30-second MP4 from a manually written script, a free/local TTS voice, and two or three hand-coded Remotion templates. Validate audio presence, scene accuracy, duration and local render time.

### Spike B — structured AI storyboard
Use an LLM to generate the versioned schema for the same topic. Validate with schema checks and render with templates. Do not permit execution of arbitrary model-generated code.

### Spike C — duration variants
Produce separate 30-, 60- and 90-second outputs; measure p50/p95 local rendering time and disk/RAM usage, plus content and caption quality.

### Spike D — integration and persistence
Connect the job to the backend API, project state, retries, preview/export and authenticated file access.

### Spike E — optional custom presenter
Test safe image-upload, consent and a basic 2D presenter animation. If this is too costly or low quality, gate it and launch faceless mode first.

## 9. PoC acceptance tests

1. Script approval is required before video generation.
2. Test Event Loop example includes diagrams relevant to narration, not unrelated stock footage.
3. Every generated MP4 has video and audio streams and is decoded successfully.
4. User gets 30-, 60- and 90-second outputs within signed-off duration tolerance, without clipped speech.
5. Captions match approved narration at the scene/segment level; any claimed word-level sync must be tested.
6. Stage failure shows actionable status; partial artifacts do not masquerade as a complete video.
7. Per-user projects and assets remain isolated; media deletion is supported.
8. No mandatory paid subscription is required for local PoC; record free-tier quotas and data-processing terms.
9. Initial single-job rendering works on developer's 16GB ASUS Zenbook with Intel Arc graphics; document actual performance rather than assuming 8GB dedicated VRAM.

## 10. Technology evidence (verified November 2026)

- Gemini API pricing and TTS free-tier listings: https://ai.google.dev/gemini-api/docs/pricing
- Kokoro model and license: https://huggingface.co/hexgrad/Kokoro-82M (also see https://github.com/hexgrad/kokoro)
- Remotion docs (audio and video): https://www.remotion.dev/docs/video-and-audio
- Remotion current license: https://www.remotion.dev/docs/license/pricing
- FFprobe docs: https://ffmpeg.org/ffprobe.html

## 11. Decisions and non-decisions

**Recommended for Spike A:** Remotion + React/SVG; FFmpeg/ffprobe; Kokoro local TTS first with Gemini TTS free-tier fallback; manual script before Gemini-generated planning; one local render at a time.  
**Open until benchmarking:** Which TTS model/voice is best, English/Hindi quality, exact video export resolution/framerate, captions at word level, local render speed, cloud provider, browser rendering and character animation fidelity.  
**Excluded:** Full photorealistic cinematic generation, automatic voice cloning, unlimited public free rendering, arbitrary AI-generated code execution.

**Status:** APPROVED technical pipeline baseline for V1 (20 November 2026); Codex audio/video POC reported working by product owner, but its implementation has not been independently audited and the complete SaaS is not implemented.


---

**Design-baseline approval:** 20 November 2026. Approved for Codex implementation and testing; unverified provider quotas, deployment limits and model behavior remain explicit engineering risks.
