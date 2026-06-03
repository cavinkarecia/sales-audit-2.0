const AUDITOR_MASTER = require('../data/auditors');
const { callAnthropic, parseJsonFromModel } = require('./anthropic');

const BILL_TYPE_TO_SUB = {
  train_ticket: { category: 'TA', subcategory: 'train', label: 'Train' },
  flight_ticket: { category: 'TA', subcategory: 'flight', label: 'Flight' },
  bus_ticket: { category: 'TA', subcategory: 'bus', label: 'Bus' },
  hotel_invoice: { category: 'TA', subcategory: 'accommodation', label: 'Accommodation / Hotel' },
  cab_receipt: { category: 'TA', subcategory: 'cab', label: 'Cab / Auto / Local transport' },
  restaurant_receipt: { category: 'DA', subcategory: 'food', label: 'Food / Meals' },
  other: { category: 'TA', subcategory: 'cab', label: 'Cab / Auto / Local transport' },
};

function resolveAuditor(nameOrCode) {
  const q = String(nameOrCode || '').trim().toLowerCase();
  if (!q) return null;
  let m = AUDITOR_MASTER.find((a) => a.empCode.toLowerCase() === q);
  if (m) return m;
  m = AUDITOR_MASTER.find((a) => a.name.toLowerCase() === q);
  if (m) return m;
  m = AUDITOR_MASTER.find((a) => {
    const n = a.name.toLowerCase();
    return n.includes(q) || q.includes(n);
  });
  return m || null;
}

function normalizeIsoDate(raw) {
  if (!raw) return '';
  const s = String(raw).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const d = new Date(s);
  if (!Number.isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  return '';
}

async function extractBillsFromBulkPdf(pdfBase64, apiKey) {
  const roster = AUDITOR_MASTER.map((a) => `${a.empCode}: ${a.name} (${a.cluster})`).join('\n');

  const prompt = `You are an expense OCR agent. This PDF may contain multiple reimbursement bills from different field sales auditors.

Known auditors (match by employee code or name):
${roster}

Extract EVERY distinct bill/receipt. Respond ONLY with JSON:
{
  "bills": [
    {
      "auditorName": "string",
      "auditorCode": "emp code or null",
      "expenseDate": "YYYY-MM-DD",
      "expenseTime": "HH:MM or null",
      "category": "TA or DA",
      "subcategory": "train|flight|bus|accommodation|cab|food|cash|daily",
      "billType": "train_ticket|flight_ticket|bus_ticket|hotel_invoice|cab_receipt|restaurant_receipt|other",
      "amount": number,
      "billDate": "YYYY-MM-DD or null",
      "billTime": "HH:MM or null",
      "billAmount": number or null,
      "vendor": "string or null",
      "cityType": "metro|non_metro",
      "pageHint": "page or section"
    }
  ]
}`;

  const text = await callAnthropic({
    apiKey,
    maxTokens: 4096,
    userContent: [
      { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdfBase64 } },
      { type: 'text', text: prompt },
    ],
  });

  const parsed = parseJsonFromModel(text);
  if (!parsed.bills || !Array.isArray(parsed.bills)) {
    throw new Error('AI did not return a bills array from the PDF.');
  }
  return parsed.bills;
}

function buildClaimFromExtractedBill(row, pdfMeta) {
  const mapped = BILL_TYPE_TO_SUB[row.billType] || BILL_TYPE_TO_SUB.other;
  const category = row.category === 'DA' ? 'DA' : mapped.category;
  const subcategory = row.subcategory || mapped.subcategory;
  const auditor = resolveAuditor(row.auditorCode || row.auditorName);
  const date = normalizeIsoDate(row.expenseDate || row.billDate) || new Date().toISOString().slice(0, 10);
  const amount = Number(row.amount || row.billAmount) || 0;

  return {
    id: `CL-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 5)}`,
    submittedAt: new Date().toISOString(),
    auditorCode: auditor?.empCode || row.auditorCode || 'UNKNOWN',
    auditorName: auditor?.name || row.auditorName || 'Unknown auditor',
    cluster: auditor?.cluster || '',
    homeBase: auditor?.hometown || '',
    date,
    category,
    subcategory,
    subcategoryLabel: mapped.label,
    amount,
    cityType: row.cityType === 'metro' ? 'metro' : 'non_metro',
    reason: '',
    notes: row.pageHint ? `Bulk PDF · ${row.pageHint}` : `Bulk PDF · ${pdfMeta.fileName}`,
    billFileName: pdfMeta.fileName,
    billDataUrl: pdfMeta.dataUrl,
    billMimeType: 'application/pdf',
    verdict: 'pending',
    verdictDetails: null,
    concerns: [],
    bulkImport: true,
    receiptTime: row.billTime || row.expenseTime || null,
    detectedVendor: row.vendor || null,
    detectedAmount: row.billAmount != null ? row.billAmount : null,
    detectedDate: row.billDate || null,
  };
}

module.exports = {
  extractBillsFromBulkPdf,
  buildClaimFromExtractedBill,
};
