# AI Video Studio
## Product Requirements Document (PRD) — Version 1.0

**Document status:** APPROVED product baseline for V1 implementation — 20 November 2026  
**Date:** 10 November 2026  
**Product:** AI Video Studio (working name)  
**Product type:** AI-assisted video creation SaaS, web-first  
**Primary audience:** General users, including educators, learners, creators and everyday users  
**Budget constraint:** ₹0 for initial development and proof-of-concept; no paid subscriptions or required paid API usage

> **Product promise:** Describe an idea, choose a duration, and receive a coherent 30-, 60-, or 90-second explainer video with synchronized narration, animated visuals, captions and an MP4 download. Optionally feature an uploaded character as a visual presenter.

---

## 1. Executive summary

AI Video Studio turns a user's natural-language idea into a finished, short-form narrated explainer video. After signing in, the user chats with an AI assistant, supplies a topic or concept, selects video settings, reviews the proposed narration and scene plan, and starts generation. The system assembles a script, storyboard, voiceover, programmable motion graphics and supporting visuals into a video. The user can preview the result, make limited edits, regenerate selected material and download an MP4.

The product supports two creation modes:

- **Faceless Explainer:** Narration accompanied by diagrams, animated typography, motion graphics, illustrations and optional permitted stock media.
- **Custom Character Explainer:** The same production workflow with an uploaded character/person/object included as a visual presenter. **MVP character animation is limited to basic image placement, pan/zoom, gestures or stylized 2D motion**; realistic lip-sync and voice cloning are **not** guaranteed or required in V1.

The first implementation must prioritize a reliable end-to-end experience and responsible use of free tiers and local resources. The PRD specifies *what* the product must do, not a final API provider, data model or system architecture.

## 2. Problem, opportunity and value proposition

### 2.1 User problem

Creating an explanatory video typically requires several skills and tools: researching or scripting an explanation, designing suitable visuals, recording narration, timing scenes, adding captions and exporting. A beginner may know exactly what they want to explain but lack editing, motion-design or voice-recording experience.

### 2.2 Target outcome

A user with no specialized video-production skill can produce a short, understandable narrated explainer from a single idea, while retaining enough control to correct the explanation and customize the result.

### 2.3 Differentiation hypothesis

The experience emphasizes **structured explanations with understandable visuals** and **conversational iteration**, rather than only generating unrelated cinematic clips. This is a hypothesis to validate, not a claim of uniqueness in the current market.

### 2.4 Jobs to be done

- When I need to explain a complex concept, I want AI to generate a short visual explanation so that viewers understand it quickly.
- When I have an idea but no editing skills, I want the product to handle scripting, narration and timing for me.
- When I want a fun or personalized explainer, I want to place an authorized character or image in the video without constructing the whole video manually.
- When the AI gets a concept wrong, I want to correct the script or one scene rather than repeat the entire creative process.

## 3. Product goals and non-goals

### 3.1 MVP goals

1. Deliver a complete prompt-to-MP4 workflow for 30-, 60-, and 90-second explainer videos.
2. Make video generation approachable through an interactive AI chat assistant.
3. Generate intelligible, relevant motion graphics and synced voiceover, not just a slideshow of arbitrary images.
4. Permit script/storyboard review before costly rendering and basic correction afterward.
5. Provide a limited custom-character presenter option using image uploads, with consent protections.
6. Persist projects and display clear generation status and failures.
7. Build and demo the initial workflow without mandatory paid APIs or subscriptions.

### 3.2 Explicit non-goals for V1

- Training a video foundation model from scratch.
- Generating unrestricted, photorealistic 90-second cinematic footage with a single free API call.
- Photorealistic face reenactment, authentic lip-sync or celebrity impersonation.
- Cloning a real person's voice.
- Building a full professional multi-track editor comparable to CapCut or Premiere Pro.
- Commercial-scale unlimited concurrent rendering on free infrastructure.
- A subscription billing/payment gateway, team workspaces or enterprise compliance certification.
- Guaranteed factual correctness of all AI explanations without user review.

## 4. Users and primary scenarios

| Persona | Need | Example prompt |
| --- | --- | --- |
| Student / learner | Understand a topic visually | “Explain the JavaScript Event Loop in 60 seconds.” |
| Teacher / educator | Create concise learning materials | “Explain photosynthesis for school students.” |
| Casual creator | Create shareable educational or fun clips | “Make a 30-second video on black holes.” |
| Everyday user | Use an image/character to tell a story | “Make this cartoon stone explain gravity.” |

**Audience policy:** The platform targets adults and general audiences; age-related account restrictions and jurisdictional compliance must be assessed before public launch, especially when uploading identifiable people.

## 5. Product experience and journeys

### 5.1 Primary flow — Faceless Explainer

1. Visitor opens website and signs up/signs in.
2. Authenticated user lands on a dashboard with recent projects and a conversational AI assistant.
3. Assistant asks: “What type of video would you like to create?”
4. User enters a topic. Assistant may ask only the missing essentials and suggests settings.
5. User confirms mode, duration **30/60/90 seconds**, narration language, visual style and aspect ratio.
6. AI produces a **draft script and storyboard**, including scene descriptions and approximate timing.
7. User previews/edits the script and approves generation.
8. System creates narration, scene visuals/animations, captions and assembled video; progress is shown.
9. User previews the playable result and can make bounded edits or request regeneration.
10. User downloads the finished MP4; project and status remain accessible from the dashboard.

### 5.2 Secondary flow — Custom Character Explainer

1. User selects **Custom Character** within the same creation journey.
2. User uploads a supported image of a fictional character, object, self, or person whose depiction they are authorized to use.
3. The app displays image requirements, explicit permission/consent attestation and disclosure information.
4. User supplies the topic and settings, and the AI proposes script/scene plan with the presenter included.
5. The rendering pipeline combines the character asset with scene graphics and synthetic narration.
6. User previews and exports an **AI-generated / AI-assisted** video.

**MVP fidelity constraint:** A character may be a stylized on-screen presenter with basic motion and narration; this must not be represented as accurate lip movement or as the uploaded person's real voice. If the photo/character workflow cannot run within the zero-cost constraint, it is marked **experimental / gated** while faceless mode remains the launch-critical path.

### 5.3 Example: “How ChatGPT works in 90 seconds”

The assistant proposes a coherent educational breakdown: introduction, tokens, simplified model processing, next-token prediction and response composition. The storyboard maps each narration segment to relevant motion graphics rather than random generic footage. The app should label simplifications where appropriate; it should not assert private implementation details as verified facts.

## 6. MVP feature requirements

**Priorities:** P0 = mandatory for core launch; P1 = expected MVP enhancement (can be gated if needed for feasibility); P2 = later release. **Requirement IDs** are stable references for design, tickets and tests.

### 6.1 Identity and project dashboard

| ID | Priority | Functional requirement | Acceptance criterion |
| --- | --- | --- | --- |
| FR-001 | P0 | Sign up, sign in and sign out. | New user can create an account, log in and log out; unauthenticated users cannot open protected projects. |
| FR-002 | P0 | Dashboard entry point with AI assistant and new-project action. | Authenticated user sees a creation CTA and a list of their own recent projects. |
| FR-003 | P0 | Create, view and delete own projects. | A project can be reopened across sessions; other users cannot access it. |
| FR-004 | P0 | Display generation history and status. | Project displays queued / processing / completed / failed with timestamps and actionable failure text. |

### 6.2 Conversational intake and settings

| ID | Priority | Functional requirement | Acceptance criterion |
| --- | --- | --- | --- |
| FR-005 | P0 | AI assistant accepts free-form descriptions. | User can enter “Explain the event loop”; assistant identifies topic and proposes an explainer workflow. |
| FR-006 | P0 | Assistant asks clarifying questions when required. | If essential information is missing, user can supply it without restarting; defaults are explicit. |
| FR-007 | P0 | Duration selector: 30, 60 or 90 seconds. | UI presents only supported presets; chosen target persists in project. |
| FR-008 | P0 | Narration language and format controls. | English supported at launch; Hindi targeted and requires speech-quality test; at least 16:9 and 9:16 if renderer tests pass. |
| FR-009 | P1 | Friendly / educational / playful tone and visual-style presets. | Selected tone/style alters generated script or scene plan in visible, testable ways. |
| FR-010 | P0 | Choose Faceless or Custom Character mode. | Mode is saved per project; experimental Custom Character may be explicitly flagged or gated. |

### 6.3 AI planning and user review

| ID | Priority | Functional requirement | Acceptance criterion |
| --- | --- | --- | --- |
| FR-011 | P0 | Generate a structured narration script and ordered storyboard. | Each scene has narration, visual intent and planned timing; scenes cover the requested topic. |
| FR-012 | P0 | Preview and edit narration before rendering. | User can change script text and regenerate plan prior to starting the render. |
| FR-013 | P0 | Bound generated script to target duration. | Estimated narration fits chosen duration; if TTS audio overflows, the app re-times, revises or asks for approval without silently cutting speech. |
| FR-014 | P0 | Validate planning output. | Missing scenes, invalid durations or malformed scene instructions produce controlled retries/errors, not a broken video. |

### 6.4 Video production, preview and export

| ID | Priority | Functional requirement | Acceptance criterion |
| --- | --- | --- | --- |
| FR-015 | P0 | Produce relevant motion graphics and supporting visuals. | At least one end-to-end sample has correct diagrams/animations tied to specific narrated concepts. |
| FR-016 | P0 | Generate synthetic narration. | Output has an understandable voiceover; narration language matches the selected tested option. |
| FR-017 | P0 | Synchronize narration, scene timing and captions. | Speech aligns with corresponding visual sequence; captions appear with appropriate content and timing. |
| FR-018 | P0 | Generate preview and MP4 export. | Completed project plays in supported browser and produces a downloadable, playable MP4 with audio. |
| FR-019 | P0 | Support 30/60/90-second output targets. | Automated acceptance checks validate all three presets within an agreed tolerance (proposed ±5 sec) with no clipped narration. |
| FR-020 | P0 | Expose asynchronous progress and failure states. | Slow jobs do not block the UI; errors are recoverable and do not produce a falsely successful project. |
| FR-021 | P1 | Limited edits and regeneration. | User can revise script, change narration/visual settings or regenerate selected scenes, subject to compute limits. |

### 6.5 Custom Character mode

| ID | Priority | Functional requirement | Acceptance criterion |
| --- | --- | --- | --- |
| FR-022 | P1 | Upload a supported image with basic validation. | Unsupported type, overly large file or invalid image receives a useful validation error. |
| FR-023 | P1 | Use uploaded image as on-screen presenter. | User can render a sample featuring the authorized character image with stylized movement and narration. |
| FR-024 | P0 if mode enabled | Obtain consent/rights confirmation for identifiable people. | Upload/generation cannot proceed without attestation; system provides reporting/deletion mechanism. |
| FR-025 | P0 if mode enabled | Clearly disclose synthesized speech and AI-generated presentation. | Product and video delivery UI identify the output as AI-generated and do not imply the person actually spoke. |

### 6.6 Limits, privacy and quality safeguards

| ID | Priority | Functional requirement | Acceptance criterion |
| --- | --- | --- | --- |
| FR-026 | P0 | Limit generation to available free compute/quota. | Per-user and system-wide caps prevent runaway jobs; clear message when limits are reached. |
| FR-027 | P0 | Prevent unauthorized access to user assets. | User can access only their own projects/files; private media links are protected or appropriately scoped. |
| FR-028 | P0 | Permit project and uploaded-media deletion. | Deletion removes access immediately and initiates applicable asset cleanup; retention behavior is explained. |
| FR-029 | P0 | Basic prompt/upload moderation and abuse handling. | Clearly prohibited or unsafe requests are blocked or escalated with understandable messaging. |
| FR-030 | P1 | Show generation provenance/disclosure. | Creation details or output labels identify AI-produced material; no claim of real-person endorsement. |

## 7. User stories and acceptance scenarios

**US-01 — Fast explainer creation**  
As a beginner, I want to describe a topic and select 60 seconds so I can receive a short explanation without editing experience.  
**Given** I am signed in, **when** I submit a safe topic, approve the script and generate, **then** a completed project eventually offers a playable preview and MP4 download or a clearly recoverable error.

**US-02 — Educational accuracy review**  
As a student, I want to inspect the narration and scene plan so I can correct misleading statements before video rendering.  
**Given** a draft script, **when** I edit narration and confirm, **then** the approved text drives downstream voiceover and captions.

**US-03 — Duration selection**  
As a user, I want to choose 30/60/90 seconds so I can fit a short-form format.  
**Given** a preset, **when** the renderer completes, **then** the file meets the selected target tolerance and does not cut off speech.

**US-04 — Custom character explanation**  
As a user with rights to an image, I want a character to appear as the presenter so the explainer feels personalized.  
**Given** a valid authorized image, **when** I generate in Character mode, **then** the resulting video shows that image as a stylized presenter with synthetic voiceover and AI disclosure.

**US-05 — Recover from failure**  
As a user, I want to see progress and clear errors so I understand what happened when generation fails.  
**Given** a failed render, **when** I revisit my project, **then** its failure state and retry instructions are visible and no finished download is falsely advertised.

## 8. User experience and screen inventory

| Screen | Key contents |
| --- | --- |
| Landing page | Product explanation, sample outputs, sign-in/sign-up CTAs, limitations and AI disclosure. |
| Authentication | Sign-up/sign-in, validation, recovery path subject to chosen identity provider. |
| Dashboard | AI assistant entry, create button, project cards, status and user quota. |
| Creation wizard/chat | Prompt, mode, duration, language, tone, aspect ratio, optional image upload. |
| Script/storyboard review | Editable narration, per-scene preview, duration estimate, approval button. |
| Generation progress | Queued/processing steps, safe status updates, failure/retry path. |
| Video preview | Playback, metadata, limited edit/regenerate controls, download. |
| Project library | History, open/delete actions, re-export if asset remains available. |
| Settings & safety | Account management, media deletion, consent information, generation limits. |

**UX principles:** Beginner-first; defaults over excessive questions; clear distinction between draft and completed video; transparent generation cost/limits; no fake “real-time” progress percentages; responsive on mobile even if rendering controls are desktop-first.

## 9. Non-functional requirements

| ID | Area | Requirement / launch validation |
| --- | --- | --- |
| NFR-001 | Security | Protect sessions, apply server-side authorization to every project/asset, validate uploads and secrets, and apply request-rate limits. |
| NFR-002 | Privacy | Collect minimum data; explain use of third-party AI processing and retention; provide deletion path; avoid transmitting private photos to providers without appropriate notice/consent. |
| NFR-003 | Reliability | Job state changes must be recoverable; retries must avoid duplicate user-visible outputs and runaway compute. |
| NFR-004 | Performance | Target responsive dashboard navigation on typical consumer hardware; measure time to first status and full rendering separately. Do not promise instant 90-second generation. |
| NFR-005 | Media integrity | Downloaded files must have correct audio/video tracks, usable codec/container, synchronized captions and no unintentionally truncated narration. |
| NFR-006 | Accessibility | Keyboard-operable primary actions, labeled fields, readable contrast, captions for playback and useful screen-reader status text. |
| NFR-007 | Browser support | Validate primary workflow on recent Chrome and Edge; test at least one mobile browser for viewing and playback. |
| NFR-008 | Observability | Capture generation ID, step/state, elapsed time, failures and resource use without logging raw sensitive prompts/photos by default. |
| NFR-009 | Budget guardrail | No required paid account or recurring subscription for development; generation disabled gracefully when free-tier quota/local worker unavailable. |
| NFR-010 | Legal and content | Use appropriately licensed visual/audio assets; require real-person permission, label synthetic content and support user complaints/reporting. |

**Performance SLOs are intentionally not fixed yet.** A benchmark on the 16 GB ASUS Zenbook (Intel Arc reported) and selected free providers will establish realistic job-time targets during a feasibility spike. The reported 8 GB GPU memory may be shared system memory rather than 8 GB dedicated VRAM.

## 10. Guardrails and failure/edge cases

- **Very broad prompt:** Assistant offers a concise scope suggestion rather than inventing a highly specific educational claim.
- **Unsafe or disallowed request:** Refuse the operation appropriately; do not render or charge quota.
- **Educational hallucination:** Warn about AI-generated information and enable script correction; do not assert factual verification that was not performed.
- **TTS output exceeds duration:** Replan or shorten the script with approval; never abruptly truncate narration.
- **Malformed scene plan:** Validate structured data, retry within a cap, then show actionable failure.
- **Generation API quota exhausted:** Queue is not allowed to grow indefinitely; tell user capacity is unavailable and preserve draft.
- **Browser refresh during a job:** Persist job state so user can return without starting over.
- **Uploaded image contains multiple people / ambiguous subject:** Ask user to provide a clear single-subject image or decline if safe processing is not possible.
- **Person lacks image rights or consent:** Do not support deceptive use; require explicit confirmation and clear removal/reporting routes.
- **Insufficient storage or failed export:** Mark failure; do not expose corrupted media as completed.
- **Offensive, defamatory or deceptive impersonation:** Apply policy enforcement and escalation/report paths before public launch.
- **Duplicate clicks:** Prevent accidental duplicate paid/computationally expensive generations.

## 11. Budget, technical feasibility and assumptions

### 11.1 Hard constraint: zero-money development

The application must be developable with local tools and free allowances. This **does not** imply that a public SaaS with unlimited users, cloud rendering and realistic character animation can operate at zero ongoing cost.

**Candidate components for architecture evaluation (not locked):** Gemini or another free-tier LLM for conversational planning and scripts; local/open-source TTS or eligible free-tier speech API; React/SVG/Motion Canvas or Remotion for programmable scenes; FFmpeg for rendering; a free-tier auth/database provider; limited storage. The final choice belongs in the System Design / API Evaluation phase, after current quotas, licenses, data policies and hardware compatibility are verified.

### 11.2 Rendering assumption

For the initial proof of concept, rendering may occur on a local development machine rather than a continuously available free cloud worker. The public demo may need concurrency limits, availability windows or an alternate browser-based export technique. Until load testing is complete, there is no claim of free production scalability.

### 11.3 Video-generation definition

In V1, “AI-generated video” means AI-authored script/storyboard plus assembled animated diagrams, motion graphics, permitted imagery and AI narration. It does **not** require a paid photorealistic text-to-video foundation model.

### 11.4 Language and quality assumption

English narration is launch-critical. Hindi narration is a desired MVP option subject to verified speech quality and font/caption synchronization. Hinglish, multi-speaker dialogue and dubbing are later enhancements.

## 12. Success metrics and launch gates

### 12.1 Product metrics (instrumentation required)

- **Completion rate:** Share of started generation requests that produce a valid downloadable MP4.
- **Time to first video:** Time from approved storyboard to playable output (report median and p95, by duration and hardware).
- **Script acceptance:** Share of AI script drafts accepted without major user edits.
- **Edit/retry frequency:** User actions per completed video; segment by failure and preference changes.
- **Video quality checks:** Audio present, duration within tolerance, captions present and key storyboard visuals rendered.
- **Cost per successful video:** API quota consumed, local rendering time, storage/transfers; ₹0 monetary spend target for development.

### 12.2 Minimum launch acceptance gate

1. A clean test account can sign up and create a project.
2. At least **three end-to-end test cases** (30s, 60s, 90s) export playable MP4s with narration and scene-appropriate animation.
3. A technically complex explainer (e.g. JavaScript Event Loop) demonstrates coherent diagrams rather than unrelated stock visuals.
4. Script review and correction flow is working.
5. Project isolation, error states, job retries and upload validation pass defined tests.
6. No paid service is required to complete the local proof of concept.
7. Character mode passes its own consent and output checks before it is exposed; otherwise it remains gated.
8. Privacy, attribution, AI disclosure and deletion controls are reviewed before public sharing.

**Illustrative quality threshold (to validate):** Three duration-specific sample outputs with no clipped speech and export/playback on target browsers. Broader success-rate and latency thresholds should be set only after measuring an initial test batch.

## 13. Delivery phases and dependencies

| Phase | Deliverable | Exit condition |
| --- | --- | --- |
| 1. Ideation | Vision, audience, core flows and MVP boundaries | Complete — documented here. |
| 2. PRD | This versioned requirements document | Product scope reviewed. |
| 3. Feasibility spike | One 30-second narrated diagram prototype using free tools | Proves voice + motion + export on actual laptop. |
| 4. System design | Architecture, job orchestration, technology decisions, security and deployment approach | Risks/limitations documented. |
| 5. DB and API design | Entities, job-state model, REST contracts and ownership rules | Reviewed against FR IDs. |
| 6. UI/UX design | User flows, wireframes, visual system and error states | Core flow navigable. |
| 7. Implementation | Authentication, generation orchestration, renderer, project library | End-to-end P0 functionality passes. |
| 8. QA and hardening | Functional, security, media quality and failure tests | Launch gates satisfied. |
| 9. Deployment | Limited free-tier demo / documented local renderer | Accurate capacity limits and operating instructions. |

**Recommended build order:** (A) single hard-coded demo video with voice and motion graphics → (B) LLM script/storyboard → (C) parameterized render → (D) web UI/auth/project state → (E) export, errors and persistence → (F) character mode experiment. This ordering reduces the risk of building an elaborate frontend before proving video rendering.

## 14. Risks, mitigations and dependencies

| Risk | Impact | Proposed mitigation |
| --- | --- | --- |
| Free speech/LLM API limits change | Generation unavailable | Abstract provider integration; retain local fallback where feasible; enforce quotas. |
| Render time too high on laptop | Poor user experience | Benchmark 30s first; optimize scene templates and resolution; queue work. |
| AI visual plan is semantically wrong | Misleading video | Structured scene library, validation, user script review, quality test cases. |
| Asset licensing or privacy conflicts | Legal/trust risk | Licensed assets only; clear upload consent, deletion and AI disclosure. |
| Character animation fails on Intel Arc | Missing feature | Ship image-based 2D presenter instead; keep realistic face animation deferred. |
| Free hosting cannot run rendering jobs | Demo inaccessible | Local worker during proof of concept; limited hosted frontend/API; investigate browser export. |
| Product scope grows uncontrollably | Missed milestones | Protect P0 acceptance tests; place cinematic, advanced editing and lifelike avatar in V2. |

## 15. Decisions finalized vs. open decisions

### 15.1 Finalized product decisions

- General-user web SaaS; beginner-friendly, idea-first conversational workflow.
- 30 / 60 / 90 second videos, 90 seconds maximum target for MVP.
- Faceless animated explainers as the required launch path.
- AI-written narration, planned scenes, motion graphics, synthetic voiceover, captions, preview and MP4 export.
- Script review before rendering; limited editing rather than pro timeline editor.
- Custom image/character presenter mode in scope as **P1, gated** until tested; photorealistic talking avatar not a V1 requirement.
- ₹0 development budget; no mandatory paid API or subscription.

### 15.2 Decisions to resolve in later phases

- Which LLM and TTS offerings are actually sustainable at current free quotas and terms?
- Browser-side versus local/server worker rendering, including export time on real hardware.
- Preview/export resolution, codecs and final file-size ceiling.
- Whether English + Hindi can both pass a speech and subtitle quality bar in V1.
- Initial limits per account, job concurrency and project/media retention duration.
- Whether custom-character mode uses 2D puppet/portrait animation or only camera/transform motion in V1.
- Initial public launch policy, moderation/reporting process and data-processing disclosures.
- Pricing/payment design after product validation (out of MVP).

## 16. Definition of done and sign-off

The MVP is **functionally done** when the required P0 user journey passes end to end and acceptance tests demonstrate valid narrated videos across all three supported durations; authentication, project isolation, failure handling and safety protections are in place; and deployment documentation accurately describes free-tier and local-worker constraints.

**PRD status:** APPROVED by product owner as V1 requirements baseline (20 November 2026). This is approval of scope, not a claim that every provider is selected, all features implemented or public infrastructure validated.

**Next artifact:** Feasibility spike plan followed by the System Design Document (SDD), database design, API contracts and UI/UX specification.
