/**
 * 개인 기본값 — 설정 탭에서 고르는 "다음 대화부터 쓸" 프로바이더·모델·
 * 추론 강도·에이전트 모드. localStorage 한 칸에 JSON 으로 산다.
 *
 * 대화 중 입력기 셀렉터로 바꾸는 값은 그 대화만의 덮어쓰기이므로 여기에
 * 저장되지 않는다(설정 탭만 저장한다).
 *
 * 읽을 때 models.ts 기준으로 정규화한다. 카탈로그를 받은 뒤에는 저장된
 * 레거시 계열 선택을 실제 모델 ID로 옮긴다.
 */
import {
  availableModelsForAgent,
  concreteModelForAgent,
  hasLiveModelCatalog,
  normalizeSelectedModels,
  resolveEffortForAgent,
  resolveModelForAgent,
  setSelectedModels,
  type SelectedModels,
} from './models.ts';
import { isAgentMode, type AgentMode, type AgentName } from './types.ts';

const STORAGE_KEY = 'rhwp-agent-prefs';

/**
 * 에이전트·전체 모드에서 에이전트가 문서를 고칠 때 사용자 편집을 막는 방식. off 는 막지 않고, always 는 에이전트가
 * 일하는 내내 막는다. 초(1–60)면 고치기 시작할 때부터 마지막 편집 뒤 그 초만큼만 막는다 — 대화만 할 때는 막지 않는다.
 */
export type AgentEditLock = 'off' | 'always' | number;

/** 설정의 눈금 — 왼쪽 끝은 막지 않음, 오른쪽 끝은 항상 막음. */
export const AGENT_EDIT_LOCK_STEPS: readonly AgentEditLock[] = ['off', 1, 2, 3, 5, 10, 20, 30, 60, 'always'];
export const DEFAULT_AGENT_EDIT_LOCK: AgentEditLock = 3;

export interface AgentPrefs {
  defaultAgent: AgentName;
  defaultModel: string;
  defaultEffort: string;
  /** 새 대화의 모드. 이전 저장값(defaultPermissionProfile)은 읽을 때 옮긴다. */
  defaultMode: AgentMode;
  selectedModels: SelectedModels;
  editLock: AgentEditLock;
}

function normalizeEditLock(value: unknown): AgentEditLock {
  return AGENT_EDIT_LOCK_STEPS.includes(value as AgentEditLock) ? value as AgentEditLock : DEFAULT_AGENT_EDIT_LOCK;
}

/** localStorage 최소 계약 — 테스트가 자기 저장소를 넣을 수 있게 뺐다. */
export interface AgentPrefsStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export type AgentPrefsSaveResult =
  | { ok: true; value: AgentPrefs }
  | { ok: false; value: AgentPrefs; error: string };

function isAgentName(value: unknown): value is AgentName {
  return value === 'claude' || value === 'codex' || value === 'pi';
}

/** 첫 실행·빈 프로필의 기본 프로바이더. 저장된 선택은 건드리지 않는다. */
export const DEFAULT_CHAT_AGENT: AgentName = 'claude';

/** 저장된 모드. 모드 도입 전 프로필은 안전 → 에이전트, 전체 접근 → 전체로 옮긴다. */
function storedDefaultMode(src: Record<string, unknown>): AgentMode {
  if (isAgentMode(src['defaultMode'])) return src['defaultMode'];
  return src['defaultPermissionProfile'] === 'unrestricted' ? 'full' : 'agent';
}

function resolveStorage(storage?: AgentPrefsStorage | null): AgentPrefsStorage | null {
  if (storage) return storage;
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}

export function defaultAgentPrefs(): AgentPrefs {
  const agent: AgentName = DEFAULT_CHAT_AGENT;
  const selectedModels = normalizeSelectedModels(null);
  const preferred = concreteModelForAgent('claude', 'sonnet');
  const model = selectedModels.claude.includes(preferred) ? preferred : selectedModels.claude[0]!;
  return {
    defaultAgent: agent,
    defaultModel: model,
    defaultEffort: resolveEffortForAgent(agent, null, model),
    defaultMode: 'agent',
    selectedModels,
    editLock: DEFAULT_AGENT_EDIT_LOCK,
  };
}

/** 어떤 입력이 와도 쓸 수 있는 조합으로 접는다. */
export function normalizeAgentPrefs(raw: unknown): AgentPrefs {
  const src = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const agent: AgentName = isAgentName(src['defaultAgent']) ? src['defaultAgent'] : DEFAULT_CHAT_AGENT;
  const selectedModels = normalizeSelectedModels(src['selectedModels']);
  const requested = typeof src['defaultModel'] === 'string' ? src['defaultModel'] : null;
  let model: string;
  if (agent === 'claude' || agent === 'codex') {
    const concrete = requested ? concreteModelForAgent(agent, requested) : null;
    // Profiles created before model selection may hold an explicit version ID.
    // Keep it usable until the live catalog can confirm or replace it.
    if (src['selectedModels'] === undefined && concrete &&
      (agent === 'codex' ? /^gpt-[\w.-]+$/.test(concrete) : /^claude-[\w.-]+$/.test(concrete)) &&
      (!hasLiveModelCatalog(agent) || availableModelsForAgent(agent).some((entry) => entry.id === concrete)) &&
      !selectedModels[agent].includes(concrete)) selectedModels[agent].push(concrete);
    const preferred = concreteModelForAgent(agent, agent === 'claude' ? 'sonnet' : 'sol');
    model = concrete && selectedModels[agent].includes(concrete)
      ? concrete
      : selectedModels[agent].find((id) => id === preferred) ?? selectedModels[agent][0]!;
  } else {
    model = resolveModelForAgent(agent, requested);
  }
  const effort = resolveEffortForAgent(
    agent,
    typeof src['defaultEffort'] === 'string' ? src['defaultEffort'] : null,
    model,
  );
  return {
    defaultAgent: agent,
    defaultModel: model,
    defaultEffort: effort,
    defaultMode: storedDefaultMode(src),
    selectedModels,
    editLock: normalizeEditLock(src['editLock']),
  };
}

export function loadAgentPrefs(storage?: AgentPrefsStorage | null): AgentPrefs {
  const store = resolveStorage(storage);
  if (!store) {
    const prefs = defaultAgentPrefs();
    setSelectedModels(prefs.selectedModels);
    return prefs;
  }
  try {
    const raw = store.getItem(STORAGE_KEY);
    const prefs = raw ? normalizeAgentPrefs(JSON.parse(raw)) : defaultAgentPrefs();
    setSelectedModels(prefs.selectedModels);
    return prefs;
  } catch {
    const prefs = defaultAgentPrefs();
    setSelectedModels(prefs.selectedModels);
    return prefs;
  }
}

/**
 * 바뀐 값만 덮어써 저장하고, 저장된 최종 형태를 돌려준다. 프로바이더가
 * 바뀌면 모델·강도는 그 프로바이더 기준으로 다시 해석된다.
 */
export function saveAgentPrefs(
  partial: Partial<AgentPrefs>,
  storage?: AgentPrefsStorage | null,
): AgentPrefs {
  return trySaveAgentPrefs(partial, storage).value;
}

/** 저장 실패를 숨기지 않는 설정 허브용 API. */
export function trySaveAgentPrefs(
  partial: Partial<AgentPrefs>,
  storage?: AgentPrefsStorage | null,
): AgentPrefsSaveResult {
  const store = resolveStorage(storage);
  const current = loadAgentPrefs(store);
  const next = normalizeAgentPrefs({ ...current, ...partial });
  if (!store) return { ok: false, value: next, error: '설정을 저장할 수 있는 저장소가 없습니다.' };
  try {
    store.setItem(STORAGE_KEY, JSON.stringify(next));
    setSelectedModels(next.selectedModels);
    publishEditLock(next.editLock);
  } catch (err) {
    console.warn('[agent-prefs] localStorage 저장 실패:', err);
    return {
      ok: false,
      value: next,
      error: err instanceof Error ? err.message : String(err),
    };
  }
  return { ok: true, value: next };
}

export const AGENT_PREFS_STORAGE_KEY = STORAGE_KEY;

/** 편집 중 잠금은 도구 호출마다 읽는다 — 저장소를 매번 풀지 않게 한 번 읽어 두고, 저장하면 바꾼다. */
let cachedEditLock: AgentEditLock | null = null;
const editLockListeners = new Set<(lock: AgentEditLock) => void>();

function publishEditLock(lock: AgentEditLock): void {
  if (cachedEditLock === lock) return;
  cachedEditLock = lock;
  for (const listener of editLockListeners) {
    try { listener(lock); } catch (error) { console.warn('[agent-prefs] 편집 잠금 리스너 오류:', error); }
  }
}

export function currentAgentEditLock(): AgentEditLock {
  if (cachedEditLock !== null) return cachedEditLock;
  try {
    const raw = resolveStorage()?.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) as Record<string, unknown> | null : null;
    cachedEditLock = normalizeEditLock(parsed?.['editLock']);
  } catch {
    cachedEditLock = DEFAULT_AGENT_EDIT_LOCK;
  }
  return cachedEditLock;
}

/** 편집 중 잠금 설정이 바뀌면 부른다(이 창에서 저장했거나 다른 창이 저장했다). */
export function onAgentEditLockChange(listener: (lock: AgentEditLock) => void): () => void {
  editLockListeners.add(listener);
  return () => { editLockListeners.delete(listener); };
}

if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  window.addEventListener('storage', (event) => {
    if (event.key !== STORAGE_KEY) return;
    try {
      publishEditLock(normalizeEditLock((event.newValue ? JSON.parse(event.newValue) as Record<string, unknown> : null)?.['editLock']));
    } catch {
      publishEditLock(DEFAULT_AGENT_EDIT_LOCK);
    }
  });
}

/** 사용자가 설정 탭에서 고른 값이 저장돼 있는지. 빈 프로필·깨진 JSON 은 false. */
export function hasExplicitDefaultAgent(storage?: AgentPrefsStorage | null): boolean {
  const store = resolveStorage(storage);
  if (!store) return false;
  try {
    const raw = store.getItem(STORAGE_KEY);
    if (!raw) return false;
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
    return isAgentName((parsed as Record<string, unknown>)['defaultAgent']);
  } catch {
    return false;
  }
}

/** 첫 실행이 끝날 때 쓸 기본 프로바이더 — 처음 연결한 프로바이더, 없으면 기본값. */
export function firstRunDefaultAgent(configured: readonly AgentName[]): AgentName {
  return configured[0] ?? DEFAULT_CHAT_AGENT;
}

/**
 * 저장된 선택이 없을 때만 첫 실행 결과를 기본값으로 심는다.
 * 이미 Codex 등을 고른 프로필은 그대로 둔다.
 */
export function applyFirstRunDefaultAgent(
  configured: readonly AgentName[],
  storage?: AgentPrefsStorage | null,
): AgentPrefs {
  if (hasExplicitDefaultAgent(storage)) return loadAgentPrefs(storage);
  return saveAgentPrefs({ defaultAgent: firstRunDefaultAgent(configured) }, storage);
}
