/**
 * RUGIPO ICT Support Ticketing System — API server.
 * Serves the REST API and (in production) the built frontend.
 */
require('dotenv').config();
const express = require('express');
const path = require('path');
const { readyPromise } = require('./db');
const studentRoutes = require('./routes/student');
const staffRoutes = require('./routes/staff');
const authRoutes = require('./routes/portalAuth');

const { setupChatWebsockets } = require('./ws');
const { startEmailSweeper } = require('./notify');

const app = express();
app.set('trust proxy', 1);

const allowed = (process.env.CLIENT_ORIGIN || 'http://localhost:5173').split(',').map(s => s.trim());
const selfHost = process.env.SELF_HOST || `localhost:${process.env.PORT || 4010}`;
// CORS: same-origin is always allowed (Origin host must match the request's
// own Host — that is how the served frontend talks to the API on any domain);
// dev server / other allowed origins come from CLIENT_ORIGIN (comma-separated).
// Requests with no Origin header (curl, mobile apps) are not CORS at all and
// pass through. FOREIGN origins are refused: a phishing site must never be
// able to fire a signed-in officer's session from another domain.
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (!origin) return next();
  let ok = allowed.includes(origin);
  if (!ok) {
    try {
      const host = new URL(origin).host;
      ok = host === selfHost || host === req.headers.host;
    } catch { ok = false; }
  }
  if (!ok) return res.status(403).json({ error: 'Not allowed by CORS' });
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Sec-WebSocket-Protocol');
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
});

app.use(express.json({ limit: '64kb' }));

// Production security headers (§26). Students' browsers get the guarantees;
// nothing here leaks server internals.
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  // HSTS only means something over HTTPS; harmless locally, vital in production.
  if (process.env.PUBLIC_BASE_URL || process.env.VERCEL) {
    res.setHeader('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
  }
  next();
});

// Lightweight per-IP rate limit for auth-sensitive endpoints. Buckets
// self-clean on a timer so a flood of junk IPs (bot traffic, a port scan)
// cannot grow the Map without bound and leak memory during a traffic spike.
const hits = new Map();
function rateLimit(max, windowMs) {
  const hitsTimer = setInterval(() => {
    const now = Date.now();
    for (const [k, e] of hits) if (e.resetAt <= now) hits.delete(k);
  }, Math.min(windowMs, 60_000));
  if (hitsTimer.unref) hitsTimer.unref(); // never keep the process alive for this
  return (req, res, next) => {
    const key = `${req.ip}:${req.path}`;
    const now = Date.now();
    let e = hits.get(key);
    if (!e || e.resetAt <= now) { e = { count: 0, resetAt: now + windowMs }; hits.set(key, e); }
    e.count += 1;
    if (e.count > max) {
      res.setHeader('Retry-After', String(Math.max(1, Math.ceil((e.resetAt - now) / 1000))));
      return res.status(429).json({ error: 'Too many requests. Please slow down.' });
    }
    next();
  };
}

app.get('/api/health', (_req, res) => res.json({ ok: true, service: 'RUGIPO ICT Ticketing API' }));
app.use('/api', rateLimit(300, 60_000));
app.use('/api/auth', rateLimit(20, 15 * 60_000));
app.use('/api/auth', authRoutes);
// Back-compat for older clients hitting /api/staff/login.
app.post('/api/staff/login', (req, res) => res.redirect(308, '/api/auth/login'));
app.use('/api', studentRoutes);
app.use('/api/staff', staffRoutes);

// Serve the built frontend when it exists (production).
const dist = path.join(__dirname, '..', 'client', 'dist');
// Static assets answer CORS too: embedded webviews / previews load the SPA
// module script cross-origin, and module scripts require CORS approval.
app.use(express.static(dist, {
  setHeaders(res) { res.setHeader('Access-Control-Allow-Origin', '*'); },
}));
// The staff portal stays unlisted: no sitemap entry, and /admin is excluded
// from indexing in the SPA's index.html. index.html is never cached — a phone
// must always get the newest build instead of an old page asking for deleted
// JS files (that is what blank-broke the whole site on one phone).
app.get(/^\/(?!api\/|assets\/).*/, (_req, res) => {
  res.setHeader('Cache-Control', 'no-store, must-revalidate');
  res.sendFile(path.join(dist, 'index.html'));
});

// Central error handler — no internals leak to clients.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err && /not allowed/i.test(err.message)) {
    return res.status(400).json({ error: err.message });
  }
  if (err && err.code === 'LIMIT_FILE_SIZE') {
    return res.status(400).json({ error: 'File too large (max 5 MB)' });
  }
  if (err && err.code === 'LIMIT_FILE_COUNT') {
    return res.status(400).json({ error: 'Too many files — attach up to 5 at a time.' });
  }
  if (err && err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'The request could not be read. Please try again.' });
  }
  // Structured server-side log (§23): full detail for developers here — and
  // NEVER any of it in the response body a student sees.
  console.error(JSON.stringify({
    at: new Date().toISOString(), kind: 'api_error',
    method: req.method, path: (req.originalUrl || '').slice(0, 120),
    message: String(err?.message || err).slice(0, 300),
    stack: err?.stack ? String(err.stack).split('\n').slice(0, 4).join(' | ') : undefined,
  }));
  res.status(500).json({ error: 'Something went wrong while processing your request. Please try again. If the problem continues, contact ICT Support.' });
});

const _envPort = parseInt(process.env.PORT, 10);
const PORT = Number.isFinite(_envPort) && _envPort > 0 ? _envPort : 4010; // a junk PORT must never bind port 0

// Vercel's serverless runtime imports the app and listens itself — starting a
// server there would crash. Local/node hosting (npm run dev, Railway, Render)
// takes the normal listen path.
if (!process.env.VERCEL) {
// Make sure schema + master data exist before serving traffic.
readyPromise()
  .then(() => {
    const srv = app.listen(PORT, () => console.log(`RUGIPO ICT Ticketing API on http://localhost:${PORT}`));
    // Email sweeper — retries queued/stranded mail every minute so nothing
    // sent through the queue can be silently lost.
    startEmailSweeper();
    // Real-time chat: attaches to the same HTTP server (same port, no extra config).
    const wsApi = setupChatWebsockets(srv);
    // REST chat endpoints push through the same hub so both sides update
    // instantly no matter which path (socket or HTTP) carried the message.
    studentRoutes.setChatPush(wsApi);
    staffRoutes.setChatPush(wsApi);
    srv.on('error', (e) => {
      if (e.code === 'EADDRINUSE') {
        console.error(`\nPort ${PORT} is already in use — another copy of this server is running.`);
        console.error(`Stop it first (or it may be an old window): close it, then run npm run dev again.`);
      } else {
        console.error('[server] listen failed:', e.message);
      }
      process.exit(1);
    });
  })
  .catch((e) => {
    console.error('[db] startup failed:', e.message);
    process.exit(1);
  });
}

// Hosting platforms import the app and run it themselves.
module.exports = app;

// Never die silently: log unexpected errors but keep serving students.
process.on('unhandledRejection', (e) => console.error('[warn] background error (server stays up):', e?.message || e));
process.on('uncaughtException', (e) => console.error('[warn] error (server stays up):', e?.message || e));
