/**
 * Student-facing API — NO LOGIN. Students submit their details with the
 * complaint, receive a tracking ID (RGP-YYYY-A0001), and track/reply using
 * that number + their email.
 *
 * Spec compliance:
 *  - Faculty/Department come from DB master data (validated IDs, never free text)
 *  - Structured academic_level (ND1..HND2) + study_mode (FULL_TIME/PART_TIME)
 *  - Returning students are recognized by matric number (no duplicate records)
 *  - Guided questions per service come from ticket_categories.guided_fields
 *  - Attachment downloads require a real staff JWT or the ticket's email
 */
const express = require('express');
const path = require('path');
const fs = require('fs');
const { db, nextTicketNumber, LEVEL_VALUES, MODE_VALUES } = require('../db');
const { queueEmail } = require('../notify');
const { requireStaff } = require('../auth');
const { upload, UPLOAD_DIR, cloudinaryUpload, cloudinaryUrl } = require('../uploads');
const realtime = require('../realtime');

const router = express.Router();

/**
 * Flood guard for public write endpoints (students never log in, so the IP is
 * the only handle). Self-cleaning buckets: junk IPs cannot grow the Map
 * without bound. Generous real-use ceilings — a student may correct a form
 * several times — but a scripted flood of submissions (each one a DB write +
 * a queued email) is cut off long before it can exhaust the free-tier
 * database or the Brevo quota during a launch-day spike.
 */
const floodBuckets = new Map();
function floodLimit(max, windowMs) {
  const sweeper = setInterval(() => {
    const now = Date.now();
    for (const [k, e] of floodBuckets) if (e.resetAt <= now) floodBuckets.delete(k);
  }, Math.min(windowMs, 60_000));
  if (sweeper.unref) sweeper.unref();
  return (req, res, next) => {
    const key = `${req.ip}:${req.baseUrl}${req.path}`;
    const now = Date.now();
    let e = floodBuckets.get(key);
    if (!e || e.resetAt <= now) { e = { count: 0, resetAt: now + windowMs }; floodBuckets.set(key, e); }
    e.count += 1;
    if (e.count > max) {
      res.setHeader('Retry-After', String(Math.max(1, Math.ceil((e.resetAt - now) / 1000))));
      return res.status(429).json({ error: 'Too many requests from this device. Please wait a few minutes and try again.' });
    }
    next();
  };
}

// Live-chat push helpers from the websocket hub (set once the server mounts
// this router — REST sends/closes fan out through these so both sides see
// every message instantly, not just socket-originated ones).
let wsApi = {};
function setChatPush(api) { wsApi = api || {}; }
router.setChatPush = setChatPush;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Clean free-text from students: strips HTML tags, script-ish content and
 * control characters, collapses whitespace, and enforces a length cap.
 * Students answer in plain language — anything that smells like code, markup
 * or injection payloads is neutralized before it ever reaches the database.
 */
function cleanText(value, maxLen = 500) {
  return String(value ?? '')
    // remove entire tags (<script>…</script>, <img …>, etc.)
    .replace(/<\/?[a-z][^>]*>/gi, ' ')
    // strip stray angle brackets that could start tags in emails/webviews
    .replace(/[<>]/g, '')
    // remove control chars except newline/tab
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    // collapse runs of whitespace but keep line breaks
    .replace(/[^\S\n]{2,}/g, ' ')
    .trim()
    .slice(0, maxLen);
}

/* --------------------------- taxonomy (master data) ------------------------ */

/**
 * POST /students/recognize — returning-student lookup.
 * Given matric (or reg) number + email, returns the student's saved details so
 * the complaint form can prefill them. Deliberately weak authentication by
 * design (no-login flow): the match requires BOTH the matric number AND the
 * exact email used before — neither is guessable to an outsider for a specific
 * student, and only name/department are returned (never phone).
 */
router.post('/students/recognize', floodLimit(20, 10 * 60_000), async (req, res) => {
  const matric = String(req.body?.matricNo || '').trim();
  const email = String(req.body?.email || '').trim().toLowerCase();
  if (!matric || !email) return res.status(400).json({ error: 'Enter your matric number and email first' });
  const s = await db.get(
    `SELECT s.full_name, s.reg_no, f.id AS faculty_id, f.name AS faculty_name,
            d.id AS department_id, d.name AS department_name, t.academic_level, t.study_mode
     FROM students s
     LEFT JOIN faculties f ON f.id = s.faculty_id
     LEFT JOIN departments d ON d.id = s.department_id
     LEFT JOIN LATERAL (SELECT academic_level, study_mode FROM tickets WHERE student_id = s.id ORDER BY created_at DESC LIMIT 1) t ON TRUE
     WHERE UPPER(REPLACE(s.matric_no, ' ', '')) = UPPER(REPLACE(?, ' ', '')) AND LOWER(s.email) = ?
     LIMIT 1`, matric, email);
  if (!s) return res.json({ known: false });
  res.json({
    known: true,
    student: {
      fullName: s.full_name, regNo: s.reg_no || '',
      facultyId: s.faculty_id, departmentId: s.department_id,
      academicLevel: s.academic_level || '', studyMode: s.study_mode || '',
      facultyName: s.faculty_name, departmentName: s.department_name,
    },
  });
});

router.get('/meta', async (_req, res) => {
  const faculties = await db.all(`SELECT f.id, f.name,
            COALESCE((SELECT json_agg(json_build_object('id', d.id, 'name', d.name, 'kind', d.kind) ORDER BY d.name)
              FROM departments d WHERE d.faculty_id = f.id AND d.active = 1), '[]'::json) AS departments
     FROM faculties f WHERE f.active = 1 ORDER BY f.sort_order, f.name`).then((rows) => rows.map((f) => ({ id: f.id, name: f.name, departments: typeof f.departments === 'string' ? JSON.parse(f.departments) : (f.departments || []) })));

  const categories = (await db.all('SELECT * FROM ticket_categories WHERE active = 1 ORDER BY sort_order')).map((c) => ({
    id: c.id, name: c.name, description: c.description,
    guidedFields: c.guided_fields ? JSON.parse(c.guided_fields) : [],
  }));

  const issues = (await db.all('SELECT * FROM ticket_issue_types WHERE active = 1'))
    .map((i) => ({ id: i.id, categoryId: i.category_id, name: i.name, requiresPaymentDetails: !!i.requires_payment_details, requiresAttachment: !!i.requires_attachment }));

  const levels = [
    { value: 'ND1', label: 'ND 1' }, { value: 'ND2', label: 'ND 2' },
    { value: 'HND1', label: 'HND 1' }, { value: 'HND2', label: 'HND 2' },
  ];
  const modes = [{ value: 'FULL_TIME', label: 'Full-Time' }, { value: 'PART_TIME', label: 'Part-Time' }];

  res.json({ faculties, categories, issues, levels, modes });
});

/* --------------------------- student recognition --------------------------- */

/**
 * Find or create the student record for this matric number.
 * Matching rule (spec §14): matric number is the identity key. If the matric
 * exists, the student is recognized — their name/email/phone are updated ONLY
 * when the existing record is empty in that field; conflicting identifiers
 * are kept, never silently overwritten (a second record is NOT created).
 */
async function recognizeStudent({ matricNo, regNo, studentName, email, phone, facultyId, departmentId }) {
  const matric = matricNo.toUpperCase();
  const reg = regNo ? String(regNo).trim().toUpperCase().slice(0, 40) : null;
  let s = await db.get('SELECT * FROM students WHERE matric_no = ?', matric);
  // Secondary identity: some students are known only by their portal reg no.
  if (!s && reg) s = await db.get('SELECT * FROM students WHERE reg_no = ?', reg);
  if (s) {
    await db.run(`UPDATE students SET
         full_name = COALESCE(NULLIF(full_name, ''), ?),
         email = COALESCE(NULLIF(email, ''), ?),
         phone = COALESCE(NULLIF(phone, ''), ?),
         faculty_id = COALESCE(faculty_id, ?),
         department_id = COALESCE(department_id, ?),
         reg_no = COALESCE(reg_no, ?),
         updated_at = now()
       WHERE id = ?`, studentName, email, phone, facultyId, departmentId, reg, s.id);
    return { id: s.id, recognized: true };
  }
  const info = await db.run(`INSERT INTO students (matric_no, reg_no, full_name, email, phone, faculty_id, department_id)
     VALUES (?, ?, ?, ?, ?, ?, ?)`, matric, reg, studentName, email, phone, facultyId, departmentId);
  return { id: info.lastInsertRowid, recognized: false };
}

/* ------------------------------ create a ticket ---------------------------- */

router.post('/tickets', floodLimit(6, 10 * 60_000), upload.array('files', 5), async (req, res) => {
  const b = req.body || {};
  const fail = (msg, code = 400) => {
    (req.files || []).forEach((f) => fs.unlink(f.path, () => {}));
    return res.status(code).json({ error: msg });
  };

  const required = ['studentName', 'matricNo', 'phone', 'email', 'facultyId', 'departmentId', 'academicLevel', 'studyMode', 'categoryId', 'issueTypeId', 'description'];
  const missing = required.filter((k) => !String(b[k] || '').trim());
  if (missing.length) return fail('Please complete every required field.');

  const email = String(b.email).trim().toLowerCase();
  if (!EMAIL_RE.test(email)) return fail('Enter a valid email address — your updates will be sent there.');
  if (String(b.description).trim().length < 10) return fail('Please describe the problem (at least 10 characters).');

  // Spam guard: a hidden field real visitors never fill. Bots fill everything.
  if (String(b.website || '').trim()) return fail('Your submission looks automated. Please try again.');

  // Structured academic data — validated against the master lists.
  const academicLevel = String(b.academicLevel).trim().toUpperCase();
  const studyMode = String(b.studyMode).trim().toUpperCase();
  if (!LEVEL_VALUES.includes(academicLevel)) return fail('Choose a valid level (ND 1 – HND 2).');
  if (!MODE_VALUES.includes(studyMode)) return fail('Choose a valid study mode (Full-Time or Part-Time).');

  // Master data — the submitted IDs must exist and belong together.
  const faculty = await db.get('SELECT * FROM faculties WHERE id = ? AND active = 1', b.facultyId);
  const department = await db.get('SELECT * FROM departments WHERE id = ? AND active = 1', b.departmentId);
  if (!faculty) return fail('Choose a valid faculty.');
  if (!department || department.faculty_id !== faculty.id) {
    return fail('Choose a department that belongs to the selected faculty.');
  }

  const cat = await db.get('SELECT * FROM ticket_categories WHERE id = ? AND active = 1', b.categoryId);
  const issue = await db.get('SELECT * FROM ticket_issue_types WHERE id = ? AND active = 1', b.issueTypeId);
  if (!cat || !issue || issue.category_id !== cat.id) return fail('Choose a valid category and issue.');

  // Payment complaints MUST carry the payment facts + receipt evidence —
  // the payment desk verifies every claim against the proof of the debit.
  if (issue.requires_payment_details) {
    const p = typeof b.details === 'string' ? safeParse(b.details) : (b.details || {});
    const missingPay = ['amount', 'paidFor', 'paymentMethod', 'paymentDate']
      .filter((k) => !String(p[k] || '').trim());
    if (missingPay.length) {
      return fail('Complete the payment details — amount, what the payment was for, how and when you paid.');
    }
    if (!(req.files || []).length) {
      return fail('Attach your payment receipt or debit evidence — a payment complaint cannot be submitted without it.');
    }
  }

  // Urgency: the student says whether a deadline makes this urgent ("course
  // registration closes tomorrow"). Stored as the ticket priority.
  const priority = (b.urgent === true || b.urgent === 'true' || b.urgent === '1') ? 'high' : 'normal';

  const consent = b.subscribe !== 'false' && b.subscribe !== false; // default ON, explicit opt-out allowed
  const matric = cleanText(b.matricNo, 40).toUpperCase();
  const studentName = cleanText(b.studentName, 120);
  if (!/^[A-Za-z0-9\/. -]+$/.test(matric)) return fail('Matric number looks invalid — use letters, numbers, slashes only.');
  if (!/^[A-Za-z .'\-]+$/.test(studentName)) return fail('Name looks invalid — use letters and spaces only.');

  // Upload to Cloudinary FIRST (async work outside the DB transaction). Files that
  // make it to the cloud are removed from the temp dir; the rest stay local.
  const stored = [];
  for (const f of req.files || []) {
    const cloudKey = await cloudinaryUpload(f.path, path.extname(f.filename).toLowerCase());
    stored.push({ file: f, cloudKey });
  }

  const createTicket = db.transaction(async () => {
    const { id: studentId, recognized } = await recognizeStudent({
      matricNo: matric, regNo: String(b.regNo || '').trim(), studentName,
      email, phone: String(b.phone).slice(0, 30),
      facultyId: faculty.id, departmentId: department.id,
    });

    const number = await nextTicketNumber();
    const reg = String(b.regNo || '').trim().toUpperCase().slice(0, 40) || null;
    const info = await db.run(`INSERT INTO tickets (ticket_number, student_id, faculty_id, department_id,
                            student_name, matric_no, reg_no, phone, email, department, level, programme,
                            academic_level, study_mode, priority,
                            category_id, issue_type_id, description, details)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, number, studentId, faculty.id, department.id,
      studentName, matric, reg, String(b.phone).slice(0, 30), email,
      department.name, `${LEVELS_LABEL[academicLevel]} ${MODES_LABEL[studyMode]}`,
      `${LEVELS_LABEL[academicLevel]} ${MODES_LABEL[studyMode]}`,
      academicLevel, studyMode, priority,
      cat.id, issue.id,
      cleanText(b.description, 5000),
      b.details ? cleanText(b.details, 8000) : null);
    const ticketId = info.lastInsertRowid;

    if (issue.requires_payment_details) {
      const p = typeof b.details === 'string' ? safeParse(b.details) : (b.details || {});
      await db.run(`INSERT INTO ticket_payment_details (ticket_id, amount, payment_method, payment_date, payment_for, portal_status, what_happened)
         VALUES (?, ?, ?, ?, ?, ?, ?)`, ticketId,
        str(p.amount, 40), str(p.paymentMethod, 60), str(p.paymentDate, 60),
        str(p.paidFor, 160), str(p.portalStatus, 200), str(p.whatHappened, 1000));
    }

    for (const { file: f, cloudKey } of stored) {
      // storage_key = Cloudinary public_id when uploaded, else the local filename.
      await db.run(`INSERT INTO ticket_attachments (ticket_id, uploaded_by, storage_key, original_filename, mime_type, size)
         VALUES (?, 'student', ?, ?, ?, ?)`, ticketId, cloudKey || f.filename, f.originalname.slice(0, 200), f.mimetype, f.size);
    }

    await db.run(`INSERT INTO ticket_status_history (ticket_id, old_status, new_status, changed_by, note)
       VALUES (?, NULL, 'open', 'student', 'Complaint submitted')`, ticketId);

    await db.run(`INSERT INTO audit_logs (actor_name, action, entity_type, entity_id, metadata)
       VALUES (?, 'ticket.create', 'ticket', ?, ?)`, email, ticketId, JSON.stringify({
      number, category: cat.name, issue: issue.name,
      faculty: faculty.name, department: department.name,
      academicLevel, studyMode, studentRecognized: recognized,
    }));

    if (consent) {
      await db.run(`INSERT INTO subscribers (email, name, matric_no, source) VALUES (?, ?, ?, 'ticket')
         ON CONFLICT(email) DO UPDATE SET name=excluded.name, unsubscribed_at=NULL`, email, studentName, matric);
    }

    queueEmail({
      ticketId,
      to: email,
      kind: 'confirmation',
      subject: `RUGIPO ICT: Complaint received — ${number}`,
      body: `Hello ${studentName},\n\nYour complaint has been received.\n\nTracking ID: ${number}\nCategory: ${cat.name} — ${issue.name}\nFaculty: ${faculty.name}\nDepartment: ${department.name}\nLevel: ${LEVELS_LABEL[academicLevel]} ${MODES_LABEL[studyMode]}\n\nKeep this ID. You can check progress any time at the ICT Support page (Track Ticket) using this ID and your email.\n\nWe will update you by email when there is progress or when it is resolved.\n\n— RUGIPO ICT Support`,
    });

    return { ticketId, number, recognized };
  });

  try {
    const { ticketId, number, recognized } = await createTicket();
    await require('../desk').computeDesk(ticketId); // decide payment vs portal desk now
    // Only clean up temp files AFTER the transaction commits successfully.
    for (const { file: f, cloudKey } of stored) if (cloudKey) fs.unlink(f.path, () => {});
    res.json({ ok: true, ticketId, ticketNumber: number, email, recognizedStudent: recognized });
  } catch (e) {
    (req.files || []).forEach((f) => fs.unlink(f.path, () => {}));
    console.error('[ticket create]', e);
    res.status(500).json({ error: 'Could not create the ticket. Please try again.' });
  }
});

const LEVELS_LABEL = { ND1: 'ND 1', ND2: 'ND 2', HND1: 'HND 1', HND2: 'HND 2' };
const MODES_LABEL = { FULL_TIME: 'Full-Time', PART_TIME: 'Part-Time' };

function str(v, max) { return v ? String(v).slice(0, max) : null; }
function safeParse(s) { try { return JSON.parse(s); } catch { return {}; } }

/* -------------------- student ticket history (for staff) ------------------- */

/** GET /students/:id/history — staff-only: every ticket this student logged. */
router.get('/students/:id/history', requireStaff, async (req, res) => {
  const s = await db.get('SELECT * FROM students WHERE id = ?', req.params.id);
  if (!s) return res.status(404).json({ error: 'Student not found' });
  const tickets = await db.all(`SELECT t.id, t.ticket_number, t.status, t.created_at, c.name AS category, i.name AS issue
     FROM tickets t
     JOIN ticket_categories c ON c.id = t.category_id
     JOIN ticket_issue_types i ON i.id = t.issue_type_id
     WHERE t.student_id = ? ORDER BY t.created_at DESC`, s.id);
  res.json({
    student: { id: s.id, name: s.full_name, matricNo: s.matric_no, email: s.email, phone: s.phone },
    tickets,
  });
});

/* ------------------ tracking (number + email proof) ------------------ */

async function loadTrackedTicket(req, res) {
  const number = String(req.body?.ticketNumber || req.params?.number || '').trim().toUpperCase();
  const email = String(req.body?.email || req.query?.email || '').trim().toLowerCase();
  if (!number || !email) { res.status(400).json({ error: 'Enter your tracking ID and the email you used.' }); return null; }
  const t = await db.get('SELECT * FROM tickets WHERE UPPER(ticket_number) = ? AND email = ?', number, email);
  if (!t) { res.status(404).json({ error: 'No ticket matches that tracking ID and email.' }); return null; }
  return t;
}

/** POST /tickets/track — track with { ticketNumber, email }. */
router.post('/tickets/track', async (req, res) => {
  const t = await loadTrackedTicket(req, res); if (!t) return;
  res.json({ ok: true, ticketId: t.id, ticketNumber: t.ticket_number });
});

/** GET /tickets/:id?email=… — full detail with email as the ownership proof. */
router.get('/tickets/:id', async (req, res) => {
  const t = await db.get('SELECT * FROM tickets WHERE id = ? AND email = ?', req.params.id, String(req.query.email || '').trim().toLowerCase());
  if (!t) return res.status(404).json({ error: 'Ticket not found. Check your tracking ID and email.' });

  const cat = await db.get('SELECT name FROM ticket_categories WHERE id = ?', t.category_id);
  const issue = await db.get('SELECT name FROM ticket_issue_types WHERE id = ?', t.issue_type_id);
  const faculty = t.faculty_id ? await db.get('SELECT name FROM faculties WHERE id = ?', t.faculty_id) : null;
  const department = t.department_id ? await db.get('SELECT name FROM departments WHERE id = ?', t.department_id) : null;
  // Student view: NEVER include internal notes.
  const messages = await db.all(`SELECT m.id, m.message, m.sender_role, m.created_at, m.sender_name
     FROM ticket_messages m WHERE m.ticket_id = ? AND m.visibility = 'student' ORDER BY m.created_at`, t.id);
  const attachments = await db.all(`SELECT id, original_filename, mime_type, size, created_at FROM ticket_attachments WHERE ticket_id = ?`, t.id);
  const payment = await db.get(`SELECT amount, payment_method, payment_date, payment_reference, portal_status, verification_status
     FROM ticket_payment_details WHERE ticket_id = ?`, t.id) || null; // student sees amount/method/date/what-for + verification state
  const history = await db.all(`SELECT old_status, new_status, note, created_at FROM ticket_status_history WHERE ticket_id = ? ORDER BY created_at`, t.id);
  res.json({
    ticket: {
      id: t.id, ticketNumber: t.ticket_number, status: t.status, priority: t.priority,
      description: t.description, details: safeParse(t.details), createdAt: t.created_at, updatedAt: t.updated_at,
      category: cat?.name, issue: issue?.name,
      faculty: faculty?.name || t.faculty_id, department: department?.name || t.department,
      level: t.level, academicLevel: t.academic_level, studyMode: t.study_mode,
    },
    messages, attachments, payment, history,
  });
});

/** Reply — the ticket's own email must be provided (ownership proof). */
/* ---------------------- reach ICT without a ticket ---------------------- */

const crypto = require('crypto');

/** Delete a chat conversation's history (used when either side closes it). */
async function closeConversation(messageId) {
  await db.run('DELETE FROM chat_messages WHERE message_id = ?', messageId);
  await db.run(`UPDATE contact_messages SET closed_at = now(), status = 'closed',
     message = '(conversation closed)', staff_reply = NULL WHERE id = ?`, messageId);
}

/** Public contact form — for questions that are not complaints. */
router.post('/contact', floodLimit(5, 10 * 60_000), async (req, res) => {
  const b = req.body || {};
  const senderName = cleanText(b.name, 120);
  const email = String(b.email || '').trim().toLowerCase().slice(0, 160);
  const subject = cleanText(b.subject, 160);
  const message = cleanText(b.message, 4000);
  if (!senderName) return res.status(400).json({ error: 'Tell us your name' });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Enter a valid email so we can reply' });
  if (!subject) return res.status(400).json({ error: 'Add a short subject' });
  if (!message || message.length < 10) return res.status(400).json({ error: 'Tell us a bit more (at least 10 characters)' });
  // Spam guard: a hidden field real visitors never fill. Bots fill everything.
  if (String(b.website || '').trim()) return res.status(400).json({ error: 'Your submission looks automated. Please try again.' });

  const chatToken = crypto.randomBytes(18).toString('hex');
  const r = await db.run(`INSERT INTO contact_messages (sender_name, email, phone, matric_no, subject, message, chat_token)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    senderName, email,
    b.phone ? cleanText(b.phone, 30) : null,
    b.matricNo ? cleanText(b.matricNo, 60) : null,
    subject, message, chatToken);
  // The opening message doubles as the first line of the live conversation.
  await db.run(`INSERT INTO chat_messages (message_id, sender, sender_name, body) VALUES (?, 'student', ?, ?)`,
    r.lastInsertRowid, senderName, message);
  // New question → every officer's "Student questions" badge refreshes live.
  realtime.inboxBadge();

  // Instant acknowledgement so the student knows it arrived.
  queueEmail({
    to: email,
    kind: 'contact-ack',
    subject: `We got your message — RUGIPO ICT Support`,
    body: `Hello ${senderName},\n\nThank you for reaching out to ICT Support.\n\nWhat you told us:\n"${subject}"\n\nA member of the team will reply to ${email} as soon as possible.\n\nWant to talk with us live? Open your conversation here:\n${process.env.PUBLIC_BASE_URL || ''}/chat/${chatToken}\n(keep this link — it is your private door to the conversation)\n\nIf your message turns out to be a complaint about a portal, payment or registration problem, we may ask you to log it properly so it gets a Tracking ID and full tracking.\n\n— RUGIPO ICT Support`,
  });
  res.json({ ok: true, chatUrl: `/chat/${chatToken}` });
});

/* ------------------------ live chat (token-gated) ------------------------ */

/**
 * The chat lives behind a 30-char random token emailed to the student —
 * no account, no password. Anyone with the link IS the student (same model
 * as the tracking page: ID + email), and closing the conversation wipes it.
 */
router.get('/chat/:token', async (req, res) => {
  const m = await db.get('SELECT * FROM contact_messages WHERE chat_token = ?', String(req.params.token));
  if (!m) return res.status(404).json({ error: 'This conversation link is not valid' });
  // Presence: opening the conversation marks "student opened the chat" for the
  // ICT inbox, and every reply/update below it shows staff presence back.
  await db.run('UPDATE contact_messages SET student_opened_at = now() WHERE id = ?', m.id);
  realtime.chatOpened(m.id, new Date().toISOString());
  const messages = m.closed_at ? [] : await db.all(
    'SELECT id, sender, sender_name, body, created_at FROM chat_messages WHERE message_id = ? ORDER BY created_at, id', m.id);
  const staffTyping = !m.closed_at && m.staff_typing_at
    && (Date.now() - new Date(m.staff_typing_at).getTime()) < 8000;
  res.json({
    id: m.id, // lets the student side join the same live channel as staff
    subject: m.subject, studentName: m.sender_name, closed: !!m.closed_at,
    closedAt: m.closed_at, messages,
    staffTyping,
    staffSeenAt: m.staff_seen_at || null,
  });
});

/** Student is typing — the ICT inbox shows "<Student> is typing…" live. */
router.post('/chat/:token/typing', floodLimit(120, 5 * 60_000), async (req, res) => {
  const m = await db.get('SELECT id FROM contact_messages WHERE chat_token = ?', String(req.params.token));
  if (!m) return res.status(404).json({ error: 'This conversation link is not valid' });
  await db.run('UPDATE contact_messages SET student_typing_at = now() WHERE id = ?', m.id);
  realtime.chatTyping(m.id, 'student');
  res.json({ ok: true });
});

/** Student sends a message into the conversation. */
router.post('/chat/:token', floodLimit(40, 5 * 60_000), async (req, res) => {
  const m = await db.get('SELECT * FROM contact_messages WHERE chat_token = ?', String(req.params.token));
  if (!m) return res.status(404).json({ error: 'This conversation link is not valid' });
  if (m.closed_at) return res.status(410).json({ error: 'This conversation is closed' });
  const body = cleanText(req.body?.body, 4000);
  if (body.length < 2) return res.status(400).json({ error: 'Type a message first' });
  await db.run(`INSERT INTO chat_messages (message_id, sender, sender_name, body) VALUES (?, 'student', ?, ?)`,
    m.id, m.sender_name, body);
  // Push the new message to everyone watching this conversation over
  // websocket (the ICT inbox and any second tab) — Messenger-style.
  wsApi.fanoutStaffSnapshot?.(m.id);
  wsApi.fanoutStudentSnapshot?.(m.chat_token);
  realtime.chatRefresh(m.id);
  res.json({ ok: true });
});

/** Student closes the conversation — the whole history is deleted. */
router.post('/chat/:token/close', floodLimit(10, 5 * 60_000), async (req, res) => {
  const m = await db.get('SELECT id, chat_token FROM contact_messages WHERE chat_token = ?', String(req.params.token));
  if (!m) return res.status(404).json({ error: 'This conversation link is not valid' });
  await closeConversation(m.id);
  // Tell the ICT side instantly (their thread empties and flips to closed).
  wsApi.broadcastStaffClosed?.(m.id);
  wsApi.fanoutStaffSnapshot?.(m.id);
  realtime.chatClosed(m.id);
  realtime.chatRefresh(m.id);
  res.json({ ok: true });
});

/** Reply — the ticket's own email must be provided (ownership proof). */
router.post('/tickets/:id/reply', floodLimit(20, 10 * 60_000), async (req, res) => {
  const t = await db.get('SELECT * FROM tickets WHERE id = ? AND email = ?', req.params.id, String(req.body?.email || '').trim().toLowerCase());
  if (!t) return res.status(404).json({ error: 'Ticket not found. Check your tracking ID and email.' });
  if (['resolved', 'closed', 'rejected'].includes(t.status)) {
    return res.status(409).json({ error: 'This complaint is marked solved, so the conversation is closed. Press “Reopen this complaint” if the problem came back.' });
  }
  const message = String(req.body?.message || '').trim();
  if (!message) return res.status(400).json({ error: 'Type a message first' });
  await db.run(`INSERT INTO ticket_messages (ticket_id, sender_name, sender_role, message, visibility)
     VALUES (?, ?, 'student', ?, 'student')`, t.id, t.student_name, cleanText(message, 4000));
  await db.run(`UPDATE tickets SET updated_at = now() WHERE id = ?`, t.id);
  if (t.assigned_staff_id) {
    const officer = await db.get('SELECT email FROM users WHERE id = ?', t.assigned_staff_id);
    if (officer) {
      await queueEmail({ ticketId: t.id, to: officer.email, kind: 'reply',
        subject: `New student reply on ${t.ticket_number}`,
        body: message.slice(0, 300) });
    }
  }
  res.json({ ok: true });
});

/**
 * Reopen — the student says the solved problem came back. The complaint goes
 * back to the queue for the SAME officer/engineer (assignment is kept) and a
 * system line is written on the record. Also notifies the assigned staff by
 * email so it is not missed.
 */
router.post('/tickets/:id/reopen', floodLimit(6, 10 * 60_000), async (req, res) => {
  const t = await db.get('SELECT * FROM tickets WHERE id = ? AND email = ?', req.params.id, String(req.body?.email || '').trim().toLowerCase());
  if (!t) return res.status(404).json({ error: 'Ticket not found. Check your tracking ID and email.' });
  if (!['resolved', 'closed'].includes(t.status)) {
    return res.status(409).json({ error: 'Only a solved complaint can be reopened.' });
  }
  const reason = cleanText(req.body?.reason || '', 500);
  const backTo = 'open';
  await db.run(`UPDATE tickets SET status = ?, updated_at = now() WHERE id = ?`, backTo, t.id);
  await db.run(`INSERT INTO ticket_status_history (ticket_id, old_status, new_status, changed_by, note)
     VALUES (?, ?, ?, 'student', ?)`, t.id, t.status, backTo, reason || 'Student says the problem came back');
  await db.run(`INSERT INTO ticket_messages (ticket_id, sender_name, sender_role, message, visibility)
     VALUES (?, ?, 'student', ?, 'student')`, t.id, t.student_name,
    reason ? `Reopened this complaint: ${reason}` : 'Reopened this complaint — the problem came back.');
  if (t.assigned_staff_id) {
    const officer = await db.get('SELECT email FROM users WHERE id = ?', t.assigned_staff_id);
    if (officer) {
      await queueEmail({ ticketId: t.id, to: officer.email, kind: 'reply',
        subject: `Reopened: ${t.ticket_number} — the student says it is not fixed`,
        body: `${t.student_name} reopened complaint ${t.ticket_number}.\n\nWhat they said: ${reason || 'The problem came back.'}\n\nOpen the ICT Staff Portal to continue on it.\n\n— RUGIPO ICT Support` });
    }
  }
  res.json({ ok: true });
});

/* -------------------------- attachments ------------------------------ */

/** Add more files later — needs the ticket email as proof. */
router.post('/tickets/:id/attachments', floodLimit(10, 10 * 60_000), upload.array('files', 5), async (req, res) => {
  const t = await db.get('SELECT * FROM tickets WHERE id = ? AND email = ?', req.params.id, String(req.body?.email || '').trim().toLowerCase());
  if (!t) {
    (req.files || []).forEach((f) => fs.unlink(f.path, () => {}));
    return res.status(404).json({ error: 'Ticket not found. Check your tracking ID and email.' });
  }
  try {
    const stored2 = [];
    for (const f of req.files || []) {
      const cloudKey = await cloudinaryUpload(f.path, path.extname(f.filename).toLowerCase());
      stored2.push({ file: f, cloudKey });
    }
    for (const { file: f, cloudKey } of stored2) {
      await db.run(`INSERT INTO ticket_attachments (ticket_id, uploaded_by, storage_key, original_filename, mime_type, size)
         VALUES (?, 'student', ?, ?, ?, ?)`, t.id, cloudKey || f.filename, f.originalname.slice(0, 200), f.mimetype, f.size);
    }
    for (const { file: f, cloudKey } of stored2) if (cloudKey) fs.unlink(f.path, () => {});
    await require('../desk').computeDesk(t.id); // new evidence can move the desk (receipt + proof → payment)
    res.json({ ok: true, added: (req.files || []).length });
  } catch (e) {
    (req.files || []).forEach((f) => fs.unlink(f.path, () => {}));
    throw e;
  }
});

/**
 * Download — the ticket owner (email match) OR any authenticated staff member
 * (real JWT via Authorization header — the forgeable x-staff-token header is
 * gone; spec §28/§29).
 */
router.get('/attachments/:id', async (req, res) => {
  const a = await db.get('SELECT * FROM ticket_attachments WHERE id = ?', req.params.id);
  if (!a) return res.status(404).json({ error: 'Attachment not found' });

  const requesterEmail = String(req.query.email || '').trim().toLowerCase();
  let authorized = false;
  const t = await db.get('SELECT email FROM tickets WHERE id = ?', a.ticket_id);
  if (t && requesterEmail && t.email === requesterEmail) authorized = true;
  if (!authorized) {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (token) {
      try {
        const jwt = require('jsonwebtoken');
        const payload = jwt.verify(token, process.env.JWT_SECRET || '');
        const user = await db.get('SELECT id FROM users WHERE id = ? AND active = 1', payload.sub);
        if (user) authorized = true;
      } catch { /* invalid token → fall through */ }
    }
  }
  if (!authorized) return res.status(404).json({ error: 'Attachment not found' });

  // Cloudinary-stored files: storage_key holds the public_id (no path chars, no local file).
  const isCloudinary = !a.storage_key.includes('/') || a.storage_key.includes('rugipo-tickets/');
  if (isCloudinary && !fs.existsSync(path.join(UPLOAD_DIR, path.basename(a.storage_key)))) {
    const url = cloudinaryUrl(a.storage_key);
    if (url) return res.json({ url });
    return res.status(404).json({ error: 'File missing from storage' });
  }

  const safe = path.basename(a.storage_key);
  const file = path.join(UPLOAD_DIR, safe);
  if (!file.startsWith(UPLOAD_DIR) || !fs.existsSync(file)) {
    return res.status(404).json({ error: 'File missing from storage' });
  }
  res.setHeader('Content-Type', a.mime_type);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(a.original_filename)}"`);
  fs.createReadStream(file).pipe(res);
});

/* ------------------------- public tracking --------------------------- */

/** Limited public status lookup by ticket number alone (no private details). */
router.get('/track/:number', async (req, res) => {
  const row = await db.get(`SELECT t.ticket_number, t.status, t.updated_at, c.name AS category, i.name AS issue
     FROM tickets t
     JOIN ticket_categories c ON c.id = t.category_id
     JOIN ticket_issue_types i ON i.id = t.issue_type_id
     WHERE UPPER(t.ticket_number) = ?`, String(req.params.number || '').trim().toUpperCase());
  if (!row) return res.status(404).json({ error: 'No ticket found with that number' });
  res.json({
    ticketNumber: row.ticket_number, status: row.status, category: row.category,
    issue: row.issue, updatedAt: row.updated_at,
  });
});

/* ------------------------- newsletter (public) ------------------------ */

router.post('/subscribe', floodLimit(5, 15 * 60_000), async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const name = req.body?.name ? String(req.body.name).slice(0, 120) : null;
  if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'Enter a valid email address' });
  await db.run(`INSERT INTO subscribers (email, name, source) VALUES (?, ?, 'signup')
     ON CONFLICT(email) DO UPDATE SET unsubscribed_at=NULL, name=COALESCE(excluded.name, name)`, email, name);
  res.json({ ok: true });
});

/* ----------------------------- announcements ----------------------------- */

/** Public: the latest homepage updates (only what ICT actually posted). */
router.get('/announcements', async (_req, res) => {
  const rows = await db.all(
    'SELECT id, kind, title, body, created_at FROM announcements ORDER BY created_at DESC LIMIT 20'
  );
  res.json({ announcements: rows });
});

router.post('/unsubscribe', async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  await db.run(`UPDATE subscribers SET unsubscribed_at = now() WHERE email = ?`, email);
  res.json({ ok: true });
});

/* --------------------------- lost-credential recovery -------------------- */

/**
 * POST /recover { kind: 'ids' | 'chat', email }
 * Students lose Tracking IDs and the private chat link constantly (they
 * arrive by email and emails get deleted). This re-sends them to the email
 * on file — the email itself is the ownership proof, same as tracking.
 */
router.post('/recover', floodLimit(4, 15 * 60_000), async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const kind = String(req.body?.kind || 'ids');
  if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'Enter the email you used when logging the complaint' });

  if (kind === 'chat') {
    const convos = await db.all(
      `SELECT chat_token, subject, closed_at FROM contact_messages
        WHERE email = ? AND closed_at IS NULL AND chat_token IS NOT NULL
        ORDER BY created_at DESC LIMIT 5`, email);
    if (convos.length) {
      const links = convos.map((c) => `• "${c.subject}"\n  ${process.env.PUBLIC_BASE_URL || ''}/chat/${c.chat_token}`).join('\n\n');
      queueEmail({
        to: email, kind: 'recover-chat',
        subject: 'Your ICT Support conversation links',
        body: `Hello,\n\nHere ${convos.length === 1 ? 'is the link to your open conversation' : 'are the links to your open conversations'} with ICT Support:\n\n${links}\n\nKeep these links private — anyone with one can read the conversation. Closed conversations are permanently deleted.\n\n— RUGIPO ICT Support`,
      });
    }
    // Same response either way: never reveal whether an address has data.
    return res.json({ ok: true });
  }

  const tickets = await db.all(
    `SELECT ticket_number, student_name, status, created_at FROM tickets WHERE email = ?
      ORDER BY created_at DESC LIMIT 10`, email);
  if (tickets.length) {
    const list = tickets.map((t) =>
      `• ${t.ticket_number} — logged ${String(t.created_at).slice(0, 10)} (${t.status.replace('_', ' ')})`).join('\n');
    queueEmail({
      to: email, kind: 'recover-ids',
      subject: `Your RUGIPO ICT Tracking ID${tickets.length > 1 ? 's' : ''}`,
      body: `Hello${tickets[0].student_name ? ' ' + tickets[0].student_name : ''},\n\nYou asked us to re-send your complaint Tracking ID${tickets.length > 1 ? 's' : ''}. Here ${tickets.length > 1 ? 'they are' : 'it is'}:\n\n${list}\n\nTrack any of them at ${process.env.PUBLIC_BASE_URL || ''}/track using this email address.\n\n— RUGIPO ICT Support`,
    });
  }
  return res.json({ ok: true });
});

module.exports = router;
