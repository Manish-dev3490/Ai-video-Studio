# Render free web/API deployment

This profile hosts the existing React build and Express API at one Render HTTPS
origin. Accounts, projects, conversations and storyboards persist in a dedicated
MongoDB Atlas database. It starts no laptop service or rendering worker. The
current worker is Windows-specific; the existing UI reports rendering offline
and refuses rendering without a healthy worker. Email delivery is disabled.
This is a portfolio web/API deployment, not a verified full cloud video service.

## Deployment configuration

The root `render.yaml` declares one **Free** Node web service. Render installs
the existing lockfile dependencies on its build machine and builds the frontend;
no new dependency is added. The existing engine lockfile is also installed
because the API imports its Ajv contract validator. This does not acquire the
Kokoro model or start rendering. Build and start commands are:

```text
npm ci --include=dev --ignore-scripts && npm ci --prefix packages/video-engine --omit=dev --ignore-scripts && npm run build
node scripts/start-render.mjs
```

Provision a dedicated Atlas Free cluster and a database such as
`ai_video_studio_render`. Create a least-privilege database user for this
database, and allow the selected Render service's documented outbound IP ranges
in Atlas. Do not copy the laptop's database, user accounts or local media paths.
The connection string must select this database and require TLS. Enter it as
`MONGODB_URI` in Render's private environment settings, never in source or chat.
Keep database passwords and provider keys out of logs and screenshots.

The Blueprint generates distinct JWT, CSRF and mail-encryption secrets. Supply
the existing Gemini credential as `GEMINI_API_KEY` through Render's environment
settings if AI planning is desired. Leave it empty to retain the application's
honest AI-unavailable state. Model availability and provider quota still apply.
No AI requests are made during startup or build.

The profile derives the public origin from Render's `RENDER_EXTERNAL_URL`, binds
the edge to `0.0.0.0:$PORT`, and keeps the unchanged API on
`127.0.0.1:4300`. The edge validates the fixed hostname, denies private source
paths, sanitizes forwarded headers and streams requests to the loopback API.
Normal signup/login is the only access step. `/api/v1/ready` reports real API and
transaction-capable database readiness, independently of worker availability.

Render must be given committed source from an authorized repository, or a
prebuilt registry image. This checkout initially has no commits. Creating these
deployment files does not publish them. Do not commit or push until the user
explicitly approves publishing the reviewed source.

The source must include the unchanged engine package and lockfile, along with
`review/phase-1-contracts/schemas/scene.schema.json`: the API reads the canonical
schema when loading its contract validator. Exclude all `.env` files, `var/`,
`artifacts/`, dependencies, cached models and generated exports from publication.

## Limits and acceptance checks

Free web services sleep after inactivity and have ephemeral filesystems. Do not
store exports in their local filesystem expecting persistence. A separate cloud
worker and persistent media storage are required before offering cloud video
rendering; this profile does not silently use the laptop as a worker.

After actual deployment, use a fresh browser to verify direct signup/login,
dashboard reload, project save/reload, protected API401, CSRF rejection, logout,
private-file404 and honest rendering/email availability. Check cloud logs for
startup/readiness failures without copying credentials. A provider call should
be a separate bounded test; it is not part of deployment smoke checks.

Official references: [Render web services](https://render.com/docs/web-services),
[Blueprint specification](https://render.com/docs/blueprint-spec),
[environment defaults](https://render.com/docs/environment-variables),
[free service limits](https://render.com/docs/free),
[Atlas free cluster setup](https://www.mongodb.com/docs/atlas/tutorial/deploy-free-tier-cluster/).
