/**
 * 양식 개체(명령 단추·선택 상자·라디오 단추·콤보 상자·입력 상자)의 값 읽기·쓰기와 쪽 위 hit-test.
 * 엔진 controls 질의가 양식마다 form 기록을 주고, 값은 setFormValue 한 번으로 바꾼다.
 */
import type { EditOp, Step } from '../../../vendor/hm-wasm/hm_wasm';
import type { HmCore } from './core';
import { px } from './core';
import { extendBridge } from './api';
import type { FormObjectHitResult, FormObjectInfoResult, FormValueResult } from '../types';

interface FormRecord {
  formType: string; name: string; value: number; text: string; caption: string; enabled: boolean;
  width: number; height: number; foreColor: number; backColor: number; properties: Record<string, string>; items: string[];
}
interface FormControl { target: { section: number; steps?: Step[]; para: number; control: number }; offset: number; form: FormRecord }

const cache = new WeakMap<HmCore, { tag: string; forms: FormControl[] }>();

/** 문서의 모든 양식. 내용이 바뀔 때만 다시 묻는다. */
function forms(core: HmCore): FormControl[] {
  const tag = `${core.adapter.documentInstance}:${core.state().contentEpoch}`;
  const hit = cache.get(core);
  if (hit?.tag === tag) return hit.forms;
  const found = core.query<Array<FormControl & { form?: FormRecord }>>({ kind: 'controls' }).filter(c => c.form);
  cache.set(core, { tag, forms: found });
  return found;
}

function bodyForm(core: HmCore, sec: number, para: number, ci: number): FormControl | undefined {
  return forms(core).find(f => f.target.section === sec && !f.target.steps?.length && f.target.para === para && f.target.control === ci);
}

function cellForm(core: HmCore, sec: number, tablePara: number, tableCi: number, cellIdx: number, cellPara: number, formCi: number): FormControl | undefined {
  return forms(core).find(f => {
    const step = f.target.steps?.length === 1 ? f.target.steps[0] : undefined;
    return f.target.section === sec && step?.para === tablePara && step.control === tableCi && step.index === cellIdx
      && f.target.para === cellPara && f.target.control === formCi;
  });
}

const valueOf = (f: FormRecord): FormValueResult => ({
  ok: true, formType: f.formType, name: f.name, value: f.value, text: f.text, caption: f.caption, enabled: f.enabled,
});

export function getFormValue(core: HmCore, sec: number, para: number, ci: number): FormValueResult {
  const found = bodyForm(core, sec, para, ci);
  return found ? valueOf(found.form) : { ok: false };
}

export function getFormObjectInfo(core: HmCore, sec: number, para: number, ci: number): FormObjectInfoResult {
  const found = bodyForm(core, sec, para, ci);
  if (!found) return { ok: false };
  const f = found.form;
  return { ...valueOf(f), width: f.width, height: f.height, foreColor: f.foreColor, backColor: f.backColor, properties: f.properties, items: f.items };
}

function write(core: HmCore, found: FormControl | undefined, valueJson: string): { ok: boolean } {
  if (!found) return { ok: false };
  const parsed = JSON.parse(valueJson) as { value?: unknown; text?: unknown };
  const op: Record<string, unknown> = { op: 'setFormValue', target: found.target };
  if (typeof parsed.value === 'number') op.value = parsed.value;
  if (typeof parsed.text === 'string') op.text = parsed.text;
  if (op.value === undefined && op.text === undefined) return { ok: false };
  core.transact([op as unknown as EditOp]);
  return { ok: true };
}

export function setFormValue(core: HmCore, sec: number, para: number, ci: number, valueJson: string): { ok: boolean } {
  return write(core, bodyForm(core, sec, para, ci), valueJson);
}

export function setFormValueInCell(core: HmCore, sec: number, tablePara: number, tableCi: number, cellIdx: number, cellPara: number, formCi: number, valueJson: string): { ok: boolean } {
  return write(core, cellForm(core, sec, tablePara, tableCi, cellIdx, cellPara, formCi), valueJson);
}

/** 양식이 쪽에 그려진 상자. 양식 앞뒤 캐럿이 가로 범위를, 줄 아래에서 양식 높이가 세로 범위를 준다. */
function box(core: HmCore, f: FormControl, page: number): { x: number; y: number; w: number; h: number } | null {
  const list = { section: f.target.section, ...(f.target.steps?.length ? { steps: f.target.steps } : {}) };
  const before = core.caret({ ...list, para: f.target.para, offset: f.offset }, 'downstream', page);
  if (!before || before.page !== page) return null;
  const after = core.caret({ ...list, para: f.target.para, offset: f.offset + 8 }, 'upstream', page);
  const left = px(Math.min(before.x, after?.x ?? before.x));
  const right = px(Math.max(before.x, after?.x ?? before.x + f.form.width));
  const bottom = px(before.y + before.height);
  const h = Math.min(px(before.height), px(f.form.height)) || px(before.height);
  return { x: left, y: bottom - h, w: right - left, h };
}

export function getFormObjectAt(core: HmCore, pageNum: number, x: number, y: number): FormObjectHitResult {
  for (const f of forms(core)) {
    // 옛 API 는 본문과 한 겹 표 셀 안 양식만 가리킬 수 있다.
    if ((f.target.steps?.length ?? 0) > 1) continue;
    const top = f.target.steps?.[0]?.para ?? f.target.para;
    if (!core.lines({ section: f.target.section, steps: [] }, top).some(line => line.page === pageNum)) continue;
    const bbox = box(core, f, pageNum);
    if (!bbox || x < bbox.x || x > bbox.x + bbox.w || y < bbox.y || y > bbox.y + bbox.h) continue;
    const step = f.target.steps?.[0];
    const { form } = f;
    return {
      found: true, sec: f.target.section, para: step ? step.para : f.target.para, ci: f.target.control,
      formType: form.formType as FormObjectHitResult['formType'], name: form.name, value: form.value, caption: form.caption, text: form.text, bbox,
      ...(step ? { inCell: true, tablePara: step.para, tableCi: step.control, cellIdx: step.index, cellPara: f.target.para } : {}),
    };
  }
  return { found: false };
}

extendBridge({ getFormValue, getFormObjectInfo, setFormValue, setFormValueInCell, getFormObjectAt });
