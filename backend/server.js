require('dotenv').config();

const path = require('path');
const crypto = require('crypto');
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const session = require('express-session');
const cookieParser = require('cookie-parser');

const { initDb, getPool, ensureSession } = require('./db');
const AUDITOR_MASTER = require('./data/auditors');
const { parseAttendanceBuffer, parsePjpBuffer, buildPlanIndexes, pickDefaultDate } = require('./lib/excel');
const { dateKey } = require('./lib/utils');
const { rosterAiReview } = require('./lib/claims');
const { processClaim } = require('./lib/claim-processor');
const { extractBillsFromBulkPdf, buildClaimFromExtractedBill } = require('./lib/bulk-pdf');
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

async function runBulkPdfJob(jobId, { sessionId, apiKey, fileBuffer, fileName }) {
  try {
    await updateBulkPdfJob(jobId, {
      status: 'scanning',
      message: 'AI scanning PDF for bills…',
    });

    const workspace = await loadWorkspace(sessionId);
    const pdfBase64 = fileBuffer.toString('base64');
    const pdfHash = crypto.createHash('sha256').update(fileBuffer).digest('hex');
    const pdfMeta = { fileName, pdfHash };

    const { bills: rows, partial } = await extractBillsFromBulkPdf(pdfBase64, apiKey);
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
    for (let i = 0; i < rows.length; i += 1) {
      const claim = buildClaimFromExtractedBill(rows[i], pdfMeta, i);
      const workspaceForClaim = {
        ...workspace,
        claims: workspace.claims,
      };
      await processClaim(claim, workspaceForClaim, sessionId, { apiKey, skipAi: true });
      await ensureSession(sessionId);
      await getPool().query(
        `INSERT INTO claims (id, session_id, payload, created_at, updated_at)
         VALUES ($1, $2, $3::jsonb, NOW(), NOW())`,
        [claim.id, sessionId, JSON.stringify(claim)]
      );
      workspace.claims.unshift(claim);
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

  const rawRows = att.rows[0]?.rows || [];
  const planRows = pjp.rows[0]?.plan_rows || [];
  const meta = pjp.rows[0]?.meta || {};
  const indexes = buildPlanIndexes(planRows);

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
    claims: claimsRes.rows.map((r) => r.payload),
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
    planByEmpDate: workspace.planByEmpDate,
    planByNameDate: workspace.planByNameDate,
    filteredDate: defaultDate,
    claims: workspace.claims,
    aiKeySource: process.env.ANTHROPIC_API_KEY ? 'server' : 'browser',
    hasServerApiKey: !!process.env.ANTHROPIC_API_KEY,
    authRequired: false,
  };
}

// --- Public / auth routes ---

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'sentinel-backend', build: '2026.06.8-main2' });
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
      return res.json({ ...buildStatePayload(await loadWorkspace(sessionId), null), sessionId });
    }
    const workspace = await loadWorkspace(sessionId);
    res.json({ ...buildStatePayload(workspace, req.query.filteredDate || null), sessionId });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || 'Failed to load state' });
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

    const workspace = await loadWorkspace(sessionId);
    const filteredDate = pickDefaultDate(rawRows, workspace.pjpMinDate, workspace.pjpMaxDate);
    res.json({ ...buildStatePayload({ ...workspace, rawRows, attendanceFileName: req.file.originalname }, filteredDate), sessionId });
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

    const indexes = buildPlanIndexes(parsed.planRows);
    const workspace = await loadWorkspace(sessionId);
    const filteredDate = pickDefaultDate(workspace.rawRows, parsed.pjpMinDate, parsed.pjpMaxDate);
    res.json({
      ...buildStatePayload(
        {
          ...workspace,
          planRows: parsed.planRows,
          pjpFileName: req.file.originalname,
          ...meta,
          ...indexes,
        },
        filteredDate
      ),
      sessionId,
    });
  } catch (err) {
    console.error(err);
    res.status(400).json({ error: err.message || 'Could not parse PJP file' });
  }
});

// --- Claims ---

app.get('/api/claims', authRequired, async (req, res) => {
  try {
    const sessionId = getSessionId(req);
    if (!sessionId) return res.status(400).json({ error: 'Missing X-Session-Id header' });
    const workspace = await loadWorkspace(sessionId);
    res.json({ claims: workspace.claims });
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

    await ensureSession(sessionId);
    const jobId = await createBulkPdfJob(sessionId, req.file.originalname);
    const fileBuffer = Buffer.from(req.file.buffer);
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

    const workspace = await loadWorkspace(sessionId);
    const claim = {
      ...req.body,
      id: req.body.id || `CL-${Date.now().toString(36).toUpperCase()}`,
      submittedAt: req.body.submittedAt || new Date().toISOString(),
      verdict: 'pending',
      verdictDetails: null,
      concerns: [],
    };

    await processClaim(claim, workspace, sessionId, { apiKey: getClientApiKey(req) });

    await ensureSession(sessionId);
    await getPool().query(
      `INSERT INTO claims (id, session_id, payload, created_at, updated_at)
       VALUES ($1, $2, $3::jsonb, NOW(), NOW())`,
      [claim.id, sessionId, JSON.stringify(claim)]
    );

    res.status(201).json({ claim });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || 'Failed to save claim' });
  }
});

app.post('/api/claims/:id/verify', authRequired, async (req, res) => {
  try {
    const sessionId = getSessionId(req);
    if (!sessionId) return res.status(400).json({ error: 'Missing X-Session-Id header' });

    const workspace = await loadWorkspace(sessionId);
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

    res.json({ claim });
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

app.get('/api/expense/stats', authRequired, async (_req, res) => {
  try {
    const pool = getPool();
    const registry = await loadExpenseRegistry(pool);
    const { rows: claimRows } = await pool.query('SELECT payload FROM claims');
    const claims = claimRows.map((r) => r.payload);
    const flagged = claims.filter((c) =>
      ['suspicious', 'collusion', 'review'].includes(c.verdict)
    ).length;
    const collusion = claims.filter((c) => c.verdict === 'collusion').length;
    const lowOcr = claims.filter(
      (c) => c.validation?.flags?.some((f) => f.code === 'LOW_OCR_CONFIDENCE')
    ).length;
    res.json({
      totalClaims: claims.length,
      registrySize: registry.length,
      flagged,
      collusion,
      lowOcr,
      pending: claims.filter((c) => c.verdict === 'pending').length,
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
    console.log(`Login: ${process.env.APP_PASSWORD ? 'enabled' : 'disabled (set APP_PASSWORD for production)'}`);
  });
}

start().catch((err) => {
  console.error('Failed to start:', err);
  process.exit(1);
});
