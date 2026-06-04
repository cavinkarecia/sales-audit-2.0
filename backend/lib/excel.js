const XLSX = require('xlsx');
const {
  parseLocation,
  parseExcelDate,
  dateKey,
  parseKms,
  parseYesNo,
  serializeDate,
} = require('./utils');

function normalizeRow(r) {
  const loc = parseLocation(r.Location || r.location || r.GPS);
  const date = parseExcelDate(
    r['Choose Date'] || r['Date Collected'] || r['Choose date'] || r.Date || r.date
  );
  return {
    id: r.ID,
    date: serializeDate(date),
    auditor: r['Choose Your Name'] || r['Auditor Name'] || r.auditor || r['Employee Name'],
    auditorId: r.User,
    onField: r['Are You on field Today?'] === 'Yes',
    asPerPlan: r["Is today's audit as per planned?"],
    absentReason: r['Absent Reason'],
    distributorCode: r['Distributor Code'],
    distributorName: r['Distributor Name'],
    newDistributorName: r['New Distributor Name'],
    asm: r['ASM Name'],
    newAsm: r['New ASM Name'],
    sde: r['SDE Name'],
    salesman: r['Salesman Name'],
    beat: r['Beat Name'],
    totalShops: r['Total Shops in Beat'] || r['Total Shops in New Beat'] || 0,
    location: loc,
  };
}

function normalizePlanRow(r, sheetName) {
  const dateVal = r['Date '] || r.Date;
  const date = parseExcelDate(dateVal);
  return {
    sheet: sheetName,
    date: serializeDate(date),
    dateKey: dateKey(date),
    day: r.Day,
    empCode: r['Employee Code'] != null ? String(r['Employee Code']).replace(/\.0$/, '') : null,
    empName: r['Employee Name'],
    workType: r['Work Type'] ? String(r['Work Type']).trim() : null,
    state: r.State,
    fromTown: r['From Town Name'],
    toTown: r['To Town Name'],
    kms: parseKms(r['Kms Travelled']),
    hotelStay: parseYesNo(r['Hotel Stay (yes/No)']),
    asm: r['ASM Name'],
    sde: r['SDE Name'],
    plannedRsCode: r['Planned RS Code'] != null ? String(r['Planned RS Code']).replace(/\.0$/, '') : null,
    plannedRsName: r['Planned RS Name'],
    classification: r['Classification - Remarks'],
    channel: r.Channel,
  };
}

function parseAttendanceBuffer(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer', cellDates: true });
  const sheetName = wb.SheetNames[0];
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { defval: null });
  if (!rows.length) throw new Error('The attendance file appears empty.');
  return rows.map(normalizeRow);
}

function parsePjpBuffer(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer', cellDates: true });
  const planRows = [];
  const pjpEmpCodes = new Set();

  for (const sheetName of wb.SheetNames) {
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { defval: null });
    for (const r of rows) {
      const plan = normalizePlanRow(r, sheetName);
      if (!plan.dateKey || (!plan.empCode && !plan.empName)) continue;
      planRows.push(plan);
      if (plan.empCode) pjpEmpCodes.add(plan.empCode);
    }
  }

  if (!planRows.length) throw new Error('The PJP file appears empty.');

  const dates = planRows.map((p) => p.date).filter(Boolean).map((d) => new Date(d));
  let pjpMonth = null;
  let pjpMinDate = null;
  let pjpMaxDate = null;

  if (dates.length) {
    const monthCounts = {};
    for (const d of dates) {
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      monthCounts[key] = (monthCounts[key] || 0) + 1;
    }
    const topMonth = Object.entries(monthCounts).sort((a, b) => b[1] - a[1])[0][0];
    const [y, m] = topMonth.split('-').map(Number);
    pjpMonth = {
      year: y,
      month: m,
      label: new Date(y, m - 1, 1).toLocaleDateString('en-IN', { month: 'long', year: 'numeric' }),
    };
    const inMonth = dates.filter((d) => d.getFullYear() === y && d.getMonth() === m - 1);
    pjpMinDate = serializeDate(new Date(Math.min(...inMonth.map((d) => d.getTime()))));
    pjpMaxDate = serializeDate(new Date(Math.max(...inMonth.map((d) => d.getTime()))));
  }

  return {
    planRows,
    pjpEmpCodes: [...pjpEmpCodes],
    pjpMonth,
    pjpMinDate,
    pjpMaxDate,
  };
}

function buildPlanIndexes(planRows) {
  const planByEmpDate = {};
  const planByNameDate = {};
  const { normalizeName } = require('./utils');
  for (const plan of planRows || []) {
    if (plan.empCode) planByEmpDate[`${plan.empCode}|${plan.dateKey}`] = plan;
    if (plan.empName) planByNameDate[`${normalizeName(plan.empName)}|${plan.dateKey}`] = plan;
  }
  return { planByEmpDate, planByNameDate };
}

function pickDefaultDate(rawRows, pjpMinDate, pjpMaxDate) {
  const allDates = rawRows.map((r) => (r.date ? new Date(r.date) : null)).filter(Boolean);
  if (pjpMinDate && pjpMaxDate) {
    const min = new Date(pjpMinDate);
    const max = new Date(pjpMaxDate);
    const inRange = allDates.filter((d) => d >= min && d <= max);
    if (inRange.length) return dateKey(new Date(Math.max(...inRange.map((d) => d.getTime()))));
    return dateKey(max);
  }
  if (allDates.length) return dateKey(new Date(Math.max(...allDates.map((d) => d.getTime()))));
  return null;
}

module.exports = {
  parseAttendanceBuffer,
  parsePjpBuffer,
  buildPlanIndexes,
  pickDefaultDate,
};
