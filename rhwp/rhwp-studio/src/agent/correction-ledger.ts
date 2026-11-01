/** 사용자 편집을 문단 단위로 모은다. 새 글·붙여넣기·구조 편집은 취향의 증거가 아니다. */
import type { DocumentPosition } from '../core/types.ts';
import type { ParagraphReader, ParagraphRef } from './taste-rewrites.ts';
import { changedRegion, containerKey } from './taste-rewrites.ts';
import type { ReviewSignal } from './types.ts';

type Passage = { ref: ParagraphRef; before: string; after: string; count: number; id: string };
interface LedgerDeps {
  reader: ParagraphReader;
  enabled(): boolean;
  emit(signals: ReviewSignal[]): void;
  idleMs?: number;
}
export class CorrectionLedger {
  private deps: LedgerDeps;
  private passages = new Map<string, Passage>();
  private sent = new Set<string>();
  private active: Passage | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private composing = false;
  private blocked = false;
  constructor(deps: LedgerDeps) { this.deps = deps; }

  begin(pos: DocumentPosition): void {
    if (!this.deps.enabled()) { this.clear(); return; }
    if (this.blocked || this.composing || pos.isTextBox) return;
    const ref: ParagraphRef = pos.cellIndex === undefined
      ? { sectionIdx: pos.sectionIndex, paraIdx: pos.paragraphIndex }
      : { sectionIdx: pos.sectionIndex, paraIdx: pos.cellParaIndex ?? 0,
          cell: { paraIdx: pos.parentParaIndex ?? pos.paragraphIndex, controlIdx: pos.controlIndex ?? 0,
            cellIdx: pos.cellIndex, ...(pos.cellPath ? { path: pos.cellPath } : {}) } };
    try {
      const text = this.deps.reader.text(ref);
      if (text === null || text.length > 8000) return;
      const key = `${containerKey(ref)}#${ref.paraIdx}`;
      let passage = this.passages.get(key);
      if (!passage || passage.after !== text) {
        passage = { ref, before: text, after: text, count: this.deps.reader.count(ref), id: key };
        this.passages.set(key, passage);
      }
      this.active = passage;
      while (this.passages.size > 100) this.passages.delete(this.passages.keys().next().value!);
    } catch { this.active = null; }
  }

  end(): void {
    if (this.composing || this.blocked || !this.active) return;
    const passage = this.active;
    this.active = null;
    try {
      if (this.deps.reader.count(passage.ref) !== passage.count) { this.invalidate(); return; }
      passage.after = this.deps.reader.text(passage.ref) ?? passage.before;
    } catch { this.invalidate(); return; }
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), this.deps.idleMs ?? 15_000);
  }

  composition(start: boolean, pos?: DocumentPosition): void {
    if (start) { if (pos) this.begin(pos); this.composing = true; if (this.timer) clearTimeout(this.timer); }
    else if (this.composing) { this.composing = false; this.end(); }
  }
  suspend(value: boolean): void {
    this.active = null;
    this.passages.clear();
    this.blocked = value;
  }
  /** 실행 취소·다른 작성자의 편집은 아직 해석하지 않은 증거를 거둔다. 이미 보낸 증거의 중복 표시는 유지한다. */
  invalidate(): void { this.active = null; this.passages.clear(); }
  flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (!this.deps.enabled()) { this.clear(); return; }
    if (this.composing || this.blocked) return;
    const groups = new Map<string, ReviewSignal[]>();
    for (const [key, p] of this.passages) {
      // 스냅숏 복원처럼 이 원장을 거치지 않은 변경 뒤에는 이 교정이 문서에 남아 있지 않을 수 있다.
      if (this.currentText(p) !== p.after) { this.passages.delete(key); continue; }
      const { prefix, suffix } = changedRegion(p.before, p.after);
      const removed = p.before.slice(prefix, p.before.length - suffix).trim();
      const added = p.after.slice(prefix, p.after.length - suffix).trim();
      // 빈 삽입·삭제 및 공백 변경은 취향으로 만들지 않는다. 한 글자 용어 수정은 포함한다.
      if (!removed || !added || removed === added) { p.before = p.after; continue; }
      if (removed.length + added.length > 400) continue;
      const transformation = JSON.stringify([removed.normalize('NFKC'), added.normalize('NFKC')]);
      const evidenceId = `${p.id}:${fingerprint(p.before + '\0' + p.after)}`;
      if (this.sent.has(evidenceId)) continue;
      const start = Math.max(0, prefix - 60);
      const after = p.before.slice(start, Math.min(p.before.length, p.before.length - suffix + 60));
      const userText = p.after.slice(start, Math.min(p.after.length, p.after.length - suffix + 60));
      const group = groups.get(transformation) ?? [];
      group.push({ kind: 'correction', at: new Date().toISOString(), after, userText, evidenceId, passageId: p.id });
      groups.set(transformation, group);
    }
    for (const group of groups.values()) {
      if (new Set(group.map(s => s.passageId)).size < 2) continue;
      const batch = group.slice(0, 20);
      this.deps.emit(batch);
      for (const signal of batch) this.sent.add(signal.evidenceId!);
    }
    while (this.sent.size > 500) this.sent.delete(this.sent.values().next().value!);
  }
  clear(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null; this.active = null; this.passages.clear(); this.sent.clear(); this.composing = false; this.blocked = false;
  }
  private currentText(passage: Passage): string | null {
    try { return this.deps.reader.text(passage.ref); } catch { return null; }
  }
}
function fingerprint(text: string): string {
  let hash = 2166136261;
  for (const char of text) hash = Math.imul(hash ^ char.codePointAt(0)!, 16777619);
  return (hash >>> 0).toString(36);
}
