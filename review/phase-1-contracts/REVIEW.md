# AI Video Studio Phase 1 Contract Drafts

**Status: Draft 2 updated with approved decisions — 21 November 2026.** The product owner approved all twelve recommendations for this contract update. Their approved initial policies are recorded in [approved-policy.json](approved-policy.json), with a decision-by-decision record in [decisions.json](decisions.json). This approval authorizes contract updates and validation only. Application implementation remains unauthorized.

All changes stay under `review/phase-1-contracts/`. The six original approved documents, working prototype and Phase 0 artifacts remain unchanged. No dependencies, application modules, database migrations or commits are part of this update.

## Review files

- [OpenAPI draft 2](openapi.json): the same 32 approved operations across 26 paths, with updated payloads and policy annotations.
- [Scene schema](schemas/scene.schema.json): canonical templates, bounded props, immutable storyboards and measured timing.
- [Job schema](schemas/job.schema.json): public status/receipts and separate internal execution, reservation and publication records.
- [Job lifecycle](job-transitions.json): guarded transitions, recovery, cancellation, settlement and retention rules as declarative data.
- [Workflow example](examples/review-flow.json), [API cases](examples/api/cases.json), [scene cases](examples/scenes/cases.json) and [job cases](examples/jobs/cases.json).
- [Validation results](validation/results.json) and preservation manifests in `validation/`.

## Approved initial policies

| Area | Approved choice |
| --- | --- |
| Templates | Nine canonical IDs. First develop/test TITLE, STEPS, STACK_QUEUE, FLOWCHART and KEY_POINTS. Enable other templates only after tests; character remains P1/gated. |
| Input limits | Initial upper bounds include 2–18 scenes, prompt 2,000 characters and title 120 characters, with closed per-template props. Bounds alone do not prove layout or spoken duration. |
| Rendering | Initial 1280×720, 30 FPS, 30/60/90-second targets with ±5-second tolerance. Measured speech governs timing. |
| Captions | Clean MP4 plus a separate private WebVTT file. Browser captions toggle and separate video/caption downloads. MP4 alone is caption-free. Burned-in export is deferred. |
| Voice/style | Preferred local Kokoro, one quality-tested English voice, EDUCATIONAL and MOTION_GRAPHICS. No public voice selector or automatic cloud fallback. |
| Duplicate requests | 24-hour replay window; matching request returns the original admission receipt/job without another reservation. Changed body or route target conflicts. |
| Demo quotas | Three slots per user UTC day, one slot per new admission for any preset, one running plus two waiting globally, one active job per project. Values are initial configurable demo limits. |
| Worker recovery | Heartbeat every 10 seconds, renewable lease 60 seconds, at most two total automatic execution attempts. Fencing and actual process-stop checks protect publication and cancellation. |
| Media | Private local authenticated byte-range streaming initially. Remote signed redirects are deferred. Each new read checks owner, deletion and expiry. |
| Retention | Successful intermediates clean after delivery is verified; failed temporary artifacts at most 24 hours. Video and caption exports share seven-day expiry from verified successful publication UTC. |
| Provenance | Frozen approved script/settings plus internal engine/template/TTS/audio/timeline/font/encoding records and final video/caption hashes. |
| Login | Same-origin deployment, production HTTPS and secure httpOnly cookies with explicit SameSite plus CSRF/Origin checks. Access 15 minutes, rotating refresh seven days, password-only signup 15–128 characters. |
| Approval | Generation-setting changes require a new draft, review and approval. Title-only project edits do not. Earlier approved snapshots and successful outputs remain preserved, subject to media retention. |

The initial profile describes future implementation targets. It does not advertise currently implemented Kokoro voices, generic templates or SaaS endpoints. Only the existing 30-second prototype has been benchmarked.

## Baseline and scope of the update

The original [API Design v1.0.1](../../docs/AI_Video_Studio_API_Design_v1.0.1.md), [Database Design v1.0](../../docs/AI_Video_Studio_Database_Design_v1.0.md), [HLD](../../docs/AI_Video_Studio_HLD_v1.0.md), [Pipeline Design](../../docs/AI_Video_Studio_Audio_Video_Pipeline_Design_v1.0.md), and [UI UX Design](../../docs/AI_Video_Studio_UIUX_Design_v1.0.md) remain untouched. The conversation-approved choices are recorded here as a separate contract update.

OpenAPI remains version `1.0.1-draft.2` on `/api/v1`. The drafts use OpenAPI 3.1 and external JSON Schema 2020-12 models, consistent with the [OpenAPI Schema Object specification](https://spec.openapis.org/oas/v3.1.0.html#schema-object). Caption delivery reuses `/assets/{assetId}/download`; no worker, subtitle-specific, prompt-edit or other business route has been added.

The twelve recommendation records have status `APPROVED`. Schema and OpenAPI artifacts have status `DRAFT_UPDATED_WITH_APPROVED_DECISIONS`: policy approval does not claim implemented behavior or blanket approval of every newly completed DTO spelling and deployment detail.

## Canonical scene and timing rules

Scene data uses `sceneId`, `template`, `narration`, `visualProps`, `estimatedDurationSec` and optional `assetIds`. Allowed template IDs are TITLE, STEPS, STACK_QUEUE, FLOWCHART, COMPARISON, TIMELINE, KEY_POINTS, IMAGE_WITH_LABELS and CHARACTER_PRESENTER_2D. Legacy aliases remain mapping notes only:

| Older illustrative name | Canonical intent |
| --- | --- |
| TITLE_CARD | TITLE |
| PROCESS_STEPS | STEPS |
| FLOW_DIAGRAM | FLOWCHART |
| SUMMARY_CARD | KEY_POINTS |
| IMAGE_PRESENTER | Explicitly choose IMAGE_WITH_LABELS or CHARACTER_PRESENTER_2D and apply the relevant feature gate |

The prototype's existing topic-specific `kind` values are unchanged. Schema membership never enables a template. Text is inert content; media references are owner-resolved IDs, never executable props or arbitrary paths/URLs.

Planning estimates use seconds, measured speech uses integer milliseconds, and the compositor uses integer 30 FPS frames. Scene ranges are half-open and contiguous, transitions fit inside their windows, narration offsets are scene-relative, and caption boundaries are composition-absolute. Speech requires at least `ceil(audioMs * fps / 1000)` frames plus its offset. Estimates remain advisory; measured timing must meet the approved tolerance.

A large measured mismatch fails with a safe revision-required outcome. The user reviews and approves a new draft rather than silently changing frozen text or cutting/speeding speech. A later generation-setting change has the same reapproval requirement. Title-only changes preserve approval.

## Clean video and selectable captions

A completed publication requires an owned, verified ready VIDEO_EXPORT (`video/mp4`) and matching CAPTION_TRACK (`text/vtt`). Public generation metadata carries `outputAssetId` and `captionAssetId`; the existing asset route delivers either file. Both derive from the same canonical measured timeline. The browser caption toggle uses the sidecar; downloading only the MP4 provides no captions.

Video and caption share `expiresAt = verifiedPublishedAt + 604800 seconds`. Expiry or user deletion blocks new downloads/range requests even if physical cleanup has not completed. Historical job status stays COMPLETED and retains both IDs; current media availability tells the UI whether preview/download is still possible. Already delivered bytes cannot be recalled. A missing/unready publication pair must never appear as a new completed result.

## Jobs quota and cancellation

Projects retain overview phases DRAFT/REVIEW/RENDERING/HAS_OUTPUT; storyboards retain DRAFT/APPROVED. Generation statuses remain QUEUED, PROCESSING, CANCEL_REQUESTED, COMPLETED, FAILED and CANCELLED, with six separate processing stages. No new status was invented for script review or expired media.

A matching 24-hour idempotency replay runs after authentication/ownership/deletion checks and before fresh capacity/quota checks. Uniqueness is owner/action/key; the request digest also includes method, normalized route template, concrete target and canonical body. Replays preserve the original admission data, while response tracing metadata belongs to the current HTTP request. Polling remains the source of live job status.

Each new admission atomically links its job, receipt, capacity and one-slot quota reservation in a transaction-capable MongoDB setup. Automatic recovery uses the same job/reservation, with a new fencing token and at most two total attempts. User retry is a new job/admission with fresh checks.

A new retry of FAILED additionally requires `error.retryable=true`. A known duration/revision-required snapshot cannot bypass this rule through a new start request: correct the draft, review it and approve it first. Other nonretryable errors require their indicated corrective action. Matching authenticated receipt replay remains allowed because it creates no work or quota reservation.

| Confirmed outcome | Reservation disposition |
| --- | --- |
| Successful publication | Consume |
| System/provider failure | Release |
| Pipeline validation or measured-duration failure requiring a revised draft | Release |
| User cancellation before actual video rendering starts | Release |
| User cancellation after video rendering has started | Consume |
| Cancellation requested but execution/stop evidence remains uncertain | Keep reserved until safely resolved |

Internal `ExecutionState.renderStartedAt` records the first actual rendering start and survives reclaims. A current stage label alone cannot determine the cancellation charge. Cancellation and completion race through guarded writes; the first committed outcome wins. Fencing blocks stale writes, while stale workers must also stop their owned processes before real capacity is considered free.

If start evidence arrives after cancellation was accepted, an evidence-only guarded update may record a process proven to have started before cancellation. It cannot launch, resume or publish work. A post-cancel launch cannot be classified as prior user-rendered work. Unknown start/stop ordering keeps cancellation/reservation pending until safely resolved.

## Internal provenance

Public job responses expose no leases, private hashes, storage paths or provider credentials. An immutable RenderManifest records approved input, selected execution versions, audio and WebVTT/timeline bindings before rendering. A separate PublishedExportManifest binds final video/caption hashes and shared publication expiry without mutating those inputs.

Audio reuse requires matching text, voice, model and relevant settings plus verified retained artifacts. Cleaning intermediates or expiring exports can remove the blobs needed for exact reproduction; retained metadata alone is not an unconditional byte-identical regeneration guarantee.

## Deferred details

The approved policies remain settled. These narrower details need implementation-time selection or verification:

- Exact Kokoro runtime/model/voice and quality results; additional templates, Hindi and vertical quality gates.
- Duration-specific render/stage timeouts after 30/60/90-second benchmarks. The measured 30-second render does not establish a 60/90-second SLA.
- Exact cookie names, paths, domain/SameSite selection and local-development/CSRF binding for the same-origin deployment.
- Canonical JSON serialization, optional empty-body normalization and post-window idempotency key handling.
- WebVTT escaping and frame-to-millisecond serialization, preserving canonical timing.
- Remaining DTO vocabulary and cleanup scheduling within the approved private-access/retention rules.
- Remote object storage/signed URLs, burned-in export and other gated P1 extensions.

These are not twelve reopened product decisions. They authorize no feature activation or application implementation.

## Validation and preservation

Run the contract-only checker from the repository root:

```powershell
node review/phase-1-contracts/validation/check-contracts.cjs
```

It reads existing installed Ajv 8 and ajv-formats without changing dependencies. Checks include JSON parsing, local references, schema meta-validation/compilation, positive/negative examples, the exact 32-operation surface, selected OpenAPI structure/security, approved-policy consistency, and SHA-256 preservation of 74 original documentation/prototype/benchmark files excluding node_modules and .git.

Examples marked `semanticViolations` intentionally pass structural validation and identify future service checks. This phase does not implement those checks, ownership, database transactions, job execution or rendering. A complete dedicated OpenAPI validator is not installed, so selected structural checks are not a full OAS conformance certification.

Original approved documentation and the working prototype remain unchanged. No subsequent implementation phase has started.
