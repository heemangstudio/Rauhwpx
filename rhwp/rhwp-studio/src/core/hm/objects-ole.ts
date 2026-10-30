/** 본문 OLE 수식을 같은 개체 슬롯의 편집 가능한 수식으로 바꾼다. */
import type { EditOp } from '../../../vendor/hm-wasm/hm_wasm';
import type { HmCore } from './core';
import { extendBridge } from './api';
export function promoteOleEquation(core: HmCore, sec: number, para: number, ci: number) {
  const object = { section: sec, para, control: ci };
  core.transact([{ op: 'promoteOleEquation', object } as unknown as EditOp]);
  const equation = core.query<{ script: string }>({ kind: 'equation', object });
  return { ok: true, paraIdx: para, controlIdx: ci, script: equation.script };
}
extendBridge({ promoteOleEquation });
