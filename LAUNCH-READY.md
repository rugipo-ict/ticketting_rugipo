# Launch-Readiness Audit — RUGIPO ICT Ticketing System

Full end-to-end review of the codebase before launch, as requested. Every change below was
verified by running the system, not by reading alone.

## What was checked (whole repo)

- `server/` — Express app (`server.js`), DB layer (`db.js`), auth (`auth.js`), uploads
  (`uploads.js`), email queue (`notify.js`), websockets (`ws.js`), realtime (`realtime.js`),
  desk routing (`desk.js`), seed (`seed.js`), and all three route modules
  (`routes/student.js` 688 lines, `routes/staff.js` 1302 lines, `routes/portalAuth.js`).
- `api/index.js` — Vercel serverless entry (imports the same app; websockets correctly
  skipped there, chat falls back to polling + Supabase broadcast).
- `client/` — full React SPA (public site, tracking, token-gated chat, staff portal,
  admin account/master-data management). Built cleanly with `npm run build`.
- Deployment configs — `vercel.json` (build + rewrites + caching headers), `railway.json`
  (healthcheck `/api/meta`, restart policy).
- Security posture — secrets are NOT in git (only `server/.env.example` is tracked; real
  `.env` is ignored), passwords bcrypt-hashed (cost 12), staff JWTs with role middleware,
  uploads validated by extension + MIME + size with random storage keys, SQL is fully
  parameterized (SQLite `?` → Postgres `$n` conversion is literal-safe), student free-text
  is sanitized (`cleanText`) and capped, JSON body capped at 64 KB, HTML/script stripped
  from every chat/message path.

## Issues found and fixed (this pass)

1. **Email delivery could collide with open database transactions** (`db.js`, `notify.js`).
   Confirmation emails are queued inside the ticket-creation and status-change
   transactions. Delivery inherited that transaction's bound connection, so the external
   Brevo HTTP call could stall the transaction — and with a 2-connection pool, stall other
   requests under load. Delivery is now always detached from any caller's transaction
   (`runOutsideStore`) and scheduled off the request path; a 60-second serverless timer
   also resumes any mail stranded by a frozen Vercel function.
2. **CORS allowed every origin** (`server.js`). The fallback returned `cb(null, true)` for
   unknown origins, so any website could fire a signed-in officer's session cross-origin.
   Now: no-Origin requests pass (curl/clients), the app's own origin and `CLIENT_ORIGIN`
   pass, **foreign origins get 403**.
3. **Rate-limit maps grew without bound** (`server.js`, `routes/student.js`,
   `routes/portalAuth.js`). A flood of junk IPs/emails (bot scan) would leak memory during
   a traffic spike. All limit buckets now self-clean on a timer; 429 responses carry
   `Retry-After`.
4. **No flood guards on public write endpoints** (`routes/student.js`). Students never log
   in, so one device could hammer ticket creation, contact messages, chat sends and
   recovery emails (each = DB write + queued email) into the free-tier database. Per-route
   ceilings added (e.g. 6 tickets / 10 min / device, 4 recovery emails / 15 min) —
   generous for real use, hard stop for scripts.
5. **Login timing side-channel** (`routes/portalAuth.js`). Unknown accounts skipped the
   bcrypt compare, letting an attacker probe which staff emails exist from response
   timing. Now every login runs the same bcrypt compare against a fixed dummy hash when
   the account doesn't exist. Lockout buckets also self-clean now.

## Verification (all green)

- `node --check` passes on all 13 server files.
- Read-only production DB verification (`server/scripts/verify-fixes.js`): all 5 checks
  pass against the live Aiven database (audit search, resolver attribution, dashboard,
  reports, workload credit).
- Client production build succeeds.
- Live boot smoke test against production DB: `/api/health` 200, `/api/meta` serves the
  full faculty/department catalogue, foreign-origin POST → 403, same-origin POST → 200,
  flood guard: requests 1–4 → 200, request 5 → 429 with `Retry-After`.

## One remaining action before launch (outside the code)

**Vercel production is serving an older build than `main`.** The live site currently loads
`assets/index-DBQSlzFK.js`; the current `main` builds `index-ByobwosT.js`. The three
recent fix commits are on GitHub but not deployed. Fix (repo owner, ~2 minutes):
Vercel Dashboard → ticketting-rugipo project → Settings → Git → set **Production Branch
= `main`**, then Deployments → latest `main` deployment → **Promote to Production**.
Or simply re-deploy from `main`. Verify afterwards: the served `index.html` references
`index-ByobwosT.js`.

## Stress-test plan (before public launch)

1. Deploy current `main` to production (action above).
2. Ask 5–10 staff/students to use it simultaneously for 15 minutes: submit tickets (with
   attachments), track, reply, chat live, escalate, resolve — while one officer keeps the
   dashboard open.
3. Watch the free-tier DB connection count in the Aiven console during that window (pool
   cap is 2 per instance on purpose; Vercel may run a few warm instances).
4. Send one wrong-password × 5 sequence on `/admin` to confirm lockout, and 5 rapid
   submissions from one device to confirm the 429 flood guard.
5. Confirm a test ticket's confirmation email arrives (Brevo quota + sender reputation).

## Moving the repo to a GitHub organization

The repo is still under the personal account `github.com/gaveus` (transfer not done —
`gaveus` belongs to no organizations yet). To let Heritage review with proper access:

1. Create the org (free "Free" plan is enough): GitHub → + → New organization → e.g.
   `rugipo-ict`, invite Heritage as a member.
2. Transfer the repo: `github.com/gaveus/ticketting_rugipo` → Settings → General →
   **Danger Zone → Transfer ownership** → enter the org name → confirm. GitHub
   automatically redirects the old URL, issues stay intact.
3. Reconnect Vercel: Dashboard → project → Settings → Git → reconnect the GitHub App for
   the org and re-select the repo (production URL does not change).
4. Heritage can then browse the code, file structure and history directly — or be given
   a Team with read access if you want tighter control.

Transfer must be done signed-in as `gaveus` (it needs the account owner); everything
else in this document is already complete.
