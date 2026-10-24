import type { CodexResetResult, TokenUsageDays, TokenUsageReport, UsageSummary } from '../agent/types.ts';

async function request(frame: Record<string, unknown>) {
  const response = await fetch('/__sidebar-live-usage', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Sidebar-Audit': '1' },
    body: JSON.stringify(frame), signal: AbortSignal.timeout(frame.type === 'token-usage-request' ? 145000 : 85000),
  });
  const result = await response.json();
  if (result.type === 'usage-error' || result.type === 'token-usage-error' || result.type === 'codex-reset-error') {
    throw new Error(result.message || '실제 사용량을 확인하지 못했어요.');
  }
  if (!response.ok) throw new Error('실제 사용량 허브에 연결하지 못했어요.');
  return result;
}

export async function requestLiveUsage(refresh = false): Promise<UsageSummary> {
  const result = await request({ type: 'usage-request', refresh });
  if (result.type !== 'usage-report' || !result.usage?.providers || !result.usage?.limits) {
    throw new Error('실제 사용량 응답이 없어요.');
  }
  return result.usage;
}

export async function requestLiveTokenUsage(days: TokenUsageDays, refresh = false): Promise<TokenUsageReport> {
  const result = await request({ type: 'token-usage-request', days, refresh });
  if (result.type !== 'token-usage' || result.days !== days || !Array.isArray(result.providers)
    || !Array.isArray(result.daily) || typeof result.totalTokens !== 'number') {
    throw new Error('실제 토큰 사용량 응답이 없어요.');
  }
  return result as TokenUsageReport;
}

export async function consumeLiveCodexReset(idempotencyKey: string, accountKey: string): Promise<CodexResetResult> {
  const result = await request({ type: 'codex-reset-consume', idempotencyKey, accountKey });
  if (result.type !== 'codex-reset-result' || !result.usage?.providers || !result.usage?.limits) {
    throw new Error('초기화 결과를 확인하지 못했어요.');
  }
  return { outcome: result.outcome, usage: result.usage };
}
