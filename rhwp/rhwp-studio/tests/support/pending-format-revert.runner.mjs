// 실제 WASM(rhwp/pkg) + WasmBridge + PendingEditManager — 혼합 서식 문단에 건 에이전트 서식의
// 거절과 승인 후 undo 가 글자마다 원래 모양으로 돌아오는지 본다.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const studio = join(dirname(fileURLToPath(import.meta.url)), '../..');
const src = join(studio, 'src');
const pkg = join(studio, '../pkg');
const binding = pathToFileURL(join(pkg, 'rhwp.js')).href;
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === '@wasm/rhwp.js') return { url: binding, shortCircuit: true };
    if (/^\.{1,2}\//.test(specifier) && !/\.[cm]?[tj]s$/.test(specifier)) {
      return { url: pathToFileURL(join(dirname(fileURLToPath(context.parentURL)), specifier + '.ts')).href, shortCircuit: true };
    }
    return next(specifier, context);
  },
});
const engine = await import(binding);
engine.initSync({ module: readFileSync(join(pkg, 'rhwp_bg.wasm')) });
const { WasmBridge } = await import(pathToFileURL(join(src, 'core/wasm-bridge.ts')).href);
const { EventBus } = await import(pathToFileURL(join(src, 'core/event-bus.ts')).href);
const { PendingEditManager } = await import(pathToFileURL(join(src, 'agent/pending-edits.ts')).href);

const TEXT = '가나다라마바사아자';
const doc = engine.HwpDocument.createEmpty();
doc.createBlankDocument();
doc.insertText(0, 0, 0, TEXT);
doc.applyCharFormat(0, 0, 0, 3, JSON.stringify({ bold: true }));

const wasm = Object.create(WasmBridge.prototype);
wasm.doc = doc;
// 스냅샷 복원 뒤의 외부 그림 주입은 개발 서버 fetch 라 여기서는 끈다
wasm.populateExternalImagesFromDevServer = async () => {};
const recorded = [];
const manager = new PendingEditManager({
  wasm,
  eventBus: new EventBus(),
  inputHandler: {
    getCursorPosition: () => ({ sectionIndex: 0, paragraphIndex: 0, charOffset: 0 }),
    executeOperation: (op) => { if (op.kind === 'record') recorded.push(op.command); },
    prepareSnapshotCapacity: () => {},
    retainExternalSnapshot: () => {},
    releaseExternalSnapshot: () => {},
  },
  canvasView: {},
  overlay: { setOps: () => {}, clear: () => {} },
});

const length = [...TEXT].length;
const marks = () => Array.from({ length }, (_, i) => (wasm.getCharPropertiesAt(0, 0, i).bold ? 'B' : '.')).join('');
const runs = () => wasm.getCharShapeRuns(0, 0, 0, length);
const range = () => ({ sectionIdx: 0, startParaIdx: 0, startCharOffset: 0, endParaIdx: 0, endCharOffset: length });

assert.equal(marks(), 'BBB......');
const original = runs();

const rejected = manager.applyCharFormat('claude', range(), { bold: false });
assert.equal(marks(), '.........');
manager.reject(rejected.changeSetId);
assert.equal(marks(), 'BBB......', '거절');
assert.deepEqual(runs(), original);

const approved = manager.applyCharFormat('claude', range(), { bold: false });
assert.equal(manager.approve(approved.changeSetId), true);
assert.equal(marks(), '.........');
assert.equal(recorded.length, 1);
recorded[0].undo(wasm);
assert.equal(marks(), 'BBB......', '승인 후 undo');
assert.deepEqual(runs(), original);
recorded[0].execute(wasm);
assert.equal(marks(), '.........', 'redo');

console.log('PENDING_FORMAT_REVERT_OK');
