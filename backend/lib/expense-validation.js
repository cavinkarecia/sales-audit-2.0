const { normalizeTransactionId, hashBillDataUrl } = require('./ocr');
const { isBillAiVerifiable } = require('./bill-media');

const TIME_WINDOW_MS = (parseInt(process.env.CLAIM_TIME_WINDOW_MINUTES, 10) || 10) * 60 * 1000;
const BILL_MAX_AGE_DAYS = parseInt(process.env.BILL_MAX_AGE_DAYS, 10) || 3;
const OCR_CONFIDENCE_THRESHOLD = parseFloat(process.env.OCR_CONFIDENCE_THRESHOLD || '0.72');

function getLocationKey(claim) {
  if (claim.ocr?.billLocation) {
    return String(claim.ocr.billLocation).toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 80) || null;
  }
  if (claim.geo?.detectedCity) {
    return String(claim.geo.detectedCity).toLowerCase().replace(/[^a-z0-9]/g, '');
  }
  if (claim.geo?.gpsLat != null && claim.geo?.gpsLng != null) {
    return `gps_${claim.geo.gpsLat.toFixed(2)}_${claim.geo.gpsLng.toFixed(2)}`;
  }
  return null;
}

function enrichClaimForValidation(claim) {
  claim.billHash = claim.billHash || hashBillDataUrl(claim.billDataUrl);
  if (claim.ocr?.transactionId && !claim.ocr.transactionIdNorm) {
    claim.ocr.transactionIdNorm = normalizeTransactionId(claim.ocr.transactionId);
  }
  claim.locationKey = getLocationKey(claim);
  return claim;
}

/**
 * Run all expense fraud checks against the global registry.
 * @param {object} claim - current claim (mutated with validation block)
 * @param {Array} registry - rows from expense_claim_registry
 */
function runExpenseValidationChecks(claim, registry) {
  const flags = [];
  const submittedAt = new Date(claim.submittedAt).getTime();
  const locationKey = claim.locationKey || getLocationKey(claim);
  const txnNorm = claim.ocr?.transactionIdNorm || null;
  const billHash = claim.billHash || null;
  const billAmount = claim.ocr?.billAmount ?? null;

  const others = registry.filter((r) => r.claim_id !== claim.id);

  // 8 — OCR confidence below threshold → manual review
  if (claim.ocr && claim.ocr.confidence != null && claim.ocr.confidence < OCR_CONFIDENCE_THRESHOLD) {
    flags.push({
      code: 'LOW_OCR_CONFIDENCE',
      severity: 'review',
      message: `OCR confidence ${(claim.ocr.confidence * 100).toFixed(0)}% is below threshold ${(OCR_CONFIDENCE_THRESHOLD * 100).toFixed(0)}% — route to manual review.`,
    });
  }

  if (!claim.ocr && claim.billDataUrl && isBillAiVerifiable(claim)) {
    flags.push({
      code: 'OCR_MISSING',
      severity: 'review',
      message: 'Bill attached but OCR extraction failed or was skipped.',
    });
  }

  // 6 — ±10 minute window matches
  const inWindow = others.filter((r) => {
    const t = new Date(r.submitted_at).getTime();
    return Math.abs(t - submittedAt) <= TIME_WINDOW_MS;
  });

  // Location conflict: two different agents, same location, same window
  if (locationKey) {
    const locationConflicts = inWindow.filter(
      (r) => r.auditor_code !== claim.auditorCode && r.location_key && r.location_key === locationKey
    );
    if (locationConflicts.length) {
      flags.push({
        code: 'LOCATION_CONFLICT',
        severity: 'suspicious',
        message: `Another agent (${locationConflicts.map((r) => r.auditor_name || r.auditor_code).join(', ')}) claimed from the same location (${claim.ocr?.billLocation || claim.geo?.detectedCity || locationKey}) within the time window.`,
        relatedClaimIds: locationConflicts.map((r) => r.claim_id),
      });
    }
  }

  // Transaction ID checks (7 — normalized comparison)
  if (txnNorm) {
    const txnMatches = others.filter((r) => r.transaction_id_norm === txnNorm);

    // 3 — Duplicate transaction ID
    if (txnMatches.length) {
      flags.push({
        code: 'DUPLICATE_TRANSACTION_ID',
        severity: 'suspicious',
        message: `Transaction ID "${claim.ocr?.transactionId || txnNorm}" already used in claim(s): ${txnMatches.map((r) => r.claim_id).join(', ')}.`,
        relatedClaimIds: txnMatches.map((r) => r.claim_id),
      });
    }

    // 9 — Amount tampering: same txn ID, different amount
    const tampering = txnMatches.filter((r) => {
      if (r.bill_amount == null || billAmount == null) return false;
      return Math.abs(Number(r.bill_amount) - Number(billAmount)) > 1;
    });
    if (tampering.length) {
      flags.push({
        code: 'AMOUNT_TAMPERING',
        severity: 'suspicious',
        message: `Same transaction ID with different bill amount (this claim ₹${billAmount} vs existing ₹${tampering[0].bill_amount}).`,
        relatedClaimIds: tampering.map((r) => r.claim_id),
      });
    }

    // 10 — Collusion: same txn ID linked to 2+ agents
    const agentSet = new Set([claim.auditorCode, ...txnMatches.map((r) => r.auditor_code)]);
    if (agentSet.size >= 2) {
      flags.push({
        code: 'COLLUSION',
        severity: 'collusion',
        message: `Transaction ID linked to ${agentSet.size} different agents — escalated as collusion.`,
        relatedClaimIds: txnMatches.map((r) => r.claim_id),
        relatedAgents: [...agentSet],
      });
    }
  }

  // 4 — Full duplicate: same window, different agent, same location, same bill image
  if (billHash && locationKey) {
    const fullDupes = inWindow.filter(
      (r) =>
        r.auditor_code !== claim.auditorCode &&
        r.location_key === locationKey &&
        r.bill_hash &&
        r.bill_hash === billHash
    );
    if (fullDupes.length) {
      flags.push({
        code: 'FULL_DUPLICATE_CLAIM',
        severity: 'suspicious',
        message: `Same bill image and location submitted by another agent (${fullDupes.map((r) => r.auditor_name || r.auditor_code).join(', ')}) in the same time window.`,
        relatedClaimIds: fullDupes.map((r) => r.claim_id),
      });
    }
  }

  // 5 — Bill date older than 3 days from claim date
  if (claim.ocr?.billDate && claim.date) {
    const billDate = new Date(claim.ocr.billDate);
    const claimDate = new Date(claim.date);
    if (!Number.isNaN(billDate.getTime()) && !Number.isNaN(claimDate.getTime())) {
      const diffDays = (claimDate.getTime() - billDate.getTime()) / 86400000;
      if (diffDays > BILL_MAX_AGE_DAYS) {
        flags.push({
          code: 'STALE_BILL_DATE',
          severity: 'suspicious',
          message: `Bill date ${claim.ocr.billDate} is ${Math.floor(diffDays)} days before claim date ${claim.date} (max allowed gap: ${BILL_MAX_AGE_DAYS} days).`,
        });
      }
    }
  }

  claim.validation = {
    flags,
    checksRun: [
      'location_conflict',
      'duplicate_transaction_id',
      'full_duplicate_claim',
      'bill_date_vs_claim_date',
      'time_window_matching',
      'transaction_id_normalization',
      'ocr_confidence_threshold',
      'amount_tampering',
      'collusion_detection',
    ],
    config: {
      timeWindowMinutes: TIME_WINDOW_MS / 60000,
      billMaxAgeDays: BILL_MAX_AGE_DAYS,
      ocrConfidenceThreshold: OCR_CONFIDENCE_THRESHOLD,
    },
  };

  return flags;
}

function applyValidationFlagsToClaim(claim) {
  const flags = claim.validation?.flags || [];
  if (!flags.length) return claim;

  for (const f of flags) {
    const prefix =
      f.severity === 'collusion' ? '🚨 COLLUSION' : f.severity === 'suspicious' ? '⚠ FLAG' : 'ℹ REVIEW';
    claim.concerns.push(`${prefix} [${f.code}]: ${f.message}`);
  }

  const hasCollusion = flags.some((f) => f.severity === 'collusion');
  const hasSuspicious = flags.some((f) => f.severity === 'suspicious');
  const hasReview = flags.some((f) => f.severity === 'review');
  const rank = { genuine: 0, review: 1, suspicious: 2, collusion: 3 };
  let v = claim.verdict || 'review';
  if (hasReview && rank[v] < rank.review) v = 'review';
  if (hasSuspicious && rank[v] < rank.suspicious) v = 'suspicious';
  if (hasCollusion) v = 'collusion';

  if (flags.some((f) => f.code === 'LOW_OCR_CONFIDENCE') && v === 'genuine') v = 'review';

  claim.verdict = v;
  if (!claim.verdictDetails) {
    claim.verdictDetails = flags.map((f) => f.message).join(' ');
  }
  return claim;
}

async function loadExpenseRegistry(pool, excludeClaimId = null) {
  let sql = 'SELECT * FROM expense_claim_registry';
  const params = [];
  if (excludeClaimId) {
    sql += ' WHERE claim_id <> $1';
    params.push(excludeClaimId);
  }
  sql += ' ORDER BY submitted_at DESC LIMIT 1500';
  const { rows } = await pool.query(sql, params);
  return rows;
}

async function upsertRegistryEntry(pool, claim, sessionId) {
  const txnNorm = claim.ocr?.transactionIdNorm || null;
  await pool.query(
    `INSERT INTO expense_claim_registry (
      claim_id, session_id, auditor_code, auditor_name, submitted_at, claim_date,
      transaction_id_raw, transaction_id_norm, location_key, bill_hash,
      bill_amount, claimed_amount, ocr_confidence
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
    ON CONFLICT (claim_id) DO UPDATE SET
      submitted_at = EXCLUDED.submitted_at,
      transaction_id_raw = EXCLUDED.transaction_id_raw,
      transaction_id_norm = EXCLUDED.transaction_id_norm,
      location_key = EXCLUDED.location_key,
      bill_hash = EXCLUDED.bill_hash,
      bill_amount = EXCLUDED.bill_amount,
      claimed_amount = EXCLUDED.claimed_amount,
      ocr_confidence = EXCLUDED.ocr_confidence`,
    [
      claim.id,
      sessionId,
      claim.auditorCode,
      claim.auditorName,
      claim.submittedAt,
      claim.date,
      claim.ocr?.transactionId || null,
      txnNorm,
      claim.locationKey || getLocationKey(claim),
      claim.billHash || null,
      claim.ocr?.billAmount ?? null,
      claim.amount,
      claim.ocr?.confidence ?? null,
    ]
  );
}

async function deleteRegistryEntry(pool, claimId) {
  await pool.query('DELETE FROM expense_claim_registry WHERE claim_id = $1', [claimId]);
}

module.exports = {
  runExpenseValidationChecks,
  applyValidationFlagsToClaim,
  enrichClaimForValidation,
  loadExpenseRegistry,
  upsertRegistryEntry,
  deleteRegistryEntry,
  getLocationKey,
  OCR_CONFIDENCE_THRESHOLD,
  TIME_WINDOW_MS,
  BILL_MAX_AGE_DAYS,
};
