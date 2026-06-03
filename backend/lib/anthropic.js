const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';

const DEFAULT_MODEL = 'claude-sonnet-4-6';
const MODEL_FALLBACKS = [
  process.env.ANTHROPIC_MODEL,
  DEFAULT_MODEL,
  'claude-sonnet-4-5-20250929',
  'claude-haiku-4-5-20251001',
].filter(Boolean);

const MODEL = MODEL_FALLBACKS[0] || DEFAULT_MODEL;

function resolveApiKey(clientKey) {
  const key = String(clientKey || process.env.ANTHROPIC_API_KEY || '').trim();
  if (!key) {
    throw new Error(
      'No Anthropic API key. In the app, click the "AI Key" chip in the header and paste your sk-ant-... key.'
    );
  }
  return key;
}

function formatAnthropicError(status, errBody) {
  const raw = errBody?.error?.message || errBody?.message || '';
  if (
    /claude-sonnet-4-20250514|claude-opus-4-20250514|deprecated|retired|not found/i.test(raw) ||
    (status === 404 && /model/i.test(raw))
  ) {
    return `AI model unavailable. Hard-refresh the app (Ctrl+Shift+R). Expected model: ${DEFAULT_MODEL}.`;
  }
  if (/invalid.?api.?key|authentication|401/i.test(raw) || status === 401) {
    return 'Invalid Anthropic API key. Open "AI Key" in the header and paste a new key from console.anthropic.com.';
  }
  if (/credit|billing|balance|402|403/i.test(raw) || status === 402) {
    return 'Anthropic billing issue — add credits at console.anthropic.com.';
  }
  return raw || `Anthropic API error (${status})`;
}

async function callAnthropicOnce(model, { apiKey, system, userContent, maxTokens }) {
  const key = resolveApiKey(apiKey);

  const messages = [{ role: 'user', content: userContent }];
  const body = { model, max_tokens: maxTokens, messages };
  if (system) body.system = system;

  const resp = await fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    let errBody = null;
    try {
      errBody = await resp.json();
    } catch {
      /* ignore */
    }
    const err = new Error(formatAnthropicError(resp.status, errBody));
    err.status = resp.status;
    err.isModelError = /model/i.test(err.message);
    throw err;
  }

  const data = await resp.json();
  const text = (data.content || []).map((c) => c.text || '').join('').trim();
  return { text, stopReason: data.stop_reason || null };
}

async function callAnthropic(opts = {}) {
  const maxTokens = opts.maxTokens || 1024;
  const models = [...new Set(MODEL_FALLBACKS)];
  let lastErr = null;
  for (const model of models) {
    try {
      const result = await callAnthropicOnce(model, { ...opts, maxTokens });
      return opts.withMeta ? result : result.text;
    } catch (err) {
      lastErr = err;
      if (!err.isModelError && err.status !== 404) throw err;
    }
  }
  throw lastErr || new Error('All AI models failed');
}

function extractJsonBlock(text) {
  let cleaned = String(text || '')
    .replace(/```json\n?/gi, '')
    .replace(/```/g, '')
    .trim();
  const start = cleaned.indexOf('{');
  if (start >= 0) cleaned = cleaned.slice(start);
  return cleaned;
}

function salvageTruncatedBillsJson(text) {
  const billsKeyIdx = text.indexOf('"bills"');
  if (billsKeyIdx === -1) return null;

  const arrStart = text.indexOf('[', billsKeyIdx);
  if (arrStart === -1) return null;

  const bills = [];
  let i = arrStart + 1;

  while (i < text.length) {
    while (i < text.length && /[\s,]/.test(text[i])) i += 1;
    if (i >= text.length || text[i] === ']') break;
    if (text[i] !== '{') break;

    let depth = 0;
    let inStr = false;
    let esc = false;
    const objStart = i;

    for (; i < text.length; i += 1) {
      const ch = text[i];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === '\\') esc = true;
        else if (ch === '"') inStr = false;
      } else if (ch === '"') {
        inStr = true;
      } else if (ch === '{') {
        depth += 1;
      } else if (ch === '}') {
        depth -= 1;
        if (depth === 0) {
          const chunk = text.slice(objStart, i + 1);
          try {
            bills.push(JSON.parse(chunk));
          } catch {
            /* skip malformed object */
          }
          i += 1;
          break;
        }
      }
    }
  }

  return bills.length ? { bills, _partial: true } : null;
}

function parseJsonFromModel(text) {
  const cleaned = extractJsonBlock(text);
  try {
    return JSON.parse(cleaned);
  } catch (err) {
    const salvaged = salvageTruncatedBillsJson(cleaned);
    if (salvaged) return salvaged;
    throw err;
  }
}

module.exports = { callAnthropic, parseJsonFromModel, MODEL, DEFAULT_MODEL };
