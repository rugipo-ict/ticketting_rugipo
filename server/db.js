/**
 * PostgreSQL database layer (Aiven / any Postgres).
 * Same call shape the app already uses, now async:
 *   await db.get(sql, ...params)      → first row | undefined
 *   await db.all(sql, ...params)      → rows array
 *   await db.run(sql, ...params)      → { changes, lastInsertRowid }
 *   await db.exec(sql)                → raw multi-statement (no params)
 *   await db.transaction(fn)          → BEGIN/COMMIT/ROLLBACK bound to the async context,
 *                                       nested calls join the outer transaction.
 *
 * Concurrency: ticket numbers come from ticket_number_seq; issue types carry a
 * UNIQUE (category_id, lower(name)) index so seeds can never duplicate rows.
 */
const { Pool } = require('pg');
const { AsyncLocalStorage } = require('async_hooks');
const path = require('path');

// Always load THIS folder's .env regardless of where the process was started
// (root, server/, VS Code, task scheduler…). Kills a whole class of failures.
require('dotenv').config({ path: path.join(__dirname, '.env') });

const DATABASE_URL = process.env.DATABASE_URL || '';
if (!DATABASE_URL) {
  console.error('[db] FATAL: DATABASE_URL is not set (server/.env)');
  process.exit(1);
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  // Aiven free tier allows ~20-25 connections TOTAL per service. Keep each
  // instance small so a dev copy + production copy can coexist. Serverless
  // hosts (Vercel) spawn many short-lived instances — keep the per-instance
  // cap tight so they never collectively exhaust the database.
  max: Number(process.env.PG_POOL_MAX) || 2,
  idleTimeoutMillis: 15_000,          // close dead sockets before reuse
  connectionTimeoutMillis: 10_000,    // fail fast into the 503 retry path
  keepAlive: true,
});

const als = new AsyncLocalStorage();

/**
 * Convert SQLite-style `?` placeholders to Postgres `$1…$n`.
 * Skips question marks inside single-quoted SQL literals.
 */
function toPgSql(sql) {
  let out = '';
  let n = 0;
  let i = 0;
  while (i < sql.length) {
    const c = sql[i];
    if (c === "'") {
      // copy the literal verbatim (handles '' escapes)
      out += c; i++;
      while (i < sql.length) {
        if (sql[i] === "'" && sql[i + 1] === "'") { out += "''"; i += 2; continue; }
        out += sql[i];
        if (sql[i] === "'") { i++; break; }
        i++;
      }
      continue;
    }
    if (c === '?') { n += 1; out += `$${n}`; i++; continue; }
    out += c; i++;
  }
  return out;
}

function withClient(fn) {
  return pool.connect().then(async (client) => {
    try {
      return await fn(client);
    } finally {
      client.release();
    }
  });
}

function hasReturning(sql) {
  return /\bRETURNING\b/i.test(sql);
}

/* ------------------------- transient-failure retry ------------------------
 * Serverless + managed Postgres (Vercel ↔ Aiven) produces short blips: a cold
 * connection, a dropped socket, or the provider's connection limit flashing
 * "too many clients". One failure must not become a user-visible error —
 * every query silently retries a couple of times with a tiny backoff before
 * giving up. Transactions are retried only as a whole (rollback first), and
 * queries already inside a transaction are never retried here (their client
 * is bound and possibly broken — the tx wrapper handles its own fate).
 */
const TRANSIENT_CODES = new Set(['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EPIPE', '57P01', '53300']);
function isTransient(e) {
  if (!e) return false;
  if (TRANSIENT_CODES.has(e.code)) return true;
  return /too many clients|connection terminated|timeout expired|terminating connection|connection ended/i.test(e.message || '');
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function withRetry(fn) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (attempt >= 3 || als.getStore() || !isTransient(e)) throw e;
      await sleep(150 * attempt * attempt); // 150ms, 600ms
    }
  }
}

async function run(sql, ...params) {
  sql = toPgSql(sql);
  if (/^\s*INSERT\b/i.test(sql) && !hasReturning(sql) && !/\bON CONFLICT\b/i.test(sql)) {
    sql += ' RETURNING id';
  }
  const store = als.getStore();
  const r = await withRetry(() => (store
    ? store.client.query(sql, params)
    : withClient((c) => c.query(sql, params))));
  if (r.command === 'INSERT' && r.rows[0] && r.rows[0].id != null) {
    return { changes: r.rowCount, lastInsertRowid: r.rows[0].id };
  }
  return { changes: r.rowCount, lastInsertRowid: null };
}

async function runInTx(fn) {
  return withClient(async (client) => {
    await client.query('BEGIN');
    try {
      const result = await als.run({ client }, fn);
      await client.query('COMMIT');
      return result;
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch { /* connection gone */ }
      throw e;
    }
  });
}

/**
 * Run a function OUTSIDE any active transaction context. Background work
 * (email delivery, sweeps) scheduled from inside a request transaction must
 * never inherit that transaction's bound client — otherwise its queries join
 * an uncommitted transaction (and stall other requests waiting on the same
 * connection). AsyncLocalStorage propagates through timers/microtasks, so
 * callers use this to cut the link deliberately.
 */
function runOutsideStore(fn) {
  return als.exit(fn);
}

const db = {
  inTx() { return !!als.getStore(); },

  get(sql, ...params) {
    sql = toPgSql(sql);
    const store = als.getStore();
    const q = withRetry(() => (store
      ? store.client.query(sql, params)
      : withClient((c) => c.query(sql, params))));
    return Promise.resolve(q).then((r) => r.rows[0]);
  },

  all(sql, ...params) {
    sql = toPgSql(sql);
    const store = als.getStore();
    const q = withRetry(() => (store
      ? store.client.query(sql, params)
      : withClient((c) => c.query(sql, params))));
    return Promise.resolve(q).then((r) => r.rows);
  },

  async run(sql, ...params) {
    return run(sql, ...params);
  },

  exec(sql) {
    const store = als.getStore();
    const q = withRetry(() => (store
      ? store.client.query(sql)
      : withClient((c) => c.query(sql))));
    return Promise.resolve(q).then(() => {});
  },

  transaction(fn) {
    return (...args) => {
      if (als.getStore()) return fn(...args); // join the running transaction
      return runInTx(() => fn(...args));
    };
  },

  pool,
};

/* ----------------------------- schema bootstrap ---------------------------- */

async function ensureSchema() {
  await db.exec(`
CREATE TABLE IF NOT EXISTS faculties (
  id SERIAL PRIMARY KEY,
  name TEXT UNIQUE NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS departments (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  faculty_id INTEGER REFERENCES faculties(id),
  kind TEXT NOT NULL DEFAULT 'academic' CHECK (kind IN ('academic','unit','center')),
  active INTEGER NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_dept_fac_name ON departments(name, faculty_id);
CREATE TABLE IF NOT EXISTS students (
  id SERIAL PRIMARY KEY,
  matric_no TEXT UNIQUE NOT NULL,
  reg_no TEXT,
  full_name TEXT NOT NULL,
  email TEXT NOT NULL,
  phone TEXT,
  faculty_id INTEGER REFERENCES faculties(id),
  department_id INTEGER REFERENCES departments(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_students_reg_no ON students(reg_no) WHERE reg_no IS NOT NULL;
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  role TEXT NOT NULL CHECK (role IN ('staff','senior','admin')),
  full_name TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  staff_no TEXT,
  phone TEXT,
  gender TEXT CHECK (gender IS NULL OR gender IN ('male','female')),
  profile_image TEXT,
  must_change_password INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS ticket_categories (
  id SERIAL PRIMARY KEY,
  name TEXT UNIQUE NOT NULL,
  description TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  guided_fields TEXT
);
CREATE TABLE IF NOT EXISTS ticket_issue_types (
  id SERIAL PRIMARY KEY,
  category_id INTEGER NOT NULL REFERENCES ticket_categories(id),
  name TEXT NOT NULL,
  requires_payment_details INTEGER NOT NULL DEFAULT 0,
  requires_attachment INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_issue_cat_name ON ticket_issue_types(category_id, LOWER(name));
CREATE TABLE IF NOT EXISTS tickets (
  id SERIAL PRIMARY KEY,
  ticket_number TEXT UNIQUE NOT NULL,
  student_name TEXT NOT NULL,
  matric_no TEXT NOT NULL,
  reg_no TEXT,
  phone TEXT NOT NULL,
  email TEXT NOT NULL,
  department TEXT NOT NULL,
  level TEXT NOT NULL,
  programme TEXT NOT NULL,
  category_id INTEGER NOT NULL REFERENCES ticket_categories(id),
  issue_type_id INTEGER NOT NULL REFERENCES ticket_issue_types(id),
  description TEXT NOT NULL,
  details TEXT,
  priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('low','normal','high','urgent')),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','assigned','in_progress','waiting_student','escalated','resolved','closed','rejected')),
  assigned_staff_id INTEGER REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ,
  student_id INTEGER REFERENCES students(id),
  faculty_id INTEGER REFERENCES faculties(id),
  department_id INTEGER REFERENCES departments(id),
  academic_level TEXT CHECK (academic_level IS NULL OR academic_level IN ('ND1','ND2','HND1','HND2')),
  study_mode TEXT CHECK (study_mode IS NULL OR study_mode IN ('FULL_TIME','PART_TIME'))
);
CREATE INDEX IF NOT EXISTS idx_tickets_student ON tickets(student_id);
CREATE TABLE IF NOT EXISTS ticket_status_history (
  id SERIAL PRIMARY KEY,
  ticket_id INTEGER NOT NULL REFERENCES tickets(id),
  old_status TEXT,
  new_status TEXT NOT NULL,
  changed_by TEXT,
  note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_history_ticket ON ticket_status_history(ticket_id);
CREATE TABLE IF NOT EXISTS ticket_messages (
  id SERIAL PRIMARY KEY,
  ticket_id INTEGER NOT NULL REFERENCES tickets(id),
  sender_name TEXT NOT NULL,
  sender_role TEXT NOT NULL,
  message TEXT NOT NULL,
  visibility TEXT NOT NULL DEFAULT 'student' CHECK (visibility IN ('student','internal')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_messages_ticket ON ticket_messages(ticket_id);
CREATE TABLE IF NOT EXISTS ticket_assignments (
  id SERIAL PRIMARY KEY,
  ticket_id INTEGER NOT NULL REFERENCES tickets(id),
  staff_id INTEGER NOT NULL REFERENCES users(id),
  assigned_by INTEGER REFERENCES users(id),
  assigned_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  unassigned_at TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS ticket_payment_details (
  id SERIAL PRIMARY KEY,
  ticket_id INTEGER UNIQUE NOT NULL REFERENCES tickets(id),
  amount TEXT,
  payment_method TEXT,
  payment_date TEXT,
  payment_reference TEXT,
  portal_status TEXT,
  what_happened TEXT,
  verification_status TEXT NOT NULL DEFAULT 'unverified',
  verified_by INTEGER REFERENCES users(id),
  verified_at TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS ticket_attachments (
  id SERIAL PRIMARY KEY,
  ticket_id INTEGER NOT NULL REFERENCES tickets(id),
  uploaded_by TEXT NOT NULL,
  storage_key TEXT NOT NULL,
  original_filename TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS escalations (
  id SERIAL PRIMARY KEY,
  ticket_id INTEGER NOT NULL REFERENCES tickets(id),
  escalated_by INTEGER REFERENCES users(id),
  escalated_by_name TEXT,
  escalated_by_staff_no TEXT,
  reason TEXT NOT NULL,
  from_status TEXT,
  specialty TEXT NOT NULL DEFAULT 'portal',
  resolved_by INTEGER REFERENCES users(id),
  resolved_by_name TEXT,
  resolved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_escalations_ticket ON escalations(ticket_id);
CREATE TABLE IF NOT EXISTS outbound_emails (
  id SERIAL PRIMARY KEY,
  ticket_id INTEGER REFERENCES tickets(id),
  to_email TEXT NOT NULL,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'notification',
  status TEXT NOT NULL DEFAULT 'queued',
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS subscribers (
  id SERIAL PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  name TEXT,
  matric_no TEXT,
  source TEXT NOT NULL DEFAULT 'signup',
  unsubscribed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS contact_messages (
  id SERIAL PRIMARY KEY,
  sender_name TEXT NOT NULL,
  email TEXT NOT NULL,
  phone TEXT,
  matric_no TEXT,
  subject TEXT NOT NULL,
  message TEXT NOT NULL,
  staff_reply TEXT,
  replied_by INTEGER REFERENCES users(id),
  replied_by_name TEXT,
  replied_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new','answered')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_contact_status ON contact_messages(status, created_at DESC);
CREATE TABLE IF NOT EXISTS audit_logs (
  id SERIAL PRIMARY KEY,
  actor_id INTEGER REFERENCES users(id),
  actor_name TEXT,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id INTEGER,
  metadata TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS announcements (
  id SERIAL PRIMARY KEY,
  kind TEXT NOT NULL DEFAULT 'announcement' CHECK (kind IN ('announcement','update','maintenance')),
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  created_by INTEGER REFERENCES users(id),
  created_by_name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_announcements_recent ON announcements(created_at DESC);
`);

  // Ticket numbers come from a sequence so parallel submissions can't collide.
  await db.exec(`CREATE SEQUENCE IF NOT EXISTS ticket_number_seq START 1;`);

  // Migration: payment verification column (added for the Postgres port).
  await db.exec(`ALTER TABLE ticket_payment_details ADD COLUMN IF NOT EXISTS verification_status TEXT NOT NULL DEFAULT 'unverified';`);
  // Migration: allow the 'sending' delivery state (Brevo HTTP integration).
  await db.exec(`ALTER TABLE outbound_emails DROP CONSTRAINT IF EXISTS outbound_emails_status_check;`);
  await db.exec(`ALTER TABLE outbound_emails ADD CONSTRAINT outbound_emails_status_check
     CHECK (status IN ('queued','sending','pending_credentials','sent','failed'));`);
  // Branded HTML body column (email design system).
  await db.exec(`ALTER TABLE outbound_emails ADD COLUMN IF NOT EXISTS html TEXT;`);
  await db.exec(`ALTER TABLE outbound_emails ADD COLUMN IF NOT EXISTS attempts INTEGER NOT NULL DEFAULT 0;`);
  // Staff profile columns (gender, photo, forced password change).
  await db.exec(`ALTER TABLE users ADD COLUMN IF NOT EXISTS gender TEXT;`);
  await db.exec(`ALTER TABLE users ADD COLUMN IF NOT EXISTS profile_image TEXT;`);
  await db.exec(`ALTER TABLE users ADD COLUMN IF NOT EXISTS must_change_password INTEGER NOT NULL DEFAULT 0;`);
  await db.exec(`ALTER TABLE users DROP COLUMN IF EXISTS unit;`);
  // Senior Engineer speciality: which kind of complaints they handle.
  await db.exec(`ALTER TABLE users ADD COLUMN IF NOT EXISTS specialty TEXT;`);
  await db.exec(`ALTER TABLE escalations ADD COLUMN IF NOT EXISTS specialty TEXT NOT NULL DEFAULT 'portal';`);
  // Live chat on student questions: secret link token + conversation close.
  await db.exec(`ALTER TABLE contact_messages ADD COLUMN IF NOT EXISTS chat_token TEXT UNIQUE;`);
  // Which desk owns the complaint ('payment' | 'portal') — drives senior scoping.
  await db.exec(`ALTER TABLE tickets ADD COLUMN IF NOT EXISTS desk TEXT;`);
  // What the payment was meant for (students must state this on payment complaints).
  await db.exec(`ALTER TABLE ticket_payment_details ADD COLUMN IF NOT EXISTS payment_for TEXT;`);
  // Backfill the desk for tickets created before this column existed.
  await db.exec(`UPDATE tickets t SET desk = CASE
      WHEN i.requires_payment_details = 1 THEN 'payment'
      WHEN c.name = 'Receipt' AND EXISTS (
        SELECT 1 FROM ticket_attachments a WHERE a.ticket_id = t.id AND a.uploaded_by = 'student') THEN 'payment'
      ELSE 'portal' END
    FROM ticket_issue_types i, ticket_categories c
    WHERE t.issue_type_id = i.id AND t.category_id = c.id AND t.desk IS NULL;`);
  // Conversations can be 'closed' (history deleted) as well as new/answered.
  await db.exec(`ALTER TABLE contact_messages DROP CONSTRAINT IF EXISTS contact_messages_status_check;`);
  await db.exec(`ALTER TABLE contact_messages ADD CONSTRAINT contact_messages_status_check
     CHECK (status IN ('new','answered','closed'));`);
  await db.exec(`ALTER TABLE contact_messages ADD COLUMN IF NOT EXISTS closed_at TIMESTAMPTZ;`);
  await db.exec(`ALTER TABLE contact_messages ADD COLUMN IF NOT EXISTS staff_seen_at TIMESTAMPTZ;`);
  // Live chat presence: typing indicators + "student opened the chat" (Messenger-style).
  await db.exec(`ALTER TABLE contact_messages ADD COLUMN IF NOT EXISTS student_typing_at TIMESTAMPTZ;`);
  await db.exec(`ALTER TABLE contact_messages ADD COLUMN IF NOT EXISTS staff_typing_at TIMESTAMPTZ;`);
  await db.exec(`ALTER TABLE contact_messages ADD COLUMN IF NOT EXISTS student_opened_at TIMESTAMPTZ;`);
  await db.exec(`CREATE TABLE IF NOT EXISTS chat_messages (
    id SERIAL PRIMARY KEY,
    message_id INTEGER NOT NULL REFERENCES contact_messages(id) ON DELETE CASCADE,
    sender TEXT NOT NULL CHECK (sender IN ('student','staff')),
    sender_name TEXT,
    body TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );`);
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_chat_messages_thread ON chat_messages(message_id, created_at);`);
}

/* --------------------------- ticket number generator ----------------------- */

/**
 * Human-readable ticket number: RGP-2026-A0001 — one random letter of the year
 * followed by a 4-digit counter, sequence-backed and collision-checked.
 * The letter is picked from the sequence so consecutive tickets get different
 * letters; when the counter rolls past 9999 the suffix widens (A10000…).
 * Lookups are case-insensitive everywhere, so students can type a0001.
 */
const LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // no I or O — they read as 1 and 0
async function nextTicketNumber() {
  const year = new Date().getFullYear();
  for (;;) {
    const seq = await db.get(`SELECT nextval('ticket_number_seq') AS v`).then((r) => Number(r.v));
    const letter = LETTERS[(seq - 1) % LETTERS.length];
    const candidate = `RGP-${year}-${letter}${String(seq).padStart(4, '0')}`;
    const exists = await db.get('SELECT 1 AS x FROM tickets WHERE ticket_number = ?', candidate);
    if (!exists) return candidate; // sequence outlived last year's numbers — skip collisions
  }
}

/* ------------------------- structured academic data ------------------------ */

const LEVELS = [
  { value: 'ND1', label: 'ND 1' },
  { value: 'ND2', label: 'ND 2' },
  { value: 'HND1', label: 'HND 1' },
  { value: 'HND2', label: 'HND 2' },
];
const MODES = [
  { value: 'FULL_TIME', label: 'Full-Time' },
  { value: 'PART_TIME', label: 'Part-Time' },
];
const LEVEL_VALUES = LEVELS.map((l) => l.value);
const MODE_VALUES = MODES.map((m) => m.value);

/* ------------------------- one-time schema + seed -------------------------- */

let ready = null;
function readyPromise() {
  if (!ready) {
    ready = (async () => {
      await ensureSchema();
      await seedIfEmpty();
      console.log('[db] PostgreSQL schema + master data ready');
    })().catch((e) => { ready = null; throw e; });
  }
  return ready;
}

async function seedIfEmpty() {
  const n = await db.get('SELECT COUNT(*)::int AS n FROM faculties');
  if (n.n > 0) return;
  console.log('[db] empty database — seeding official RUGIPO master data…');
  const { seedMasterData } = require('./seed');
  await seedMasterData();
}

module.exports = { db, readyPromise, nextTicketNumber, runOutsideStore, LEVELS, MODES, LEVEL_VALUES, MODE_VALUES };
