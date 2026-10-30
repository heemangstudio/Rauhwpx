import type { HmCore } from './core';
import { loadExtensionViewerSettings } from '../extension-settings';
import { extendBridge } from './api';

/** 파일 연결이 끝난 뒤에만 도구 모음이 글꼴 변경을 보낸다. */
export async function prepareFontFamilies(core: HmCore, names: string[]): Promise<void> {
  await core.adapter.hmPrepareFontFamilies(names, await loadExtensionViewerSettings());
}

extendBridge({ prepareFontFamilies });
