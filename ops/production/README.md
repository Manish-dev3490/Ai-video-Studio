# Local production profile

This is a ₹0, loopback-only profile for the built React application, Express API,
private Windows renderer and a dedicated MongoDB replica set. It preserves the
development `.env`, development database and original engine. It does not publish
a site, install services, open firewall ports, register a certificate authority,
download dependencies or configure a paid hosting account.

## Prepare and run

Use the existing installed dependencies, Chrome, PowerShell 7, MongoDB and verified
offline Kokoro model. Build the frontend before startup:

```powershell
npm run build
node scripts/start-production.mjs --init
node scripts/production-check.mjs --native
node scripts/start-production.mjs
```

The init command creates **ignored `.env.production.local` once**, with three
independent random secrets and a private self-signed TLS certificate. Repeating it
preserves both the profile and existing certificate. It does not copy the
development Gemini/email credentials. Set provider credentials in this private
file when available; never put them in browser variables, chat or source control.

The defaults use:

| Component | Local address or private location |
| --- | --- |
| HTTPS gateway | `https://studio.localhost:8443` bound only to `127.0.0.1` |
| Express production build/API | `127.0.0.1:4200` |
| Dedicated MongoDB | `127.0.0.1:27019`, replica set `avsProductionLocal` |
| Application database | `ai_video_studio_production_local` |
| Media and render jobs | Separate `var/production/media` and `var/production/jobs` |
| Database files | `var/production/mongodb/data` |
| Certificate and private key | Ignored `var/production/tls` |

This isolated MongoDB instance is unauthenticated and loopback-only; it is for
this private local profile, never a public database. API and worker share one
private media disk. A hosted split between API and worker needs separately
reviewed authenticated storage and database access.

The certificate is self-signed and browsers can show a trust warning. This is a
local test certificate, not a publicly trusted certificate. No OS trust-store
change is made. Automated browser checks may explicitly trust this local test
endpoint; do not disable certificate validation in a public deployment.

Ctrl+C or the supervisor's inherited private IPC channel stops the HTTPS gateway,
then the worker, API and its owned MongoDB process. No HTTP shutdown route exists.
A hard supervisor/OS crash may leave the dedicated MongoDB process running;
startup refuses an occupied port rather than attaching to or killing an unknown
process. API/worker IPC and the native renderer parent-identity guard handle their
owned descendants. A persistent Windows service manager is not installed.

## Configuration and health

`production-check.mjs` defaults to configuration inspection only. It prints
non-sensitive issue codes and never sends email, installs software or writes to a
database. `--native` verifies local executable/model/build/certificate availability.
`--database` performs a bounded, read-only writable-replica-set probe. A running
local profile is required for the default database probe:

```powershell
node scripts/production-check.mjs --database
node scripts/production-check.mjs --public
```

`--public` intentionally fails: a localhost profile is not a public launch.
Native prerequisites checked by the CLI are availability/integrity checks, not a
claim that a fresh render or Caddy deployment was performed.

`GET /api/v1/health` is process liveness. `GET /api/v1/ready` returns only a minimal
ready/not-ready status and HTTP 200/503 for database transaction readiness.
Worker availability remains in the authenticated capabilities API, so a stopped
renderer does not block sign-in or saved-project access. Requests outside these
exact GET/HEAD probes require HTTPS. The API trusts only its loopback gateway;
the gateway replaces inbound forwarding headers instead of trusting browser
supplied proxy metadata. Production logs omit request bodies, queries, raw
resource paths, credentials and cookie values.

## Enable real email

The generated profile explicitly disables email locally until a provider and
sender are configured. This does not prove inbox delivery. For the existing
Resend adapter, set these fields in the ignored profile and restart it:

```dotenv
MAIL_TRANSPORT=resend
PRODUCTION_ALLOW_DISABLED_MAIL=false
MAIL_FROM=AI Video Studio <verified-sender@your-domain.example>
RESEND_API_KEY=YOUR_PRIVATE_PROVIDER_KEY
```

Use a provider-verified sender and an explicitly approved test inbox. Keep the
independent `MAIL_ENCRYPTION_SECRET` stable while encrypted messages are pending.
Provider acceptance, provider-reported delivery and a person confirming inbox
receipt are different verification levels. Use the separately provided email
delivery-check command and record which level actually passed. The local profile
does not change the existing development mail preview or send real email on init.

## Backups and recovery boundary

No backup schedule, production restore or off-machine backup has been performed.
`mongodump` and `mongorestore` are separate MongoDB Database Tools and must already
be installed before logical backup/restore commands are usable. They were not
installed by this phase. Protect their private `--config` YAML files with the
operator's OS permissions; put credentials there, not in process arguments or Git.

For a logical backup, quiesce application writes and stop rendering while keeping
the intended database available under controlled database-only operation. Snapshot
the corresponding private exports and database together. The all-in-one local
supervisor stops its MongoDB on clean shutdown, so it is not an unattended logical
backup service. A clean offline copy of the entire dedicated database directory
and private media is a separate cold-backup option after all owned processes stop.

For a full replica-set logical dump with point-in-time oplog replay, the private
source config must select the intended dedicated replica set without narrowing
the dump to one `--db`:

```powershell
mongodump --config var/production/backup-source.yml --archive=var/production/backups/snapshot.archive --gzip --oplog
# Restore ONLY into a separately started, empty, isolated restore-test instance:
mongorestore --config var/production/restore-test-target.yml --archive=var/production/backups/snapshot.archive --gzip --oplogReplay
```

Never run a restore against the development or source production instance. Verify
the resolved target connection before execution, check ownership/media integrity
after restore, and retain an encrypted, access-controlled off-machine copy before
claiming disaster recovery readiness. Application encryption secrets require a
separate protected recovery procedure; they must not be printed or stored in an
unencrypted database/media archive.

## Future public deployment

The Caddyfiles here are optional reviewed templates, not installed or validated
against a live Caddy binary. Local startup uses the built-in loopback TLS gateway.
The public template requires a real owned domain, DNS, publicly trusted HTTPS,
properly managed services, authenticated database access, backup/restore proof and
mail deliverability checks. Do not expose the local database, renderer or operator
review CLI to browsers. Multiple API processes also require shared rate limiting;
this profile deliberately starts one API process and one worker.

References: [Caddy TLS](https://caddyserver.com/docs/caddyfile/directives/tls),
[Caddy reverse proxy headers](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy),
[MongoDB backup and restore tools](https://www.mongodb.com/docs/manual/tutorial/backup-and-restore-tools/),
[mongodump](https://www.mongodb.com/docs/database-tools/mongodump/).
