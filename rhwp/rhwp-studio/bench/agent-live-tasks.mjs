/**
 * 실측 과제 모음 — 샘플 문서 + 에이전트 모드 + 사용자 프롬프트 + 자동 채점.
 *
 * 채점은 턴 전후의 문서 스냅숏(본문 문단 텍스트·글자/문단 모양, 최상위 표 셀, 쪽 수)을 비교하는
 * 순수 함수다. 읽기 전용 과제는 마지막 답 텍스트를 본다. 점수는 0..1 이고 details 에 근거를 남긴다.
 * 과제 밖의 변경(의도하지 않은 편집)은 따로 세어 감점하고 details.unintended 로 보고한다.
 */
import { setTimeout as delay } from 'node:timers/promises';

// ─────────────────────────────────────────────────────────────────────────────
// 페이지 쪽 스냅숏
// ─────────────────────────────────────────────────────────────────────────────

/**
 * window.__wasm.doc(원시 HwpDocument)으로 문서를 읽는다. 에이전트 모드에서 보류 중인 편집도
 * 엔진에 바로 적용돼 있으므로(라이브 미리보기) 같은 함수로 미리보기 상태를 읽는다.
 */
export async function documentSnapshot(page) {
  return page.evaluate(() => {
    const doc = window.__wasm.doc;
    const J = (s) => (typeof s === 'string' ? JSON.parse(s) : s);
    const charAt = (sec, para, offset) => {
      try {
        const p = J(doc.getCharPropertiesAt(sec, para, offset));
        return { bold: p.bold === true, italic: p.italic === true, underline: Boolean(p.underline) && p.underline !== 'None', size: p.fontSize };
      } catch { return null; }
    };
    const body = [];
    const tables = [];
    for (let sec = 0; sec < doc.getSectionCount(); sec += 1) {
      const count = doc.getParagraphCount(sec);
      for (let para = 0; para < count; para += 1) {
        const length = doc.getParagraphLength(sec, para);
        const text = length > 0 ? doc.getTextRange(sec, para, 0, length) : '';
        const first = Math.max(0, text.search(/\S/));
        const lastIdx = (() => { for (let i = text.length - 1; i >= 0; i -= 1) if (/\S/.test(text[i])) return i; return 0; })();
        let pp = {};
        try { pp = J(doc.getParaPropertiesAt(sec, para)); } catch { /* 문단 모양 없음 */ }
        let page = null;
        try { page = J(doc.getPageOfPosition(sec, para)).page ?? null; } catch { /* 쪽 없음 */ }
        body.push({
          sec, para, text, page,
          f0: length > 0 ? charAt(sec, para, first) : null,
          fm: length > 0 ? charAt(sec, para, Math.floor((first + lastIdx) / 2)) : null,
          fl: length > 0 ? charAt(sec, para, lastIdx) : null,
          head: pp.headType ?? null,
          level: pp.paraLevel ?? null,
          numberingId: pp.numberingId ?? null,
          align: pp.alignment ?? null,
        });
        let controls = [];
        try { controls = J(doc.getControlTextPositions(sec, para)); } catch { /* 컨트롤 없음 */ }
        for (let ctrl = 0; ctrl < (Array.isArray(controls) ? controls.length : 0); ctrl += 1) {
          let dims;
          try { dims = J(doc.getTableDimensions(sec, para, ctrl)); } catch { continue; }
          const cells = [];
          for (let cell = 0; cell < dims.cellCount; cell += 1) {
            let info = {};
            try { info = J(doc.getCellInfo(sec, para, ctrl, cell)); } catch { /* 셀 정보 없음 */ }
            const parts = [];
            const n = doc.getCellParagraphCount(sec, para, ctrl, cell);
            for (let k = 0; k < n; k += 1) {
              const len = doc.getCellParagraphLength(sec, para, ctrl, cell, k);
              parts.push(len > 0 ? doc.getTextInCell(sec, para, ctrl, cell, k, 0, len) : '');
            }
            cells.push({ row: info.row ?? null, col: info.col ?? null, text: parts.join('\n') });
          }
          tables.push({ sec, para, ctrl, rows: dims.rowCount, cols: dims.colCount, cells });
        }
      }
    }
    let numberings = [];
    try { numberings = window.__wasm.getNumberingList(); } catch { /* 번호 목록 없음 */ }
    return { pageCount: doc.pageCount(), body, tables, numberings };
  });
}

/** 엔진에 직접 쓴 뒤 화면·리비전을 갱신한다 (턴 전 준비 단계에서만 쓴다). */
async function emitDocumentChanged(page) {
  await page.evaluate(() => new Promise((resolve) => {
    const timer = setTimeout(resolve, 3000);
    const off = window.__eventBus.on('document-layout-refreshed', () => { clearTimeout(timer); off?.(); resolve(); });
    window.__eventBus.emit('document-changed');
  }));
  await delay(300);
}

// ─────────────────────────────────────────────────────────────────────────────
// 비교 도우미
// ─────────────────────────────────────────────────────────────────────────────

const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const fmtKey = (p) => JSON.stringify([p.f0, p.fm, p.fl, p.head, p.level, p.numberingId, p.align]);
const countIn = (texts, term) => texts.reduce((n, t) => n + (t.split(term).length - 1), 0);
const allTexts = (snap) => [...snap.body.map((p) => p.text), ...snap.tables.flatMap((t) => t.cells.map((c) => c.text))];

/**
 * 본문 문단을 순서대로 맞춘다 — 삽입/삭제가 있어도 같은 문단끼리 짝을 짓는다 (LCS, 텍스트 기준).
 * 반환: 짝 목록 [{b, a}] 과 짝 없는 before/after 인덱스.
 */
function alignParagraphs(before, after, key = (p) => norm(p.text)) {
  const n = before.length;
  const m = after.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i][j] = key(before[i]) === key(after[j]) ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const pairs = [];
  const removed = [];
  const added = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (key(before[i]) === key(after[j])) { pairs.push({ b: i, a: j }); i += 1; j += 1; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { removed.push(i); i += 1; }
    else { added.push(j); j += 1; }
  }
  while (i < n) removed.push(i++);
  while (j < m) added.push(j++);
  return { pairs, removed, added };
}

/**
 * 과제 대상이 아닌 문단·표의 변경을 센다. isTarget(beforePara) 가 true 인 문단, expectText 로 기대 텍스트가
 * 정해진 문단은 그 기대와 비교한다. 짝이 맞는 문단은 서식도 본다 (checkFormat 이 false 면 텍스트만).
 */
function unintendedChanges(before, after, { isTarget = () => false, expectText = null, checkFormat = true, tolerate = [] } = {}) {
  const sameLength = before.body.length === after.body.length;
  const changed = [];
  const tolerated = (b, a) => tolerate.some((fn) => fn(b, a, expectText ?? ((p) => p.text)));
  if (sameLength) {
    for (let i = 0; i < before.body.length; i += 1) {
      const b = before.body[i];
      const a = after.body[i];
      if (isTarget(b, i)) continue;
      const want = expectText ? expectText(b) : b.text;
      if (norm(a.text) !== norm(want) && !tolerated(b, a)) changed.push({ at: `${b.sec}:${b.para}`, kind: 'text', before: b.text.slice(0, 80), after: a.text.slice(0, 80) });
      else if (checkFormat && fmtKey(a) !== fmtKey(b)) changed.push({ at: `${b.sec}:${b.para}`, kind: 'format', text: b.text.slice(0, 40) });
    }
  } else {
    const { removed, added } = alignParagraphs(before.body, after.body, (p) => norm(expectText ? expectText(p) : p.text));
    for (const i of removed) if (!isTarget(before.body[i], i)) changed.push({ at: `${before.body[i].sec}:${before.body[i].para}`, kind: 'removed', before: before.body[i].text.slice(0, 80) });
    for (const j of added) changed.push({ at: `after ${after.body[j].sec}:${after.body[j].para}`, kind: 'added', after: after.body[j].text.slice(0, 80) });
  }
  return changed;
}

function tableChanges(before, after, { skip = () => false } = {}) {
  const out = [];
  for (const t of before.tables) {
    if (skip(t)) continue;
    const match = after.tables.find((x) => x.cells.length === t.cells.length && x.cells.every((c, i) => norm(c.text) === norm(t.cells[i].text)));
    if (!match) out.push({ at: `table ${t.sec}:${t.para}#${t.ctrl}`, kind: 'table' });
  }
  return out;
}

/**
 * 낱말을 바꾸면 조사도 따라 바뀐다 (회사를 → 기업을, 회사라도 → 기업이라도). 바꾼 낱말 뒤의 조사를 지워 비교한다.
 */
function particleTolerant(term) {
  const re = new RegExp(`${term}(으로|이라도|이든|이나|이랑|이며|이고|을|를|이|가|은|는|과|와|로|라도|든|나|랑|며|고)?`, 'g');
  const strip = (text) => text.replace(re, term).replace(/\s+/g, '');
  return (b, a, expectText) => strip(expectText(b)) === strip(a.text);
}

const clamp01 = (x) => Math.max(0, Math.min(1, x));
const round3 = (x) => Math.round(x * 1000) / 1000;

// ─────────────────────────────────────────────────────────────────────────────
// 과제
// ─────────────────────────────────────────────────────────────────────────────

const TREATISE = 'basic/treatise sample.hwp';

/** 1~2쪽 본문에 넣을 오타. 원래 낱말은 그 문단에서 한 번만 나온다. */
const TYPOS = [
  { para: 5, word: '정의한다', typo: '정이한다' },
  { para: 10, word: '메인프레임', typo: '메인프래임' },
  { para: 11, word: '궁극적인', typo: '궁극젹인' },
  { para: 13, word: '워킹그룹', typo: '워킹그릅' },
  { para: 16, word: '권고하고', typo: '권고하교' },
  { para: 18, word: '커피숍', typo: '커피숖' },
];
/** 원문에 원래 있던 오타·띄어쓰기 — 고쳐도 감점하지 않는다. */
const PREEXISTING_FIXES = [
  ['Sercurity', 'Security'], ['보안이 기능이', '보안 기능이'], ['Dirver', 'Driver'],
  ['첫 째로', '첫째로'], ['존재 하는', '존재하는'], ['적용 되었는지', '적용되었는지'],
];
const tolerateKnownFixes = (b, a) => {
  let text = b.text;
  for (const [from, to] of PREEXISTING_FIXES) text = text.split(from).join(to);
  const strip = (s) => s.replace(/\s+/g, '');
  return strip(text) === strip(a.text) || strip(b.text) === strip(a.text);
};

const SUBHEADING = /^\s*\d+\.\s+\S/;

export const TASKS = [
  {
    id: 'typos',
    title: '오타 수정 (1~2쪽, 정답 있음)',
    sample: TREATISE,
    workflow: 'direct',
    permissionProfile: 'unrestricted',
    prompt: '1~2쪽 본문에 오타가 몇 군데 있어요. 찾아서 고쳐 주세요. 오타가 아닌 문장은 바꾸지 마세요.',
    async setup(page) {
      const injected = await page.evaluate((typos) => {
        const wasm = window.__wasm;
        const out = [];
        for (const t of typos) {
          const len = wasm.getParagraphLength(0, t.para);
          const text = wasm.getTextRange(0, t.para, 0, len);
          const at = text.indexOf(t.word);
          if (at < 0) { out.push({ ...t, ok: false }); continue; }
          const result = wasm.replaceText(0, t.para, at, t.word.length, t.typo);
          out.push({ ...t, ok: result?.ok !== false, offset: at });
        }
        return out;
      }, TYPOS);
      await emitDocumentChanged(page);
      const failed = injected.filter((t) => !t.ok);
      if (failed.length) throw new Error(`오타 주입 실패: ${failed.map((t) => t.word).join(', ')}`);
      return { injected };
    },
    check({ before, after }) {
      const texts = after.body.map((p) => p.text);
      const perTypo = TYPOS.map((t) => {
        const typoLeft = countIn(texts, t.typo);
        const restored = countIn(texts, t.word) >= countIn(before.body.map((p) => p.text), t.word) + 1;
        return { word: t.word, typo: t.typo, fixed: typoLeft === 0 && restored, typoLeft };
      });
      const fixed = perTypo.filter((t) => t.fixed).length;
      const typoParas = new Set(TYPOS.map((t) => t.para));
      const expectText = (b) => {
        if (!typoParas.has(b.para)) return b.text;
        let text = b.text;
        for (const t of TYPOS) if (t.para === b.para) text = text.replace(t.typo, t.word);
        return text;
      };
      const unintended = [
        ...unintendedChanges(before, after, { expectText, tolerate: [tolerateKnownFixes, (b, a) => typoParas.has(b.para) && tolerateKnownFixes({ text: expectText(b) }, a)] }),
        ...tableChanges(before, after),
      ];
      const recall = fixed / TYPOS.length;
      return {
        score: round3(clamp01(recall - 0.1 * unintended.length)),
        details: { fixed, injected: TYPOS.length, recall: round3(recall), unintended: unintended.length, perTypo, unintendedSamples: unintended.slice(0, 8) },
      };
    },
  },
  {
    id: 'subheadings',
    title: '소제목 서식 (굵게 + 12pt)',
    sample: TREATISE,
    workflow: 'direct',
    permissionProfile: 'unrestricted',
    prompt: "본문의 번호 소제목('1. Neighbor Discovery 보안모델' 같은 것)을 전부 굵게 하고 글자 크기를 12pt로 바꿔 주세요. 장 제목과 본문은 그대로 두세요.",
    check({ before, after }) {
      const targets = before.body.map((p, i) => ({ p, i })).filter(({ p }) => SUBHEADING.test(p.text) && p.f0?.size === 1150);
      const sameShape = before.body.length === after.body.length;
      const results = targets.map(({ p, i }) => {
        const a = sameShape ? after.body[i] : after.body.find((x) => norm(x.text) === norm(p.text));
        if (!a) return { text: p.text.slice(0, 30), bold: false, size: null, ok: false };
        const probes = [a.f0, a.fm, a.fl].filter(Boolean);
        const bold = probes.length > 0 && probes.every((f) => f.bold);
        const size = probes.length > 0 && probes.every((f) => f.size === 1200);
        return { text: p.text.slice(0, 30), bold, size: a.f0?.size ?? null, ok: bold && size && norm(a.text) === norm(p.text) };
      });
      const ok = results.filter((r) => r.ok).length;
      const targetSet = new Set(targets.map((t) => t.i));
      const unintended = [...unintendedChanges(before, after, { isTarget: (_b, i) => targetSet.has(i) }), ...tableChanges(before, after)];
      return {
        score: round3(clamp01(ok / targets.length - 0.05 * unintended.length)),
        details: {
          headings: targets.length,
          correct: ok,
          bold: results.filter((r) => r.bold).length,
          size12: results.filter((r) => r.size === 1200).length,
          unintended: unintended.length,
          wrong: results.filter((r) => !r.ok).slice(0, 6),
          unintendedSamples: unintended.slice(0, 8),
        },
      };
    },
  },
  {
    id: 'insert-summary',
    title: '정확한 위치에 문단 삽입 (제목 바로 아래)',
    sample: TREATISE,
    workflow: 'direct',
    permissionProfile: 'unrestricted',
    prompt: '논문 제목 바로 다음 줄에, 이 논문 내용을 한 문장으로 요약한 문단을 새로 하나 넣어 주세요. 다른 문단은 고치지 마세요.',
    check({ before, after }) {
      const { added, removed } = alignParagraphs(before.body, after.body);
      const titleAfter = after.body[0]?.text ?? '';
      const titleKept = norm(titleAfter) === norm(before.body[0].text);
      const isSummary = (text) => /[가-힣]/.test(text) && norm(text).length >= 15;
      const insertedAt = added.find((j) => isSummary(after.body[j].text));
      const position = insertedAt ?? null;
      let score = 0;
      if (position === 1 && titleKept) score = 1;
      else if (position !== undefined && position !== null && position <= 4) score = 0.5;
      else if (!titleKept && isSummary(titleAfter.replace(before.body[0].text, ''))) score = 0.3; // 제목 문단에 덧붙임
      const extraAdded = added.filter((j) => j !== position).length;
      const unintended = removed.length + extraAdded + tableChanges(before, after).length;
      return {
        score: round3(clamp01(score - 0.1 * unintended)),
        details: {
          insertedAt: position,
          titleKept,
          inserted: position !== null && position !== undefined ? after.body[position].text.slice(0, 160) : null,
          paragraphsBefore: before.body.length,
          paragraphsAfter: after.body.length,
          unintended,
          removed: removed.map((i) => before.body[i].text.slice(0, 60)).slice(0, 5),
        },
      };
    },
  },
  {
    id: 'table-row',
    title: '표 행 추가 + 셀 채우기',
    sample: TREATISE,
    workflow: 'direct',
    permissionProfile: 'unrestricted',
    prompt: 'SecParam별 측정 시간이 나온 표 맨 아래에 행을 하나 추가하고, SecParam 2 / 라우터 시스템 2.1 sec / 일반노드 시스템1 3.5 sec 를 차례로 넣어 주세요.',
    check({ before, after }) {
      const isTarget = (t) => /SecParam/.test(t.cells[0]?.text ?? '');
      const orig = before.tables.find(isTarget);
      const table = after.tables.find(isTarget);
      if (!orig) throw new Error('대상 표를 원본에서 찾지 못했습니다');
      if (!table) return { score: 0, details: { found: false } };
      const rowAdded = table.rows === orig.rows + 1;
      const lastRow = table.cells.filter((c) => c.row === table.rows - 1).sort((a, b) => a.col - b.col).map((c) => norm(c.text).replace(/\s*sec$/i, ' sec'));
      const want = ['2', '2.1 sec', '3.5 sec'];
      const cellOk = want.map((w, i) => norm(lastRow[i] ?? '').replace(/\s+/g, '') === w.replace(/\s+/g, ''));
      const originalKept = orig.cells.every((c) => table.cells.some((x) => x.row === c.row && x.col === c.col && norm(x.text) === norm(c.text)));
      const unintended = [...unintendedChanges(before, after, { checkFormat: false }), ...tableChanges(before, after, { skip: isTarget })];
      const score = 0.25 * (rowAdded ? 1 : 0) + 0.25 * cellOk.filter(Boolean).length - (originalKept ? 0 : 0.25) - 0.1 * unintended.length;
      return {
        score: round3(clamp01(score)),
        details: { rowsBefore: orig.rows, rowsAfter: table.rows, lastRow, cellOk, originalKept, unintended: unintended.length, unintendedSamples: unintended.slice(0, 5) },
      };
    },
  },
  {
    id: 'replace-all',
    title: '전체 바꾸기 (표 안 포함)',
    sample: 'biz_plan.hwp',
    workflow: 'direct',
    permissionProfile: 'unrestricted',
    prompt: "문서 전체에서 'OXX사업단'을 '미래교육사업단'으로 모두 바꿔 주세요. 표 안에 있는 것도 바꿔 주세요.",
    check({ before, after }) {
      const OLD = 'OXX사업단';
      const NEW = '미래교육사업단';
      const b = allTexts(before);
      const a = allTexts(after);
      const oldBefore = countIn(b, OLD);
      const oldAfter = countIn(a, OLD);
      const newExpected = countIn(b, NEW) + oldBefore;
      const newAfter = countIn(a, NEW);
      const replaced = oldBefore - oldAfter;
      const expectText = (p) => p.text.split(OLD).join(NEW);
      const unintended = unintendedChanges(before, after, { expectText, checkFormat: false });
      const cellsExpected = before.tables.flatMap((t) => t.cells.map((c) => norm(c.text.split(OLD).join(NEW))));
      const cellsAfter = after.tables.flatMap((t) => t.cells.map((c) => norm(c.text)));
      const cellDiffs = cellsExpected.length === cellsAfter.length ? cellsExpected.filter((t, i) => t !== cellsAfter[i]).length : Math.abs(cellsExpected.length - cellsAfter.length);
      const overshoot = Math.max(0, newAfter - newExpected);
      return {
        score: round3(clamp01(replaced / oldBefore - 0.1 * (unintended.length + cellDiffs + overshoot))),
        details: { occurrences: oldBefore, remaining: oldAfter, newCount: newAfter, newExpected, unintended: unintended.length, cellDiffs, unintendedSamples: unintended.slice(0, 5) },
      };
    },
  },
  {
    id: 'question',
    title: '읽기 전용 질문 (채팅 모드)',
    sample: TREATISE,
    workflow: 'question',
    permissionProfile: 'safe',
    prompt: '이 논문의 실험 결과 표에서 SecParam이 1일 때 라우터 시스템의 측정 시간은 얼마인가요? 그리고 이 문서는 모두 몇 쪽인가요? 짧게 답해 주세요.',
    check({ before, after, finalText }) {
      const text = String(finalText ?? '');
      const value = /1\.0443/.test(text);
      const pages = before.pageCount;
      const pageRe = new RegExp(`(^|[^\\d.])${pages}\\s*(쪽|페이지|page|장)`, 'i');
      const pageOk = pageRe.test(text);
      const unchanged = unintendedChanges(before, after).length === 0;
      return {
        score: round3((value ? 0.5 : 0) + (pageOk ? 0.5 : 0) - (unchanged ? 0 : 0.5)),
        details: { value, pageOk, expectedPages: pages, documentUnchanged: unchanged, answer: text.slice(-400) },
      };
    },
  },
  {
    id: 'staged-replace',
    title: '에이전트 모드 범위 바꾸기 (검토 대기 편집)',
    sample: 'basic/interview.hwp',
    workflow: 'direct',
    permissionProfile: 'safe',
    prompt: "'취업 10원칙' 목록에서만 '회사'를 모두 '기업'으로 바꿔 주세요. '면접 10계명' 쪽은 그대로 두세요.",
    check({ before, after, pending }) {
      const startIdx = before.body.findIndex((p) => /취업 10원칙/.test(p.text));
      const scope = (p) => p.sec === 0 && p.para > startIdx;
      const inScopeBefore = countIn(before.body.filter(scope).map((p) => p.text), '회사');
      const sameShape = before.body.length === after.body.length;
      const afterScope = sameShape ? after.body.filter((_p, i) => scope(before.body[i])) : after.body.filter(scope);
      const inScopeLeft = countIn(afterScope.map((p) => p.text), '회사');
      const outBefore = countIn(before.body.filter((p) => !scope(p)).map((p) => p.text), '회사');
      const outAfter = sameShape ? countIn(after.body.filter((_p, i) => !scope(before.body[i])).map((p) => p.text), '회사') : null;
      const expectText = (p) => (scope(p) ? p.text.split('회사').join('기업') : p.text);
      const unintended = unintendedChanges(before, after, { expectText, checkFormat: true, tolerate: [particleTolerant('기업')] });
      const replacedFrac = (inScopeBefore - inScopeLeft) / inScopeBefore;
      return {
        score: round3(clamp01(replacedFrac - (outAfter === outBefore ? 0 : 0.5) - 0.1 * unintended.length)),
        details: {
          inScope: inScopeBefore, inScopeLeft, outOfScopeBefore: outBefore, outOfScopeAfter: outAfter,
          pendingAtTurnEnd: pending?.hasPending ?? null, pendingSets: pending?.sets ?? null, pendingOps: pending?.ops ?? null,
          unintended: unintended.length, unintendedSamples: unintended.slice(0, 5),
        },
      };
    },
  },
  {
    id: 'real-list',
    title: '손으로 친 가~자 목록을 진짜 문단 번호로',
    sample: 'biz_plan.hwp',
    workflow: 'direct',
    permissionProfile: 'unrestricted',
    prompt: "'4. 과업내용' 아래 '가.'부터 '자.'까지 항목은 글자로 직접 쳐 놓은 번호예요. 이 아홉 항목을 한글의 진짜 문단 번호 목록(가. 나. 다. 모양)으로 바꾸고, 손으로 친 '가.' '나.' 같은 글자는 지워 주세요. 내용은 그대로 두세요.",
    check({ before, after }) {
      const MANUAL = /^\s*([가나다라마바사아자])\.\s*/;
      const start = before.body.findIndex((p) => /^4\. 과업내용/.test(p.text));
      const items = before.body.slice(start + 1, start + 12).filter((p) => MANUAL.test(p.text)).slice(0, 9);
      const results = items.map((p) => {
        const content = norm(p.text.replace(MANUAL, ''));
        const a = after.body.find((x) => norm(x.text.replace(MANUAL, '')) === content || norm(x.text) === content);
        if (!a) return { content: content.slice(0, 24), found: false, numbered: false, prefixRemoved: false };
        const numbering = after.numberings?.find?.((n) => n.id === a.numberingId) ?? null;
        return {
          content: content.slice(0, 24),
          found: true,
          numbered: a.head === 'Number' || a.head === 'Outline',
          prefixRemoved: !MANUAL.test(a.text),
          head: a.head,
          format: numbering?.levelFormats?.[a.level ?? 0] ?? null,
          // HWP 번호 모양 8 = 가나다
          hangul: numbering?.numberFormats?.[a.level ?? 0] === 8,
        };
      });
      const itemScore = results.map((r) => (r.numbered ? 0.4 : 0) + (r.prefixRemoved ? 0.4 : 0) + (r.numbered && r.hangul ? 0.2 : 0));
      const contentKept = results.filter((r) => r.found).length;
      const targetTexts = new Set(items.map((p) => norm(p.text)));
      const unintended = unintendedChanges(before, after, { isTarget: (b) => targetTexts.has(norm(b.text)) });
      const firstFormat = results.find((r) => r.format)?.format ?? null;
      return {
        score: round3(clamp01(itemScore.reduce((a, b) => a + b, 0) / items.length - 0.1 * (items.length - contentKept) - 0.05 * unintended.length)),
        details: {
          items: items.length,
          numbered: results.filter((r) => r.numbered).length,
          prefixRemoved: results.filter((r) => r.prefixRemoved).length,
          contentKept,
          numberFormat: firstFormat,
          hangulFormat: results.filter((r) => r.hangul).length,
          unintended: unintended.length,
          unintendedSamples: unintended.slice(0, 5),
          missing: results.filter((r) => !r.found).map((r) => r.content),
        },
      };
    },
  },
];

export function selectTasks(ids) {
  if (!ids) return TASKS;
  const wanted = ids.split(',').map((s) => s.trim()).filter(Boolean);
  const unknown = wanted.filter((id) => !TASKS.some((t) => t.id === id));
  if (unknown.length) throw new Error(`알 수 없는 과제: ${unknown.join(', ')} (가능: ${TASKS.map((t) => t.id).join(', ')})`);
  return TASKS.filter((t) => wanted.includes(t.id));
}
