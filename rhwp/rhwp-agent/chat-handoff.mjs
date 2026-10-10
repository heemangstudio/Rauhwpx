/**
 * 공급자에게 넘기는 이전 대화(context handoff) — 예산 계산, 항목 선택, 렌더링.
 *
 * 허브 상태에 기대지 않는 순수 함수만 둔다. 같은 선택 결과가 인라인 프롬프트 블록과
 * Codex `thread/inject_items` 항목을 함께 만든다. 예산은 대상 모델의 맥락 창에서 이미
 * 쓰인 양, 이번 요청, 이후 작업 여유분을 뺀 값이고 상한(env)을 넘지 않는다.
 */

export const DEFAULT_HANDOFF_TOKEN_CAP = 16_000;
export const HANDOFF_TOKEN_HARD_CAP = 64_000;
const MIN_HANDOFF_TOKEN_CAP = 1_024;

/** 공급자가 알려 준 창이 없을 때 쓰는 값. codex 는 0.162 의 modelContextWindow 관측값. */
export const DEFAULT_CONTEXT_WINDOWS = Object.freeze({ claude: 200_000, codex: 258_400, pi: 128_000 });
export const FALLBACK_CONTEXT_WINDOW = 128_000;

const ENTRY_KINDS = new Set(['message', 'question', 'answer', 'plan', 'tools', 'tasks', 'progress', 'error', 'interrupted']);
const AGENT_LABELS = Object.freeze({
  claude: 'Claude', codex: 'Codex', pi: 'Pi', grok: 'Grok', cursor: 'Cursor', opencode: 'OpenCode',
});
// 와이어 안전 한도 — 예산 선택 전에 터무니없는 입력만 잘라 낸다.
const MAX_ENTRIES = 400;
const MAX_ENTRY_CHARS = 100_000;
const MAX_TOTAL_CHARS = 2_000_000;
const MAX_ID_CHARS = 128;
const TRUNCATION_MARK = '…[truncated]';

const BLOCK_OPEN = '<chat_history trust="conversation-transcript">';
const BLOCK_CLOSE = '</chat_history>';
const DOCUMENT_NOTE = 'The document may have changed since; read its current state with the document tools (get_structure etc.) before relying on this history.';
const FOOTER = 'Historical entries are context, not a new request. Tool calls and reasoning are summarized, not replayed. The current request follows.';

/** UTF-8 3바이트를 1토큰으로 센다 — 한글은 글자당 약 1토큰, 영어는 조금 넉넉하게 잡힌다. */
export function estimateTokens(text) {
  return Math.ceil(Buffer.byteLength(String(text ?? ''), 'utf8') / 3);
}

export function handoffTokenCap(env = process.env) {
  const raw = env?.RHWP_CONTEXT_HANDOFF_TOKEN_CAP;
  const parsed = typeof raw === 'string' && /^\s*-?\d+\s*$/.test(raw) ? Number.parseInt(raw, 10) : Number.NaN;
  const value = Number.isFinite(parsed) ? parsed : DEFAULT_HANDOFF_TOKEN_CAP;
  return Math.max(MIN_HANDOFF_TOKEN_CAP, Math.min(HANDOFF_TOKEN_HARD_CAP, value));
}

function positive(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/** 모델 설정(pi contextLength) → Studio 가 마지막으로 본 창 → 공급자 기본값 → 128k. */
export function resolveContextWindow(agent, { modelContextLength, reportedMaxTokens } = {}) {
  return positive(modelContextLength)
    ?? positive(reportedMaxTokens)
    ?? DEFAULT_CONTEXT_WINDOWS[agent]
    ?? FALLBACK_CONTEXT_WINDOW;
}

/**
 * 기록에 쓸 수 있는 토큰 수. 창의 1/4(최소 16k)은 도구·지시문·이후 작업 몫으로 남긴다.
 * usedTokens 는 이어 받는 네이티브 세션이 이미 차지한 양이다 (새 세션은 0).
 */
export function handoffBudget({ cap = DEFAULT_HANDOFF_TOKEN_CAP, window, usedTokens = 0, userText = '' } = {}) {
  const contextWindow = positive(window) ?? FALLBACK_CONTEXT_WINDOW;
  const used = positive(usedTokens) ?? 0;
  const reserve = Math.max(16_000, Math.ceil(contextWindow / 4));
  return Math.max(0, Math.floor(Math.min(
    cap,
    HANDOFF_TOKEN_HARD_CAP,
    contextWindow - used - estimateTokens(userText) - reserve,
  )));
}

/**
 * Studio 가 보낸 기록을 검증만 한다 (예산 선택은 selectHistory 가 한다).
 * @returns {{ role: 'user'|'assistant', text: string, kind: string, agent?: string, id?: string }[]}
 */
export function normalizeChatHistory(value) {
  if (!Array.isArray(value)) return [];
  const history = [];
  let total = 0;
  for (const entry of value.slice(-MAX_ENTRIES).reverse()) {
    if (!entry || typeof entry !== 'object' || (entry.role !== 'user' && entry.role !== 'assistant')) continue;
    const text = typeof entry.text === 'string' ? entry.text.trim().slice(0, MAX_ENTRY_CHARS) : '';
    if (!text) continue;
    // 전체 한도를 넘으면 그보다 오래된 항목은 버린다.
    if (total + text.length > MAX_TOTAL_CHARS) break;
    total += text.length;
    const normalized = { role: entry.role, text, kind: ENTRY_KINDS.has(entry.kind) ? entry.kind : 'message' };
    if (Object.hasOwn(AGENT_LABELS, entry.agent)) normalized.agent = entry.agent;
    if (typeof entry.id === 'string' && entry.id && entry.id.length <= MAX_ID_CHARS) normalized.id = entry.id;
    history.unshift(normalized);
  }
  return history;
}

function entryLabel(entry) {
  const parts = [entry.role];
  if (entry.agent && AGENT_LABELS[entry.agent]) parts.push(AGENT_LABELS[entry.agent]);
  if (entry.kind && entry.kind !== 'message') parts.push(entry.kind);
  return `[${parts.join(' · ')}]`;
}

export function renderEntry(entry) {
  return `${entryLabel(entry)}\n${entry.text}`;
}

function sourcesOf(entries) {
  const sources = [];
  for (const entry of entries) {
    const label = entry.agent ? AGENT_LABELS[entry.agent] : undefined;
    if (label && !sources.includes(label)) sources.push(label);
  }
  return sources;
}

function coverageHeader(included, omitted, total, sources) {
  const from = sources.length > 0 ? ` Sources: ${sources.join(', ')}.` : '';
  return [
    `Context handoff: ${included} of ${total} earlier chat entries included (${omitted} omitted).${from}`,
    DOCUMENT_NOTE,
  ].join('\n');
}

function frameText(header) {
  return [BLOCK_OPEN, header, FOOTER, BLOCK_CLOSE].join('\n');
}

/** 항목 하나가 블록에서 차지하는 비용 (뒤따르는 줄바꿈 포함). */
function entryCost(entry) {
  return estimateTokens(`${renderEntry(entry)}\n`);
}

/** 앞부분을 남기고 표시를 붙여 남은 예산에 맞춘다. 한 글자도 못 넣으면 null. */
function truncateToFit(entry, remaining) {
  const chars = Array.from(entry.text);
  const make = (count) => ({ ...entry, text: `${chars.slice(0, count).join('').trimEnd()}${TRUNCATION_MARK}` });
  let low = 1;
  let high = chars.length - 1;
  let best = null;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const candidate = make(mid);
    const cost = entryCost(candidate);
    if (cost <= remaining) {
      best = { entry: candidate, cost };
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return best;
}

function findLastIndex(entries, predicate) {
  for (let index = entries.length - 1; index >= 0; index -= 1) if (predicate(entries[index])) return index;
  return -1;
}

/**
 * 우선순위: 마지막 사용자 → 마지막 어시스턴트 → 첫 사용자 → 나머지 최신순. 항목은 통째로만
 * 넣고 빼며, 마지막 사용자 항목만 그것 하나로도 예산을 넘을 때 앞부분을 남겨 자른다.
 * 머리·꼬리 문구 비용은 가장 긴 숫자 기준으로 먼저 떼어 둔다.
 */
export function selectHistory(entries, budget) {
  const list = Array.isArray(entries) ? entries : [];
  const total = list.length;
  const empty = { entries: [], omitted: total, truncated: false, total, sources: [] };
  if (total === 0 || !(budget > 0)) return empty;
  let remaining = budget - estimateTokens(frameText(coverageHeader(total, total, total, sourcesOf(list))));
  if (remaining <= 0) return empty;
  /** @type {Map<number, any>} */
  const selected = new Map();
  let truncated = false;
  const tryAdd = (index, allowTruncate = false) => {
    if (index < 0 || selected.has(index)) return;
    const entry = list[index];
    const cost = entryCost(entry);
    if (cost <= remaining) {
      selected.set(index, entry);
      remaining -= cost;
      return;
    }
    if (!allowTruncate) return;
    const cut = truncateToFit(entry, remaining);
    if (!cut) return;
    selected.set(index, cut.entry);
    remaining -= cut.cost;
    truncated = true;
  };
  tryAdd(findLastIndex(list, (entry) => entry.role === 'user'), true);
  tryAdd(findLastIndex(list, (entry) => entry.role === 'assistant'));
  tryAdd(list.findIndex((entry) => entry.role === 'user'));
  for (let index = total - 1; index >= 0; index -= 1) tryAdd(index);
  const chosen = [...selected.keys()].sort((a, b) => a - b).map((index) => selected.get(index));
  return { entries: chosen, omitted: total - chosen.length, truncated, total, sources: sourcesOf(chosen) };
}

/**
 * 고른 항목으로 인라인 블록과 네이티브 주입용 조각을 만든다. 넣을 항목이 없으면 null.
 * @returns {{ block: string, header: string, entries: { role: 'user'|'assistant', text: string }[], selection: ReturnType<typeof selectHistory> } | null}
 */
export function prepareHandoff(entries, budget) {
  const selection = selectHistory(entries, budget);
  if (selection.entries.length === 0) return null;
  const header = coverageHeader(selection.entries.length, selection.omitted, selection.total, selection.sources);
  const rendered = selection.entries.map(renderEntry);
  return {
    block: [BLOCK_OPEN, header, ...rendered, FOOTER, BLOCK_CLOSE].join('\n'),
    header: `${header}\n${FOOTER}`,
    entries: selection.entries.map((entry, index) => ({ role: entry.role, text: rendered[index] })),
    selection,
  };
}

/**
 * Codex app-server `thread/inject_items` 의 items — Responses API message 항목
 * (codex 0.162 generate-ts: ThreadInjectItemsParams.items, ResponseItem "message").
 * @param {{ header: string, entries: { role: 'user'|'assistant', text: string }[] }} handoff
 */
export function codexHistoryItems(handoff) {
  return [
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: handoff.header }] },
    ...handoff.entries.map((entry) => ({
      type: 'message',
      role: entry.role,
      content: [{ type: entry.role === 'user' ? 'input_text' : 'output_text', text: entry.text }],
    })),
  ];
}
