const crypto = require('crypto');
const { getPool } = require('../db');

function noticeKey(auditorCode, deviationDate) {
  return `${String(auditorCode).trim()}|${String(deviationDate).slice(0, 10)}`;
}

const NOTICE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function isNoticeExpired(notice) {
  if (!notice?.expiresAt) return false;
  return new Date(notice.expiresAt).getTime() <= Date.now();
}

async function listNoticesForSession(sessionId, deviationDate) {
  const pool = getPool();
  let q = `SELECT * FROM pjp_deviation_notices WHERE session_id = $1`;
  const params = [sessionId];
  if (deviationDate) {
    q += ` AND deviation_date = $2`;
    params.push(String(deviationDate).slice(0, 10));
  }
  q += ` ORDER BY created_at DESC`;
  const { rows } = await pool.query(q, params);
  return rows.map(serializeNotice);
}

async function getNoticeByToken(token) {
  const { rows } = await getPool().query(
    'SELECT * FROM pjp_deviation_notices WHERE response_token = $1',
    [token]
  );
  const notice = rows[0] ? serializeNotice(rows[0]) : null;
  if (notice && isNoticeExpired(notice) && notice.status !== 'responded') {
    return { ...notice, expired: true };
  }
  return notice;
}

async function createOrRefreshNotice(sessionId, payload) {
  const pool = getPool();
  const deviationDate = String(payload.deviationDate).slice(0, 10);
  const auditorCode = String(payload.auditorCode).trim();

  const existing = await pool.query(
    `SELECT * FROM pjp_deviation_notices
     WHERE session_id = $1 AND auditor_code = $2 AND deviation_date = $3
     ORDER BY created_at DESC LIMIT 1`,
    [sessionId, auditorCode, deviationDate]
  );

  if (existing.rows.length && existing.rows[0].status === 'responded') {
    const row = existing.rows[0];
    return { notice: serializeNotice(row), created: false, alreadyResponded: true };
  }

  const id = existing.rows[0]?.id || `PN-${Date.now().toString(36).toUpperCase()}`;
  const responseToken = existing.rows[0]?.response_token || crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + NOTICE_TTL_MS).toISOString();

  const fields = {
    id,
    session_id: sessionId,
    response_token: responseToken,
    auditor_code: auditorCode,
    auditor_name: payload.auditorName || auditorCode,
    cluster: payload.cluster || null,
    deviation_date: deviationDate,
    planned_town: payload.plannedTown || null,
    distributor_name: payload.distributorName || null,
    current_location: payload.currentLocation || null,
    dist_pjp_km: payload.distPjpKm != null ? Number(payload.distPjpKm) : null,
    followed_label: payload.followedLabel || 'No',
    status: 'pending',
    reason_text: existing.rows[0]?.reason_text || null,
    responded_at: existing.rows[0]?.responded_at || null,
    expires_at: expiresAt,
  };

  await pool.query(
    `INSERT INTO pjp_deviation_notices (
      id, session_id, response_token, auditor_code, auditor_name, cluster,
      deviation_date, planned_town, distributor_name, current_location, dist_pjp_km, followed_label,
      status, reason_text, responded_at, expires_at, updated_at
    ) VALUES (
      $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, NOW()
    )
    ON CONFLICT (id) DO UPDATE SET
      auditor_name = EXCLUDED.auditor_name,
      cluster = EXCLUDED.cluster,
      planned_town = EXCLUDED.planned_town,
      distributor_name = EXCLUDED.distributor_name,
      current_location = EXCLUDED.current_location,
      dist_pjp_km = EXCLUDED.dist_pjp_km,
      followed_label = EXCLUDED.followed_label,
      expires_at = EXCLUDED.expires_at,
      status = CASE
        WHEN pjp_deviation_notices.status = 'responded' THEN pjp_deviation_notices.status
        ELSE EXCLUDED.status
      END,
      updated_at = NOW()`,
    [
      fields.id,
      fields.session_id,
      fields.response_token,
      fields.auditor_code,
      fields.auditor_name,
      fields.cluster,
      fields.deviation_date,
      fields.planned_town,
      fields.distributor_name,
      fields.current_location,
      fields.dist_pjp_km,
      fields.followed_label,
      fields.status,
      fields.reason_text,
      fields.responded_at,
      fields.expires_at,
    ]
  );

  const { rows } = await pool.query('SELECT * FROM pjp_deviation_notices WHERE id = $1', [id]);
  return { notice: serializeNotice(rows[0]), created: true, alreadyResponded: false };
}

async function saveNoticeResponse(token, reasonText) {
  const text = String(reasonText || '').trim();
  if (!text || text.length < 5) {
    throw new Error('Please enter a reason (at least 5 characters).');
  }
  const existing = await getNoticeByToken(token);
  if (!existing) throw new Error('Notice not found or link expired.');
  if (existing.expired) throw new Error('This notice has expired. Ask your manager to send a new WhatsApp notification.');
  if (existing.status === 'responded') return existing;

  const { rows } = await getPool().query(
    `UPDATE pjp_deviation_notices
     SET reason_text = $2, status = 'responded', responded_at = NOW(), updated_at = NOW()
     WHERE response_token = $1 AND status <> 'responded'
     RETURNING *`,
    [token, text.slice(0, 2000)]
  );
  if (!rows.length) {
    throw new Error('Notice not found or link expired.');
  }
  return serializeNotice(rows[0]);
}

async function markWhatsAppSent(noticeId, delivery = 'manual') {
  await getPool().query(
    `UPDATE pjp_deviation_notices
     SET whatsapp_sent_at = NOW(), whatsapp_delivery = $2, updated_at = NOW()
     WHERE id = $1`,
    [noticeId, delivery]
  );
}

async function deleteNoticesForSession(sessionId) {
  await getPool().query('DELETE FROM pjp_deviation_notices WHERE session_id = $1', [sessionId]);
}

function serializeNotice(row) {
  if (!row) return null;
  return {
    id: row.id,
    sessionId: row.session_id,
    responseToken: row.response_token,
    auditorCode: row.auditor_code,
    auditorName: row.auditor_name,
    cluster: row.cluster,
    deviationDate: row.deviation_date
      ? String(row.deviation_date).slice(0, 10)
      : row.deviation_date,
    plannedTown: row.planned_town,
    distributorName: row.distributor_name,
    currentLocation: row.current_location,
    distPjpKm: row.dist_pjp_km != null ? Number(row.dist_pjp_km) : null,
    followedLabel: row.followed_label,
    status: row.status,
    reasonText: row.reason_text,
    whatsappSentAt: row.whatsapp_sent_at,
    whatsappDelivery: row.whatsapp_delivery,
    respondedAt: row.responded_at,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

module.exports = {
  noticeKey,
  NOTICE_TTL_MS,
  isNoticeExpired,
  listNoticesForSession,
  getNoticeByToken,
  createOrRefreshNotice,
  saveNoticeResponse,
  markWhatsAppSent,
  deleteNoticesForSession,
  serializeNotice,
};
