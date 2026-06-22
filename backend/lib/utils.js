function normalizeName(s) {
  if (!s) return '';
  let n = String(s);
  n = n.replace(/^Other\s*=\s*/i, '');
  return n.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function tokenizeName(s) {
  if (!s) return [];
  const cleaned = String(s).replace(/^Other\s*=\s*/i, '').toLowerCase();
  return cleaned.split(/\s+/).filter((t) => t.length >= 3).map((t) => t.replace(/[^a-z0-9]/g, ''));
}

function lev(a, b) {
  if (a === b) return 0;
  const m = a.length;
  const n = b.length;
  if (!m) return n;
  if (!n) return m;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
    }
  }
  return dp[m][n];
}

function buildAuditorIndex(master) {
  const byNorm = {};
  const byCode = {};
  const byToken = {};
  for (const a of master) {
    byNorm[normalizeName(a.name)] = a;
    byCode[a.empCode] = a;
    for (const t of tokenizeName(a.name)) {
      if (!byToken[t]) byToken[t] = [];
      byToken[t].push(a);
    }
  }
  return { byNorm, byCode, byToken };
}

function findAuditor(nameStr, empCode, master, index) {
  if (empCode && index.byCode[String(empCode)]) return index.byCode[String(empCode)];
  if (!nameStr) return null;
  const norm = normalizeName(nameStr);
  if (index.byNorm[norm]) return index.byNorm[norm];

  let bestLev = null;
  let bestLevDist = Infinity;
  for (const m of master) {
    const mNorm = normalizeName(m.name);
    const d = lev(norm, mNorm);
    if (d <= 2 && d / Math.max(norm.length, mNorm.length) <= 0.2 && d < bestLevDist) {
      bestLev = m;
      bestLevDist = d;
    }
  }
  if (bestLev) return bestLev;

  const inputTokens = tokenizeName(nameStr);
  if (!inputTokens.length) return null;
  const scores = new Map();
  for (const t of inputTokens) {
    for (const m of index.byToken[t] || []) scores.set(m, (scores.get(m) || 0) + 1);
    for (const knownToken of Object.keys(index.byToken)) {
      if (knownToken === t) continue;
      if (Math.abs(knownToken.length - t.length) > 2) continue;
      if (lev(t, knownToken) <= 1 && t.length >= 4) {
        for (const m of index.byToken[knownToken]) scores.set(m, (scores.get(m) || 0) + 0.5);
      }
    }
  }
  if (!scores.size) return null;
  const ranked = [...scores.entries()].sort((a, b) => b[1] - a[1]);
  if (ranked[0][1] >= 2) return ranked[0][0];
  if (inputTokens.length === 1 && ranked[0][1] >= 1) {
    if (ranked.length > 1 && ranked[1][1] === ranked[0][1]) return null;
    return ranked[0][0];
  }
  return null;
}

function parseLocation(loc) {
  if (loc && typeof loc === 'object' && loc.lat != null && loc.lng != null) {
    const lat = Number(loc.lat);
    const lng = Number(loc.lng);
    if (!Number.isNaN(lat) && !Number.isNaN(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180) {
      return { lat, lng };
    }
  }
  if (loc == null) return null;
  const s = String(loc).trim();
  if (!s) return null;
  const parts = s.split(/[,;]\s*/).map((p) => parseFloat(p.trim()));
  if (parts.length < 2 || Number.isNaN(parts[0]) || Number.isNaN(parts[1])) return null;
  if (Math.abs(parts[0]) > 90 && Math.abs(parts[1]) <= 90) {
    return { lat: parts[1], lng: parts[0] };
  }
  return { lat: parts[0], lng: parts[1] };
}

function parseExcelDate(v) {
  if (v == null) return null;
  if (v instanceof Date) return v;
  if (typeof v === 'number') return new Date(Math.round((v - 25569) * 86400 * 1000));
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

function dateKey(d) {
  if (!d) return null;
  const dt = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(dt.getTime())) return null;
  const y = dt.getFullYear();
  const m = String(dt.getMonth() + 1).padStart(2, '0');
  const day = String(dt.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function parseKms(v) {
  if (v == null || v === '' || v === '-') return null;
  if (typeof v === 'number') return v;
  const m = String(v).match(/(\d+(?:\.\d+)?)/);
  return m ? parseFloat(m[1]) : null;
}

function parseYesNo(v) {
  if (!v) return null;
  const s = String(v).trim().toLowerCase();
  if (s === 'yes' || s === 'y') return true;
  if (s === 'no' || s === 'n') return false;
  return null;
}

function serializeDate(d) {
  if (!d) return null;
  const dk = dateKey(d);
  return dk ? `${dk}T12:00:00.000Z` : null;
}

function reviveDatesInRows(rows) {
  return rows.map((r) => ({
    ...r,
    date: r.date ? new Date(String(r.date).slice(0, 10) + 'T12:00:00') : null,
  }));
}

function revivePlanRows(rows) {
  return rows.map((p) => ({
    ...p,
    date: p.date ? new Date(p.date) : null,
  }));
}

module.exports = {
  normalizeName,
  tokenizeName,
  lev,
  buildAuditorIndex,
  findAuditor,
  parseLocation,
  parseExcelDate,
  dateKey,
  parseKms,
  parseYesNo,
  serializeDate,
  reviveDatesInRows,
  revivePlanRows,
};
