# Temporary laptop-hosted demo

This password-protected HTTPS preview uses Cloudflare Quick Tunnels and the
existing Windows renderer. It is a temporary demo, not a permanent production
deployment. Keep the laptop awake, connected and the demo process running. The
URL changes after restart; Quick Tunnels have no uptime guarantee.

```powershell
npm run demo:start
npm run demo:stop
```

For a public portfolio demo with normal app signup/login and no separate demo
access prompt, start it explicitly with:

```powershell
npm run demo:start -- --public
```

This mode keeps application authentication, private-file denial and CSRF checks.
The URL still changes on restart and requires the laptop to remain running; it
is unsuitable as a permanent resume link. `var/demo/access.txt` contains the URL
and normal signup/login instructions without demo credentials in this mode.

Startup creates `var/demo/profile.env` once, with independent app secrets and a
separate demo password. It reuses the configured server-side Gemini credential,
if available; no provider call occurs on startup. Do not share the profile.
In the default private mode, the current URL, demo username and demo password are in ignored
`var/demo/access.txt`. Give these only to intended reviewers. Enter them on the
Demo access page, then sign up or log in inside the app. No native browser
password popup is used. App email verification, email
changes and password recovery are unavailable. Gemini calls require provider
quota and remain subject to that provider's billing/configuration.

The UI/API use port4300; the password gateway uses port4301. Both bind only to
127.0.0.1. The private MongoDB replica set uses port27020, database
`ai_video_studio_demo`, and ignored `var/demo/mongodb`. Exports/jobs use separate
`var/demo/media` and `var/demo/jobs` roots. Existing dev/local-production data,
approved docs, prototype and engine are untouched. No database or worker port is
tunneled. In the default private mode, app pages, API, assets and health checks require a separate demo
session. Only the access form is public. Its session is a signed, expiring,
Secure/HttpOnly/SameSite cookie, separate from app sign-in. The gateway removes
the demo cookie and Authorization headers before forwarding to the API. Native
HTTP authentication challenges are not used, so unsigned-in app401 responses
cannot reopen the browser's access-password popup.

Cloudflare can replace origin 502/504 responses with its own error page. For
this temporary gateway only, JSON API responses with those statuses are relayed
as HTTP 503 with `X-AVS-Origin-Status` retaining the original status. The exact
structured API error body is preserved. The backend's documented HTTP contract
and all successful responses remain unchanged. This is not a success fallback.

The verified official portable executable lives in
`var/tools/cloudflared/2026.11.1/cloudflared.exe` (SHA256
`341deda3db5ec498a0482254d6c38c0b7cf01a30c37bb5dd95d2216d08955e35`).
No npm dependencies, OS service, certificate authority or firewall rule is
installed. Startup refuses missing/modified executables and occupied demo ports.
Cloudflared gets no application secrets. The worker gets no Gemini or Resend
credentials. Public TLS is verified normally; no certificate bypass is used.

Stopping the supervisor shuts down the tunnel first, then its own worker/API
and dedicated database. `demo:stop` uses an ignored local stop request tied to
the current run; no HTTP shutdown route exists. Data persists across restarts.
A hard OS crash can leave the dedicated database running; startup refuses an
occupied port rather than attaching to or killing another process.

To validate a running link without sending emails, AI requests or rendering:

```powershell
npm run demo:check
```

The smoke check uses a fresh browser with no automatic HTTP credentials, enters
the demo access form in private mode or opens signup directly in public mode,
and checks that zero native authentication challenges
occur through entry, reload, signup and login. It uses an isolated test account
and saves a project through the real public HTTPS link. It also checks secure
cookies, CSRF, private-path denial, worker availability and disabled email.
Existing 30/60/90-second render evidence remains in `artifacts/phase8`; the public
smoke check does not claim a fresh end-to-end Gemini/render run.

References: [Quick Tunnels](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/),
[official binary release](https://github.com/cloudflare/cloudflared/releases/tag/2026.11.1).
