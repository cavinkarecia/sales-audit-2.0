const { getPool } = require('../db');
const { applyRuleChecks, extractAndVerifyBill, mergeAiVerdict, buildIndexes } = require('./claims');
const { hashBillDataUrl } = require('./ocr');
const { isBillAiVerifiable } = require('./bill-media');
const {
  runExpenseValidationChecks,
  applyValidationFlagsToClaim,
  enrichClaimForValidation,
  loadExpenseRegistry,
  upsertRegistryEntry,
} = require('./expense-validation');

/**
 * Full expense claim pipeline: rules → single-pass OCR+AI → database validation.
 * apiKey comes from the browser (X-Anthropic-Api-Key header), not Render env.
 */
async function processClaim(claim, workspace, sessionId, { apiKey, skipAi = false } = {}) {
  claim.concerns = claim.concerns || [];
  claim.submittedAt = claim.submittedAt || new Date().toISOString();
  claim.verdict = claim.verdict || 'pending';
  claim.billHash = hashBillDataUrl(claim.billDataUrl);

  const key = apiKey && String(apiKey).trim() ? String(apiKey).trim() : null;
  const pool = getPool();
  const registryPromise = loadExpenseRegistry(pool, claim.id);

  const indexes = buildIndexes(workspace.planRows);
  applyRuleChecks(claim, {
    rawRows: workspace.rawRows,
    planByEmpDate: workspace.planByEmpDate,
    pjpEmpCodes: new Set(workspace.pjpEmpCodes),
    existingClaims: workspace.claims.filter((c) => c.id !== claim.id),
  });

  const canProcessBill = isBillAiVerifiable(claim);
  const canAi = !skipAi && key && canProcessBill;

  if (canAi) {
    try {
      const [{ ocr, aiResult }, registry] = await Promise.all([
        extractAndVerifyBill(claim, key),
        registryPromise,
      ]);
      claim.ocr = ocr;
      if (ocr) {
        claim.detectedVendor = ocr.vendor;
        claim.detectedAmount = ocr.billAmount;
        claim.detectedDate = ocr.billDate;
        claim.detectedTransactionId = ocr.transactionId;
      }
      enrichClaimForValidation(claim);
      runExpenseValidationChecks(claim, registry);
      applyValidationFlagsToClaim(claim);

      claim.aiResult = aiResult;
      mergeAiVerdict(claim);
      applyValidationFlagsToClaim(claim);
    } catch (err) {
      claim.aiError = err.message;
      claim.ocrError = err.message;
      claim.concerns.push(`Bill analysis failed: ${err.message}`);
      const registry = await registryPromise;
      enrichClaimForValidation(claim);
      runExpenseValidationChecks(claim, registry);
      applyValidationFlagsToClaim(claim);
      if (claim.verdict === 'pending' || claim.verdict === 'genuine') claim.verdict = 'review';
      claim.verdictDetails =
        claim.verdictDetails ||
        `Bill could not be verified by AI (${err.message}). Rule-based checks still applied.`;
    }
  } else {
    const registry = await registryPromise;
    enrichClaimForValidation(claim);
    runExpenseValidationChecks(claim, registry);
    applyValidationFlagsToClaim(claim);

    if (!claim.billDataUrl) {
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
  }

  if (claim.verdict === 'pending') claim.verdict = 'review';

  await upsertRegistryEntry(pool, claim, sessionId);
  return claim;
}

module.exports = { processClaim };
