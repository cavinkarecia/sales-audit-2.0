const { callAnthropic, parseJsonFromModel } = require('./anthropic');

const MAX_PDF_BYTES = 12 * 1024 * 1024;

const AUDIT_PROMPT = `You are an expense reimbursement auditor for Indian field sales teams.

The attached PDF is typically a reimbursement sheet with:
- Embedded photos/scans of receipts or tickets (bus, train, hotel, food, cab, etc.)
- Handwritten or typed summary rows (e.g. "Bus Travel: 496", "local convenience: 100", "Total: 596")
- A sheet date (often highlighted)

Your job:
1. Extract EVERY distinct receipt/invoice image visible in the PDF.
2. Extract EVERY claimed line item from summary tables or totals on the sheet (not just receipts).
3. Detect FALSE or UNSUPPORTED claims — e.g. a line item amount with NO matching receipt, or totals that do not add up.
4. Flag date mismatches between sheet date and receipt dates.

Respond ONLY with valid JSON (no markdown):
{
  "sheetDate": "YYYY-MM-DD or null",
  "auditorName": "string or null",
  "invoices": [
    {
      "id": "inv-1",
      "date": "YYYY-MM-DD",
      "amount": 191,
      "vendor": "MSRTC or establishment name",
      "billType": "bus_ticket|train_ticket|flight_ticket|hotel_invoice|restaurant_receipt|cab_receipt|other",
      "pageHint": "page 1 / top-left",
      "confidence": 0.0 to 1.0
    }
  ],
  "claimedLines": [
    {
      "id": "line-1",
      "label": "Bus Travel",
      "amount": 496,
      "hasReceiptSupport": true,
      "matchedInvoiceIds": ["inv-1", "inv-2"],
      "notes": "optional short note"
    }
  ],
  "totalClaimed": 596,
  "totalReceiptAmount": 496,
  "discrepancies": [
    {
      "type": "unsupported_claim|total_mismatch|date_mismatch|missing_receipt|amount_mismatch",
      "severity": "suspicious|review",
      "message": "Human-readable explanation",
      "claimedLabel": "local convenience",
      "claimedAmount": 100,
      "receiptAmount": null,
      "highlightDate": "YYYY-MM-DD or null",
      "relatedInvoiceIds": [],
      "relatedClaimLineIds": ["line-2"]
    }
  ],
  "overallVerdict": "genuine|review|suspicious",
  "reasoning": "1-3 sentence summary for the approver"
}

Rules:
- Sum all invoice amounts into totalReceiptAmount.
- Sum all claimed line amounts (or use explicit Total row) into totalClaimed.
- hasReceiptSupport is false when a claimed line has no receipts that plausibly cover it.
- Flag unsupported_claim when a category amount has zero matching receipts.
- Flag total_mismatch when totalClaimed differs from totalReceiptAmount by more than ₹10.
- Mark suspicious if any unsupported claim or total mismatch > ₹10.
- Assign stable ids inv-1, inv-2… and line-1, line-2…
- Read amounts from receipt images even if in Marathi/Hindi/English.`;

async function analyzeMultiInvoicePdfBuffer(buffer, apiKey) {
  if (!buffer || !buffer.length) throw new Error('Empty PDF upload.');
  if (buffer.length > MAX_PDF_BYTES) {
    const mb = (buffer.length / (1024 * 1024)).toFixed(1);
    throw new Error(`PDF is too large (${mb} MB). Maximum is ${MAX_PDF_BYTES / (1024 * 1024)} MB.`);
  }
  const pdfBase64 = buffer.toString('base64');

  const { text, stopReason } = await callAnthropic({
    apiKey,
    maxTokens: 16384,
    withMeta: true,
    userContent: [
      { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdfBase64 } },
      { type: 'text', text: AUDIT_PROMPT },
    ],
  });

  const parsed = parseJsonFromModel(text);
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('AI did not return a valid audit result.');
  }
  if (stopReason === 'max_tokens') {
    parsed._partial = true;
  }
  return normalizeAuditResult(parsed);
}

function normalizeAuditResult(raw) {
  const invoices = Array.isArray(raw.invoices) ? raw.invoices.map((inv, i) => ({
    id: inv.id || `inv-${i + 1}`,
    date: inv.date ? String(inv.date).slice(0, 10) : null,
    amount: inv.amount != null ? Number(inv.amount) : null,
    vendor: inv.vendor ? String(inv.vendor).trim() : null,
    billType: inv.billType || 'other',
    pageHint: inv.pageHint ? String(inv.pageHint) : null,
    confidence: inv.confidence != null ? Math.max(0, Math.min(1, Number(inv.confidence))) : null,
  })) : [];

  const claimedLines = Array.isArray(raw.claimedLines) ? raw.claimedLines.map((line, i) => ({
    id: line.id || `line-${i + 1}`,
    label: line.label ? String(line.label).trim() : `Line ${i + 1}`,
    amount: line.amount != null ? Number(line.amount) : null,
    hasReceiptSupport: line.hasReceiptSupport !== false,
    matchedInvoiceIds: Array.isArray(line.matchedInvoiceIds) ? line.matchedInvoiceIds : [],
    notes: line.notes ? String(line.notes) : null,
  })) : [];

  const receiptSum = invoices.reduce((s, inv) => s + (inv.amount || 0), 0);
  const claimedSum = claimedLines.reduce((s, l) => s + (l.amount || 0), 0);
  const totalClaimed = raw.totalClaimed != null ? Number(raw.totalClaimed) : claimedSum;
  const totalReceiptAmount = raw.totalReceiptAmount != null ? Number(raw.totalReceiptAmount) : receiptSum;

  const discrepancies = Array.isArray(raw.discrepancies) ? raw.discrepancies.map((d) => ({
    type: d.type || 'unsupported_claim',
    severity: d.severity === 'review' ? 'review' : 'suspicious',
    message: d.message ? String(d.message) : 'Discrepancy detected',
    claimedLabel: d.claimedLabel || null,
    claimedAmount: d.claimedAmount != null ? Number(d.claimedAmount) : null,
    receiptAmount: d.receiptAmount != null ? Number(d.receiptAmount) : null,
    highlightDate: d.highlightDate ? String(d.highlightDate).slice(0, 10) : null,
    relatedInvoiceIds: Array.isArray(d.relatedInvoiceIds) ? d.relatedInvoiceIds : [],
    relatedClaimLineIds: Array.isArray(d.relatedClaimLineIds) ? d.relatedClaimLineIds : [],
  })) : [];

  // Deterministic checks to supplement AI
  if (Math.abs(totalClaimed - totalReceiptAmount) > 10 && !discrepancies.some((d) => d.type === 'total_mismatch')) {
    discrepancies.push({
      type: 'total_mismatch',
      severity: 'suspicious',
      message: `Total claimed ₹${totalClaimed} differs from sum of receipts ₹${totalReceiptAmount} by ₹${Math.abs(totalClaimed - totalReceiptAmount).toFixed(0)}.`,
      claimedLabel: 'Total',
      claimedAmount: totalClaimed,
      receiptAmount: totalReceiptAmount,
      highlightDate: raw.sheetDate ? String(raw.sheetDate).slice(0, 10) : null,
      relatedInvoiceIds: invoices.map((i) => i.id),
      relatedClaimLineIds: claimedLines.map((l) => l.id),
    });
  }

  for (const line of claimedLines) {
    if (!line.hasReceiptSupport && line.amount > 0) {
      if (!discrepancies.some((d) => d.relatedClaimLineIds?.includes(line.id))) {
        discrepancies.push({
          type: 'unsupported_claim',
          severity: 'suspicious',
          message: `"${line.label}" ₹${line.amount} has no matching receipt in the PDF.`,
          claimedLabel: line.label,
          claimedAmount: line.amount,
          receiptAmount: null,
          highlightDate: raw.sheetDate ? String(raw.sheetDate).slice(0, 10) : null,
          relatedInvoiceIds: [],
          relatedClaimLineIds: [line.id],
        });
      }
    }
  }

  let overallVerdict = ['genuine', 'review', 'suspicious'].includes(raw.overallVerdict)
    ? raw.overallVerdict
    : 'review';
  if (discrepancies.some((d) => d.severity === 'suspicious')) overallVerdict = 'suspicious';
  else if (discrepancies.length && overallVerdict === 'genuine') overallVerdict = 'review';

  return {
    sheetDate: raw.sheetDate ? String(raw.sheetDate).slice(0, 10) : null,
    auditorName: raw.auditorName ? String(raw.auditorName).trim() : null,
    invoices,
    claimedLines,
    totalClaimed,
    totalReceiptAmount,
    discrepancies,
    overallVerdict,
    reasoning: raw.reasoning ? String(raw.reasoning) : null,
    partial: !!raw._partial,
  };
}

function buildClaimFromAudit(audit, pdfMeta) {
  const suffix = Date.now().toString(36).toUpperCase();
  const concerns = audit.discrepancies.map((d) => d.message);
  const date = audit.sheetDate || new Date().toISOString().slice(0, 10);

  return {
    id: `CL-${suffix}`,
    submittedAt: new Date().toISOString(),
    auditorCode: 'MULTI',
    auditorName: audit.auditorName || 'Multi-invoice sheet',
    cluster: '',
    homeBase: '',
    date,
    category: 'TA',
    subcategory: 'bus',
    subcategoryLabel: 'Multi-invoice PDF',
    amount: audit.totalClaimed || 0,
    cityType: 'non_metro',
    reason: '',
    notes: `Multi-invoice audit · ${pdfMeta.fileName} · ${audit.invoices.length} receipts detected`,
    billFileName: pdfMeta.fileName,
    billHash: pdfMeta.pdfHash || null,
    billMimeType: 'application/pdf',
    verdict: audit.overallVerdict || 'review',
    verdictDetails: audit.reasoning || `Receipts total ₹${audit.totalReceiptAmount} vs claimed ₹${audit.totalClaimed}.`,
    concerns,
    multiInvoiceAudit: true,
    auditResult: audit,
    detectedVendor: audit.invoices[0]?.vendor || null,
    detectedAmount: audit.totalReceiptAmount,
    detectedDate: audit.sheetDate,
  };
}

module.exports = {
  MAX_PDF_BYTES,
  analyzeMultiInvoicePdfBuffer,
  normalizeAuditResult,
  buildClaimFromAudit,
};
