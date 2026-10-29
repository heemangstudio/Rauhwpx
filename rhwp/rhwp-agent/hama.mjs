/**
 * Hama 플랜 — 사이트 API 가 라이선스 리스로 Hama 하네스(Pi 런타임)의 모델을 대 주는 유료 플랜.
 * 데스크톱이 `GET /v1/hama/status` 로 플랜·한도·모델을 묻고, 허브는 그 답을 정리해 Pi 홈(agent-hama/)의
 * models.json 을 쓴다. 이 파일은 순수 함수만 둔다 (허브 쪽 상태는 hama-hosted.mjs).
 *
 * 규칙
 * - 호스팅 Claude 는 Haiku 5.5 하나뿐이다 (상수). 서버 답에 다른 Claude 가 있어도 쓰지 않는다.
 * - 싼 모델은 서버가 주는 목록에서 Claude 가 아닌 것만 쓴다. 추론 강도는 서버가 정한다.
 * - 한도에 걸린 요청은 429 이고 문구에 `[hama-cap:<cap>:<iso>]` 꼬리표가 붙는다.
 */
/** 호스팅 Claude 허용 목록. 정확히 하나다 — Sonnet·Opus 는 어떤 경로로도 들어오지 않는다. */
export const HAMA_CLAUDE_MODEL = 'anthropic/claude-haiku-5.5';
export const HAMA_CAPS = /** @type {const} */ (['cap_5h', 'cap_week', 'cap_month']);
export const HAMA_ANTHROPIC_PATH = '/v1/hama/anthropic';
export const HAMA_OPENAI_PATH = '/v1/hama/openrouter';
export const HAMA_DEFAULT_MAX_OUTPUT_TOKENS = 16_000;
const MAX_CHEAP_MODELS = 4;
const MODEL_ID = /^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._:-]*$/i;

/**
 * Haiku 5.5 의 Pi 모델 설정. 가격(100만 토큰당 USD)은 사이트 API 의 단가표와 같다 — 비용 표시용이고
 * 실제 차감은 서버가 한다.
 */
const HAIKU_ENTRY = Object.freeze({
  name: 'Claude Haiku 5.5',
  reasoning: true,
  input: ['text', 'image'],
  contextWindow: 200_000,
  cost: { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
});
const CHEAP_DEFAULT_CONTEXT = 128_000;

/** `[hama-cap:cap_5h:2026-10-30T15:00:00.000Z]` */
const CAP_TAG = /\[hama-cap:(cap_5h|cap_week|cap_month):([0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+(?:Z|[+-][0-9]{2}:[0-9]{2}))\]/;

/**
 * 실패 문구에서 Hama 한도 꼬리표를 찾는다. 없거나 시각이 깨졌으면 null.
 * @param {unknown} text
 * @returns {{ cap: 'cap_5h'|'cap_week'|'cap_month', resetsAt: number } | null}
 */
export function parseHamaCap(text) {
  const match = CAP_TAG.exec(String(text ?? '').slice(0, 64 * 1024));
  if (!match) return null;
  const resetsAt = Date.parse(match[2]);
  if (!Number.isFinite(resetsAt)) return null;
  return { cap: /** @type {any} */ (match[1]), resetsAt };
}

/** 사이트 API 주소. https, 또는 개발용 루프백 http 만 받는다. */
export function hamaApiBase(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  let url;
  try { url = new URL(raw.trim()); } catch { return null; }
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) return null;
  if (url.hostname === 'openrouter.ai' || url.hostname.endsWith('.openrouter.ai')) return null;
  if (url.hostname === 'api.anthropic.com') return null;
  if (url.username || url.password || url.search || url.hash) return null;
  return url.toString().replace(/\/+$/, '');
}

function finiteUsd(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function isoTime(value) {
  if (typeof value !== 'string') return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : null;
}

function modelId(value) {
  return typeof value === 'string' && value.length <= 128 && MODEL_ID.test(value) ? value : null;
}

/**
 * 서버의 status 답을 믿지 않고 다시 확인한다. 시각은 epoch ms 로 바꾼다.
 * @returns {HamaStatus | null}
 *
 * @typedef {{ usedUsd: number, limitUsd: number, resetsAt: number|null }} HamaCapWindow
 * @typedef {Object} HamaStatus
 * @property {'active'|'disabled'} planStatus
 * @property {number|null} allowanceUsd
 * @property {number|null} periodStart
 * @property {number|null} periodEnd
 * @property {Partial<Record<'cap_5h'|'cap_week'|'cap_month', HamaCapWindow>>} caps
 * @property {{ cap: 'cap_5h'|'cap_week'|'cap_month', resetsAt: number|null, cheapAvailable: boolean } | null} blocked
 * @property {string} defaultModel 언제나 HAMA_CLAUDE_MODEL 이거나 싼 모델 하나
 * @property {string[]} cheapModels
 * @property {number} maxOutputTokens
 */
export function normalizeHamaStatus(body) {
  if (!body || typeof body !== 'object' || body.ok !== true) return null;
  const plan = body.plan && typeof body.plan === 'object' ? body.plan : null;
  const planStatus = plan?.status === 'active' ? 'active' : 'disabled';
  /** @type {HamaStatus['caps']} */
  const caps = {};
  for (const cap of HAMA_CAPS) {
    const raw = body.caps?.[cap];
    const usedUsd = finiteUsd(raw?.usedUsd);
    const limitUsd = finiteUsd(raw?.limitUsd);
    if (usedUsd === null || limitUsd === null) continue;
    caps[cap] = { usedUsd, limitUsd, resetsAt: isoTime(raw.resetsAt) };
  }
  const rawBlocked = body.blocked && typeof body.blocked === 'object' ? body.blocked : null;
  const blocked = rawBlocked && HAMA_CAPS.includes(rawBlocked.cap)
    ? {
      cap: rawBlocked.cap,
      resetsAt: isoTime(rawBlocked.resetsAt),
      // 이번 달 한도는 싼 모델도 막는다 — 서버가 다르게 말해도 그렇게 본다.
      cheapAvailable: rawBlocked.cap !== 'cap_month' && rawBlocked.cheapAvailable === true,
    }
    : null;
  const cheapModels = [];
  for (const raw of Array.isArray(body.models?.cheap) ? body.models.cheap : []) {
    const id = modelId(raw);
    if (!id || id.startsWith('anthropic/') || cheapModels.includes(id)) continue;
    cheapModels.push(id);
    if (cheapModels.length >= MAX_CHEAP_MODELS) break;
  }
  const requestedDefault = modelId(body.models?.default);
  const defaultModel = requestedDefault && cheapModels.includes(requestedDefault)
    ? requestedDefault
    : HAMA_CLAUDE_MODEL;
  const maxTokens = Number(body.models?.maxOutputTokens);
  return {
    planStatus,
    allowanceUsd: finiteUsd(plan?.allowanceUsd),
    periodStart: isoTime(plan?.periodStart),
    periodEnd: isoTime(plan?.periodEnd),
    caps,
    blocked,
    defaultModel,
    cheapModels,
    maxOutputTokens: Number.isSafeInteger(maxTokens) && maxTokens > 0
      ? Math.min(maxTokens, 64_000)
      : HAMA_DEFAULT_MAX_OUTPUT_TOKENS,
  };
}

/**
 * agent-hama/models.json. provider id 는 openrouter 그대로라 Pi 는 `--model openrouter/<id>` 로 돈다.
 * Haiku 만 Anthropic Messages 경로이고 싼 모델은 OpenAI 호환 경로다. 키는 두지 않는다 (리스는 env 로만).
 *
 * @param {{ apiBase: string, status: HamaStatus, catalog?: Array<any> | null }} input
 *   catalog: 싼 모델 경로의 `/models` (이름·컨텍스트·가격). 없으면 기본값으로 쓴다.
 */
export function hamaModelsJson({ apiBase, status, catalog = null }) {
  const maxTokens = status.maxOutputTokens;
  const byId = new Map((Array.isArray(catalog) ? catalog : []).map((entry) => [entry?.id, entry]));
  const haiku = {
    id: HAMA_CLAUDE_MODEL,
    name: HAIKU_ENTRY.name,
    api: 'anthropic-messages',
    baseUrl: `${apiBase}${HAMA_ANTHROPIC_PATH}`,
    reasoning: HAIKU_ENTRY.reasoning,
    input: [...HAIKU_ENTRY.input],
    contextWindow: HAIKU_ENTRY.contextWindow,
    maxTokens,
    cost: { ...HAIKU_ENTRY.cost },
  };
  const cheap = status.cheapModels.map((id) => {
    const entry = byId.get(id);
    const context = Number(entry?.contextLength);
    const perMillion = (value) => Math.round(Number(value ?? 0) * 1e12) / 1e6;
    return {
      id,
      name: cheapModelName(id, entry?.name),
      // 추론 강도는 서버가 붙인다. Pi 가 따로 보내지 않게 추론 모델로 두지 않는다.
      reasoning: false,
      input: entry?.supportsImages === true ? ['text', 'image'] : ['text'],
      contextWindow: Number.isSafeInteger(context) && context > 0 ? context : CHEAP_DEFAULT_CONTEXT,
      maxTokens,
      cost: {
        input: perMillion(entry?.pricing?.prompt),
        output: perMillion(entry?.pricing?.completion),
        cacheRead: perMillion(entry?.pricing?.cacheRead),
        cacheWrite: 0,
      },
    };
  });
  return {
    providers: {
      openrouter: {
        baseUrl: `${apiBase}${HAMA_OPENAI_PATH}`,
        api: 'openai-completions',
        models: [haiku, ...cheap],
      },
    },
  };
}

/** 'deepseek/deepseek-v4.1-flash' → 'DeepSeek V4.1 Flash'. 카탈로그 이름이 있으면 회사 이름만 뗀다. */
export function cheapModelName(id, catalogName = null) {
  if (typeof catalogName === 'string' && catalogName.trim()) {
    return catalogName.replace(/^[^:]{1,40}:\s*/, '').trim().slice(0, 80) || id;
  }
  const tail = String(id).split('/').pop() ?? String(id);
  return tail.split('-').map((part) => {
    if (part === 'deepseek') return 'DeepSeek';
    if (/^qwen/i.test(part)) return `Qwen${part.slice(4)}`;
    if (/^v?\d/.test(part)) return part.toUpperCase();
    return part.charAt(0).toUpperCase() + part.slice(1);
  }).join(' ');
}

/** PiModelConfig 모양 (사이드바 모델 피커와 설정 요약이 쓴다). */
export function hamaModelConfigs(modelsJson) {
  return modelsJson.providers.openrouter.models.map((entry) => ({
    id: entry.id,
    name: entry.name,
    reasoning: entry.reasoning,
    supportsImages: entry.input.includes('image'),
    efforts: entry.reasoning ? ['low', 'medium', 'high'] : [],
    defaultEffort: entry.reasoning ? 'medium' : null,
    contextLength: entry.contextWindow,
    maxOutputTokens: entry.maxTokens,
    pricing: {
      prompt: entry.cost.input / 1e6,
      completion: entry.cost.output / 1e6,
      cacheRead: entry.cost.cacheRead / 1e6,
    },
  }));
}
