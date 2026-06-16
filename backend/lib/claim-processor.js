const { getPool } = require('../db');
const { applyRuleChecks, verifyClaimWithAI, mergeAiVerdict, buildIndexes } = require('./claims');
const { extractBillOcr, hashBillDataUrl } = require('./ocr');
const { isBillAiVerifiable } = require('./bill-media');
const {
  runExpenseValidationChecks,
  applyValidationFlagsToClaim,
  enrichClaimForValidation,
  loadExpenseRegistry,
  upsertRegistryEntry,
} = require('./expense-validation');

/**
 * Full expense claim pipeline: rules → OCR → database validation → AI vision.
 * apiKey comes from the browser (X-Anthropic-Api-Key header), not Render env.
 */
async function processClaim(claim, workspace, sessionId, { apiKey, skipAi = false } = {}) {
  claim.concerns = claim.concerns || [];
  claim.submittedAt = claim.submittedAt || new Date().toISOString();
  claim.verdict = claim.verdict || 'pending';
  claim.billHash = hashBillDataUrl(claim.billDataUrl);

  const key = apiKey && String(apiKey).trim() ? String(apiKey).trim() : null;

  const indexes = buildIndexes(workspace.planRows);
  applyRuleChecks(claim, {
    rawRows: workspace.rawRows,
    planByEmpDate: workspace.planByEmpDate,
    pjpEmpCodes: new Set(workspace.pjpEmpCodes),
    existingClaims: workspace.claims.filter((c) => c.id !== claim.id),
  });

  const canProcessBill = isBillAiVerifiable(claim);

  if (canProcessBill && key) {
    try {
      claim.ocr = await extractBillOcr(claim, key);
      if (claim.ocr) {
        claim.detectedVendor = claim.ocr.vendor;
        claim.detectedAmount = claim.ocr.billAmount;
        claim.detectedDate = claim.ocr.billDate;
        claim.detectedTransactionId = claim.ocr.transactionId;
      }
    } catch (err) {
      claim.ocrError = err.message;
      claim.concerns.push(`OCR extraction failed: ${err.message}`);
    }
  }

  enrichClaimForValidation(claim);

  const pool = getPool();
  const registry = await loadExpenseRegistry(pool, claim.id);
  runExpenseValidationChecks(claim, registry);
  applyValidationFlagsToClaim(claim);

  const canAi = !skipAi && key && canProcessBill;
  if (canAi) {
    try {
      claim.aiResult = await verifyClaimWithAI(claim, key);
      mergeAiVerdict(claim);
      applyValidationFlagsToClaim(claim);
    } catch (err) {
      claim.aiError = err.message;
      if (claim.verdict === 'pending' || claim.verdict === 'genuine') claim.verdict = 'review';
      const aiNote = `Bill could not be verified by AI (${err.message}). Rule-based and OCR checks still applied.`;
      claim.verdictDetails = claim.verdictDetails ? `${claim.verdictDetails} ${aiNote}` : aiNote;
    }
  } else if (!claim.billDataUrl) {
    if (claim.verdict === 'pending') claim.verdict = 'review';
    claim.verdictDetails =
      claim.verdictDetails ||
      'No bill attached — OCR and AI skipped. Validation used rules and registry checks only.';
  } else if (!canProcessBill) {
    if (claim.verdict === 'pending') claim.verdict = 'review';
    claim.verdictDetails =
      claim.verdictDetails ||
      'Unsupported bill format — use PDF, image (JPG/PNG), or Excel.';
  } else if (!key) {
    if (claim.verdict === 'pending') claim.verdict = 'review';
    claim.verdictDetails =
      claim.verdictDetails ||
      'Paste your Anthropic API key using the "AI Key" chip in the header to enable bill OCR and AI verification.';
  }

  if (claim.verdict === 'pending') claim.verdict = 'review';

  await upsertRegistryEntry(pool, claim, sessionId);
  return claim;
}

module.exports = { processClaim };
