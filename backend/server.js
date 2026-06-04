require('dotenv').config();

const path = require('path');
const crypto = require('crypto');
const express = require('express');
const compression = require('compression');
const cors = require('cors');
const multer = require('multer');
const session = require('express-session');
const cookieParser = require('cookie-parser');

const { initDb, getPool, ensureSession } = require('./db');
const AUDITOR_MASTER = require('./data/auditors');
const {
  parseAttendanceBuffer,
  parsePjpBuffer,
  buildPlanIndexes,
  pickDefaultDate,
  scopeAttendanceToPjpMonth,
} = require('./lib/excel');
const { dateKey } = require('./lib/utils');
const { rosterAiReview } = require('./lib/claims');
const { processClaim } = require('./lib/claim-processor');
const {
  extractBillsFromBulkPdfBuffer,
  buildClaimFromExtractedBill,
  MAX_PDF_BYTES,
  slimClaimForClient,
} = require('./lib/bulk-pdf');
const {
  createBulkPdfJob,
  updateBulkPdfJob,
  getBulkPdfJob,
  serializeBulkPdfJob,
} = require('./lib/bulk-jobs');
const { loadExpenseRegistry, deleteRegistryEntry } = require('./lib/expense-validation');

const PORT = process.env.PORT || 3000;
const ROOT_DIR = path.join(__dirname, '..');
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

function isPdfUpload(file) {
  if (!file) return false;
  const mime = String(file.mimetype || '').toLowerCase();
  if (mime === 'application/pdf' || mime === 'application/x-pdf') return true;
  return /\.pdf$/i.test(String(file.originalname || ''));
}

function slimClaimPayload(payload) {
  if (!payload || typeof payload !== 'object') return payload;
  return {
    id: payload.id,
    auditorCode: payload.auditorCode,
    date: payload.date,
    subcategory: payload.subcategory,
    amount: payload.amount,
  };
}

async function runBulkPdfJob(jobId, { sessionId, apiKey, fileBuffer, fileName }) {
  try {
    await updateBulkPdfJob(jobId, {
      status: 'scanning',
      message: 'AI scanning PDF for bills…',
    });

    const workspace = await loadWorkspaceLite(sessionId);
    const pdfHash = crypto.createHash('sha256').update(fileBuffer).digest('hex');
    const pdfMeta = { fileName, pdfHash };

    const { bills: rows, partial } = await extractBillsFromBulkPdfBuffer(fileBuffer, apiKey);
    if (!rows.length) {
      await updateBulkPdfJob(jobId, {
        status: 'failed',
        error: 'No bills detected in this PDF.',
        message: 'No bills detected in this PDF.',
      });
      return;
    }

    await updateBulkPdfJob(jobId, {
      status: 'creating',
      message: `Creating ${rows.length} expenses…`,
      detected: rows.length,
    });

    let createdCount = 0;
    const existingClaims = workspace.claims;
    for (let i = 0; i < rows.length; i += 1) {
      const claim = buildClaimFromExtractedBill(rows[i], pdfMeta, i);
      await processClaim(
        claim,
        { ...workspace, claims: existingClaims },
        sessionId,
        { apiKey, skipAi: true }
      );
      await ensureSession(sessionId);
      await getPool().query(
        `INSERT INTO claims (id, session_id, payload, created_at, updated_at)
         VALUES ($1, $2, $3::jsonb, NOW(), NOW())`,
        [claim.id, sessionId, JSON.stringify(claim)]
      );
      existingClaims.unshift(slimClaimPayload(claim));
      createdCount += 1;
    }

    await updateBulkPdfJob(jobId, {
      status: 'done',
      message: `Created ${createdCount} expenses.`,
      resultCount: createdCount,
      partial,
      warning: partial
        ? 'Some bills may be missing — AI output was truncated. Split large PDFs if needed.'
        : null,
    });
  } catch (err) {
    console.error('Bulk PDF job failed:', err);
    await updateBulkPdfJob(jobId, {
      status: 'failed',
      error: err.message || 'Bulk PDF processing failed',
      message: 'Bulk PDF processing failed.',
    });
  }
}

const app = express();
app.set('trust proxy', 1);

app.use(compression());
app.use(cookieParser());
app.use(
  cors({
    origin: true,
    credentials: true,
    allowedHeaders: ['Content-Type', 'X-Session-Id', 'X-Anthropic-Api-Key'],
    exposedHeaders: ['Content-Type'],
  })
);
app.use(express.json({ limit: '15mb' }));
app.use(
  session({
    secret: process.env.SESSION_SECRET || 'dev-only-change-me',
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 7 * 24 * 60 * 60 * 1000,
    },
  })
);

function authRequired(_req, _res, next) {
  // Dashboard password disabled — open access without APP_PASSWORD login
  return next();
}

function getSessionId(req) {
  return req.headers['x-session-id'] || req.query.sessionId || null;
}

/** Browser header first, then ANTHROPIC_API_KEY on Render (set once in dashboard). */
function getClientApiKey(req) {
  const h = req.headers['x-anthropic-api-key'];
  if (h && String(h).trim()) return String(h).trim();
  const env = process.env.ANTHROPIC_API_KEY;
  if (env && String(env).trim()) return String(env).trim();
  return null;
}

async function loadWorkspace(sessionId) {
  await ensureSession(sessionId);
  const pool = getPool();

  const att = await pool.query(
    'SELECT filename, rows FROM attendance_snapshots WHERE session_id = $1',
    [sessionId]
  );
  const pjp = await pool.query(
    'SELECT filename, plan_rows, meta FROM pjp_snapshots WHERE session_id = $1',
    [sessionId]
  );
  const claimsRes = await pool.query(
    'SELECT payload FROM claims WHERE session_id = $1 ORDER BY created_at DESC',
    [sessionId]
  );

  const rawRowsAll = att.rows[0]?.rows || [];
  const planRows = pjp.rows[0]?.plan_rows || [];
  const meta = pjp.rows[0]?.meta || {};
  const indexes = buildPlanIndexes(planRows);
  const rawRows = scopeAttendanceToPjpMonth(rawRowsAll, meta.pjpMinDate, meta.pjpMaxDate);

  return {
    attendanceFileName: att.rows[0]?.filename || null,
    pjpFileName: pjp.rows[0]?.filename || null,
    rawRows,
    rawRowsAll,
    attendanceRowCountTotal: rawRowsAll.length,
    planRows,
    pjpMonth: meta.pjpMonth || null,
    pjpMinDate: meta.pjpMinDate || null,
    pjpMaxDate: meta.pjpMaxDate || null,
    pjpEmpCodes: meta.pjpEmpCodes || [],
    planByEmpDate: indexes.planByEmpDate,
    planByNameDate: indexes.planByNameDate,
    claims: claimsRes.rows.map((r) => r.payload),
  };
}

/** Attendance/PJP + slim claims only — used by bulk PDF to avoid loading full claim payloads. */
async function loadWorkspaceLite(sessionId) {
  await ensureSession(sessionId);
  const pool = getPool();

  const att = await pool.query(
    'SELECT filename, rows FROM attendance_snapshots WHERE session_id = $1',
    [sessionId]
  );
  const pjp = await pool.query(
    'SELECT filename, plan_rows, meta FROM pjp_snapshots WHERE session_id = $1',
    [sessionId]
  );
  const rawRowsAll = att.rows[0]?.rows || [];
  const planRows = pjp.rows[0]?.plan_rows || [];
  const meta = pjp.rows[0]?.meta || {};
  const indexes = buildPlanIndexes(planRows);
  const rawRows = scopeAttendanceToPjpMonth(rawRowsAll, meta.pjpMinDate, meta.pjpMaxDate);
  const slimClaims = await loadSlimClaimRows(sessionId, 500);

  return {
    attendanceFileName: att.rows[0]?.filename || null,
    pjpFileName: pjp.rows[0]?.filename || null,
    rawRows,
    planRows,
    pjpMonth: meta.pjpMonth || null,
    pjpMinDate: meta.pjpMinDate || null,
    pjpMaxDate: meta.pjpMaxDate || null,
    pjpEmpCodes: meta.pjpEmpCodes || [],
    planByEmpDate: indexes.planByEmpDate,
    planByNameDate: indexes.planByNameDate,
    claims: slimClaims.map((p) => slimClaimPayload(p)),
  };
}

function buildStatePayload(workspace, filteredDate) {
  const uniqueAuditors = [...new Set(workspace.rawRows.map((r) => r.auditor).filter(Boolean))].sort();
  let defaultDate = filteredDate || pickDefaultDate(workspace.rawRows, workspace.pjpMinDate, workspace.pjpMaxDate);
  if (!defaultDate) defaultDate = dateKey(new Date());

  return {
    sessionId: null,
    attendanceFileName: workspace.attendanceFileName,
    pjpFileName: workspace.pjpFileName,
    rawRows: workspace.rawRows,
    planRows: workspace.planRows,
    uniqueAuditors,
    pjpMonth: workspace.pjpMonth,
    pjpMinDate: workspace.pjpMinDate,
    pjpMaxDate: workspace.pjpMaxDate,
    pjpEmpCodes: workspace.pjpEmpCodes,
    filteredDate: defaultDate,
    claims: workspace.claims.map(slimClaimForClient),
    aiKeySource: process.env.ANTHROPIC_API_KEY ? 'server' : 'browser',
    hasServerApiKey: !!process.env.ANTHROPIC_API_KEY,
    authRequired: false,
  };
}

/** Lightweight state — no attendance/PJP row blobs (fetch via /api/attendance and /api/pjp). */
async function loadStateSummary(sessionId) {
  await ensureSession(sessionId);
  const pool = getPool();

  const [att, pjp, claimCountRes] = await Promise.all([
    pool.query(
      `SELECT filename,
        CASE WHEN rows IS NULL THEN 0 ELSE jsonb_array_length(rows) END AS row_count
       FROM attendance_snapshots WHERE session_id = $1`,
      [sessionId]
    ),
    pool.query(
      `SELECT filename, meta,
        CASE WHEN plan_rows IS NULL THEN 0 ELSE jsonb_array_length(plan_rows) END AS plan_row_count
       FROM pjp_snapshots WHERE session_id = $1`,
      [sessionId]
    ),
    pool.query('SELECT COUNT(*)::int AS n FROM claims WHERE session_id = $1', [sessionId]),
  ]);

  const meta = pjp.rows[0]?.meta || {};
  const rawRowCount = Number(att.rows[0]?.row_count) || 0;
  const planRowCount = Number(pjp.rows[0]?.plan_row_count) || 0;

  return {
    attendanceFileName: att.rows[0]?.filename || null,
    attendanceRowCount: rawRowCount,
    pjpFileName: pjp.rows[0]?.filename || null,
    planRowCount,
    pjpMonth: meta.pjpMonth || null,
    pjpMinDate: meta.pjpMinDate || null,
    pjpMaxDate: meta.pjpMaxDate || null,
    pjpEmpCodes: meta.pjpEmpCodes || [],
    claimCount: claimCountRes.rows[0]?.n || 0,
    _hasAttendance: rawRowCount > 0,
    _hasPjp: planRowCount > 0,
  };
}

function buildStateSummaryPayload(summary, filteredDate) {
  let defaultDate =
    filteredDate || pickDefaultDate([], summary.pjpMinDate, summary.pjpMaxDate);
  if (!defaultDate) defaultDate = dateKey(new Date());

  return {
    sessionId: null,
    attendanceFileName: summary.attendanceFileName,
    attendanceRowCount: summary.attendanceRowCount,
    pjpFileName: summary.pjpFileName,
    planRowCount: summary.planRowCount,
    pjpMonth: summary.pjpMonth,
    pjpMinDate: summary.pjpMinDate,
    pjpMaxDate: summary.pjpMaxDate,
    pjpEmpCodes: summary.pjpEmpCodes,
    filteredDate: defaultDate,
    claimCount: summary.claimCount || 0,
    hasAttendance: summary._hasAttendance,
    hasPjp: summary._hasPjp,
    aiKeySource: process.env.ANTHROPIC_API_KEY ? 'server' : 'browser',
    hasServerApiKey: !!process.env.ANTHROPIC_API_KEY,
    authRequired: false,
  };
}

// --- Public / auth routes ---

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'sentinel-backend',
    build: '2026.06.16-main',
    renderBranch: process.env.RENDER_GIT_BRANCH || null,
    renderService: process.env.RENDER_SERVICE_NAME || null,
  });
});

app.get('/api/config', (_req, res) => {
  res.json({
    authRequired: false,
    aiKeySource: process.env.ANTHROPIC_API_KEY ? 'server' : 'browser',
    hasServerApiKey: !!process.env.ANTHROPIC_API_KEY,
  });
});

app.get('/api/auth/status', (_req, res) => {
  res.json({ authenticated: true, authRequired: false });
});

app.post('/api/auth/login', (req, res) => {
  const password = process.env.APP_PASSWORD;
  if (!password) {
    req.session.authenticated = true;
    return res.json({ ok: true });
  }
  if (req.body?.password === password) {
    req.session.authenticated = true;
    return res.json({ ok: true });
  }
  return res.status(401).json({ error: 'Incorrect password' });
});

app.post('/api/auth/logout', (req, res) => {
  req.session.destroy(() => {
    res.json({ ok: true });
  });
});

// --- Session ---

app.post('/api/session', authRequired, async (_req, res) => {
  try {
    const sessionId = crypto.randomUUID();
    await ensureSession(sessionId);
    res.json({ sessionId });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || 'Could not create session' });
  }
});

app.get('/api/state', authRequired, async (req, res) => {
  try {
    let sessionId = getSessionId(req);
    if (!sessionId) {
      sessionId = crypto.randomUUID();
      await ensureSession(sessionId);
      return res.json({
        ...buildStateSummaryPayload(
          {
            attendanceFileName: null,
            attendanceRowCount: 0,
            pjpFileName: null,
            planRowCount: 0,
            pjpMonth: null,
            pjpMinDate: null,
            pjpMaxDate: null,
            pjpEmpCodes: [],
            claimCount: 0,
            _hasAttendance: false,
            _hasPjp: false,
          },
          null
        ),
        sessionId,
      });
    }
    const summary = await loadStateSummary(sessionId);
    res.json({
      ...buildStateSummaryPayload(summary, req.query.filteredDate || null),
      sessionId,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || 'Failed to load state' });
  }
});

app.get('/api/attendance', authRequired, async (req, res) => {
  try {
    const sessionId = getSessionId(req);
    if (!sessionId) return res.status(400).json({ error: 'Missing X-Session-Id header' });
    const { rows } = await getPool().query(
      'SELECT filename, rows FROM attendance_snapshots WHERE session_id = $1',
      [sessionId]
    );
    if (!rows.length) {
      return res.json({
        attendanceFileName: null,
        rawRows: [],
        rawRowsAll: [],
        uniqueAuditors: [],
        rowCountTotal: 0,
        rowCountInScope: 0,
      });
    }
    const meta = await getPjpMeta(sessionId);
    const rawRowsAll = rows[0].rows || [];
    const rawRows = scopeAttendanceToPjpMonth(rawRowsAll, meta.pjpMinDate, meta.pjpMaxDate);
    const uniqueAuditors = [...new Set(rawRows.map((r) => r.auditor).filter(Boolean))].sort();
    res.json({
      attendanceFileName: rows[0].filename,
      rawRows,
      rawRowsAll,
      uniqueAuditors,
      rowCountTotal: rawRowsAll.length,
      rowCountInScope: rawRows.length,
      pjpMonth: meta.pjpMonth || null,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || 'Failed to load attendance' });
  }
});

app.get('/api/pjp', authRequired, async (req, res) => {
  try {
    const sessionId = getSessionId(req);
    if (!sessionId) return res.status(400).json({ error: 'Missing X-Session-Id header' });
    const { rows } = await getPool().query(
      'SELECT filename, plan_rows, meta FROM pjp_snapshots WHERE session_id = $1',
      [sessionId]
    );
    if (!rows.length) {
      return res.json({
        pjpFileName: null,
        planRows: [],
        pjpMonth: null,
        pjpMinDate: null,
        pjpMaxDate: null,
        pjpEmpCodes: [],
      });
    }
    const meta = rows[0].meta || {};
    res.json({
      pjpFileName: rows[0].filename,
      planRows: rows[0].plan_rows || [],
      pjpMonth: meta.pjpMonth || null,
      pjpMinDate: meta.pjpMinDate || null,
      pjpMaxDate: meta.pjpMaxDate || null,
      pjpEmpCodes: meta.pjpEmpCodes || [],
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || 'Failed to load PJP' });
  }
});

app.delete('/api/state', authRequired, async (req, res) => {
  try {
    const sessionId = getSessionId(req);
    if (!sessionId) return res.status(400).json({ error: 'Missing X-Session-Id header' });
    const pool = getPool();
    await pool.query(
      'DELETE FROM expense_claim_registry WHERE session_id = $1',
      [sessionId]
    );
    await pool.query('DELETE FROM claims WHERE session_id = $1', [sessionId]);
    await pool.query('DELETE FROM attendance_snapshots WHERE session_id = $1', [sessionId]);
    await pool.query('DELETE FROM pjp_snapshots WHERE session_id = $1', [sessionId]);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || 'Reset failed' });
  }
});

async function getPjpMeta(sessionId) {
  const res = await getPool().query('SELECT meta FROM pjp_snapshots WHERE session_id = $1', [sessionId]);
  return res.rows[0]?.meta || {};
}

async function getAttendanceRowsForSession(sessionId, scoped = true) {
  const res = await getPool().query('SELECT rows FROM attendance_snapshots WHERE session_id = $1', [
    sessionId,
  ]);
  const all = res.rows[0]?.rows || [];
  if (!scoped) return all;
  const meta = await getPjpMeta(sessionId);
  return scopeAttendanceToPjpMonth(all, meta.pjpMinDate, meta.pjpMaxDate);
}

// --- Uploads ---

app.post('/api/upload/attendance', authRequired, upload.single('file'), async (req, res) => {
  try {
    const sessionId = getSessionId(req);
    if (!sessionId) return res.status(400).json({ error: 'Missing X-Session-Id header' });
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    const rawRows = parseAttendanceBuffer(req.file.buffer);
    await ensureSession(sessionId);
    await getPool().query(
      `INSERT INTO attendance_snapshots (session_id, filename, rows, updated_at)
       VALUES ($1, $2, $3::jsonb, NOW())
       ON CONFLICT (session_id) DO UPDATE SET filename = $2, rows = $3::jsonb, updated_at = NOW()`,
      [sessionId, req.file.originalname, JSON.stringify(rawRows)]
    );

    const pjpMeta = await getPjpMeta(sessionId);
    const filteredDate = pickDefaultDate(rawRows, pjpMeta.pjpMinDate, pjpMeta.pjpMaxDate);
    res.json({
      ok: true,
      reload: true,
      sessionId,
      attendanceFileName: req.file.originalname,
      rowCount: rawRows.length,
      filteredDate,
    });
  } catch (err) {
    console.error(err);
    res.status(400).json({ error: err.message || 'Could not parse attendance file' });
  }
});

app.post('/api/upload/pjp', authRequired, upload.single('file'), async (req, res) => {
  try {
    const sessionId = getSessionId(req);
    if (!sessionId) return res.status(400).json({ error: 'Missing X-Session-Id header' });
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    const parsed = parsePjpBuffer(req.file.buffer);
    const meta = {
      pjpMonth: parsed.pjpMonth,
      pjpMinDate: parsed.pjpMinDate,
      pjpMaxDate: parsed.pjpMaxDate,
      pjpEmpCodes: parsed.pjpEmpCodes,
    };

    await ensureSession(sessionId);
    await getPool().query(
      `INSERT INTO pjp_snapshots (session_id, filename, plan_rows, meta, updated_at)
       VALUES ($1, $2, $3::jsonb, $4::jsonb, NOW())
       ON CONFLICT (session_id) DO UPDATE SET filename = $2, plan_rows = $3::jsonb, meta = $4::jsonb, updated_at = NOW()`,
      [sessionId, req.file.originalname, JSON.stringify(parsed.planRows), JSON.stringify(meta)]
    );

    const attRows = await getAttendanceRowsForSession(sessionId);
    const filteredDate = pickDefaultDate(attRows, parsed.pjpMinDate, parsed.pjpMaxDate);
    res.json({
      ok: true,
      reload: true,
      sessionId,
      pjpFileName: req.file.originalname,
      planRowCount: parsed.planRows.length,
      ...meta,
      filteredDate,
    });
  } catch (err) {
    console.error(err);
    res.status(400).json({ error: err.message || 'Could not parse PJP file' });
  }
});

// --- Claims ---

const MAX_BILL_DATA_URL_LEN = 6_000_000;

/** Claims list / rules — never load bill images from PostgreSQL into memory. */
async function loadSlimClaimRows(sessionId, limit = 300) {
  const { rows } = await getPool().query(
    `SELECT (payload - 'billDataUrl') AS payload
     FROM claims WHERE session_id = $1
     ORDER BY created_at DESC
     LIMIT $2`,
    [sessionId, limit]
  );
  return rows.map((r) => r.payload);
}

async function loadSessionClaims(sessionId) {
  return loadSlimClaimRows(sessionId, 300).map(slimClaimForClient);
}

/** Minimal workspace for saving/verifying a claim (no attendance blob, no bill images in memory). */
async function loadWorkspaceForClaimSave(sessionId) {
  await ensureSession(sessionId);
  const pool = getPool();

  const [pjp, claimPayloads] = await Promise.all([
    pool.query(
      `SELECT filename, plan_rows, meta,
        CASE WHEN plan_rows IS NULL THEN 0 ELSE jsonb_array_length(plan_rows) END AS plan_n
       FROM pjp_snapshots WHERE session_id = $1`,
      [sessionId]
    ),
    loadSlimClaimRows(sessionId, 500),
  ]);

  const meta = pjp.rows[0]?.meta || {};
  const planN = Number(pjp.rows[0]?.plan_n) || 0;
  const planRows = planN > 0 && planN <= 12000 ? pjp.rows[0].plan_rows || [] : [];
  const indexes = buildPlanIndexes(planRows);

  return {
    attendanceFileName: null,
    pjpFileName: pjp.rows[0]?.filename || null,
    rawRows: [],
    planRows,
    pjpMonth: meta.pjpMonth || null,
    pjpMinDate: meta.pjpMinDate || null,
    pjpMaxDate: meta.pjpMaxDate || null,
    pjpEmpCodes: meta.pjpEmpCodes || [],
    planByEmpDate: indexes.planByEmpDate,
    planByNameDate: indexes.planByNameDate,
    claims: claimPayloads.map((p) => slimClaimPayload(p)),
  };
}

app.get('/api/claims', authRequired, async (req, res) => {
  try {
    const sessionId = getSessionId(req);
    if (!sessionId) return res.status(400).json({ error: 'Missing X-Session-Id header' });
    res.json({ claims: await loadSessionClaims(sessionId) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/claims/bulk-pdf', authRequired, upload.single('pdf'), async (req, res) => {
  try {
    const sessionId = getSessionId(req);
    if (!sessionId) return res.status(400).json({ error: 'Missing X-Session-Id header' });
    const apiKey = getClientApiKey(req);
    if (!apiKey) {
      return res.status(400).json({
        error: 'Paste your Anthropic API key using the "AI Key" chip in the header.',
      });
    }
    if (!isPdfUpload(req.file)) {
      return res.status(400).json({ error: 'Upload a PDF file.' });
    }
    if (req.file.buffer.length > MAX_PDF_BYTES) {
      const mb = (req.file.buffer.length / (1024 * 1024)).toFixed(1);
      return res.status(400).json({
        error: `PDF is too large (${mb} MB). Maximum is ${MAX_PDF_BYTES / (1024 * 1024)} MB — split into smaller files.`,
      });
    }

    await ensureSession(sessionId);
    const jobId = await createBulkPdfJob(sessionId, req.file.originalname);
    const fileBuffer = req.file.buffer;
    const fileName = req.file.originalname;

    res.status(202).json({ jobId, status: 'queued', message: 'Bulk PDF upload started.' });

    runBulkPdfJob(jobId, { sessionId, apiKey, fileBuffer, fileName }).catch(async (err) => {
      console.error(err);
      await updateBulkPdfJob(jobId, {
        status: 'failed',
        error: err.message || 'Bulk PDF processing failed',
        message: 'Bulk PDF processing failed.',
      });
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || 'Bulk PDF processing failed' });
  }
});

app.get('/api/claims/bulk-pdf/:jobId', authRequired, async (req, res) => {
  try {
    const sessionId = getSessionId(req);
    if (!sessionId) return res.status(400).json({ error: 'Missing X-Session-Id header' });
    const job = await getBulkPdfJob(req.params.jobId);
    if (!job || job.session_id !== sessionId) {
      return res.status(404).json({ error: 'Bulk upload job not found or expired.' });
    }
    res.json(serializeBulkPdfJob(job));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || 'Could not read bulk upload status' });
  }
});

app.post('/api/claims', authRequired, async (req, res) => {
  try {
    const sessionId = getSessionId(req);
    if (!sessionId) return res.status(400).json({ error: 'Missing X-Session-Id header' });

    if (req.body?.billDataUrl && String(req.body.billDataUrl).length > MAX_BILL_DATA_URL_LEN) {
      return res.status(400).json({
        error: 'Bill image is too large. Compress the photo or use a smaller screenshot (max ~4 MB).',
      });
    }

    const workspace = await loadWorkspaceForClaimSave(sessionId);
    const claim = {
      ...req.body,
      id: req.body.id || `CL-${Date.now().toString(36).toUpperCase()}`,
      submittedAt: req.body.submittedAt || new Date().toISOString(),
      verdict: 'pending',
      verdictDetails: null,
      concerns: [],
    };

    const apiKey = getClientApiKey(req);
    const isImage =
      claim.billDataUrl && claim.billMimeType && String(claim.billMimeType).startsWith('image/');
    // Save quickly with rules/registry only — AI/OCR runs via /verify (avoids Render 502 timeouts).
    await processClaim(claim, workspace, sessionId, { apiKey, skipAi: true });

    await ensureSession(sessionId);
    await getPool().query(
      `INSERT INTO claims (id, session_id, payload, created_at, updated_at)
       VALUES ($1, $2, $3::jsonb, NOW(), NOW())`,
      [claim.id, sessionId, JSON.stringify(claim)]
    );

    const clientClaim = {
      ...slimClaimForClient(claim),
      billDataUrl: claim.billDataUrl || null,
    };
    res.status(201).json({ claim: clientClaim, verifySuggested: !!(isImage && apiKey) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || 'Failed to save claim' });
  }
});

app.post('/api/claims/:id/verify', authRequired, async (req, res) => {
  try {
    const sessionId = getSessionId(req);
    if (!sessionId) return res.status(400).json({ error: 'Missing X-Session-Id header' });

    const workspace = await loadWorkspaceForClaimSave(sessionId);
    const row = await getPool().query(
      'SELECT payload FROM claims WHERE id = $1 AND session_id = $2',
      [req.params.id, sessionId]
    );
    if (!row.rows.length) return res.status(404).json({ error: 'Claim not found' });

    const claim = row.rows[0].payload;
    claim.concerns = [];
    claim.validation = null;
    claim.aiError = null;
    claim.ocrError = null;

    await processClaim(claim, workspace, sessionId, { apiKey: getClientApiKey(req) });

    await getPool().query(
      'UPDATE claims SET payload = $1::jsonb, updated_at = NOW() WHERE id = $2 AND session_id = $3',
      [JSON.stringify(claim), claim.id, sessionId]
    );

    res.json({
      claim: {
        ...slimClaimForClient(claim),
        billDataUrl: claim.billDataUrl || null,
      },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || 'Verification failed' });
  }
});

app.delete('/api/claims/:id', authRequired, async (req, res) => {
  try {
    const sessionId = getSessionId(req);
    if (!sessionId) return res.status(400).json({ error: 'Missing X-Session-Id header' });
    await deleteRegistryEntry(getPool(), req.params.id);
    await getPool().query('DELETE FROM claims WHERE id = $1 AND session_id = $2', [
      req.params.id,
      sessionId,
    ]);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/expense/stats', authRequired, async (req, res) => {
  try {
    const sessionId = getSessionId(req);
    if (!sessionId) return res.status(400).json({ error: 'Missing X-Session-Id header' });
    const pool = getPool();
    const { rows: claimRows } = await pool.query(
      `SELECT payload->>'verdict' AS verdict, payload->'validation' AS validation
       FROM claims WHERE session_id = $1`,
      [sessionId]
    );
    const { rows: regCount } = await pool.query('SELECT COUNT(*)::int AS n FROM expense_claim_registry');
    let flagged = 0;
    let collusion = 0;
    let lowOcr = 0;
    let pending = 0;
    for (const r of claimRows) {
      const v = r.verdict;
      if (v === 'pending') pending += 1;
      if (['suspicious', 'collusion', 'review'].includes(v)) flagged += 1;
      if (v === 'collusion') collusion += 1;
      const flags = r.validation?.flags;
      if (Array.isArray(flags) && flags.some((f) => f.code === 'LOW_OCR_CONFIDENCE')) lowOcr += 1;
    }
    res.json({
      totalClaims: claimRows.length,
      registrySize: regCount[0]?.n || 0,
      flagged,
      collusion,
      lowOcr,
      pending,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// --- AI roster review ---

app.post('/api/ai/roster-review', authRequired, async (req, res) => {
  try {
    const apiKey = getClientApiKey(req);
    if (!apiKey) {
      return res.status(400).json({
        error: 'Paste your Anthropic API key using the "AI Key" chip in the header.',
      });
    }
    const { master, days } = req.body;
    if (!master || !days?.length) {
      return res.status(400).json({ error: 'master and days are required' });
    }
    const result = await rosterAiReview({ master, days, apiKey });
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || 'AI review failed' });
  }
});

app.get('/api/auditors', authRequired, (_req, res) => {
  res.json({ auditors: AUDITOR_MASTER });
});

// --- Static frontend (same Render URL) ---

app.use(express.static(ROOT_DIR, { index: false }));

app.get('/', (_req, res) => {
  res.sendFile(path.join(ROOT_DIR, 'index.html'));
});

app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(ROOT_DIR, 'index.html'));
});

async function start() {
  if (!process.env.DATABASE_URL) {
    console.error('FATAL: Set DATABASE_URL (PostgreSQL connection string from Render).');
    process.exit(1);
  }
  await initDb();
  app.listen(PORT, () => {
    console.log(`Sentinel server running on port ${PORT}`);
    console.log('AI: uses API key from browser (AI Key chip) — no ANTHROPIC_API_KEY needed on Render');
    console.log(`Login: ${process.env.APP_PASSWORD ? 'enabled (remove APP_PASSWORD on Render for open access)' : 'disabled'}`);
  });
}

start().catch((err) => {
  console.error('Failed to start:', err);
  process.exit(1);
});
