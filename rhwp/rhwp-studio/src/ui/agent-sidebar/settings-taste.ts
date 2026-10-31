// 설정 → Rau 의 "대화에서 배우기" 스위치. 학습은 호스팅 Rau 에서만 돌아서 공급자·모델은 고르지 않는다.
import type { SidebarBridge } from '../../agent/bridge.ts';
import type { TasteSettings } from '../../agent/types.ts';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export interface TasteLearningToggleDeps {
  bridge: Pick<SidebarBridge, 'requestTasteSettings' | 'setTasteSettings'>;
  isDisposed(): boolean;
}

export interface TasteLearningToggle {
  root: HTMLElement;
  /** 허브의 값(요청의 답이나 다른 창의 알림). 고르는 중인 요청의 답은 이 값이 덮는다. */
  accept(settings: TasteSettings | null): void;
  refresh(): Promise<void>;
}

export function createTasteLearningToggle(deps: TasteLearningToggleDeps): TasteLearningToggle {
  const root = el('label', 'ag-settings-control-row ag-settings-toggle-row ag-taste-learning-row');
  const copy = el('span', 'ag-settings-control-copy');
  copy.append(
    el('span', 'ag-settings-control-label', '대화에서 배우기'),
    el('span', 'ag-settings-control-description', '채팅에서 고친 말투와 용어를 기억에 쌓아요.'),
  );
  const input = el('input', 'ag-settings-toggle-input');
  input.type = 'checkbox';
  input.setAttribute('role', 'switch');
  input.setAttribute('aria-label', '대화에서 배우기');
  const track = el('span', 'ag-settings-toggle-track');
  track.setAttribute('aria-hidden', 'true');
  root.append(copy, input, track);

  // 허브가 답하기 전에는 기본값(켜짐)을 보이고 잠가 둔다.
  let settings: TasteSettings | null = null;
  let shown: TasteSettings = { enabled: true, provider: 'auto', model: null, effort: null };
  let saving = false;
  let request = 0;

  function render(): void {
    input.checked = shown.enabled;
    input.disabled = settings === null || saving;
  }

  function accept(next: TasteSettings | null): void {
    request += 1;
    saving = false;
    settings = next;
    if (next) shown = { ...next };
    render();
  }

  async function refresh(): Promise<void> {
    const seq = ++request;
    const next = await deps.bridge.requestTasteSettings();
    if (!deps.isDisposed() && seq === request) accept(next);
  }

  async function save(patch: Partial<TasteSettings>): Promise<void> {
    const seq = ++request;
    shown = { ...shown, ...patch };
    saving = true;
    render();
    const next = await deps.bridge.setTasteSettings(patch);
    if (deps.isDisposed() || seq !== request) return;
    // 저장하지 못했으면 허브의 값으로 되돌린다.
    if (next) accept(next);
    else {
      saving = false;
      if (settings) shown = { ...settings };
      void refresh();
    }
  }

  input.addEventListener('change', () => void save({ enabled: input.checked }));
  render();
  return { root, accept, refresh };
}
