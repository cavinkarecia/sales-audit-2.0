const XLSX = require('xlsx');

function parseBillDataUrl(dataUrl) {
  if (!dataUrl) return null;
  const m = String(dataUrl).match(/^data:([^;]+);base64,(.+)$/s);
  if (!m) return null;
  return { mediaType: m[1].trim(), base64: m[2] };
}

function resolveBillMime(claim) {
  const parsed = parseBillDataUrl(claim.billDataUrl);
  let mediaType = String(claim.billMimeType || parsed?.mediaType || '').trim();
  const fileName = String(claim.billFileName || '').toLowerCase();

  if (!mediaType || mediaType === 'application/octet-stream') {
    if (fileName.endsWith('.pdf')) mediaType = 'application/pdf';
    else if (/\.(jpe?g)$/.test(fileName)) mediaType = 'image/jpeg';
    else if (fileName.endsWith('.png')) mediaType = 'image/png';
    else if (fileName.endsWith('.webp')) mediaType = 'image/webp';
    else if (fileName.endsWith('.gif')) mediaType = 'image/gif';
    else if (/\.xlsx?$/.test(fileName)) {
      mediaType = fileName.endsWith('.xls')
        ? 'application/vnd.ms-excel'
        : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    } else if (fileName.endsWith('.csv')) mediaType = 'text/csv';
  }

  return {
    mediaType,
    base64: parsed?.base64 || null,
    fileName: claim.billFileName || null,
  };
}

function isSpreadsheetMime(mediaType, fileName = '') {
  const fn = String(fileName).toLowerCase();
  return (
    /spreadsheet|excel|csv|sheet|ms-excel/i.test(mediaType) ||
    /\.(xlsx?|csv)$/i.test(fn)
  );
}

function isPdfMime(mediaType, fileName = '') {
  return mediaType === 'application/pdf' || String(fileName).toLowerCase().endsWith('.pdf');
}

function isImageMime(mediaType) {
  return String(mediaType).startsWith('image/');
}

/** Whether OCR / AI vision can process this bill attachment. */
function isBillAiVerifiable(claim) {
  if (!claim?.billDataUrl) return false;
  const { mediaType, fileName } = resolveBillMime(claim);
  return isImageMime(mediaType) || isPdfMime(mediaType, fileName) || isSpreadsheetMime(mediaType, fileName);
}

function excelBase64ToTextSummary(base64, maxRows = 60) {
  const buf = Buffer.from(base64, 'base64');
  const wb = XLSX.read(buf, { type: 'buffer', cellDates: true, raw: false });
  const lines = [];
  for (const sheetName of wb.SheetNames.slice(0, 4)) {
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { defval: '', header: 1 });
    lines.push(`--- Sheet: ${sheetName} ---`);
    for (const row of rows.slice(0, maxRows)) {
      if (!Array.isArray(row)) continue;
      const cells = row.map((c) => (c == null ? '' : String(c).replace(/\s+/g, ' ').trim()));
      if (cells.some((c) => c)) lines.push(cells.join('\t'));
    }
  }
  return lines.join('\n').slice(0, 14000);
}

/**
 * Build Anthropic message content for a bill: image, PDF document, or Excel as text.
 */
function buildBillAnthropicContent(claim, textPrompt) {
  const parsed = parseBillDataUrl(claim.billDataUrl);
  if (!parsed?.base64) throw new Error('Invalid bill file data');

  const { mediaType, fileName } = resolveBillMime(claim);
  const content = [];

  if (isPdfMime(mediaType, fileName)) {
    content.push({
      type: 'document',
      source: { type: 'base64', media_type: 'application/pdf', data: parsed.base64 },
    });
  } else if (isImageMime(mediaType)) {
    content.push({
      type: 'image',
      source: { type: 'base64', media_type: mediaType, data: parsed.base64 },
    });
  } else if (isSpreadsheetMime(mediaType, fileName)) {
    const tableText = excelBase64ToTextSummary(parsed.base64);
    content.push({
      type: 'text',
      text: `The attached reimbursement file is a spreadsheet. Tab-separated export:\n\n${tableText}`,
    });
  } else {
    throw new Error(
      `Unsupported bill type (${mediaType || 'unknown'}). Upload PDF, JPG, PNG, WEBP, or Excel (.xlsx/.xls/.csv).`
    );
  }

  content.push({ type: 'text', text: textPrompt });
  return content;
}

module.exports = {
  parseBillDataUrl,
  resolveBillMime,
  isBillAiVerifiable,
  isImageMime,
  isPdfMime,
  isSpreadsheetMime,
  excelBase64ToTextSummary,
  buildBillAnthropicContent,
};
