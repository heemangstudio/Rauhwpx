/**
 * 자동 수정 데스크톱 API 의 미리보기 대역. 데스크톱 없이 단추의 세 결과와 설정을 보여 준다.
 * `?autofix=fixed|failed|unavailable` 은 켜 둔 상태로 그 결과를 돌려준다. `autofix=off` 는 답했지만 끈 상태,
 * `autofix=undecided` 는 아직 답하지 않은 상태(기존 사용자 소개 창이 뜬다). 없으면 웹 빌드처럼 API 가 없다.
 * 결과는 미리보기 단추의 'Autofix result' 나 `sidebarPreview.autofix.setOutcome()` 으로 바꾼다.
 */
import type {
  AutofixRequest,
  AutofixResult,
  AutofixSettings,
  AutofixStatus,
  DesktopAutofixApi,
} from '../ui/autofix/autofix.ts';

export const mockAutofixOutcomes = ['fixed', 'failed', 'unavailable'] as const;
const RUN_DELAY_MS = 2400;

export interface MockAutofix {
  api: DesktopAutofixApi;
  outcome(): AutofixStatus;
  setOutcome(outcome: AutofixStatus): void;
  /** 받은 요청들(최근 순서대로) */
  requests: AutofixRequest[];
  /** 고쳤다고 답할 때마다 부른다(미리보기의 고장 난 상태를 되돌린다). */
  onFixed(listener: () => void): void;
}

function defaultSettings(enabled: boolean, decided: boolean): AutofixSettings {
  return {
    enabled,
    decided,
    providers: [
      { id: 'codex', enabled: true, model: 'sol', effort: 'low' },
      { id: 'claude', enabled: true, model: 'claude-sonnet-5-5', effort: 'medium' },
    ],
  };
}

export function createMockAutofix(params: URLSearchParams): MockAutofix | null {
  const mode = params.get('autofix');
  if (!mode) return null;
  let outcome: AutofixStatus = mockAutofixOutcomes.includes(mode as AutofixStatus) ? mode as AutofixStatus : 'fixed';
  let settings = defaultSettings(mode !== 'off' && mode !== 'undecided', mode !== 'undecided');
  const listeners = new Set<(settings: AutofixSettings) => void>();
  const requests: AutofixRequest[] = [];
  const fixedListeners: Array<() => void> = [];
  const copy = (): AutofixSettings => ({ ...settings, providers: settings.providers.map((provider) => ({ ...provider })) });
  const api: DesktopAutofixApi = {
    run: (request) => new Promise<AutofixResult>((resolve) => {
      requests.push({ ...request });
      setTimeout(() => {
        if (outcome === 'fixed') for (const listener of fixedListeners) listener();
        resolve(outcome === 'fixed' ? { status: 'fixed', provider: 'codex' } : { status: outcome });
      }, RUN_DELAY_MS);
    }),
    getSettings: async () => copy(),
    setSettings: async (patch) => {
      settings = {
        ...settings,
        ...patch,
        providers: (patch.providers ?? settings.providers).map((provider) => ({ ...provider })),
      };
      const next = copy();
      for (const listener of [...listeners]) listener(copy());
      return next;
    },
    onChange: (callback) => {
      listeners.add(callback);
      return () => { listeners.delete(callback); };
    },
  };
  return {
    api,
    outcome: () => outcome,
    setOutcome: (next) => { outcome = next; },
    requests,
    onFixed: (listener) => { fixedListeners.push(listener); },
  };
}
