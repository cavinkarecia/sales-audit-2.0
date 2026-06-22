const XLSX = require('xlsx');
const {
  parseLocation,
  parseExcelDate,
  dateKey,
  parseKms,
  parseYesNo,
  serializeDate,
} = require('./utils');

/** Column G (0-based index 6) in the attendance tracker holds GPS lat/long. */
const ATTENDANCE_GPS_COL_INDEX = 6;

const ATTENDANCE_LOCATION_HEADERS = [
  'Location',
  'location',
  'GPS',
  'gps',
  'Lat Long',
  'Lat/Long',
  'Latitude Longitude',
  'Current Location',
  'Geo Location',
  'Geo',
];

function extractColumnByIndex(ws, colIndex) {
  if (!ws || !ws['!ref']) return [];
  const range = XLSX.utils.decode_range(ws['!ref']);
  const values = [];
  for (let R = range.s.r + 1; R <= range.e.r; R++) {
    const cell = ws[XLSX.utils.encode_cell({ r: R, c: colIndex })];
    values.push(cell != null && cell.v != null ? cell.v : null);
  }
  return values;
}

function resolveAttendanceLocation(r, colGValue) {
  for (const key of ATTENDANCE_LOCATION_HEADERS) {
    if (r[key] != null && r[key] !== '') {
      const loc = parseLocation(r[key]);
      if (loc) return loc;
    }
  }
  if (colGValue != null && colGValue !== '') {
    const loc = parseLocation(colGValue);
    if (loc) return loc;
  }
  for (const val of Object.values(r)) {
    if (typeof val === 'string' && /-?\d+\.?\d*\s*[,;]\s*-?\d+\.?\d*/.test(val)) {
      const loc = parseLocation(val);
      if (loc) return loc;
    }
  }
  return null;
}

function normalizeRow(r, colGValue) {
  const loc = resolveAttendanceLocation(r, colGValue);
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

const MAX_ATTENDANCE_ROWS = 20000;
const MAX_PJP_ROWS = 35000;

function parseAttendanceBuffer(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer', cellDates: true });
  const sheetName = wb.SheetNames[0];
  const ws = wb.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json(ws, { defval: null });
  if (!rows.length) throw new Error('The attendance file appears empty.');
  if (rows.length > MAX_ATTENDANCE_ROWS) {
    throw new Error(
      `Attendance file has ${rows.length.toLocaleString()} rows (max ${MAX_ATTENDANCE_ROWS.toLocaleString()}). Split by month or remove extra rows.`
    );
  }
  const colGValues = extractColumnByIndex(ws, ATTENDANCE_GPS_COL_INDEX);
  return rows.map((r, i) => normalizeRow(r, colGValues[i]));
}

function filterPlanRowsToMonth(planRows, year, month) {
  return (planRows || []).filter((p) => {
    if (!p.date) return false;
    const d = new Date(String(p.date).slice(0, 10) + 'T12:00:00');
    return d.getFullYear() === year && d.getMonth() === month - 1;
  });
}

function parsePjpBuffer(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer', cellDates: true });
  const planRowsAll = [];
  const pjpEmpCodes = new Set();

  for (const sheetName of wb.SheetNames) {
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { defval: null });
    for (const r of rows) {
      const plan = normalizePlanRow(r, sheetName);
      if (!plan.dateKey || (!plan.empCode && !plan.empName)) continue;
      planRowsAll.push(plan);
    }
  }

  if (!planRowsAll.length) throw new Error('The PJP file appears empty.');
  if (planRowsAll.length > MAX_PJP_ROWS) {
    throw new Error(
      `PJP file has ${planRowsAll.length.toLocaleString()} plan rows (max ${MAX_PJP_ROWS.toLocaleString()}). Split the workbook or remove extra rows.`
    );
  }

  const dates = planRowsAll.map((p) => p.date).filter(Boolean).map((d) => new Date(String(d).slice(0, 10) + 'T12:00:00'));
  let pjpMonth = null;
  let pjpMinDate = null;
  let pjpMaxDate = null;
  let planRows = planRowsAll;

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
    planRows = filterPlanRowsToMonth(planRowsAll, y, m);
    for (const plan of planRows) {
      if (plan.empCode) pjpEmpCodes.add(plan.empCode);
    }
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

/** Keep only attendance rows whose calendar date falls within the PJP month window. */
function scopeAttendanceToPjpMonth(rows, pjpMinDate, pjpMaxDate) {
  if (!rows?.length || !pjpMinDate || !pjpMaxDate) return rows || [];
  const min = dateKey(new Date(pjpMinDate));
  const max = dateKey(new Date(pjpMaxDate));
  return rows.filter((r) => {
    if (!r.date) return false;
    const dk = dateKey(new Date(r.date));
    return dk && dk >= min && dk <= max;
  });
}

function pickDefaultDate(rawRows, pjpMinDate, pjpMaxDate) {
  const allDates = rawRows.map((r) => (r.date ? new Date(r.date) : null)).filter(Boolean);
  if (pjpMinDate && pjpMaxDate) {
    const min = dateKey(new Date(pjpMinDate));
    const max = dateKey(new Date(pjpMaxDate));
    const inRange = allDates.filter((d) => {
      const dk = dateKey(d);
      return dk >= min && dk <= max;
    });
    if (inRange.length) return dateKey(new Date(Math.max(...inRange.map((d) => d.getTime()))));
    return max;
  }
  if (allDates.length) return dateKey(new Date(Math.max(...allDates.map((d) => d.getTime()))));
  return null;
}

module.exports = {
  MAX_ATTENDANCE_ROWS,
  MAX_PJP_ROWS,
  ATTENDANCE_GPS_COL_INDEX,
  parseAttendanceBuffer,
  parsePjpBuffer,
  buildPlanIndexes,
  pickDefaultDate,
  scopeAttendanceToPjpMonth,
  filterPlanRowsToMonth,
  resolveAttendanceLocation,
};
