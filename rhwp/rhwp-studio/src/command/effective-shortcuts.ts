/**
 * 실제로 쓰는 단축키 표 — 기본 표(shortcut-map.ts) 위에 사용자 지정(shortcut-overrides.ts)을 얹는다.
 *
 * 입력 처리기와 전역 단축키는 모두 matchEffectiveShortcut() 으로 키를 찾는다. 메뉴·명령 팔레트·
 * 컨텍스트 메뉴·네이티브 메뉴·도구 막대 표시는 shortcutLabelFor() 하나로 읽는다. 사용자 지정이
 * 없으면 기본 표와 기본 표시가 그대로다.
 */

import { defaultShortcuts, matchShortcut, type ShortcutDef } from './shortcut-map.ts';
import { chordLabelsFor } from './chord-map.ts';
import {
  bindingIdOf,
  bindingToShortcutDef,
  configurableCommandIds,
  formatBindingLabel,
  LOCKED_SHORTCUT_COMMANDS,
  parseBindingId,
  reservedReason,
  SHORTCUT_ERROR_UNSUPPORTED,
  type BindingId,
} from './shortcut-bindings.ts';
import {
  defaultBindingIdsByCommand,
  emptyShortcutOverrides,
  loadShortcutOverrides,
  MAX_ADDS_PER_COMMAND,
  MAX_TOTAL_BINDING_IDS,
  resolveShortcutStorage,
  SHORTCUT_OVERRIDES_KEY,
  trySaveShortcutOverrides,
  type CommandOverride,
  type ShortcutOverrides,
  type ShortcutStorage,
} from './shortcut-overrides.ts';
import { detectPlatformKind, type PlatformKind } from '../engine/navigation-keymap.ts';
import type { CommandDef } from './types.ts';

type ShortcutTable = readonly (readonly [ShortcutDef, string])[];

export interface CommandBinding { id: BindingId; source: 'default' | 'user' }

export type BindingCheck =
  | { kind: 'ok' }
  | { kind: 'same' }
  | { kind: 'reserved'; reason: string }
  | { kind: 'locked'; owner: string }
  | { kind: 'conflict'; owner: string };

export type SaveResult = { ok: true } | { ok: false; error: string };

export interface ShortcutService {
  table(): readonly [ShortcutDef, string][];
  bindings(commandId: string): CommandBinding[];
  isCustomized(commandId: string): boolean;
  customizedCount(): number;
  readOnly(): boolean;
  ownerOf(id: BindingId): string | null;
  conflicts(): Map<BindingId, string[]>;
  check(commandId: string, id: BindingId, platform?: PlatformKind): BindingCheck;
  assign(commandId: string, id: BindingId, opts?: { replace?: BindingId; takeFrom?: string }): SaveResult;
  remove(commandId: string, id: BindingId): SaveResult;
  resetCommand(commandId: string): SaveResult;
  resetAll(): SaveResult;
  subscribe(fn: (source: 'local' | 'external') => void): () => void;
  dispose(): void;
}

export const SHORTCUT_READ_ONLY = '새 버전에서 저장한 단축키 설정이라 이 버전에서는 바꿀 수 없습니다.';
export const SHORTCUT_LOCKED = '앱 메뉴가 쓰는 키라 바꿀 수 없습니다.';
export const SHORTCUT_CONFLICT = '다른 명령에 지정된 키입니다.';
export const SHORTCUT_TOO_MANY = '더 지정할 수 없습니다.';

let knownCommandIds: Set<string> | null = null;
function isKnownCommand(commandId: string, defaults: ShortcutTable): boolean {
  knownCommandIds ??= new Set(configurableCommandIds());
  return knownCommandIds.has(commandId) || defaults.some(([, id]) => id === commandId);
}

/** 고정 명령이 기본으로 쓰는 키 (되돌리기 Ctrl+Z 등). 사용자 추가 키가 이 키를 가로채지 못한다. */
function lockedBindingIds(defaults: ShortcutTable, locked: ReadonlyMap<string, string>): Set<BindingId> {
  const ids = new Set<BindingId>();
  for (const [def, commandId] of defaults) {
    if (!locked.has(commandId)) continue;
    const id = bindingIdOf(def);
    if (id) ids.add(id);
  }
  return ids;
}

/**
 * 사용자 추가 키 가운데 실제로 쓸 것. check() 가 막는 키(고정 명령의 키, 편집기·브라우저 예약 키)는
 * 손으로 고친 저장값에 있어도 표에 넣지 않는다 — 저장값은 그대로 둔다.
 */
function usableAdds(
  entry: CommandOverride | undefined,
  lockedIds: ReadonlySet<BindingId>,
  platform: PlatformKind,
): BindingId[] {
  return (entry?.add ?? []).filter(id => !lockedIds.has(id) && !reservedReason(id, platform));
}

/**
 * 실제 표를 만든다. 순서는 모든 명령의 사용자 추가 키가 먼저, 그다음 기본 행이다. 기본 행은 그 명령의
 * remove 목록에 있을 때만 빠지고, 자모·code 쌍둥이를 그대로 지녀 기본 매칭이 이전과 같다.
 * 고정 명령과 알 수 없는 명령의 사용자 지정, 고정 명령의 키나 예약 키를 가져간 사용자 추가 키는 무시한다.
 */
export function buildEffectiveShortcuts(
  defaults: ShortcutTable,
  overrides: ShortcutOverrides,
  locked: ReadonlyMap<string, string> = LOCKED_SHORTCUT_COMMANDS,
  platform: PlatformKind = detectPlatformKind(),
): [ShortcutDef, string][] {
  const table: [ShortcutDef, string][] = [];
  const removed = new Map<string, Set<BindingId>>();
  const lockedIds = lockedBindingIds(defaults, locked);
  for (const [commandId, entry] of Object.entries(overrides.commands)) {
    if (locked.has(commandId) || !isKnownCommand(commandId, defaults)) continue;
    if (entry.remove.length) removed.set(commandId, new Set(entry.remove));
    for (const id of usableAdds(entry, lockedIds, platform)) {
      const def = bindingToShortcutDef(id);
      if (def) table.push([def, commandId]);
    }
  }
  for (const [def, commandId] of defaults) {
    const drop = removed.get(commandId);
    if (drop) {
      const id = bindingIdOf(def);
      if (id && drop.has(id)) continue;
    }
    table.push([def, commandId]);
  }
  return table;
}

function cloneOverrides(overrides: ShortcutOverrides): ShortcutOverrides {
  const commands: Record<string, CommandOverride> = {};
  for (const [commandId, entry] of Object.entries(overrides.commands)) {
    commands[commandId] = { add: [...entry.add], remove: [...entry.remove] };
  }
  return { version: 1, commands };
}

/** 저장소가 없을 때(테스트·막힌 저장소) 이 창 안에서만 쓰는 저장소 */
function memoryStorage(): ShortcutStorage {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, String(value)); },
    removeItem: (key) => { values.delete(key); },
  };
}

type StorageEventTarget = Pick<Window, 'addEventListener' | 'removeEventListener'>;

/** 다른 창이 rhwp-shortcuts 를 바꾸거나 저장소를 비우면 onExternal 을 부른다. 다른 키는 무시한다. */
export function windowStorageListener(
  onExternal: () => void,
  target: StorageEventTarget | undefined = typeof window === 'undefined' ? undefined : window,
): () => void {
  if (!target || typeof target.addEventListener !== 'function') return () => {};
  const handler = (event: Event) => {
    // key 가 null 이면 localStorage.clear() 다.
    const { key } = event as StorageEvent;
    if (key === SHORTCUT_OVERRIDES_KEY || key === null) onExternal();
  };
  target.addEventListener('storage', handler);
  return () => target.removeEventListener('storage', handler);
}

export function createShortcutService(opts: {
  storage?: ShortcutStorage | null;
  defaults?: ShortcutTable;
  listen?: (onExternal: () => void) => () => void;
} = {}): ShortcutService {
  const defaults = opts.defaults ?? defaultShortcuts;
  const sharedStorage = opts.storage === undefined ? resolveShortcutStorage() : opts.storage;
  const storage = sharedStorage ?? memoryStorage();
  const defaultIds = defaultBindingIdsByCommand(defaults);
  const locked = LOCKED_SHORTCUT_COMMANDS;
  const listeners = new Set<(source: 'local' | 'external') => void>();

  let { overrides, readOnly } = loadShortcutOverrides(storage, defaults);
  let cached: [ShortcutDef, string][] | null = null;

  const table = () => (cached ??= buildEffectiveShortcuts(defaults, overrides, locked));
  const notify = (source: 'local' | 'external') => {
    for (const listener of [...listeners]) {
      try {
        listener(source);
      } catch (error) {
        console.warn('[shortcuts] 단축키 변경 알림 실패:', error);
      }
    }
  };
  const reload = () => {
    ({ overrides, readOnly } = loadShortcutOverrides(storage, defaults));
    cached = null;
    notify('external');
  };
  // 다른 창(같은 출처)의 저장은 storage 이벤트로 따라간다. 주입한 저장소에는 listen 을 함께 넣는다.
  const listen = opts.listen ?? (opts.storage === undefined && sharedStorage ? (fn: () => void) => windowStorageListener(fn) : null);
  const stopListening = listen ? listen(reload) : () => {};

  const ownDefaults = (commandId: string) => defaultIds.get(commandId) ?? new Set<BindingId>();
  const isActiveOverride = (commandId: string) => !locked.has(commandId) && isKnownCommand(commandId, defaults);
  const lockedIds = lockedBindingIds(defaults, locked);
  const addsOf = (entry: CommandOverride | undefined) => usableAdds(entry, lockedIds, detectPlatformKind());

  const bindings = (commandId: string): CommandBinding[] => {
    const out: CommandBinding[] = [];
    const seen = new Set<BindingId>();
    const entry = isActiveOverride(commandId) ? overrides.commands[commandId] : undefined;
    for (const id of addsOf(entry)) {
      if (seen.has(id)) continue;
      seen.add(id);
      out.push({ id, source: 'user' });
    }
    const removed = new Set(entry?.remove ?? []);
    for (const [def, owner] of defaults) {
      if (owner !== commandId) continue;
      const id = bindingIdOf(def);
      if (!id || seen.has(id) || removed.has(id)) continue;
      seen.add(id);
      out.push({ id, source: 'default' });
    }
    return out;
  };

  const isCustomized = (commandId: string): boolean => {
    if (!isActiveOverride(commandId)) return false;
    const entry = overrides.commands[commandId];
    if (!entry) return false;
    const own = ownDefaults(commandId);
    return addsOf(entry).length > 0 || entry.remove.some(id => own.has(id));
  };

  const ownerOf = (id: BindingId): string | null => {
    const canonical = parseBindingId(id);
    if (!canonical) return null;
    for (const [def, commandId] of table()) {
      if (bindingIdOf(def) === canonical) return commandId;
    }
    return null;
  };

  const check = (commandId: string, id: BindingId, platform: PlatformKind = detectPlatformKind()): BindingCheck => {
    const canonical = parseBindingId(id);
    if (!canonical) return { kind: 'reserved', reason: SHORTCUT_ERROR_UNSUPPORTED };
    if (locked.has(commandId)) return { kind: 'locked', owner: commandId };
    if (bindings(commandId).some(binding => binding.id === canonical)) return { kind: 'same' };
    const owner = ownerOf(canonical);
    if (owner && locked.has(owner)) return { kind: 'locked', owner };
    // 그 명령의 기본 키는 예약 목록과 겹쳐도(macOS Cmd+H 등) 언제나 되살릴 수 있다.
    if (!ownDefaults(commandId).has(canonical)) {
      const reason = reservedReason(canonical, platform);
      if (reason) return { kind: 'reserved', reason };
    }
    if (owner && owner !== commandId) return { kind: 'conflict', owner };
    return { kind: 'ok' };
  };

  const entryOf = (next: ShortcutOverrides, commandId: string): CommandOverride => {
    let entry = next.commands[commandId];
    if (!entry) next.commands[commandId] = entry = { add: [], remove: [] };
    return entry;
  };
  /** 명령에서 키 하나를 뺀다. 사용자 추가 키면 지우고, 기본 키면 remove 에 적는다. */
  const dropBinding = (next: ShortcutOverrides, commandId: string, id: BindingId) => {
    const entry = entryOf(next, commandId);
    entry.add = entry.add.filter(other => other !== id);
    if (ownDefaults(commandId).has(id) && !entry.remove.includes(id)) entry.remove.push(id);
  };
  /** 명령에 키 하나를 더한다. 지운 기본 키면 remove 에서 빼기만 한다. */
  const addBinding = (next: ShortcutOverrides, commandId: string, id: BindingId) => {
    const entry = entryOf(next, commandId);
    if (ownDefaults(commandId).has(id)) entry.remove = entry.remove.filter(other => other !== id);
    else if (!entry.add.includes(id)) entry.add.push(id);
  };

  const commit = (next: ShortcutOverrides): SaveResult => {
    let total = 0;
    for (const [commandId, entry] of Object.entries(next.commands)) {
      if (entry.add.length === 0 && entry.remove.length === 0) {
        delete next.commands[commandId];
        continue;
      }
      if (entry.add.length > MAX_ADDS_PER_COMMAND) return { ok: false, error: SHORTCUT_TOO_MANY };
      total += entry.add.length + entry.remove.length;
    }
    if (total > MAX_TOTAL_BINDING_IDS) return { ok: false, error: SHORTCUT_TOO_MANY };
    const saved = trySaveShortcutOverrides(next, storage);
    if (!saved.ok) return saved;
    overrides = next;
    cached = null;
    notify('local');
    return { ok: true };
  };

  const writable = (commandId?: string): SaveResult | null => {
    if (readOnly) return { ok: false, error: SHORTCUT_READ_ONLY };
    if (commandId !== undefined && locked.has(commandId)) return { ok: false, error: SHORTCUT_LOCKED };
    return null;
  };

  return {
    table,
    bindings,
    isCustomized,
    customizedCount: () => Object.keys(overrides.commands).filter(isCustomized).length,
    readOnly: () => readOnly,
    ownerOf,
    conflicts() {
      const owners = new Map<BindingId, string[]>();
      for (const [def, commandId] of table()) {
        const id = bindingIdOf(def);
        if (!id) continue;
        const list = owners.get(id);
        if (!list) owners.set(id, [commandId]);
        else if (!list.includes(commandId)) list.push(commandId);
      }
      for (const [id, list] of owners) if (list.length < 2) owners.delete(id);
      return owners;
    },
    check,
    assign(commandId, id, assignOpts = {}) {
      const blocked = writable(commandId);
      if (blocked) return blocked;
      const canonical = parseBindingId(id);
      if (!canonical) return { ok: false, error: SHORTCUT_ERROR_UNSUPPORTED };
      const replace = assignOpts.replace === undefined ? null : parseBindingId(assignOpts.replace);
      if (replace === canonical) return { ok: true };
      const result = check(commandId, canonical);
      if (result.kind === 'locked') return { ok: false, error: SHORTCUT_LOCKED };
      if (result.kind === 'reserved') return { ok: false, error: result.reason };
      if (result.kind === 'conflict' && assignOpts.takeFrom !== result.owner) {
        return { ok: false, error: SHORTCUT_CONFLICT };
      }
      if (result.kind === 'same' && !replace) return { ok: true };
      const next = cloneOverrides(overrides);
      if (replace) dropBinding(next, commandId, replace);
      if (result.kind === 'conflict') dropBinding(next, result.owner, canonical);
      if (result.kind !== 'same') addBinding(next, commandId, canonical);
      return commit(next);
    },
    remove(commandId, id) {
      const blocked = writable(commandId);
      if (blocked) return blocked;
      const canonical = parseBindingId(id);
      if (!canonical) return { ok: false, error: SHORTCUT_ERROR_UNSUPPORTED };
      const next = cloneOverrides(overrides);
      dropBinding(next, commandId, canonical);
      return commit(next);
    },
    resetCommand(commandId) {
      const blocked = writable(commandId);
      if (blocked) return blocked;
      const next = cloneOverrides(overrides);
      delete next.commands[commandId];
      // 되살아난 기본 키를 다른 명령이 사용자 추가로 가져갔으면 거기서 뺀다 — 기본값 되돌리기가 키를 실제로 되찾는다.
      const restored = ownDefaults(commandId);
      for (const [otherId, entry] of Object.entries(next.commands)) {
        if (otherId === commandId) continue;
        entry.add = entry.add.filter(other => !restored.has(other));
      }
      return commit(next);
    },
    resetAll() {
      const blocked = writable();
      if (blocked) return blocked;
      return commit(emptyShortcutOverrides());
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => { listeners.delete(fn); };
    },
    dispose() {
      stopListening();
      listeners.clear();
    },
  };
}

/** 앱 전체가 쓰는 단축키 서비스 */
export const shortcuts: ShortcutService = createShortcutService();

const recorders = new Set<() => boolean>();

/**
 * 단축키 설정이 키를 기록(또는 키로 찾기)하는 동안 true. 기록기보다 먼저 등록된 window 캡처 처리기
 * (사이드바 ⌃⌘S·⌃⌘J, Ctrl+Tab 문서 전환)는 이 값을 보고 키를 기록기에 넘긴다.
 */
export function isShortcutRecording(): boolean {
  for (const live of recorders) if (live()) return true;
  return false;
}

/**
 * 기록기를 등록한다. live() 는 지금도 키를 받는지 — 문서 탭을 바꿔 설정 화면이 떨어져 나가면 false 를
 * 돌려 다른 처리기를 막지 않는다. 돌려준 함수로 등록을 푼다.
 */
export function trackShortcutRecording(live: () => boolean): () => void {
  recorders.add(live);
  return () => { recorders.delete(live); };
}

/** KeyboardEvent 에 맞는 실제(사용자 지정 반영) 단축키 명령 ID. 없으면 null. */
export function matchEffectiveShortcut(e: KeyboardEvent, platform?: PlatformKind): string | null {
  return matchShortcut(e, shortcuts.table(), platform);
}

/**
 * 메뉴·팔레트·컨텍스트 메뉴·네이티브 메뉴·도구 막대에 보일 단축키 표기 (formatShortcutLabel 전 형태).
 * - 사용자 지정이 없으면 def.shortcutLabel 그대로 (연속 키 표기·메뉴 안 한 글자 키 포함).
 * - 사용자 지정이 있으면 실제 표의 첫 키 ('Ctrl+Shift+B').
 * - 사용자 지정으로 키가 하나도 남지 않으면 연속 키·한 글자 키 표기, 그것도 없으면 null (표시 지우기).
 */
export function shortcutLabelFor(
  commandId: string,
  def?: Pick<CommandDef, 'shortcutLabel'>,
  service: ShortcutService = shortcuts,
): string | null | undefined {
  if (!service.isCustomized(commandId)) return def?.shortcutLabel;
  const first = service.bindings(commandId)[0];
  if (first) return formatBindingLabel(first.id);
  const own = def?.shortcutLabel;
  if (own && (own.includes(',') || /^[A-Z0-9]$/.test(own))) return own;
  return chordLabelsFor(commandId)[0] ?? null;
}
