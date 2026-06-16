const crypto = require('crypto');
const { callAnthropic, parseJsonFromModel } = require('./anthropic');
const { buildBillAnthropicContent } = require('./bill-media');

const OCR_PROMPT = `You are an OCR engine for Indian expense receipts and travel bills (image, PDF, or spreadsheet export).
Extract every visible field from the bill with high accuracy.

Respond ONLY with JSON (no markdown):
{
  "transactionId": "raw transaction / invoice / booking / UPI ref as printed, or null",
  "billDate": "YYYY-MM-DD or null",
  "billAmount": number or null,
  "vendor": "establishment name or null",
  "billLocation": "city or address on bill or null",
  "ocrConfidence": number between 0 and 1 (your confidence in the extraction overall),
  "rawTextSnippet": "short excerpt of key lines read from the bill"
}`;

async function extractBillOcr(claim, apiKey) {
  if (!claim.billDataUrl) return null;

  const text = await callAnthropic({
    apiKey,
    maxTokens: 800,
    userContent: buildBillAnthropicContent(claim, OCR_PROMPT),
  });

  const parsed = parseJsonFromModel(text);
  return normalizeOcrResult(parsed);
}

function normalizeOcrResult(raw) {
  if (!raw || typeof raw !== 'object') return null;
  let confidence = parseFloat(raw.ocrConfidence);
  if (Number.isNaN(confidence)) confidence = 0.5;
  confidence = Math.max(0, Math.min(1, confidence));

  return {
    transactionId: raw.transactionId ? String(raw.transactionId).trim() : null,
    transactionIdNorm: normalizeTransactionId(raw.transactionId),
    billDate: raw.billDate ? String(raw.billDate).slice(0, 10) : null,
    billAmount: raw.billAmount != null ? Number(raw.billAmount) : null,
    vendor: raw.vendor ? String(raw.vendor).trim() : null,
    billLocation: raw.billLocation ? String(raw.billLocation).trim() : null,
    confidence,
    rawTextSnippet: raw.rawTextSnippet ? String(raw.rawTextSnippet).slice(0, 500) : null,
    extractedAt: new Date().toISOString(),
  };
}

function normalizeTransactionId(value) {
  if (value == null || value === '') return null;
  const s = String(value).toLowerCase().replace(/[^a-z0-9]/g, '');
  return s.length >= 4 ? s : null;
}

function hashBillDataUrl(dataUrl) {
  if (!dataUrl) return null;
  const m = dataUrl.match(/^data:[^;]+;base64,(.+)$/);
  const payload = m ? m[1] : dataUrl;
  return crypto.createHash('sha256').update(payload).digest('hex');
}

module.exports = {
  extractBillOcr,
  normalizeOcrResult,
  normalizeTransactionId,
  hashBillDataUrl,
};
