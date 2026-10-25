import { extendBridge } from './api';
import type { HmCore } from './core';
import type { HmlOpenMetadata, HmlSaveState } from './bridge-types';

export function exportHml(core: HmCore): Uint8Array {
  return core.call(doc => doc.serializeAs('hml', false)).slice();
}

export function hasHmlExportCapability(_core: HmCore): boolean {
  return true;
}

export function getHmlSaveState(core: HmCore): HmlSaveState {
  return { sourceFormat: core.adapter.getSourceFormat(), hmlSavable: true, blockers: [] };
}

export function getHmlOpenMetadata(core: HmCore): HmlOpenMetadata | null {
  return core.adapter.hmHmlSourceMetadata();
}

extendBridge({ exportHml, hasHmlExportCapability, getHmlSaveState, getHmlOpenMetadata });
