function getPublicBaseUrl(req) {
  if (process.env.PUBLIC_BASE_URL) return String(process.env.PUBLIC_BASE_URL).replace(/\/$/, '');
  if (req) {
    const proto = req.headers['x-forwarded-proto'] || req.protocol || 'https';
    return `${proto}://${req.get('host')}`;
  }
  return 'http://localhost:3000';
}

function formatDeviationDate(isoDate) {
  try {
    return new Date(`${String(isoDate).slice(0, 10)}T12:00:00`).toLocaleDateString('en-IN', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
    });
  } catch {
    return isoDate;
  }
}

function buildDeviationMessage(notice, baseUrl) {
  const respondUrl = `${baseUrl}/respond/${notice.responseToken}`;
  const dist =
    notice.distPjpKm != null ? `${Number(notice.distPjpKm).toFixed(1)} km from planned town` : 'off-plan GPS';
  const lines = [
    '🚨 *PJP deviation — action required*',
    '',
    `*Auditor:* ${notice.auditorName} (${notice.auditorCode})`,
    `*Date:* ${formatDeviationDate(notice.deviationDate)}`,
    `*PJP planned (Col H):* ${notice.plannedTown || '—'}`,
    `*Current location:* ${notice.currentLocation || '—'}`,
    `*Distance:* ${dist}`,
    '',
    `@${notice.auditorName} — please share *why you did not follow today's PJP*:`,
    respondUrl,
    '',
    '_Reply via the link above (opens a short form). Your answer will appear on the Sales Audit dashboard._',
  ];
  return lines.join('\n');
}

function buildWhatsAppShareUrl(message) {
  return `https://wa.me/?text=${encodeURIComponent(message)}`;
}

async function sendWhatsAppViaTwilio({ to, message }) {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_WHATSAPP_FROM;
  if (!sid || !token || !from || !to) {
    return { sent: false, method: 'manual', error: 'Twilio WhatsApp not configured' };
  }

  const auth = Buffer.from(`${sid}:${token}`).toString('base64');
  const body = new URLSearchParams({
    From: from.startsWith('whatsapp:') ? from : `whatsapp:${from}`,
    To: to.startsWith('whatsapp:') ? to : `whatsapp:${to}`,
    Body: message,
  });

  const resp = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
  });

  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    return { sent: false, method: 'twilio', error: data.message || `Twilio error ${resp.status}` };
  }
  return { sent: true, method: 'twilio', sid: data.sid };
}

async function notifyPjpDeviation(notice, req) {
  const baseUrl = getPublicBaseUrl(req);
  const message = buildDeviationMessage(notice, baseUrl);
  const shareUrl = buildWhatsAppShareUrl(message);

  const notifyTo = process.env.WHATSAPP_NOTIFY_TO;
  let auto = { sent: false, method: 'manual' };
  if (notifyTo) {
    const targets = String(notifyTo)
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean);
    for (const to of targets) {
      auto = await sendWhatsAppViaTwilio({ to, message });
      if (auto.sent) break;
    }
  }

  return {
    message,
    shareUrl,
    respondUrl: `${baseUrl}/respond/${notice.responseToken}`,
    autoSent: !!auto.sent,
    delivery: auto.sent ? auto.method : 'manual_share',
    error: auto.error || null,
  };
}

function isWhatsAppConfigured() {
  return !!(
    process.env.TWILIO_ACCOUNT_SID &&
    process.env.TWILIO_AUTH_TOKEN &&
    process.env.TWILIO_WHATSAPP_FROM &&
    process.env.WHATSAPP_NOTIFY_TO
  );
}

module.exports = {
  getPublicBaseUrl,
  buildDeviationMessage,
  buildWhatsAppShareUrl,
  notifyPjpDeviation,
  isWhatsAppConfigured,
};
