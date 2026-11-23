# AI Video Studio — REST API Design

**Version:** 1.0.1 (APPROVED API baseline; non-breaking assistant history addition; 20 November 2026)  
**Date:** 18 November 2026  
**Inputs:** Approved Product Requirements Document v1.0; AI Video Studio HLD v1.0  
**Application stack:** React + Redux Toolkit/RTK Query + JavaScript; Node.js + Express + JavaScript; MongoDB/Mongoose  
**Media workflow:** Gemini structured planning → user approval → MongoDB generation job → local Kokoro TTS/Remotion/FFmpeg worker → protected media delivery  
**Budget:** ₹0 prototype development; infrastructure quotas and operational limits remain to be validated

## 1. Design goal and scope

Define stable **client-to-server** REST contracts. The web client never calls Gemini, TTS, MongoDB, storage admin APIs, or renderer commands directly. Those are internal adapters. API approval is **not implementation**, database implementation, or a claim that the POC's real dependencies have already been audited.

The primary flow is:

1. Sign in / create an authenticated session.
2. Create project and converse with the AI assistant.
3. Generate a draft storyboard from the user's idea and settings.
4. Edit/review/approve a specific storyboard revision.
5. Submit an asynchronous generation job; poll status until completion.
6. Preview and download the MP4 through an authorized asset route.

Custom Character Mode is **P1/gated** in the PRD. No realistic lip sync or real-person voice cloning is promised. Basic photo/presenter animation requires appropriate rights confirmation and synthetic-content disclosure.

## 2. Conventions

| Concern | Contract |
| --- | --- |
| Base prefix | `/api/v1` |
| Transport | HTTPS for remote deployment; local HTTP for development |
| Content | `application/json` unless multipart upload or binary download |
| JSON field style | `camelCase` |
| Identifiers | Opaque strings; clients do not parse MongoDB ObjectIds |
| Timestamps | ISO 8601 UTC (`2026-11-18T16:00:00.000Z`) |
| Pagination | `limit` (default 20, max 50) and opaque `cursor`; server gives `nextCursor` |
| Versioning | URI major version; breaking API changes require `/api/v2` |
| Authentication | Short-lived JWT **httpOnly cookie** + rotated refresh-session cookie; no access tokens in localStorage |
| CSRF | Origin check + double-submit/synchronizer token, `X-CSRF-Token` on cookie-authenticated write operations |
| Frontend | RTK Query with `credentials: 'include'`; refresh once on 401, avoid endless loops |
| Request tracing | `X-Request-ID` response header plus `requestId` in error body |
| Duplicate create protection | `Idempotency-Key` on generation start/retry |
| State conflicts | `409` on stale storyboard revision, invalid phase or incompatible active render |
| Long-running render | `202 Accepted`, with `generationId` and polling resource; completion not guaranteed |
| Privacy | Ownership check for projects, storyboards, jobs and assets on every route |

**Success response** (unless `204`, binary or redirect):

```json
{ "data": { "id": "prj_opaque", "status": "DRAFT" }, "meta": { "requestId": "req_opaque" } }
```

**Error response:**

```json
{
  "error": {
    "code": "REVISION_CONFLICT",
    "message": "This storyboard has changed. Reload the latest revision.",
    "details": { "currentRevision": 3 },
    "retryable": false
  },
  "requestId": "req_opaque"
}
```

Never leak stack traces, raw LLM responses, internal file paths, cookie values or secrets. Return `404` instead of revealing ownership of another user's resources.

**Status usage:** `200` read/edit, `201` created, `202` background render or asynchronous deletion/cancellation, `204` successful empty response, `302` short-lived signed-media redirect, `400` malformed payload, `401` unauthenticated, `403` authenticated but forbidden action, `404` missing/not owned, `409` state or revision conflict, `413` oversized upload, `415` unsupported format, `422` valid JSON but invalid field or unsupported setting, `429` rate/quota exceeded, `502/503/504` upstream/backend temporarily unavailable.

## 3. Public and account endpoints

| Method | Endpoint | Purpose | Success |
| --- | --- | --- | --- |
| GET | `/auth/csrf` | Bootstrap CSRF protection before auth/mutations | 200 |
| POST | `/auth/signup` | Create account, establish session | 201 |
| POST | `/auth/login` | Authenticate and set cookies | 200 |
| POST | `/auth/refresh` | Rotate refresh token/session and access cookie | 200 |
| POST | `/auth/logout` | Revoke current refresh session, clear cookies | 204 |
| GET | `/auth/me` | Fetch currently authenticated profile | 200 |
| GET | `/health` | Non-sensitive API liveness only | 200 |

### Auth rules

- Request for signup: `{ "displayName": "Demo User", "email": "demo@example.com", "password": "..." }`; enforce strict length/password requirements server-side and avoid exposing account enumeration in sensitive recovery flows.
- Login: `{ "email": "demo@example.com", "password": "..." }`; response sets cookies and includes `{ "user": { "id", "displayName", "email" } }` (never raw JWT).
- `GET /auth/me` returns `{ "data": { "user": { ... } } }`.
- Refresh rotates the refresh session atomically; reuse of a revoked token triggers session invalidation, as appropriate.
- Prefer same-origin reverse-proxy hosting with `Secure`, `httpOnly` and appropriate `SameSite` cookie settings. If frontend/backend are truly cross-site, use tightly configured CORS, `SameSite=None; Secure`, credentials and independent CSRF protection. No wildcard credentials CORS.
- CSRF bootstrap returns `{ "data": { "csrfToken": "..." } }` and necessary signed cookie; send header for state-changing endpoints including signup/login/refresh/logout.
- Password recovery is a later separately reviewed addition (email delivery needs infrastructure); not silently assumed in V1.

## 4. Project endpoints

| Method | Endpoint | Purpose | Success |
| --- | --- | --- | --- |
| POST | `/projects` | Create a draft project | 201 |
| GET | `/projects?limit=20&cursor=...` | Current user's paginated projects | 200 |
| GET | `/projects/{projectId}` | Detail, settings, current storyboard/output pointers | 200 |
| PATCH | `/projects/{projectId}` | Update editable title/settings | 200 |
| DELETE | `/projects/{projectId}` | Immediately revoke access; schedule asset cleanup | 202 |

Project create request:

```json
{
  "title": "Event Loop Explained",
  "prompt": "Explain JavaScript's event loop clearly",
  "settings": {
    "mode": "FACELESS", "durationSec": 60,
    "language": "en", "aspectRatio": "16:9",
    "tone": "EDUCATIONAL", "visualStyle": "MOTION_GRAPHICS"
  }
}
```

Settings: `durationSec ∈ {30,60,90}`; initial language `en` (optionally `hi` only when advertised in `/capabilities`); `mode = FACELESS | CHARACTER_2D`; aspect ratio `16:9 | 9:16` only when available. For character mode, `characterAssetId` is required **before starting generation**, validated as an owned, permitted upload with retained consent attestation. A project can be created with character mode pending image selection.

Project response:

```json
{
  "data": {
    "id": "prj_A1", "title": "Event Loop Explained",
    "prompt": "Explain JavaScript's event loop clearly",
    "settings": { "mode": "FACELESS", "durationSec": 60, "language": "en", "aspectRatio": "16:9", "tone": "EDUCATIONAL", "visualStyle": "MOTION_GRAPHICS" },
    "phase": "DRAFT", "currentStoryboardId": null,
    "latestGenerationId": null, "latestOutputAssetId": null,
    "createdAt": "2026-11-18T16:00:00.000Z", "updatedAt": "2026-11-18T16:00:00.000Z"
  }
}
```

`phase` is an overview for UI (`DRAFT | REVIEW | RENDERING | HAS_OUTPUT`); **generation status is authoritative** on the job. Existing completed outputs must not disappear simply because a later regeneration fails. `PATCH` cannot mutate an immutable approved storyboard or an in-flight job snapshot. Project deletion is logically immediate and media cleanup asynchronous; outputs and links are revoked right away.

## 5. Conversational AI assistant

| Method | Endpoint | Purpose | Success |
| --- | --- | --- | --- |
| POST | `/assistant/messages` | Add user turn to a project and request AI suggestion | 200 |
| GET | `/projects/{projectId}/assistant/messages?limit=20&cursor=...` | Read owner-scoped paginated conversation history (oldest-to-newest per page) | 200 |

Request:

```json
{ "projectId": "prj_A1", "message": "Make it beginner friendly, 60 seconds, English." }
```

Response:

```json
{
  "data": {
    "assistantMessage": "I suggest a 60-second beginner-friendly explainer with animated diagrams.",
    "suggestedSettings": { "durationSec": 60, "language": "en", "tone": "EDUCATIONAL", "mode": "FACELESS" },
    "missingInformation": [],
    "conversationRevision": 2
  }
}
```

**Conversation history (approved V1 contract):** `GET /projects/{projectId}/assistant/messages?limit=20&cursor=...` returns `{ "data": { "messages": [{"id":"msg_A1","role":"USER","content":"Explain the event loop","conversationRevision":1,"createdAt":"2026-11-18T16:00:00.000Z"}], "nextCursor": null } }`. `limit` defaults to 20 (max 50). Sort ascending by immutable `conversationRevision`; cursor points after last returned revision. Require authentication and owner-scoped project lookup (404 if not owned); do not return hidden system instructions, private provider payloads, or other users' conversation. `400` for malformed cursor, `401` for missing session. DB index `{projectId:1, conversationRevision:1}` unique.

Suggestions do **not** automatically mutate project settings: user chooses/accepts them with `PATCH /projects/{projectId}`. Keep only bounded server-side history, validate text and quota, moderate requests before provider calls, never expose Gemini credentials. Rate-limit and return `503 PROVIDER_UNAVAILABLE` or `429 AI_QUOTA_EXCEEDED` with recoverable UI instructions when necessary. Use a strict timeout rather than holding requests indefinitely.

## 6. Storyboard generation, editing, approval

| Method | Endpoint | Purpose | Success |
| --- | --- | --- | --- |
| POST | `/projects/{projectId}/storyboards/generate` | Gemini creates *new draft* from project prompt/settings | 201 |
| GET | `/projects/{projectId}/storyboards/current` | Read current draft/approved storyboard | 200 |
| GET | `/projects/{projectId}/storyboards/{storyboardId}` | Read an earlier owned storyboard/version | 200 |
| PATCH | `/projects/{projectId}/storyboards/{storyboardId}` | Edit DRAFT with `expectedRevision` | 200 |
| POST | `/projects/{projectId}/storyboards/{storyboardId}/approve` | Approve exact draft revision | 200 |
| POST | `/projects/{projectId}/storyboards/{storyboardId}/fork` | Copy approved storyboard into new editable draft (P1) | 201 |

**Generate draft:** `POST` body may be `{}`; the server reads the authenticated user's existing project settings and prompts. Response returns a **new version** of a validated storyboarding object. A successfully planned draft has immutable `id`, mutable `revision` during `DRAFT`, and `status: DRAFT`. Previous approved versions remain available to jobs that reference them. Gemini returns data only; server assigns IDs and validates allowlisted scene types, timings and visual props.

Storyboard response example (illustrative fragment; not a whole 60-second plan):

```json
{
  "data": {
    "id": "sb_A1", "projectId": "prj_A1", "revision": 1,
    "status": "DRAFT", "targetDurationSec": 60,
    "scenes": [{
      "sceneId": "scene_1", "template": "STACK_QUEUE",
      "narration": "JavaScript executes synchronous functions on a call stack.",
      "visualProps": { "title": "Call Stack", "items": ["main()", "calculate()"] },
      "estimatedDurationSec": 8
    }]
  }
}
```

PATCH request:

```json
{
  "expectedRevision": 1,
  "scenes": [{
    "sceneId": "scene_1", "template": "STACK_QUEUE",
    "narration": "JavaScript runs synchronous functions using a call stack.",
    "visualProps": { "title": "Call Stack", "items": ["main()", "calculate()"] },
    "estimatedDurationSec": 8
  }]
}
```

Server atomically checks `status=DRAFT` and `revision=1`, validates the **whole updated scene list** and increments to revision 2. Invalid/cross-owned IDs are `404`, stale revision `409 REVISION_CONFLICT`. Whitelist templates; reject executable code, URLs/paths and props not supported by the selected template. For longer script edits, recalculate narration estimate and ask user to confirm before rendering.

Approve request: `{ "expectedRevision": 2 }`. Response: `{ "data": { "id": "sb_A1", "revision": 2, "status": "APPROVED", "approvedAt": "2026-11-18T16:10:00.000Z" } }`. Approval freezes this storyboard snapshot. Regeneration after completion must fork/new-version; do not mutate the version used by an existing job.

Planning is synchronous for the initial low-volume MVP (limited provider timeout/retries). If Gemini planning consistently exceeds API platform timeouts, promote this operation into a separately tracked asynchronous planning job in an API v1-compatible extension before public launch.

## 7. Asynchronous generation endpoints

| Method | Endpoint | Purpose | Success |
| --- | --- | --- | --- |
| POST | `/projects/{projectId}/generations` | Enqueue video job using approved storyboard | 202 |
| GET | `/projects/{projectId}/generations?limit=20&cursor=...` | Generation history | 200 |
| GET | `/generations/{generationId}` | Poll current job status | 200 |
| POST | `/generations/{generationId}/cancel` | Request cancellation (best effort) | 202 |
| POST | `/generations/{generationId}/retry` | Enqueue **new** job from failed/cancelled approved snapshot | 202 |

### Start generation

Require `Idempotency-Key: <client-generated UUID or unique token>` header. Example request:

```json
{ "storyboardId": "sb_A1", "approvedRevision": 2 }
```

Server checks user/project ownership, `APPROVED` storyboard belongs to project and exact revision, user quota, worker availability and generation concurrency. If unavailable, return `503 WORKER_UNAVAILABLE` with `Retry-After` where reasonable; don't accept an indefinitely backed-up queue.

`202 Accepted` response:

```json
{
  "data": {
    "generationId": "gen_001", "projectId": "prj_A1",
    "storyboardId": "sb_A1", "approvedRevision": 2,
    "status": "QUEUED", "stage": null,
    "statusUrl": "/api/v1/generations/gen_001"
  }
}
```

Repeated requests with the **same key and exact same payload** return the same `generationId`. Reusing a key for a different payload yields `409 IDEMPOTENCY_CONFLICT`. Idempotency scope: `(authenticated user, endpoint/action, key)` with documented retention (proposal: 24 hours); enforce uniqueness in DB design. Do not start another active generation for the same project while one is running; conflict `409 ACTIVE_GENERATION_EXISTS`. Different projects can queue up to system caps.

### Get generation status (authoritative)

```json
{
  "data": {
    "id": "gen_001", "projectId": "prj_A1", "storyboardId": "sb_A1",
    "approvedRevision": 2, "status": "PROCESSING",
    "stage": "RENDER_VIDEO",
    "progress": { "completedStages": 3, "totalStages": 6 },
    "attempt": 1, "outputAssetId": null,
    "error": null,
    "createdAt": "2026-11-18T16:11:00.000Z",
    "updatedAt": "2026-11-18T16:12:00.000Z"
  }
}
```

Statuses: `QUEUED → PROCESSING → COMPLETED | FAILED | CANCELLED`; `CANCEL_REQUESTED` is a transitional state. Stages: `PREPARE_ASSETS`, `SYNTHESIZE_AUDIO`, `ALIGN_TIMELINE`, `RENDER_VIDEO`, `VALIDATE_OUTPUT`, `UPLOAD_OUTPUT`. Do **not** fabricate progress percentages. A completed job has a verified accessible `outputAssetId`; a failed job has sanitized `{code,message,retryable}`.

**RTK Query polling:** every ~3 seconds during QUEUED/PROCESSING/CANCEL_REQUESTED, adapt to server `Retry-After` and page visibility, stop on terminal status/unmount; refreshing the page simply reloads stored state. Polling frequency is a client design default, not a hard SLA.

**Cancellation:** `POST /cancel` returns `202` acknowledging the cancellation **request**, not claiming that rendering has stopped. The worker cooperatively checks cancellation flags. A completed job may reject cancellation with `409`.

**Retry:** only from FAILED/CANCELLED, after capacity/quota check; creates a **new** generation ID linked to the original (`retryOf`), preserving historical outcomes. Same idempotency rules apply. Quota isn't double-consumed for deduplicated requests; charging/refund policy on failures is a separate usage specification.

## 8. Media assets and delivery

| Method | Endpoint | Purpose | Success |
| --- | --- | --- | --- |
| POST | `/assets/uploads` | Upload permitted image with metadata/consent | 201 |
| GET | `/assets/{assetId}` | Read sanitized metadata | 200 |
| GET | `/assets/{assetId}/download` | Authorized media access (stream or short-lived redirect) | 200 / 302 |
| DELETE | `/assets/{assetId}` | Revoke and clean up an unused upload | 202 |
| POST | `/reports` | Flag prohibited or non-consensual output/asset for review | 201 |

**Upload:** `multipart/form-data` with `file`, `purpose=CHARACTER_REFERENCE`, `containsIdentifiablePerson=true|false`, `rightsConfirmed=true`, `aiDisclosureAcknowledged=true`. Server verifies authenticated owner, declared and detected content types, file size, image decoding, safe dimensions, re-encodes/strips EXIF where appropriate, screens uploads and records consent assertion. Provisional allowlist: JPEG/PNG/WebP, maximum **10 MiB**; thresholds pending actual asset provider validation. Reject unsupported and unsafe uploads; returning an ID must not imply model-generated realistic facial movement.

Metadata example:

```json
{
  "data": {
    "id": "asset_001", "ownerId": "user_001",
    "kind": "CHARACTER_IMAGE", "mimeType": "image/png", "sizeBytes": 235012,
    "status": "READY", "aiGenerated": false,
    "createdAt": "2026-11-18T16:15:00.000Z"
  }
}
```

Final MP4 is a `VIDEO_EXPORT` asset, `aiGenerated: true`, `mimeType: video/mp4`, `generationId` reference. Uploaded portraits remain **private** and should not be sent to third-party providers unless disclosed and permitted.

`GET /assets/{assetId}/download`: owner auth required; either `200` streaming binary in local mode or `302 Location: <short-lived signed URL>` in remote object storage. Signed URLs must be scoped/expiring (proposal: ≤60 s); never publish a permanent private-media public link. For video playback, streaming/range support or signed object URLs must work; test browsers. Cleanup after `DELETE` is asynchronous but authorization is revoked immediately. If a project or active job uses the asset, return `409 ASSET_IN_USE` or mark for controlled deletion after job termination. `POST /reports` records abuse report without exposing the report queue to the browser.

## 9. Usage, availability, capabilities

| Method | Endpoint | Purpose | Success |
| --- | --- | --- | --- |
| GET | `/usage` | Current user limits, consumed usage, next eligible action | 200 |
| GET | `/capabilities` | Supported modes, languages, durations, ratios, availability | 200 |

Example `GET /capabilities`:

```json
{
  "data": {
    "durationsSec": [30, 60, 90],
    "languages": ["en"],
    "modes": ["FACELESS"],
    "aspectRatios": ["16:9"],
    "worker": { "available": true, "status": "ONLINE" },
    "characterMode": { "enabled": false, "reason": "EXPERIMENTAL" }
  }
}
```

Advertise only tested options; don't show Hindi, 9:16 or character uploads as available until quality and safety gates pass. `GET /usage` returns configured daily limit, used/reserved counts, active/queued jobs and optional reset timestamp; avoid representing arbitrary daily quota as a guaranteed public service plan.

## 10. State transitions and ownership rules

```text
Storyboard:   DRAFT --approve(exact revision)--> APPROVED (immutable)
                   | edit(expectedRevision) -> DRAFT (revision + 1)

Generation:   QUEUED -> PROCESSING -> COMPLETED
                 |          |  \--> FAILED
                 |          \--> CANCEL_REQUESTED -> CANCELLED
                 \--> CANCELLED
```

A generation's `approvedRevision` and storyboard snapshot **never change** even when the project or another storyboard version is edited. Project owner is derived from auth, never from a client-supplied user ID; subsequent jobs or asset accesses query both ID and owner. Media deletions and job processing must be idempotent/restart-safe.

## 11. Security requirements for implementers

1. Central `requireAuth` middleware and per-resource ownership checks for every project/storyboard/generation/asset route. Favor 404 for non-owned IDs.
2. Passwords salted+hashed (`argon2id` preferred; bcrypt supported); JWT issuer/audience/expiry checks; refresh sessions hashed in DB, rotated/revoked; `httpOnly` secure cookies.
3. CSRF + Origin checks for cookie-authenticated writes, including uploads and auth mutations; strict CORS allowlist and `credentials: include` on the React client. Never store JWT or API keys in Redux/localStorage.
4. Strict server-side field allowlist: no client-set `ownerId`, `job.status`, `outputAssetId`, `storageKey`, scene execution code, provider IDs, lease tokens, or worker internal state.
5. Gemini output is untrusted data: validate structured schema, allowlisted scene templates and bounded strings/arrays, reject malicious URLs/paths and raw executable code before rendering.
6. Validate image magic bytes + real decoding + dimensions + upload size, sanitize EXIF, rate-limit and isolate temp assets, enforce retention. For identifiable people, obtain explicit rights/consent, offer deletion/reporting and label synthesized output. Consent attestation alone does not guarantee permission or prevent misuse; moderation and reporting are also required.
7. Rate-limit auth, assistant, planning, uploads and generation; enforce quotas atomically and worker availability before enqueue; cap parallel video renders (1 locally until benchmarks).
8. Protect media by owner authorization and short-lived delivery; no permanently public user-uploaded portraits. Do not log raw uploaded media or sensitive prompts by default.
9. Use centralized error handling and correlation IDs. Sanitize errors on TTS failure, Gemini quota depletion, worker offline, invalid scene plan, corrupt render, missing storage and retry conflict.
10. Worker is **internal**: it claims jobs from DB using private credentials, uses lease/heartbeat/retry logic, and does not expose an unauthenticated public `/worker/*` route.

## 12. Operational behavior and errors

| Scenario | Expected response and behavior |
| --- | --- |
| User not signed in | `401 AUTH_REQUIRED` |
| Project/job/asset belongs to another user | `404 NOT_FOUND` |
| Unsupported duration (e.g. 70) | `422 INVALID_DURATION` with allowed values |
| Character mode disabled | `422 FEATURE_UNAVAILABLE` or capability-gated UI |
| Prompt blocked or suspect image | `422 CONTENT_NOT_ALLOWED` or pending safety review |
| LLM quota consumed | `429 AI_QUOTA_EXCEEDED`, suggested retry policy |
| Free render worker offline | `503 WORKER_UNAVAILABLE`, no queued job created |
| Stale storyboard | `409 REVISION_CONFLICT` |
| Attempt render without approval | `409 STORYBOARD_NOT_APPROVED` |
| Double-click generation | Same result for same `Idempotency-Key` |
| Retry with different body, same key | `409 IDEMPOTENCY_CONFLICT` |
| Failed render | Job `FAILED` with sanitized code; original script retained |
| File exceeds max upload | `413 FILE_TOO_LARGE` |
| File not a decoded supported image | `415 UNSUPPORTED_MEDIA_TYPE` / `422 INVALID_MEDIA` |
| Export failed validation | Never `COMPLETED`, cleanup temp files |
| Delete project | Immediately hide/revoke access, async purge referenced files |

## 13. Traceability to approved PRD

| PRD requirement | API coverage |
| --- | --- |
| FR-001 | `/auth/*` |
| FR-002, FR-003 | `/projects` and `/projects/{id}` |
| FR-004 | `/projects/{id}/generations`, `/generations/{id}` |
| FR-005, FR-006 | `/assistant/messages` |
| FR-007–FR-010 | project settings + `/capabilities` |
| FR-011–FR-014 | generate/read/edit/approve storyboard |
| FR-015–FR-019 | generation submission + worker/asset contracts + video-validation acceptance tests |
| FR-020 | generation status, cancellation and retries |
| FR-021 | edit storyboard, fork, re-render |
| FR-022–FR-025 | uploads, consent, character gate and AI-disclosed asset metadata |
| FR-026 | `/usage`, admission control, `/capabilities` |
| FR-027–FR-028 | per-owner project/asset authorization and deletion |
| FR-029 | prompt/upload moderation + `/reports` |
| FR-030 | `aiGenerated` asset metadata and UI disclosure |

## 14. Suggested RTK Query endpoint grouping

- `authApi`: `csrf`, `signup`, `login`, `refresh`, `me`, `logout`.
- `projectsApi`: `createProject`, `listProjects`, `getProject`, `updateProject`, `deleteProject`.
- `assistantApi`: `sendMessage`, `getProjectMessages` (paginated).
- `storyboardsApi`: `generateDraft`, `getCurrentStoryboard`, `getStoryboardById`, `editStoryboard`, `approveStoryboard`, `forkStoryboard`.
- `generationsApi`: `startGeneration`, `listGenerations`, `getGeneration`, `cancelGeneration`, `retryGeneration`.
- `assetsApi`: `uploadImage`, `getAsset`, `getAssetDownload`, `deleteAsset`, `reportAbuse`.
- `usageApi`: `getUsage`, `getCapabilities`.

Suggested cache tags: `User`, `Projects`, `Project/{id}`, `Storyboard/{projectId}`, `Generations/{projectId}`, `Generation/{id}`, `Usage`, `Capabilities`. Use invalidation rather than duplicating server data in Redux slices. Use `FormData` for uploads (do not manually set boundary `Content-Type`). Use CSRF header for mutations and `credentials:'include'` for authenticated requests.

## 15. Open decisions before implementation

1. Which portions of Codex's working POC can be reused? Inspect its actual TTS, media render, FFprobe output and benchmark.
2. Confirm exact cookie hostname/CORS/CSRF deployment model.
3. Choose storage adapter (`LOCAL` for dev, object store for demo) and media retention policy.
4. Confirm `hi`, `9:16`, and `CHARACTER_2D` feature flags based on quality, compliance and performance tests.
5. Benchmark Gemini storyboard-generation latency; if API call regularly exceeds hosting timeout, introduce a planning job without changing client flow radically.
6. Decide per-user daily limits, queue caps and reservation/refund behavior; document in Usage/DB Design.
7. Agree on project deletion and generation cancellation cleanup semantics, and lifetime of idempotency keys.

## 16. Next SDLC deliverable

**Database Design:** MongoDB collections/field schemas for `users`, `sessions`, `projects`, `storyboards`, `generationJobs`, `mediaAssets`, optional `usageRecords` and assistant-message storage; indexes for ownership, sorting, active jobs, atomic worker leases, revision conflicts, and idempotency; deletion/retention/TTL rules.

**Implementation handoff rule:** The API contract is APPROVED (20 November 2026) for V1 development; place it with OpenAPI v1.0.1 in `docs/api-design/` and instruct Codex to preserve endpoint behavior while implementing module by module. An approval is not evidence that endpoints exist or pass integration tests.

## 17. References

- Approved AI Video Studio PRD v1.0 (`docs/PRD` or supplied project file).
- AI Video Studio HLD v1.0 (18 November 2026).
- OpenAPI Specification: https://spec.openapis.org/oas/
- MDN HTTP `202 Accepted`: https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Status/202
- OWASP API Security Top 10: https://owasp.org/projects/api-security-project


---

**Design-baseline approval:** 20 November 2026. Approved for Codex implementation and testing; unverified provider quotas, deployment limits and model behavior remain explicit engineering risks.
