/** 그림 리사이즈 이력이 쓰는 개체별 네이티브 변환 보관함. */
import type { HmCore } from './core';
import { unsupported } from './core';
import { extendBridge } from './api';
import { objectAddress, objectAddressByPath } from './objects-editing';
import type { CellPathLike } from './bridge-types';
import type * as original from './document';

interface Handle { instance: number; native: number }
const journals = new WeakMap<HmCore, { next: number; handles: Map<number, Handle> }>();
function journal(core: HmCore) {
  let value = journals.get(core);
  if (!value) { value = { next: 1, handles: new Map() }; journals.set(core, value); }
  return value;
}
export const capturePictureTransform: typeof original.capturePictureTransform = (core, target) => {
  if (target.noteRef || target.memoRef) throw unsupported('capturePictureTransform.furniture');
  const section = Number(target.sec), parent = Number(target.ppi), control = Number(target.innerControlIdx ?? target.ci);
  const headerFooter = target.headerFooter as { outerParaIdx: number; outerControlIdx: number } | undefined;
  let address = objectAddress(section, parent, control);
  // 머리말·꼬리말 그림: 문단·컨트롤 번호는 바깥 머리말·꼬리말 목록 안의 번호다.
  if (headerFooter) address = { section, steps: [{ para: headerFooter.outerParaIdx, control: headerFooter.outerControlIdx, index: 0 }], para: parent, control };
  else if (Array.isArray(target.cellPath) && target.cellPath.length) address = objectAddressByPath(section, parent, target.cellPath as CellPathLike, control);
  else if (target.cellIdx !== undefined) address = {
    section, steps: [{ para: parent, control: Number(target.outerTableControlIdx ?? target.ci), index: Number(target.cellIdx) }],
    para: Number(target.cellParaIdx ?? 0), control,
  };
  const native = core.call(doc => doc.captureObjectTransform(JSON.stringify(address)));
  const store = journal(core);
  const id = store.next++;
  store.handles.set(id, { instance: core.adapter.documentInstance, native });
  return id;
};
export const swapPictureTransform: typeof original.swapPictureTransform = (core, id) => {
  const handle = journal(core).handles.get(id);
  if (!handle || handle.instance !== core.adapter.documentInstance) throw new Error('그림 변환 보관함이 현재 문서에 없습니다');
  core.mutate(doc => doc.swapObjectTransform(handle.native));
};
export const discardPictureTransform: typeof original.discardPictureTransform = (core, id) => {
  const store = journal(core);
  const handle = store.handles.get(id);
  if (!handle) return;
  store.handles.delete(id);
  if (handle.instance === core.adapter.documentInstance && core.hasDocument()) core.call(doc => doc.discardObjectTransform(handle.native));
};

extendBridge({ capturePictureTransform, swapPictureTransform, discardPictureTransform });
