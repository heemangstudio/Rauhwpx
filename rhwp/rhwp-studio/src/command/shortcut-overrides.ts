/**
 * 사용자 지정 단축키 저장소 — 기본 표(shortcut-map.ts)에 얹는 차이만 저장한다.
 *
 * localStorage `rhwp-shortcuts` 한 칸에 `{"version":1,"commands":{"format:bold":{"add":[…],"remove":[…]}}}`
 * 로 산다. `rhwp-settings` 와 칸을 나눠, 깨진 값이 다른 설정에 번지지 않는다. 기본 단축키는 코드에
 * 남으므로 새 기본값은 저절로 들어오고, 되돌리기는 항목을 지우는 것이다.
 *
 * 저장소는 주입할 수 있다(테스트). DOM 에 기대지 않는다.
 */

import { defaultShortcuts, type ShortcutDef } from './shortcut-map.ts';
import { bindingIdOf, parseBindingId, type BindingId } from './shortcut-bindings.ts';

export const SHORTCUT_OVERRIDES_KEY = 'rhwp-shortcuts';
export const SHORTCUT_OVERRIDES_VERSION = 1;
/** 명령 하나에 더할 수 있는 키 수 */
export const MAX_ADDS_PER_COMMAND = 16;
/** 저장소 전체 ID 수 (add + remove) */
export const MAX_TOTAL_BINDING_IDS = 1000;

export interface CommandOverride { add: BindingId[]; remove: BindingId[] }
export interface ShortcutOverrides { version: 1; commands: Record<string, CommandOverride> }

/** localStorage 최소 계약 — 테스트가 자기 저장소를 넣을 수 있게 뺐다. */
export interface ShortcutStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export const SHORTCUT_SAVE_FAILED = '저장하지 못했습니다. 저장 공간을 확인하세요.';

export function emptyShortcutOverrides(): ShortcutOverrides {
  return { version: 1, commands: {} };
}

export function resolveShortcutStorage(storage?: ShortcutStorage | null): ShortcutStorage | null {
  if (storage) return storage;
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}

/** 명령별 기본 바인딩 ID 집합 */
export function defaultBindingIdsByCommand(
  defaults: readonly (readonly [ShortcutDef, string])[] = defaultShortcuts,
): Map<string, Set<BindingId>> {
  const byCommand = new Map<string, Set<BindingId>>();
  for (const [def, commandId] of defaults) {
    const id = bindingIdOf(def);
    if (!id) continue;
    let ids = byCommand.get(commandId);
    if (!ids) byCommand.set(commandId, ids = new Set());
    ids.add(id);
  }
  return byCommand;
}

function bindingList(raw: unknown): BindingId[] {
  if (!Array.isArray(raw)) return [];
  const out: BindingId[] = [];
  for (const value of raw) {
    const id = parseBindingId(value);
    if (id && !out.includes(id)) out.push(id);
  }
  return out;
}

/**
 * 저장소에서 읽은 값을 검증한다. 잘못된 ID 는 하나씩 버리고, 중복은 합치고, 같은 명령의 기본 키를
 * 더한 항목은 "remove 에서 빼기"로 바꾸고, 빈 항목은 지운다. 알 수 없는 명령 ID 는 그대로 둔다
 * (이름이 바뀌거나 이전 버전으로 돌아가도 잃지 않게). 런타임은 그런 명령을 무시한다.
 */
export function normalizeShortcutOverrides(
  raw: unknown,
  defaults: readonly (readonly [ShortcutDef, string])[] = defaultShortcuts,
): ShortcutOverrides {
  const result = emptyShortcutOverrides();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return result;
  const commands = (raw as { commands?: unknown }).commands;
  if (!commands || typeof commands !== 'object' || Array.isArray(commands)) return result;

  const defaultIds = defaultBindingIdsByCommand(defaults);
  let total = 0;
  for (const [commandId, entry] of Object.entries(commands as Record<string, unknown>)) {
    if (!commandId || !entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const ownDefaults = defaultIds.get(commandId) ?? new Set<BindingId>();
    const record = entry as { add?: unknown; remove?: unknown };
    let remove = bindingList(record.remove);
    const add: BindingId[] = [];
    for (const id of bindingList(record.add)) {
      // 자기 기본 키를 다시 더한 것은 "지운 기본 키 되살리기"다.
      if (ownDefaults.has(id)) remove = remove.filter(other => other !== id);
      else add.push(id);
    }
    const cappedAdd = add.slice(0, MAX_ADDS_PER_COMMAND);
    const room = MAX_TOTAL_BINDING_IDS - total;
    if (room <= 0) break;
    const keptAdd = cappedAdd.slice(0, room);
    const keptRemove = remove.slice(0, Math.max(0, room - keptAdd.length));
    if (keptAdd.length === 0 && keptRemove.length === 0) continue;
    total += keptAdd.length + keptRemove.length;
    result.commands[commandId] = { add: keptAdd, remove: keptRemove };
  }
  return result;
}

/**
 * 저장된 사용자 지정을 읽는다. 깨진 JSON·객체가 아닌 값은 기본값(빈 사용자 지정)으로 읽는다 —
 * 다음 저장이 덮어쓴다. 더 새 버전이 저장한 값이면 readOnly 로 기본값만 쓰고 쓰지 않는다.
 */
export function loadShortcutOverrides(
  storage?: ShortcutStorage | null,
  defaults: readonly (readonly [ShortcutDef, string])[] = defaultShortcuts,
): { overrides: ShortcutOverrides; readOnly: boolean } {
  let raw: string | null = null;
  try {
    raw = resolveShortcutStorage(storage)?.getItem(SHORTCUT_OVERRIDES_KEY) ?? null;
  } catch {
    raw = null;
  }
  if (!raw) return { overrides: emptyShortcutOverrides(), readOnly: false };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { overrides: emptyShortcutOverrides(), readOnly: false };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { overrides: emptyShortcutOverrides(), readOnly: false };
  }
  const version = (parsed as { version?: unknown }).version;
  if (typeof version === 'number' && version > SHORTCUT_OVERRIDES_VERSION) {
    return { overrides: emptyShortcutOverrides(), readOnly: true };
  }
  return { overrides: normalizeShortcutOverrides(parsed, defaults), readOnly: false };
}

/** 한 번의 setItem 으로 쓴다. 비었으면 항목을 지운다. 실패하면 {ok:false} — 호출자는 메모리를 그대로 둔다. */
export function trySaveShortcutOverrides(
  overrides: ShortcutOverrides,
  storage?: ShortcutStorage | null,
): { ok: true } | { ok: false; error: string } {
  const store = resolveShortcutStorage(storage);
  if (!store) return { ok: false, error: SHORTCUT_SAVE_FAILED };
  try {
    if (Object.keys(overrides.commands).length === 0) store.removeItem(SHORTCUT_OVERRIDES_KEY);
    else store.setItem(SHORTCUT_OVERRIDES_KEY, JSON.stringify(overrides));
    return { ok: true };
  } catch {
    return { ok: false, error: SHORTCUT_SAVE_FAILED };
  }
}
