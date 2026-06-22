const crypto = require('crypto');
const { getPool } = require('../db');

async function createBulkPdfJob(sessionId, fileName, jobType = 'bulk') {
  const jobId = crypto.randomUUID();
  await getPool().query(
    `INSERT INTO bulk_pdf_jobs (id, session_id, status, message, file_name, job_type)
     VALUES ($1, $2, 'queued', 'Upload received — starting…', $3, $4)`,
    [jobId, sessionId, fileName, jobType]
  );
  return jobId;
}

async function updateBulkPdfJob(jobId, patch = {}) {
  const fields = [];
  const values = [];
  let i = 1;

  const allowed = {
    status: 'status',
    message: 'message',
    error: 'error',
    detected: 'detected',
    result_count: 'resultCount',
    partial: 'partial',
    warning: 'warning',
    audit_result: 'auditResult',
  };

  for (const [col, key] of Object.entries(allowed)) {
    if (patch[key] !== undefined) {
      fields.push(`${col} = $${i++}`);
      values.push(patch[key]);
    }
  }

  if (!fields.length) return getBulkPdfJob(jobId);

  fields.push('updated_at = NOW()');
  values.push(jobId);

  await getPool().query(
    `UPDATE bulk_pdf_jobs SET ${fields.join(', ')} WHERE id = $${i}`,
    values
  );
  return getBulkPdfJob(jobId);
}

async function getBulkPdfJob(jobId) {
  const { rows } = await getPool().query('SELECT * FROM bulk_pdf_jobs WHERE id = $1', [jobId]);
  return rows[0] || null;
}

function serializeBulkPdfJob(row) {
  if (!row) return null;
  return {
    jobId: row.id,
    status: row.status,
    message: row.message,
    error: row.error,
    detected: row.detected,
    count: row.result_count,
    partial: row.partial,
    warning: row.warning,
    fileName: row.file_name,
    jobType: row.job_type || 'bulk',
    auditResult: row.audit_result || null,
    updatedAt: row.updated_at,
  };
}

module.exports = {
  createBulkPdfJob,
  updateBulkPdfJob,
  getBulkPdfJob,
  serializeBulkPdfJob,
};
