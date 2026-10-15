/**
 * Transactional email behind a tiny provider interface: `{ name, send({ to, subject, text, html, idempotencyKey }) }`.
 * Resend is the only real provider. With no RESEND_API_KEY the log provider records the
 * attempt and reports `skipped`, so a missing email setup never fails the Groble webhook.
 */

export function createResendProvider({ apiKey, from, replyTo, fetchImpl = globalThis.fetch, timeoutMs = 8000 }) {
  return {
    name: 'resend',
    async send({ to, subject, text, html, idempotencyKey }) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await fetchImpl('https://api.resend.com/emails', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
            ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
          },
          body: JSON.stringify({
            from,
            to: [to],
            subject,
            text,
            html,
            ...(replyTo ? { reply_to: replyTo } : {}),
          }),
          signal: controller.signal,
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) {
          return { status: 'failed', error: `resend ${res.status}: ${String(body?.message ?? body?.name ?? '').slice(0, 200)}` };
        }
        return { status: 'sent', providerId: typeof body?.id === 'string' ? body.id : undefined };
      } catch (error) {
        return { status: 'failed', error: String(error?.message ?? error).slice(0, 200) };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

export function createLogProvider({ log = (line) => process.stderr.write(`${line}\n`) } = {}) {
  return {
    name: 'log',
    async send({ to }) {
      log(`[site-api] license email skipped (RESEND_API_KEY not set) for ${maskEmail(to)}`);
      return { status: 'skipped' };
    },
  };
}

export function createEmailProvider(env = process.env) {
  const apiKey = typeof env.RESEND_API_KEY === 'string' ? env.RESEND_API_KEY.trim() : '';
  if (!apiKey) return createLogProvider();
  return createResendProvider({
    apiKey,
    from: env.LICENSE_EMAIL_FROM?.trim() || 'HamaEditor <license@heemangstudios.com>',
    replyTo: env.LICENSE_EMAIL_REPLY_TO?.trim() || 'management@heemangstudios.com',
  });
}

export function maskEmail(email) {
  const text = String(email ?? '');
  const at = text.indexOf('@');
  if (at < 1) return '***';
  return `${text[0]}***${text.slice(at)}`;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function licenseEmail({ key, downloadUrl = 'https://heemangstudios.com/' }) {
  const subject = '[HamaEditor] Mac 라이선스 키를 보내드려요';
  const text = [
    'HamaEditor를 구매해 주셔서 고마워요.',
    '',
    `라이선스 키: ${key}`,
    '',
    'HamaEditor for Mac을 실행한 뒤 라이선스 화면에 위 키를 붙여 넣어 주세요.',
    '키 하나로 Mac 2대까지 쓸 수 있어요. 다른 Mac으로 옮기려면 앱에서 기존 Mac의 등록을 해제해 주세요.',
    `다운로드: ${downloadUrl}`,
    '',
    '문의는 이 메일에 답장하거나 management@heemangstudios.com 으로 보내 주세요.',
  ].join('\n');
  const html = `<p>HamaEditor를 구매해 주셔서 고마워요.</p>
<p>라이선스 키:<br><strong style="font-size:18px;font-family:ui-monospace,Menlo,monospace">${escapeHtml(key)}</strong></p>
<p>HamaEditor for Mac을 실행한 뒤 라이선스 화면에 위 키를 붙여 넣어 주세요.<br>
키 하나로 Mac 2대까지 쓸 수 있어요. 다른 Mac으로 옮기려면 앱에서 기존 Mac의 등록을 해제해 주세요.</p>
<p><a href="${escapeHtml(downloadUrl)}">다운로드</a></p>
<p>문의는 이 메일에 답장하거나 <a href="mailto:management@heemangstudios.com">management@heemangstudios.com</a> 으로 보내 주세요.</p>`;
  return { subject, text, html };
}
