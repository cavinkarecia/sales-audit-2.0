const AUDITOR_MASTER = require('../data/auditors');
const { buildAuditorIndex, findAuditor, dateKey } = require('./utils');
const { haversineKm, resolveCityCoords, nearestCityName } = require('./geo');
const { callAnthropic, parseJsonFromModel } = require('./anthropic');
const { buildBillAnthropicContent } = require('./bill-media');
const { normalizeOcrResult } = require('./ocr');

const DA_CAPS = { metro: 525, non_metro: 450 };
const auditorIndex = buildAuditorIndex(AUDITOR_MASTER);

function buildIndexes(planRows) {
  const planByEmpDate = {};
  const planByNameDate = {};
  const { normalizeName } = require('./utils');
  for (const plan of planRows) {
    if (plan.empCode) planByEmpDate[`${plan.empCode}|${plan.dateKey}`] = plan;
    if (plan.empName) planByNameDate[`${normalizeName(plan.empName)}|${plan.dateKey}`] = plan;
  }
  return { planByEmpDate, planByNameDate, pjpEmpCodes: new Set(planRows.map((p) => p.empCode).filter(Boolean)) };
}

function applyRuleChecks(claim, ctx) {
  const { rawRows, planByEmpDate, pjpEmpCodes, existingClaims } = ctx;
  claim.concerns = claim.concerns || [];

  if (claim.category === 'DA') {
    const cap = DA_CAPS[claim.cityType];
    if (claim.amount > cap) {
      claim.concerns.push(
        `Amount ₹${claim.amount} exceeds ${claim.cityType === 'metro' ? 'metro' : 'non-metro'} DA cap of ₹${cap}.`
      );
    }
  }

  const dupes = existingClaims.filter(
    (c) =>
      c.id !== claim.id &&
      c.auditorCode === claim.auditorCode &&
      c.date === claim.date &&
      c.subcategory === claim.subcategory &&
      Math.abs(c.amount - claim.amount) <= Math.max(10, claim.amount * 0.05)
  );
  if (dupes.length) {
    claim.concerns.push(`Possible duplicate: a similar claim (${dupes[0].id}) was already submitted on the same date.`);
  }

  let plannedTown = null;
  let plannedCoords = null;
  if (claim.category === 'TA') {
    const plan = planByEmpDate[`${claim.auditorCode}|${claim.date}`];
    if (plan) {
      const planSaysTravel =
        plan.workType &&
        /Travel Day|Market Visit/i.test(plan.workType) &&
        plan.fromTown &&
        plan.toTown &&
        (require('./utils').normalizeName(plan.fromTown) !== require('./utils').normalizeName(plan.toTown) ||
          /Travel Day/i.test(plan.workType));
      if (!planSaysTravel) {
        claim.concerns.push(`PJP shows no travel planned on ${claim.date} (work type: ${plan.workType || 'none'}).`);
      }
      if (claim.subcategory === 'accommodation' && plan.hotelStay !== true) {
        claim.concerns.push(`PJP does not show a planned hotel stay on ${claim.date}.`);
      }
      plannedTown = plan.toTown;
      plannedCoords = plan.toTown ? resolveCityCoords(plan.toTown) : null;
    } else if (pjpEmpCodes.size > 0) {
      claim.concerns.push(`No PJP entry for this auditor on ${claim.date}.`);
    }
  } else if (claim.category === 'DA') {
    const plan = planByEmpDate[`${claim.auditorCode}|${claim.date}`];
    if (plan && plan.toTown) {
      plannedTown = plan.toTown;
      plannedCoords = resolveCityCoords(plan.toTown);
    }
  }

  const attendanceRow = rawRows.find((r) => {
    const d = r.date ? dateKey(new Date(r.date)) : null;
    const master = findAuditor(r.auditor, r.auditorId, AUDITOR_MASTER, auditorIndex);
    return d === claim.date && master && master.empCode === claim.auditorCode;
  });

  if (attendanceRow) {
    if (!attendanceRow.onField && claim.category === 'TA' && claim.subcategory !== 'cab') {
      claim.concerns.push(
        `Auditor was marked absent (${attendanceRow.absentReason || 'no reason'}) on the claim date.`
      );
    }
  }

  const claimDateObj = new Date(claim.date);
  const daysSince = (Date.now() - claimDateObj.getTime()) / (1000 * 60 * 60 * 24);
  if (daysSince > 60) {
    claim.concerns.push(
      `Claim submitted ${Math.round(daysSince)} days after the expense — outside typical reimbursement window.`
    );
  }
  if (daysSince < -1) claim.concerns.push('Claim date is in the future.');

  const master = AUDITOR_MASTER.find((a) => a.empCode === claim.auditorCode);
  if (attendanceRow && attendanceRow.location && master) {
    const gps = attendanceRow.location;
    const distFromHome =
      master.lat != null ? haversineKm(master.lat, master.lng, gps.lat, gps.lng) : null;
    const distFromPlannedTown = plannedCoords
      ? haversineKm(plannedCoords.lat, plannedCoords.lng, gps.lat, gps.lng)
      : null;
    const detectedCity = nearestCityName(gps.lat, gps.lng) || `${gps.lat.toFixed(3)}, ${gps.lng.toFixed(3)}`;

    claim.geo = {
      gpsLat: gps.lat,
      gpsLng: gps.lng,
      detectedCity,
      distFromHome,
      distFromPlannedTown,
      plannedTown,
      onField: attendanceRow.onField,
    };

    const isAtHome = distFromHome != null && distFromHome <= 5;
    const isFarFromPlan = distFromPlannedTown != null && distFromPlannedTown > 30;
    const requiresFieldPresence =
      (claim.category === 'TA' && ['bus', 'cab', 'train', 'flight'].includes(claim.subcategory)) ||
      (claim.category === 'DA' && ['food', 'cash', 'daily'].includes(claim.subcategory));

    if (requiresFieldPresence) {
      if (isAtHome) {
        claim.concerns.push(
          `⚠ GEOFENCE: Auditor was at home base (${detectedCity}, ${distFromHome.toFixed(1)} km from hometown) on the claim date — not in the field. Claiming ${claim.subcategoryLabel} without being on field.`
        );
      } else if (plannedCoords && isFarFromPlan) {
        claim.concerns.push(
          `⚠ GEOFENCE: GPS shows auditor in ${detectedCity}, but PJP planned ${plannedTown} (${distFromPlannedTown.toFixed(0)} km away). Location does not match planned audit site.`
        );
      } else if (claim.category === 'DA' && claim.subcategory === 'food' && !attendanceRow.onField) {
        claim.concerns.push(
          `⚠ GEOFENCE: Claiming food/DA on a day marked as absent (${attendanceRow.absentReason || 'no reason'}).`
        );
      }
    }
    if (claim.subcategory === 'accommodation' && isAtHome) {
      claim.concerns.push(`⚠ GEOFENCE: Hotel claim but GPS shows auditor was at home base on ${claim.date}.`);
    }
  } else if (attendanceRow && !attendanceRow.location) {
    claim.concerns.push('Attendance row has no GPS coordinates — geofence verification skipped.');
  } else if (!attendanceRow) {
    claim.concerns.push(`No attendance submission found for ${claim.date} — cannot verify if auditor was in the field.`);
  }

  return claim;
}

function buildVerifyGeoBlock(claim) {
  if (!claim.geo) return '';
  return `

Field-presence verification (geofencing) for ${claim.date}:
- GPS detected location: ${claim.geo.detectedCity}
- Distance from auditor's home base (${claim.homeBase}): ${claim.geo.distFromHome != null ? `${claim.geo.distFromHome.toFixed(1)} km` : 'unknown'}
${claim.geo.plannedTown ? `- Distance from planned audit town (${claim.geo.plannedTown}): ${claim.geo.distFromPlannedTown != null ? `${claim.geo.distFromPlannedTown.toFixed(1)} km` : 'unknown'}` : '- No planned town in PJP'}
- Attendance status: ${claim.geo.onField ? 'On field' : 'Off field / absent'}
`;
}

function buildCombinedBillPrompt(claim) {
  return `You are an expense bill OCR and verification engine for Indian reimbursement claims (image, PDF, or spreadsheet).

In ONE pass, extract all visible bill fields AND verify the bill against the claim below.

Claim details:
- Auditor: ${claim.auditorName} (${claim.auditorCode})
- Home base: ${claim.homeBase}
- Expense date: ${claim.date}
- Category: ${claim.category === 'TA' ? 'Travel Allowance' : 'Daily Allowance'} — ${claim.subcategoryLabel}
- Claimed amount: ₹${claim.amount}
- City type: ${claim.cityType === 'metro' ? 'Metro' : 'Non-metro'}
${claim.reason ? `- Reason for external booking: ${claim.reason}` : ''}
${claim.notes ? `- Notes: ${claim.notes}` : ''}${buildVerifyGeoBlock(claim)}

Respond ONLY with JSON (no markdown):
{
  "transactionId": "raw transaction / invoice / UPI ref as printed, or null",
  "billDate": "YYYY-MM-DD or null",
  "billAmount": number or null,
  "vendor": "establishment name or null",
  "billLocation": "city or address on bill or null",
  "ocrConfidence": number between 0 and 1,
  "rawTextSnippet": "short excerpt of key lines",
  "billType": "train_ticket | flight_ticket | bus_ticket | hotel_invoice | restaurant_receipt | cab_receipt | other",
  "dateMatches": true | false | null,
  "amountMatches": true | false | null,
  "typeMatches": true | false,
  "locationConsistent": true | false | null,
  "tamperingIndicators": [],
  "concerns": [],
  "overallVerdict": "genuine | review | suspicious",
  "reasoning": "1-2 sentence explanation"
}

Rules:
- "dateMatches" true only if bill date matches expense date ${claim.date}.
- "amountMatches" true only if bill total is within ₹10 of ₹${claim.amount}.
- "typeMatches" true only if bill type matches ${claim.subcategoryLabel}.
- "locationConsistent" false if geofencing shows auditor at home (≤5 km from base) while claiming field expenses, or GPS >30 km from planned audit town.
- Mark "suspicious" for tampering, clear mismatches, or locationConsistent false.
- Mark "genuine" only when everything aligns.`;
}

function splitCombinedBillResult(raw) {
  if (!raw || typeof raw !== 'object') {
    throw new Error('AI returned invalid bill analysis JSON');
  }
  const ocr = normalizeOcrResult({
    transactionId: raw.transactionId,
    billDate: raw.billDate,
    billAmount: raw.billAmount,
    vendor: raw.vendor,
    billLocation: raw.billLocation,
    ocrConfidence: raw.ocrConfidence,
    rawTextSnippet: raw.rawTextSnippet,
  });
  const aiResult = {
    billDate: raw.billDate ?? null,
    billAmount: raw.billAmount != null ? Number(raw.billAmount) : null,
    vendor: raw.vendor ?? null,
    transactionId: raw.transactionId ?? null,
    billType: raw.billType ?? null,
    dateMatches: raw.dateMatches ?? null,
    amountMatches: raw.amountMatches ?? null,
    typeMatches: raw.typeMatches ?? null,
    locationConsistent: raw.locationConsistent ?? null,
    tamperingIndicators: Array.isArray(raw.tamperingIndicators) ? raw.tamperingIndicators : [],
    concerns: Array.isArray(raw.concerns) ? raw.concerns : [],
    overallVerdict: raw.overallVerdict || 'review',
    reasoning: raw.reasoning || null,
  };
  return { ocr, aiResult };
}

/** Single vision call: OCR extraction + verification (faster than two separate API calls). */
async function extractAndVerifyBill(claim, apiKey) {
  if (!claim.billDataUrl) throw new Error('No bill attached');
  const text = await callAnthropic({
    apiKey,
    maxTokens: 1400,
    userContent: buildBillAnthropicContent(claim, buildCombinedBillPrompt(claim)),
  });
  return splitCombinedBillResult(parseJsonFromModel(text));
}

async function verifyClaimWithAI(claim, apiKey) {
  if (!claim.billDataUrl) throw new Error('No bill attached');
  const { aiResult } = await extractAndVerifyBill(claim, apiKey);
  return aiResult;
}

function mergeAiVerdict(claim) {
  const ai = claim.aiResult;
  if (!ai) return claim;

  if (ai.concerns?.length) claim.concerns.push(...ai.concerns);
  if (ai.tamperingIndicators?.length) {
    claim.concerns.push(`AI detected possible tampering: ${ai.tamperingIndicators.join('; ')}`);
  }
  if (ai.dateMatches === false) {
    claim.concerns.push(`Bill date does not match claim date (bill: ${ai.billDate || 'unknown'}, claim: ${claim.date}).`);
  }
  if (ai.amountMatches === false) {
    claim.concerns.push(`Bill amount ₹${ai.billAmount ?? '?'} does not match claimed ₹${claim.amount}.`);
  }
  if (ai.typeMatches === false) {
    claim.concerns.push(`Bill type (${ai.billType}) does not match claimed sub-category (${claim.subcategoryLabel}).`);
  }
  if (ai.locationConsistent === false) {
    claim.concerns.push('AI confirms GPS location is inconsistent with this claim (auditor not at the field site).');
  }

  const aiVerdict = ai.overallVerdict || 'review';
  const hasGeofenceFlag = claim.concerns.some((c) => /GEOFENCE|geofenc|at home base/i.test(c));
  const rank = { genuine: 0, review: 1, suspicious: 2, collusion: 3 };
  let finalVerdict = aiVerdict;
  if (hasGeofenceFlag) finalVerdict = 'suspicious';
  if (claim.concerns.length >= 3 && rank[finalVerdict] < rank.review) finalVerdict = 'review';
  if (claim.concerns.length >= 5) finalVerdict = 'suspicious';
  if (claim.verdict === 'collusion') finalVerdict = 'collusion';

  claim.verdict = finalVerdict;
  if (ai.transactionId && !claim.detectedTransactionId) claim.detectedTransactionId = ai.transactionId;
  claim.verdictDetails = ai.reasoning || null;
  return claim;
}

async function rosterAiReview({ master, days, apiKey }) {
  const summary = days
    .map((d) => {
      const dev = d.deviationKm != null ? ` (${d.deviationKm.toFixed(0)} km off)` : '';
      return `${d.dateLabel} ${d.day}: planned ${d.plannedTown || d.plan?.workType || 'no plan'} | actual ${d.actualCity || (d.actual ? (d.actual.onField ? 'on field' : `absent (${d.actual.absentReason || '?'})`) : 'no submission')}${dev} → ${d.status}`;
    })
    .join('\n');

  const prompt = `You are a sales audit compliance reviewer. Below is the 30-day plan-vs-actual movement of one field auditor. Analyze adherence to the planned journey plan (PJP) and identify patterns of concern.

Auditor: ${master.name} (${master.empCode}) · Cluster: ${master.cluster} · Home base: ${master.hometown}

Day-by-day data (planned location | actual location | deviation | status):
${summary}

Respond ONLY with a JSON object in this exact shape (no markdown, no preamble):
{
  "complianceVerdict": "excellent | good | concerning | poor",
  "headline": "One-sentence summary suitable for a manager",
  "patterns": [],
  "highRiskDays": [],
  "recommendations": []
}`;

  const text = await callAnthropic({ apiKey, maxTokens: 1024, userContent: prompt });
  return parseJsonFromModel(text);
}

module.exports = {
  applyRuleChecks,
  verifyClaimWithAI,
  extractAndVerifyBill,
  mergeAiVerdict,
  rosterAiReview,
  buildIndexes,
  DA_CAPS,
};
