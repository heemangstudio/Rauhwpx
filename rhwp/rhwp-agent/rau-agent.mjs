/**
 * Rau 에이전트 — Rau 플랜(과 Rau 체험)에서 사이트 API 가 라이선스 lease 로 Rau 하네스(Pi 런타임)의 모델을 대 준다.
 * 데스크톱이 `GET /v1/rau/status` 로 자격·크레딧·모델 경로를 묻고, 허브는 그 답을 정리해 Pi 홈(agent-rau/)의
 * models.json 을 쓴다. 이 파일은 순수 함수만 둔다 (허브 쪽 상태는 rau-agent-hosted.mjs).
 * 호스팅 Rau-0.1 학습(rau-hosted.mjs)과는 다른 경로다.
 *
 * 규칙
 * - 모델은 'rau' 하나뿐이다 (상수). 서버 답에 다른 id 가 있어도 쓰지 않는다. 모델·회사 이름은 어디에도 적지 않는다.
 * - 서버는 예산형 thinking(`thinking: {type:'enabled', budget_tokens}`)만 받는다. 그래서 Pi 모델에 forceAdaptiveThinking 을
 *   두지 않는다 — Pi(pi-ai api/anthropic-messages.js streamSimple)는 그 표시가 없으면 강도를 예산으로 바꿔 보낸다
 *   (low 2048·medium 8192·high 16384, max_tokens 안으로 줄임). 표시가 있으면 adaptive + output_config.effort 를 보내 거절된다.
 * - 크레딧을 다 쓴 요청은 429 이고 문구에 `[rau-credits:<iso>]` 꼬리표가 붙는다.
 */
export const RAU_AGENT_MODEL = 'rau';
export const RAU_AGENT_MODEL_NAME = 'Rau';
export const RAU_AGENT_PATH = '/v1/rau/agent';
export const RAU_AGENT_DEFAULT_CONTEXT = 200_000;
export const RAU_AGENT_DEFAULT_MAX_OUTPUT_TOKENS = 16_000;
/** 사이드바에 보이는 추론 강도. Pi 의 예산형 단계와 같다. */
export const RAU_AGENT_EFFORTS = Object.freeze(['low', 'medium', 'high']);
export const RAU_AGENT_DEFAULT_EFFORT = 'medium';
/** Rau 하네스를 골랐는데 살아 있는 Rau 요금제·체험이 없다. 사용자 키로 넘어가지 않는다. */
export const RAU_AGENT_UNAVAILABLE_MESSAGE = 'Rau 요금제가 활성화되어 있지 않아요.';
/** Rau 크레딧을 다 썼다. 초기화 시각은 실패의 resetAt 과 문구의 꼬리표로 따로 간다. */
export const RAU_CREDITS_MESSAGE = 'Rau 크레딧을 모두 썼어요.';

/**
 * Pi 의 비용 표시용 단가(100만 토큰당 USD). 실제 차감은 서버가 한다.
 * 서버가 대 주는 모델의 공개 단가와 같다 (입력 1, 출력 5, 캐시 읽기 0.1, 캐시 쓰기 1.25).
 */
const RAU_AGENT_COST = Object.freeze({ input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 });

/** `[rau-credits:2026-11-01T00:00:00.000Z]` */
const CREDITS_TAG = /\[rau-credits:([0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+(?:Z|[+-][0-9]{2}:[0-9]{2}))\]/;

/**
 * 실패 문구에서 Rau 크레딧 꼬리표를 찾는다. 없거나 시각이 깨졌으면 null.
 * @param {unknown} text
 * @returns {{ resetsAt: number } | null}
 */
export function parseRauCredits(text) {
  const match = CREDITS_TAG.exec(String(text ?? '').slice(0, 64 * 1024));
  if (!match) return null;
  const resetsAt = Date.parse(match[1]);
  return Number.isFinite(resetsAt) ? { resetsAt } : null;
}

/** 사이트 API 주소. https, 또는 개발용 루프백 http 만 받는다. 공급자 주소는 받지 않는다. */
export function rauApiBase(raw) {
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
  return value !== null && value !== undefined && Number.isFinite(number) && number >= 0 ? number : null;
}

function epochFrom(value) {
  if (Number.isFinite(value) && value > 0) return value;
  if (typeof value !== 'string') return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : null;
}

function positiveInt(value, max) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? Math.min(number, max) : null;
}

/** 서버가 알려 준 Rau 경로. 사이트 API 아래의 /v1/rau/agent 만 받는다. */
function agentPath(value) {
  return value === undefined || value === null || value === RAU_AGENT_PATH ? RAU_AGENT_PATH : null;
}

/**
 * 서버의 status 답을 믿지 않고 다시 확인한다. 시각은 epoch ms 로 바꾼다. 모양이 틀리면 null.
 * @returns {RauAgentServerStatus | null}
 *
 * @typedef {{ allowanceUsd: number, usedUsd: number, remainingUsd: number, resetsAt: number|null }} RauCredits
 * @typedef {Object} RauAgentServerStatus
 * @property {boolean} eligible
 * @property {'plan'|'trial'|null} source
 * @property {RauCredits|null} credits
 * @property {boolean} exhausted
 * @property {number} contextWindow
 * @property {number} maxOutputTokens
 */
export function normalizeRauAgentStatus(body) {
  if (!body || typeof body !== 'object' || body.ok !== true) return null;
  const eligible = body.eligible === true;
  const allowanceUsd = finiteUsd(body.allowanceUsd);
  const usedUsd = finiteUsd(body.usedUsd);
  const credits = eligible && allowanceUsd !== null && usedUsd !== null
    ? {
      allowanceUsd,
      usedUsd,
      remainingUsd: finiteUsd(body.remainingUsd) ?? Math.max(0, allowanceUsd - usedUsd),
      resetsAt: epochFrom(body.resetsAt),
    }
    : null;
  const agent = body.agent && typeof body.agent === 'object' ? body.agent : {};
  if (eligible && agentPath(agent.baseUrl) === null) return null;
  return {
    eligible,
    source: eligible && (body.source === 'plan' || body.source === 'trial') ? body.source : null,
    credits,
    exhausted: credits !== null && credits.allowanceUsd > 0 && credits.remainingUsd <= 0,
    contextWindow: positiveInt(agent.contextWindow, 1_000_000) ?? RAU_AGENT_DEFAULT_CONTEXT,
    maxOutputTokens: positiveInt(agent.maxOutputTokens, 64_000) ?? RAU_AGENT_DEFAULT_MAX_OUTPUT_TOKENS,
  };
}

/**
 * agent-rau/models.json. provider id 는 openrouter 라 Pi 는 `--model openrouter/rau` 로 돌고, lease 는 env 의
 * OPENROUTER_API_KEY 로만 간다 (파일에 키를 두지 않는다). 모델은 Anthropic Messages 경로 하나다.
 *
 * @param {{ apiBase: string, status: RauAgentServerStatus }} input
 */
export function rauAgentModelsJson({ apiBase, status }) {
  return {
    providers: {
      openrouter: {
        baseUrl: `${apiBase}${RAU_AGENT_PATH}`,
        models: [{
          id: RAU_AGENT_MODEL,
          name: RAU_AGENT_MODEL_NAME,
          api: 'anthropic-messages',
          baseUrl: `${apiBase}${RAU_AGENT_PATH}`,
          reasoning: true,
          // forceAdaptiveThinking 을 두지 않는다 (맨 위 규칙). minimal·xhigh·max 는 고를 수 없게 막는다.
          thinkingLevelMap: { minimal: null, xhigh: null, max: null },
          input: ['text', 'image'],
          contextWindow: status.contextWindow,
          maxTokens: status.maxOutputTokens,
          cost: { ...RAU_AGENT_COST },
        }],
      },
    },
  };
}

/** PiModelConfig 모양 (사이드바 모델 피커와 설정 요약이 쓴다). 크레딧으로 쓰므로 단가는 0 으로 보낸다. */
export function rauAgentModelConfigs(modelsJson) {
  return modelsJson.providers.openrouter.models.map((entry) => ({
    id: entry.id,
    name: entry.name,
    reasoning: entry.reasoning,
    supportsImages: entry.input.includes('image'),
    efforts: [...RAU_AGENT_EFFORTS],
    defaultEffort: RAU_AGENT_DEFAULT_EFFORT,
    contextLength: entry.contextWindow,
    maxOutputTokens: entry.maxTokens,
    pricing: { prompt: 0, completion: 0, cacheRead: 0 },
  }));
}
