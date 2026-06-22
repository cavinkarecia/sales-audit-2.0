CREATE TABLE IF NOT EXISTS workspace_sessions (
  id TEXT PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS attendance_snapshots (
  session_id TEXT PRIMARY KEY REFERENCES workspace_sessions(id) ON DELETE CASCADE,
  filename TEXT,
  rows JSONB NOT NULL DEFAULT '[]',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS pjp_snapshots (
  session_id TEXT PRIMARY KEY REFERENCES workspace_sessions(id) ON DELETE CASCADE,
  filename TEXT,
  plan_rows JSONB NOT NULL DEFAULT '[]',
  meta JSONB NOT NULL DEFAULT '{}',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS claims (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES workspace_sessions(id) ON DELETE CASCADE,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_claims_session ON claims(session_id);

-- Global index for cross-auditor expense validation (all sessions)
CREATE TABLE IF NOT EXISTS expense_claim_registry (
  claim_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  auditor_code TEXT NOT NULL,
  auditor_name TEXT,
  submitted_at TIMESTAMPTZ NOT NULL,
  claim_date DATE NOT NULL,
  transaction_id_raw TEXT,
  transaction_id_norm TEXT,
  location_key TEXT,
  bill_hash TEXT,
  bill_amount NUMERIC,
  claimed_amount NUMERIC,
  ocr_confidence REAL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_registry_txn ON expense_claim_registry(transaction_id_norm)
  WHERE transaction_id_norm IS NOT NULL AND transaction_id_norm <> '';
CREATE INDEX IF NOT EXISTS idx_registry_submitted ON expense_claim_registry(submitted_at);
CREATE INDEX IF NOT EXISTS idx_registry_location_time ON expense_claim_registry(location_key, submitted_at)
  WHERE location_key IS NOT NULL AND location_key <> '';
CREATE INDEX IF NOT EXISTS idx_registry_bill_hash ON expense_claim_registry(bill_hash)
  WHERE bill_hash IS NOT NULL;

CREATE TABLE IF NOT EXISTS bulk_pdf_jobs (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES workspace_sessions(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'queued',
  message TEXT,
  error TEXT,
  file_name TEXT,
  detected INTEGER,
  result_count INTEGER,
  partial BOOLEAN NOT NULL DEFAULT FALSE,
  warning TEXT,
  job_type TEXT NOT NULL DEFAULT 'bulk',
  audit_result JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_bulk_pdf_jobs_session ON bulk_pdf_jobs(session_id);

ALTER TABLE bulk_pdf_jobs ADD COLUMN IF NOT EXISTS job_type TEXT NOT NULL DEFAULT 'bulk';
ALTER TABLE bulk_pdf_jobs ADD COLUMN IF NOT EXISTS audit_result JSONB;
