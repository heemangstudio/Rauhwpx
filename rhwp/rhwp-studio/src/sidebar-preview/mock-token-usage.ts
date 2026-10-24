import type * as T from '../agent/types.ts';

/** 미리보기용 토큰 사용량. 같은 날짜에는 같은 값이 나오도록 날짜 번호로 씨를 정한다. */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function localDate(time: number): string {
  const d = new Date(time);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const DAY = 86_400_000;
const SPIKES: Record<number, Partial<Record<T.TokenUsageAgent, number>>> = {
  // 오늘에서 며칠 전인지 → 배수
  3: { codex: 3.1 },
  11: { claude: 3.6 },
  19: { claude: 2.2, codex: 1.8 },
  26: { pi: 6 },
  41: { claude: 2.8 },
  58: { codex: 2.6 },
  73: { claude: 1.9 },
};

export type PreviewTokenUsageMode = 'sample' | 'empty' | 'partial';

export function previewTokenUsage(days: T.TokenUsageDays, mode: PreviewTokenUsageMode = 'sample', now = Date.now()): T.TokenUsageReport {
  const daily: T.TokenUsageReport['daily'] = [];
  const agents = ['claude', 'codex', 'pi'] as const;
  const totals = { claude: 0, codex: 0, pi: 0 };
  for (let ago = days - 1; ago >= 0; ago--) {
    const time = now - ago * DAY;
    const date = localDate(time);
    const random = seeded(Math.floor(time / DAY));
    const weekday = new Date(time).getDay();
    const weekend = weekday === 0 || weekday === 6 ? 0.35 : 1;
    // 최근으로 올수록 Codex 비중이 늘고 Claude 는 고르게 유지된다.
    const recent = 1 - ago / 90;
    const spike = SPIKES[ago] ?? {};
    const day = {
      date,
      claude: Math.round((0.55e9 + random() * 0.9e9) * weekend * (spike.claude ?? 1)),
      codex: Math.round((0.12e9 + random() * 0.5e9 + recent * 0.55e9) * weekend * (spike.codex ?? 1)),
      pi: random() < 0.45 ? 0 : Math.round((4e6 + random() * 26e6) * (spike.pi ?? 1)),
    };
    if (mode === 'empty') day.claude = day.codex = day.pi = 0;
    if (mode === 'partial') day.codex = 0;
    for (const agent of agents) totals[agent] += day[agent];
    daily.push(day);
  }
  const perSession = { claude: 21e6, codex: 34e6, pi: 1.6e6 };
  const providers = agents.map((agent): T.TokenUsageProvider => {
    const tokens = totals[agent];
    const cacheRead = Math.round(tokens * (agent === 'pi' ? 0.2 : 0.86));
    const cacheCreation = Math.round(tokens * (agent === 'claude' ? 0.05 : 0));
    const output = Math.round(tokens * 0.012);
    return {
      agent,
      tokens,
      inputTokens: tokens - cacheRead - cacheCreation - output,
      outputTokens: output,
      cacheReadTokens: cacheRead,
      cacheCreationTokens: cacheCreation,
      sessions: tokens ? Math.max(1, Math.round(tokens / perSession[agent])) : 0,
      costUsd: agent === 'pi' ? null : Math.round(tokens * (agent === 'claude' ? 0.335 : 0.21) / 1e4) / 100,
    };
  }).filter((provider) => provider.tokens > 0 || mode === 'empty');
  return {
    days,
    generatedAt: now,
    totalTokens: providers.reduce((sum, p) => sum + p.tokens, 0),
    sessions: providers.reduce((sum, p) => sum + p.sessions, 0),
    providers,
    daily,
    ...(mode === 'partial' ? { errors: ['Codex 세션 폴더를 읽지 못했습니다.'] } : {}),
  };
}
