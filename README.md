# AI Video Studio

The app now connects authenticated projects to saved AI assistant conversations, Gemini script/storyboard planning, explicit approval and a separate durable video worker. The original Remotion prototype, approved documentation and reusable Phase 2 engine remain unchanged.

## Run locally

Prerequisites: Node.js 22.13+ within 22.x, or 24+; npm; MongoDB Server, installed Chrome, and PowerShell 7 for the validated Windows worker. Development scripts default to this machine's installed MongoDB 7, Chrome and PowerShell executables. Set `MONGOD_BINARY`, `BROWSER_EXECUTABLE` and `POWERSHELL_EXECUTABLE` when using another installation. Cross-platform worker execution has not been validated.

```powershell
npm ci --ignore-scripts --cache .cache/npm
npm run setup:local
# Set GEMINI_API_KEY in the ignored .env file. Never add it to frontend code.
npm run dev
```

Open **http://127.0.0.1:5173** and choose **Create account**. Signup creates a real MongoDB user; there are no default credentials. Save an idea, generate the script, edit/save if needed, approve the saved revision, then start rendering. Preview and private downloads become available after media validation and paired publication.

For a fresh checkout, also install and verify the independent engine before starting the worker:

```powershell
cd packages/video-engine
npm ci --ignore-scripts --cache .cache/npm
node scripts/setup-kokoro.js
node scripts/setup-kokoro.js --verify-only
cd ../..
```

Model acquisition needs network access once. Kokoro narration itself loads the verified local model; it has no cloud narration fallback. Missing Gemini configuration returns an honest unavailable state while saved projects remain usable. The configured model defaults to `gemini-2.5-flash`, verified through the actual API; change `GEMINI_MODEL` explicitly rather than relying on an unverified model alias. Generated text still needs factual review.

`setup:local` creates an ignored `.env` with distinct random secrets; it preserves any existing file and never prints the secret values. `.env.example` contains configuration names only. Keep the hostname consistent: `127.0.0.1` and `localhost` are different cookie origins.

The development launcher starts a dedicated single-node MongoDB replica set on loopback port **27018**, with persistent data under `.cache/phase3-mongodb/data`, the API on **4100**, Vite on **5173**, and a separate worker process. Replica-set transactions protect admission, approval and quota settlement. Existing local accounts were backed up before this database was upgraded; the Windows MongoDB service/data are untouched. Ctrl+C requests worker shutdown before stopping the launcher's processes; accounts remain on disk. A worker failure leaves the UI/API running with truthful offline availability. Occupied local ports are refused. A custom `MONGODB_URI` must point to an already-running transaction-capable deployment.

If the local npm shim is broken, use the installed Node distribution's npm CLI:

```powershell
node "C:/Program Files/nodejs/node_modules/npm/bin/npm-cli.js" run build
node scripts/dev.mjs
```

Do not run another copy of the launcher while it is already running.

## Repository layout

```text
apps/
  api/src/       Express routes, security, MongoDB repositories, dashboard reads
  api/src/projects/ Validated Gemini planning, revisions and immutable approval
  api/src/jobs/ Transactional admission, leases, process control and publication
  api/test/      Authentication and security tests
  web/src/       React screens, RTK Query, Redux draft state, Tailwind tokens
  web/test/      Forms and session transport tests
  worker/src/    Separate private rendering process entry point
scripts/         Local configuration, development launcher, real browser/DB tests
packages/
  video-engine/  Preserved Phase 2 standalone engine and its independent lockfile
video-engine-poc/ Preserved original prototype
docs/            Approved documentation, read-only during implementation
review/          Approved Phase 1 contracts, preserved
artifacts/       Ignored benchmarks, screenshots and verification reports
```

The root npm workspaces include `apps/api`, `apps/web` and `apps/worker`. They do not reinstall or migrate the prototype or video-engine package.

## Implemented behavior

- Signup, login, logout and authenticated profile lookup, email verification, password recovery, display-name edits and confirmed sign-in email changes.
- Salted Argon2id password hashes: 64 MiB, three passes, one lane. Passwords accept 15–128 Unicode code points at signup without trimming or truncation; existing-account login accepts 1–128. Names use the approved database's 2–80 trimmed character range.
- Fifteen-minute signed access JWT and seven-day absolute refresh-session lifetime. Refresh rotation uses a MongoDB single-document compare-and-swap; confirmed reuse revokes the session, including outstanding access tokens. Rotation never extends the original seven-day expiry; after 2,048 rotations, sign in again.
- HttpOnly, host-only, explicitly SameSite=Lax cookies; Secure in production. Access/CSRF cookie path `/api/v1`, refresh path `/api/v1/auth`. No authentication tokens in browser storage or Redux. The CSRF bootstrap proof is held in module memory and matched against a signed HttpOnly browser-binding cookie.
- Exact Origin and CSRF header checks on mutations, bounded JSON requests, sanitized errors, request IDs, no-store responses and auth rate limits. Logout revokes the logical session and clears both auth cookies.
- Protected overview, project library, account page and a saved project creation/review flow. Dashboard data comes from authenticated APIs and MongoDB; there are no fake project or activity metrics.
- Signed, owner-bound cursor pagination for projects; owner-scoped usage reads; truthful worker-offline capabilities.
- Cross-tab session-change notifications clear private caches and unsaved drafts. Refresh uses Web Locks when available and an in-tab single-flight fallback otherwise. Browsers without Web Locks can require re-login after a simultaneous cross-tab refresh race.
- Responsive navigation, keyboard focus, reduced-motion support, loading/error/retry/empty states, locally packaged Manrope and DM Sans fonts.

Project save/read/update/delete, bounded Gemini planning, draft scene editing, revision conflicts, immutable approval, background admission and private video delivery are implemented. Billing, administration, character mode, Hindi and vertical output remain outside this implementation.

## Account verification and recovery

Account settings now support display-name edits, verification status/resend and changing the sign-in email after a current-password check. The current address stays active until the new-address link is explicitly confirmed. Existing unverified accounts retain studio access; verification adds an ownership indicator without changing the approved login response shape. Password reset is available from the sign-in page.

Development defaults to `MAIL_TRANSPORT=local`. Verification, reset and confirmation messages are written to ignored private `var/mail` JSON files. They are not sent to an inbox or exposed over HTTP. Run `npm run mail:preview` to list the latest message locations, then open the private file to follow its link. These files contain action links and should stay private. No default command prints the links or credentials.

For actual inbox delivery, explicitly configure `MAIL_TRANSPORT=resend`, `RESEND_API_KEY` and a verified `MAIL_FROM` in the ignored server `.env`. The HTTPS adapter uses a fixed provider endpoint, bounded requests, stable idempotency keys and at most three delivery attempts. Local mode is rejected in production; missing delivery configuration returns an honest unavailable state. Real external inbox delivery has not been exercised on this machine because no email-provider credential is configured. The adapter request/error behavior is tested without external mail.

One-use random links expire after 24 hours for verification and 30 minutes for password reset or email change. Their purpose-bound hashes are stored in MongoDB. Mail bodies are encrypted with AES-256-GCM and bound to their outbox metadata; terminal delivery/cancellation erases ciphertext. `MAIL_ENCRYPTION_SECRET` can supply a separate key; otherwise a domain-separated key is derived from the server JWT secret. Changing the encryption secret invalidates pending encrypted email bodies, so drain/resend pending messages when rotating it. Outbox metadata expires seven days after its action expiry.

Link fragments are captured in component memory and scrubbed from the browser URL; an explicit POST confirmation prevents link scanners from consuming them. Password reset and email confirmation atomically invalidate previous sessions using a persisted authentication epoch, including sessions created concurrently from older credentials. Neither operation automatically signs the user in. Recovery responses are generic for absent, suspended, cooled-down and eligible accounts; a 250ms response floor reduces ordinary timing differences without claiming constant-time behavior under database contention. These choices follow the [OWASP password recovery guidance](https://cheatsheetseries.owasp.org/cheatsheets/Forgot_Password_Cheat_Sheet.html).

## Planning, rendering and retention

The dashboard's **Save idea & start chat** action explicitly saves a project and opens its private assistant. The saved idea is prefilled, and the user chooses **Send message** before any chat provider call. Existing Create video → Save project → Script review remains available; saved projects and review screens also link to their assistant.

Gemini can ask clarifying questions, remember recent answers and propose supported settings. Replies and their user messages are atomically saved as an ordered pair. **Apply suggested settings** performs a separate explicit project update; chatting never silently changes settings, approvals or running renders. Script generation reads the saved conversation and stores internal revision/hash provenance, then still requires ordinary script review and approval.

Conversation history is owner-scoped, cursor-paginated and retained until project deletion. Up to 200 messages are stored per project; reaching that cap rejects a new turn rather than silently discarding history. Only the most recent 12 messages within a 16,000-character budget are sent to the provider. Earlier messages remain saved. Deletion immediately revokes history/replay access and a bounded cleanup pass erases transcripts and receipts.

Chat has a separate configurable `ASSISTANT_DAILY_LIMIT` (default 30 accepted requests per user UTC day), independent of video-generation slots. Accepted requests count even if their provider attempt fails, bounding upstream usage. A per-project lease serializes turns; at most two assistant calls run concurrently in one API process. Durable 24-hour idempotency receipts recover lost responses without duplicate messages or quota/provider work. The UI's replay-only check cannot accidentally admit a request that never reached the server.

Input preflight blocks obvious credential formats and narrowly recognized unsafe requests before storage/provider use. The same checks cover saved context, assistant replies, every storyboard scene string, manual edits, approval, admission and worker execution. Gemini safety filters provide a separate layer. These are basic English text safeguards, not a comprehensive semantic or multilingual moderation service. Provider data is strictly validated against supported settings, question/text limits and canonical reply contracts. No local fabricated assistant reply is used when Gemini is unavailable.

The server validates provider output against the canonical contracts and the five tested templates. Gemini receives topic/settings text through a server-only credential header. Its response cannot supply execution code, filesystem paths, raw media URLs, owner IDs or worker state. Concurrent planning uses a persisted project lease; dropped responses are checked against the saved draft before another paid request. The provider grammar is deliberately compact because Google's constrained decoding rejected the full canonical union; the complete canonical, semantic, text-density and narration validators still run on the server.

Scene edits use `expectedRevision`. Approval is a separate request for the exact saved revision; approved snapshots remain immutable. Settings changes clear the selected approval and require a new script/approval. Historical approvals and successful outputs remain intact. Runtime density limits are narrower than structural schema bounds to avoid the known Phase 2 text-layout edge cases.

Phase 8 adds measured narration recovery. When actual local speech misses the existing ±5-second tolerance, no video is published. The renderer rechecks its owned WAVs against speech metadata and the approved snapshot, then retains bounded numeric timing evidence. The progress/review screen shows requested/measured length and a word-count guide. **Revise narration to fit** explicitly asks Gemini for a new draft with the same scenes and visuals; it preserves the old approval and requires fresh review/approval before rendering. Lost responses recover the already saved correction through a read-only check rather than automatically issuing another AI call. Missing legacy measurements, ownership/selection changes, safety holds and active work prevent correction.

Initial planning now targets approximately 68/140/210 spoken words for 30/60/90 seconds. Server-counted under/overfilled candidates can use one repair request within the existing maximum of two provider attempts; persistent mismatch returns a controlled error. Word targets remain guidance: pronunciation, wording and pauses affect real timing. No speech clipping, speedup, altered tolerance or automatic approval is introduced.

New visual work uses short headings (70 characters maximum) and conservative text-fit checks derived from the pinned Inter font's measured glyph advances and the preserved renderer's actual text boxes. Shape-sensitive checks reject wide labels that can overflow despite a character cap. Flowcharts support an ordered 2–4-node forward chain; use STEPS for cycles/branches. Existing approved scripts remain readable, but unsupported layouts require a reviewed new draft before another render. Font/renderer changes require remeasuring and rerunning browser visual QA. The original engine and prototype remain unchanged.

Admission requires an idempotency key, an active worker and an exact matching approval/settings snapshot. One slot is reserved transactionally from a configurable default of three per user per UTC day. There is one running job, at most two waiting, and one active generation per project. Matching retries of the same HTTP admission return the original immutable receipt before capacity/quota checks. User retry creates a new job/reservation; automatic recovery retains the original reservation and allows at most two total execution attempts.

Worker leases last 60 seconds and heartbeat every 10 seconds. Fencing rejects stale writes. A native Windows Job Object contains Kokoro/Chrome/FFmpeg descendants; assignment is confirmed before execution, and parent death terminates the owned process tree. Cancellation remains pending until the tree is confirmed stopped. The render-call handoff is synchronously gated: the owned child is paused immediately before `renderMedia`, then the worker durably commits authorization/render-start evidence before allowing the call. A stage label alone never proves this boundary. Cancellation before this handoff releases the slot; after it consumes the slot. System/provider/validation failures release it.

The engine measures narration, builds a frame-accurate timeline, renders clean H.264/AAC video and validates every scene's audio against its source. There is no silent speech clipping or speedup. A duration mismatch requires a revised draft and fresh approval. Time budgets are duration-specific and based on observed local benchmarks; load and available memory materially affect runtime. They are limits, not ETAs.

Validated MP4 and VTT blobs are copied to private `var/media/exports`, checksum-checked and atomically published as a pair. They share exactly seven days from verified publication. Owner, project deletion, expiry and pair availability are checked on every new read. Single byte ranges support browser playback. No storage path or permanent public media URL is returned. Verified full deliveries allow early intermediate cleanup; undelivered successful intermediates still expire, and failed temporary attempts are eligible after 24 hours. Both the API and worker run bounded cleanup passes. Metadata/job history remains after physical deletion.

Project deletion revokes access immediately, then cleanup removes blobs. Finish/cancel an active generation before deleting; the server returns `PROJECT_BUSY` otherwise. The UI exposes actual job stages, cancellation, eligible retry, attempt history, playback, captions and downloads without fabricated completion times.

## API surface

All routes use `/api/v1` and the approved envelopes. JSON success: `{data,meta:{requestId}}`. Error: `{error:{code,message,retryable,details?},requestId}`.

| Method | Route | Purpose |
| --- | --- | --- |
| GET | `/health` | Non-sensitive process liveness |
| GET | `/auth/csrf` | Public, same-origin CSRF bootstrap |
| POST | `/auth/signup` | Create user and cookie session |
| POST | `/auth/login` | Establish cookie session |
| POST | `/auth/refresh` | Rotate the refresh secret |
| POST | `/auth/logout` | Revoke session and clear auth cookies |
| GET | `/auth/me` | Sanitized current user |
| POST | `/auth/request-email-verification`, `/auth/verify-email` | Request and explicitly confirm ownership |
| POST | `/auth/forgot-password`, `/auth/reset-password` | Private-link password recovery |
| POST | `/auth/confirm-email-change` | Confirm new address and end prior sessions |
| GET/PATCH | `/account/profile` | Owned profile and display-name edits |
| POST/DELETE | `/account/email-change` | Request/cancel a verified address change |
| GET | `/projects?limit=20&cursor=…` | Current owner's project page |
| GET | `/usage` | Current owner's daily counters |
| GET | `/capabilities` | Tested profile and live worker/queue availability |
| POST | `/assistant/messages` | Saved project chat turn and proposed settings |
| GET | `/projects/:id/assistant/messages` | Owner-scoped ascending conversation history |
| POST | `/projects` | Save project |
| GET/PATCH/DELETE | `/projects/:id` | Owned project lifecycle |
| POST | `/projects/:id/storyboards/generate` | Generate and validate Gemini draft |
| POST | `/projects/:id/storyboards/revise-duration` | Explicit new narration draft from an owned measured failure |
| GET | `/projects/:id/storyboards/current` | Current selected draft/approval |
| GET/PATCH | `/projects/:id/storyboards/:storyboardId` | Read or revise a draft |
| POST | `/projects/:id/storyboards/:storyboardId/approve` | Approve exact saved revision |
| POST | `/projects/:id/generations` | Idempotent transactional admission |
| GET | `/projects/:id/generations` | Owned attempt history |
| GET | `/generations/:id` | Real status/stage polling |
| GET | `/generations/:id/narration-feedback` | Owner-scoped numeric timing and saved-correction lookup |
| POST | `/generations/:id/cancel`, `/retry` | Confirmed cancellation or new admission |
| GET | `/assets/:id`, `/assets/:id/download` | Private metadata and ranged media |
| POST | `/reports` | Authenticated private misuse-report intake |

Mutations require `Origin` matching `APP_ORIGIN`, `X-CSRF-Token` from the bootstrap and cookies. Auth responses contain only `{user:{id,displayName,email}}`, never raw tokens.

## Safety reports and private operator review

Account settings, script review and video preview expose **Report misuse**. Send exactly one `projectId` or `assetId`, a `reasonCode` (`SAFETY`, `NON_CONSENSUAL`, `IMPERSONATION`, `PRIVACY`, `OTHER`) and a 1–2,000-character description. Do not include credentials or unnecessary personal information. The authenticated route returns only `{id,status:"OPEN",createdAt}`. It performs no target lookup; private, nonexistent and owned identifiers receive the same acknowledgement. A receipt confirms intake, not ownership/existence or automatic enforcement. `REPORT_DAILY_LIMIT` defaults to 10 accepted reports per user UTC day, enforced transactionally across API processes. Report text stays outside Redux and browser persistence.

There is no browser operator role, public report queue or HTTP review endpoint. A trusted operator uses local terminal access and private database credentials:

```powershell
npm run operator:review -- --help
npm run operator:review -- list
npm run operator:review -- show --id REPORT_ID
npm run operator:review -- review --id REPORT_ID --revision 0 --operator local-reviewer --note "Reviewed the reported concern"
# Read the current revision before each subsequent action:
npm run operator:review -- hold --id REPORT_ID --revision 1 --operator local-reviewer --note "Restrict the verified target pending investigation"
```

`list` returns bounded case metadata; `show` returns one case's sanitized description, claimed target and recent audit entries. It does not impersonate owners or expose arbitrary private media. Operator IDs are audit labels, **not authentication**: protect filesystem/terminal access and MongoDB credentials. Each mutation requires the current case revision and a bounded note, and appends an audit entry in the same transaction. Target-to-project ownership is verified privately before enforcement; a claimed ID alone cannot trigger an automatic hold.

A project hold blocks AI requests, editing, approval, new rendering and new media requests. Existing project/script reads and reporting remain available to the owner; deletion remains available after active rendering stops. Queued work cancels and releases its reservation. Running work receives a cancellation request; the worker confirms process shutdown before settling and retains the existing before/after-render-handoff quota policy. Completion is fenced against an active hold. Bytes already downloaded or buffered by a browser cannot be recalled.

`release` clears only the hold belonging to that case; it never restarts a job. `resolve` requires prior review and preserves any active hold until an explicit release. Reports and audit records currently have no TTL; final retention/erasure policy, review staffing and response/appeal process remain public-launch decisions. The private CLI is basic triage and enforcement, not a complete moderation console. Custom-character/image uploads remain disabled, so this phase does not implement an upload classifier.

## Verify

```powershell
npm test
npm run build
npm run test:e2e
npm run test:phase4
npm run test:phase4:ui
npm run test:phase5
npm run test:phase6
npm run test:phase7
npm run test:phase8
npm run test:phase8:visual
# Actual Gemini requests; requires server-side key:
npm run test:phase6:real
npm run test:phase8:real -- --duration 30
```

Unit tests cover hashing, validation, signed claims, expiry, cookie flags, CSRF/Origin, replay/races, rate limits, safe return paths and frontend renewal. The end-to-end command uses a fresh, separate local MongoDB process/data directory and the installed Chrome binary; it does not download browsers or use the existing database service. It tests real UI/signup/login, route protection, simultaneous-tab renewal/logout, owner isolation, pagination, usage, recoverable errors, mobile navigation and persistence across API/database restart. Test accounts and seeded project fixtures exist only in the isolated test database. Reports and screenshots live under `artifacts/phase3/e2e-*`.

The Phase 4 command uses an isolated replica set and private test directories under `var/phase4-tests`. It calls real Gemini and performs a fresh local Kokoro/Remotion render, so it takes substantially longer than unit tests. Its reports/screenshots/media copies live under `artifacts/phase4/e2e-*`. Passing a prior Phase 4 run directory as an argument tests a legitimate failed-job retry using its preserved real approval, without another planning request. Synthetic executor tests are explicitly limited to transaction/process plumbing; they do not claim real generated-media quality.

`test:phase4:ui` uses a separately isolated real MongoDB/Chrome session with an explicitly injected planner fixture and no provider credential, real worker, TTS or rendering. It checks revision conflicts, local edit preservation, settings invalidation, separate approval and project deletion guards. Reports live under `artifacts/phase4/ui-check-*`.

`test:phase5` runs real Chrome, a dedicated MongoDB replica set and the actual private local email dispatcher. It verifies profile persistence/cross-tab updates, explicit verification, same-route link replay, generic recovery, password reset/session revocation, preserved projects, confirmed/cancelled email changes and cross-account isolation. It creates no accounts in the development database, calls no external email/AI service and starts no render. Reports/screenshots live under `artifacts/phase5/e2e-*`; private messages and test database files stay under ignored `var/phase5-tests`.

`test:phase6` uses explicitly injected assistant/planner fixtures with real Chrome, MongoDB and application routes. It tests clarifications, persistence, explicit settings, lost-response recovery, safe failures, approval preservation, scoped history and deletion without cloud or render calls. `test:phase6:real` separately exercises actual Gemini chat, persistence across an API restart and conversation-informed storyboard planning. Its validated drafts remain unapproved and do not start rendering. Reports live under `artifacts/phase6`; private test databases live under ignored `var/phase6-tests`. Passing a prior real-test directory to the real script resumes its saved conversation without repeating chat turns.

`test:phase7` uses real Chrome, an isolated MongoDB replica set, real report routes and the actual local operator CLI. It checks report privacy, owner/target isolation, CSRF/authentication, mobile forms, revision conflicts, holds/releases and private media access. Explicit fixture bytes test ranged media authorization, not video quality. Cloud AI, email delivery, TTS and real rendering are disabled. Unit/integration tests additionally cover safety checks, late provider results and worker cancellation/quota boundaries. Reports/screenshots live under `artifacts/phase7`; databases and fixture media stay under ignored `var/phase7-tests`.

`test:phase8` checks correction, lost-response recovery, fresh approval, session fencing, mobile feedback and owner isolation using explicit AI/timing fixtures with real Chrome/MongoDB. `test:phase8:visual` renders synthetic still frames against an unchanged retained QA bundle and checks actual DOM bounds at accepted text-density boundaries; it does not synthesize audio or create MP4s. `test:phase8:real -- --duration 30|60|90` exercises real Gemini and local Kokoro/Remotion through the dashboard in a private test database. `--resume artifacts/phase8/render-...` reopens its saved state. When cloud quota is unavailable, explicit `--saved-script artifacts/phase8/reviewed-scripts/FILE.json` uses reviewed QA narration with real fresh rendering and a new dashboard approval; its report labels planning as a fixture and makes no fresh-Gemini claim. Evidence is written only under new `artifacts/phase8` and `var/phase8-tests` directories.

## Deployment boundary

### Isolated local production profile (Phase 9)

The zero-cost local profile runs the production web build and API behind a loopback HTTPS gateway, with one separate Windows worker and a dedicated replica set. It uses `https://studio.localhost:8443`, private API port4200 and MongoDB port27019. Development ports/data and `.env` remain separate. This is a localhost production-mode rehearsal, not a public deployment.

```powershell
npm run build
npm run production:init
npm run production:check
npm run production:start
# Ctrl+C gracefully stops this profile's owned gateway, worker, API and MongoDB.
```

Init creates ignored `.env.production.local` once with distinct auth/CSRF/mail-encryption secrets and a local-only self-signed certificate; it does not replace an existing profile, install packages, change Windows trust stores, create services or open a firewall. Browsers do not automatically trust the certificate. Review its local-only identity before proceeding through a browser certificate warning. The generated profile explicitly disables mail until real provider configuration exists and starts with blank provider keys. Existing server-side Gemini configuration can be securely provisioned into the ignored profile; no cloud call occurs on startup.

Only loopback proxy addresses are trusted. The gateway replaces client forwarding headers, validates the local Host and keeps the API listener private. `GET /api/v1/ready` reports only ready/not_ready for a writable replica set; worker availability remains separately visible in studio capabilities. HTTPS enforcement and sanitized request metadata logging are enabled. Do not scale this single-process profile without a shared limiter and deployment review.

For real email, set `MAIL_TRANSPORT=resend`, `RESEND_API_KEY` and `MAIL_FROM` in the appropriate ignored environment file. The sender must be authorized by the provider. `email:check` reads development configuration; `email:production` reads the local production profile. Both are configuration-only by default and make zero network requests. After choosing an approved inbox, an explicit operator test is available:

```powershell
npm run email:production
npm run email:production -- --send --to APPROVED_TEST_INBOX
# With sufficient provider read permissions:
npm run email:production -- --status PROVIDER_EMAIL_UUID
```

The plain-text test contains no account action link. Private outbox receipts retain only the provider message ID/acceptance time after encrypted payload erasure. Provider acceptance, provider delivery and inbox placement are separate outcomes; none is claimed from a mocked test or HTTP acceptance alone. Verify actual signup/reset links with the approved inbox after provider setup. See [the local production runbook](ops/production/README.md) for configuration, shutdown, optional future Caddy templates, backups and limitations. No backup/restore proof or public infrastructure is implied by this profile.

`npm run build` emits `apps/web/dist`; `npm start` serves this build and the API from the same Express origin. Set `NODE_ENV=production`, an HTTPS `APP_ORIGIN`, a private MongoDB connection and independent high-entropy secrets. Public TLS termination and remote hosting infrastructure have not been deployed or tested; the Phase9 gateway is validated only on localhost. Development HTTP exceptions apply only to loopback origins. Never expose the dedicated unauthenticated local MongoDB process externally.

The API uses process-local rate-limit counters and defaults to `trust proxy: false`; the isolated local profile explicitly trusts its loopback gateway. Multiple API instances require a shared limiter and a verified proxy/IP configuration before public traffic. Auth and the local production rehearsal do not constitute a public deployment or complete SaaS security assessment.

The one-character display-name allowance in the draft OpenAPI differs from the approved database's minimum of two; Phase 3 follows the database/UI minimum without editing either document. Phase 2's maximum-density text-fit follow-up remains recorded in its existing report.
