import type { EditorScalarSettings } from '../../core/user-settings.ts';

export const SETTINGS_DESTINATIONS = ['editing', 'theme', 'ai', 'rau', 'browser', 'skills', 'project', 'archive', 'account'] as const;
export type SettingsDestination = (typeof SETTINGS_DESTINATIONS)[number];

/** AI 설정 아래의 세부 탭. */
export const AI_SETTINGS_SECTIONS = ['connection', 'usage', 'custom'] as const;
export type AiSettingsSection = (typeof AI_SETTINGS_SECTIONS)[number];

/** 이전 설정 링크와 세션 값에서 사용하던 이름. 연결 탭은 AI 로, 라이선스 탭은 계정으로 간다. */
export type LegacySettingsDestination = 'connections' | 'license';

/** AI 세부 탭을 바로 여는 주소. */
export type AiSettingsDestination = `ai-${AiSettingsSection}`;

/** 외부 호출자가 넘길 수 있는 현재 이름, 이전 이름, AI 세부 탭 주소의 합집합. */
export type SettingsDestinationInput = SettingsDestination | LegacySettingsDestination | AiSettingsDestination;

/** 주소가 가리키는 AI 세부 탭. AI 세부 탭 주소가 아니면 undefined. */
export function aiSettingsSection(value: unknown): AiSettingsSection | undefined {
  if (value === 'connections') return 'connection';
  if (typeof value !== 'string' || !value.startsWith('ai-')) return undefined;
  const section = value.slice(3);
  return AI_SETTINGS_SECTIONS.find((candidate) => candidate === section);
}

/** 이전 연결 탭과 AI 세부 탭 주소는 AI 탭으로, 이전 라이선스 탭은 계정 탭으로 보낸다. */
export function normalizeSettingsDestination(value: unknown): SettingsDestination | undefined {
  if (aiSettingsSection(value)) return 'ai';
  if (value === 'license') return 'account';
  return SETTINGS_DESTINATIONS.some((destination) => destination === value)
    ? value as SettingsDestination
    : undefined;
}

export function isSettingsDestination(value: unknown): value is SettingsDestinationInput {
  // Keep the legacy and AI section values accepted by URL/event callers; consumers that need
  // the canonical pane id should call normalizeSettingsDestination().
  return normalizeSettingsDestination(value) !== undefined;
}

export interface EditorSettingsRuntime {
  /** 문서 보기 상태를 저장 없이 현재 창에 반영한다. 테마는 core/theme.ts 가 직접 건다. */
  preview(settings: EditorScalarSettings): void;
  /** 저장 뒤 자동저장, 메뉴, 글꼴 목록 같은 소비자를 갱신한다. */
  committed(settings: EditorScalarSettings): void;
}

export type DirtyExitChoice = 'apply' | 'discard' | 'continue';

export function cloneEditorDraft(settings: EditorScalarSettings): EditorScalarSettings {
  return {
    font: { ...settings.font },
    dialog: { ...settings.dialog },
    view: { ...settings.view },
    versionControl: { ...settings.versionControl },
    autosave: { ...settings.autosave },
  };
}

export function editorDraftEquals(
  left: EditorScalarSettings,
  right: EditorScalarSettings,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/** 한컴 보기 계약을 초안 단계에서도 지켜 미리보기와 저장값이 어긋나지 않게 한다. */
export function normalizeEditorDraft(settings: EditorScalarSettings): EditorScalarSettings {
  const normalized = cloneEditorDraft(settings);
  normalized.font.recentFontCount = Math.min(
    5,
    Math.max(1, Math.round(normalized.font.recentFontCount || 3)),
  );
  normalized.autosave.recoveryIntervalMinutes = Math.min(
    120,
    Math.max(1, Math.round(normalized.autosave.recoveryIntervalMinutes || 10)),
  );
  normalized.autosave.idleDelaySeconds = Math.min(
    600,
    Math.max(5, Math.round(normalized.autosave.idleDelaySeconds || 10)),
  );
  if (normalized.view.showControlCodes) normalized.view.showParagraphMarks = true;
  if (!normalized.view.showParagraphMarks) normalized.view.showControlCodes = false;
  return normalized;
}
