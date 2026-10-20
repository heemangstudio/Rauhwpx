const SEND_TIMEOUT_MS = 5000;

/**
 * One Telegram chat message per call. Never throws: a failed notification only logs,
 * with the bot token masked.
 */
export function createTelegramSender({
  botToken = '',
  chatId = '',
  fetchImpl = globalThis.fetch,
  label = 'telegram',
  log = (line) => process.stderr.write(`${line}\n`),
} = {}) {
  return async function sendTelegram(text) {
    if (!botToken || !chatId) return;
    try {
      const response = await fetchImpl(`https://api.telegram.org/bot${botToken}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text }),
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      });
      if (!response.ok) throw new Error(`Telegram HTTP ${response.status}`);
    } catch (error) {
      log(`[site-api] ${label} notify failed: ${String(error?.message ?? error).replaceAll(botToken, '***')}`);
    }
  };
}
