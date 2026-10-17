/**
 * 다른 문서 읽기 — 창 단위 엔진 묶음(엔진 수·쥔 엔진·쉬는 시간·공유), 미리 읽기와 crash 표식, 그리고
 * 실행기의 documentId 읽기(열린 문서, 닫힌 문서, 서식 틀)를 가짜 엔진으로 검증한다.
 */
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { AgentToolExecutor } from '../src/agent/tool-executor.ts';
import {
  DocumentPreflight,
  FOREIGN_DOCUMENT_IDLE_MS,
  FOREIGN_DOCUMENT_MAX_BYTES,
  ForeignDocumentPool,
  createRecentDocumentResolver,
  fileSourceKey,
  readFileSourceResponse,
  type FileDocumentSource,
  type ForeignDocumentAccess,
  type ForeignDocumentSource,
  type KnownDocument,
} from '../src/agent/foreign-documents.ts';
import { readChatPermissionGrants } from '../src/agent/chat-permissions.ts';
import { engineTrap } from '../src/core/engine-trap.ts';
import { documentSourceDigest } from '../src/recent/document-preflight.ts';
import type { RecentDoc } from '../src/recent/recent-store.ts';
import { expectErr, makeEnv } from './agent-test-env.ts';

const DOC_B = 'doc-b';

/** 테스트가 만든 엔진 묶음 — 쉬는 시간 타이머가 테스트 프로세스를 붙잡지 않게 끝마다 놓는다. */
const pools: ForeignDocumentPool[] = [];
function trackedPool(options: ConstructorParameters<typeof ForeignDocumentPool>[0]): ForeignDocumentPool {
  const pool = new ForeignDocumentPool(options);
  pools.push(pool);
  return pool;
}
afterEach(() => {
  for (const pool of pools.splice(0)) pool.dispose();
});

function bytesOf(n: number, fileName = `${n}.hwp`) {
  return async () => ({ bytes: new Uint8Array([n, n, n]), fileName });
}

/** 엔진 번호를 매기고 내려간 엔진 번호를 남기는 가짜 엔진 공장 */
function engineFactory() {
  const released: number[] = [];
  let made = 0;
  const createEngine = async () => {
    const id = ++made;
    return { loadDocument() {}, releaseDocument() { released.push(id); } } as never;
  };
  return { createEngine, released, made: () => made };
}

const passPreflight = new DocumentPreflight({ run: async () => ({ ok: true }), wasmVersion: () => 'test' });

class MemoryStorage {
  private items = new Map<string, string>();
  get length() { return this.items.size; }
  key(index: number) { return [...this.items.keys()][index] ?? null; }
  getItem(key: string) { return this.items.get(key) ?? null; }
  setItem(key: string, value: string) { this.items.set(key, value); }
  removeItem(key: string) { this.items.delete(key); }
  keys() { return [...this.items.keys()]; }
}

// ─── 엔진 묶음 ──────────────────────────────────────────

test('엔진은 둘까지 — 쉬는 엔진을 오래 쉰 것부터 내리고, 읽는 중인 엔진은 남긴다', async () => {
  const engines = engineFactory();
  const pool = trackedPool({ createEngine: engines.createEngine, storage: null });
  await pool.use('a', bytesOf(1), () => {});
  await pool.use('b', bytesOf(2), () => {});
  await pool.use('a', bytesOf(1), () => {});
  await pool.use('c', bytesOf(3), () => {});
  assert.deepEqual(engines.released, [2], 'a 를 다시 썼으니 b 가 가장 오래 쉬었다');
  assert.ok(pool.has('a') && pool.has('c') && !pool.has('b'));

  let finish!: () => void;
  const holding = pool.use('a', bytesOf(1), () => new Promise<void>((resolve) => { finish = resolve; }));
  await new Promise((resolve) => setImmediate(resolve));
  await pool.use('d', bytesOf(4), () => {});
  assert.ok(pool.has('a'), '읽는 중인 a 는 더 오래됐어도 내리지 않는다');
  assert.ok(!pool.has('c'));

  // 모두 읽는 중이면 한도를 넘겨 열고, 끝나는 대로 줄인다.
  let finishE!: () => void;
  const holdingE = pool.use('e', bytesOf(5), () => new Promise<void>((resolve) => { finishE = resolve; }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(pool.has('a') && pool.has('e') && !pool.has('d'));
  let finishF!: () => void;
  const holdingF = pool.use('f', bytesOf(6), () => new Promise<void>((resolve) => { finishF = resolve; }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(pool.size, 3);
  finish();
  await holding;
  assert.equal(pool.size, 2, '놓인 a 가 내려간다');
  assert.ok(!pool.has('a'));
  finishE();
  finishF();
  await Promise.all([holdingE, holdingF]);
});

test('같은 문서를 읽는 두 채팅은 엔진 하나를 같이 쓰고, 다시 읽을 때는 바이트를 읽지 않는다', async () => {
  const engines = engineFactory();
  const pool = trackedPool({ createEngine: engines.createEngine, storage: null });
  let reads = 0;
  const load = async () => { reads += 1; return { bytes: new Uint8Array([1]), fileName: 'b.hwp' }; };
  const family = { family: 'doc:b' };
  const seen = await Promise.all([
    pool.use('doc:b:1', load, (lease) => lease.wasm, family),
    pool.use('doc:b:1', load, (lease) => lease.wasm, family),
  ]);
  assert.equal(seen[0], seen[1]);
  await pool.use('doc:b:1', load, () => {}, family);
  assert.equal(reads, 1);
  assert.equal(engines.made(), 1);

  await pool.use('other', bytesOf(2), () => {});
  await pool.use('doc:b:1', load, () => {}, family);
  await pool.use('doc:b:2', load, () => {}, family);
  assert.ok(!pool.has('doc:b:1') && pool.has('other'), '파일이 바뀌면 더 오래 쉰 엔진보다 옛 판을 먼저 내린다');
});

test('마지막으로 쓴 뒤 쉬는 시간이 차야 엔진을 놓고, 사이에 쓰면 시간이 다시 잰다', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const engines = engineFactory();
  const pool = trackedPool({ createEngine: engines.createEngine, storage: null });
  await pool.use('a', bytesOf(1), () => {});
  t.mock.timers.tick(FOREIGN_DOCUMENT_IDLE_MS - 1);
  await pool.use('a', bytesOf(1), () => {});
  t.mock.timers.tick(FOREIGN_DOCUMENT_IDLE_MS - 1);
  assert.deepEqual(engines.released, []);
  t.mock.timers.tick(1);
  assert.deepEqual(engines.released, [1]);
  assert.equal(pool.size, 0);
});

test('공유 엔진에서 멈춘 문서는 표식이 남고, 다시 연 창은 그 문서를 엔진에 올리지 않는다', async () => {
  const storage = new MemoryStorage();
  const bytes = new Uint8Array([9, 9, 9]);
  const load = async () => ({ bytes, fileName: 'trap.hwp' });
  const trapping = trackedPool({
    createEngine: async () => ({ loadDocument() { throw new Error('unreachable'); }, releaseDocument() {} }) as never,
    preflight: passPreflight,
    storage,
  });
  await assert.rejects(trapping.use('doc:t:1', load, () => {}, { untrusted: true }), /unreachable/);
  assert.ok(storage.keys().some((key) => key.includes(documentSourceDigest(bytes))), '표식이 남는다');

  let engines = 0;
  const reopened = trackedPool({
    createEngine: async () => { engines += 1; return { loadDocument() {}, releaseDocument() {} } as never; },
    preflight: passPreflight,
    storage,
  });
  assert.ok(reopened.isDenied(documentSourceDigest(bytes)));
  await expectErr(reopened.use('doc:t:2', load, () => {}, { untrusted: true }), 'SOURCE_UNREADABLE');
  assert.equal(engines, 0);
});

test('crash 표식은 그 문서의 엔진 호출 동안에만 있다 — 비동기 작업 중에는 남지 않는다', async () => {
  const storage = new MemoryStorage();
  const during: number[] = [];
  const pool = trackedPool({
    createEngine: async () => ({
      loadDocument() {}, releaseDocument() {},
      pageCount() { during.push(storage.keys().length); return 1; },
    }) as never,
    preflight: passPreflight,
    storage,
  });
  let whileAwaiting = -1;
  await pool.use('doc:m:1', bytesOf(7), async (lease) => {
    (lease.wasm as unknown as { pageCount(): number }).pageCount();
    // PNG 만들기처럼 엔진 밖에서 기다리는 동안 창을 새로 고쳐도 이 문서 탓이 되지 않는다.
    await new Promise((resolve) => setTimeout(resolve, 0));
    whileAwaiting = storage.keys().length;
    (lease.wasm as unknown as { pageCount(): number }).pageCount();
  }, { untrusted: true });
  assert.deepEqual(during, [1, 1]);
  assert.equal(whileAwaiting, 0);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(storage.keys(), []);
});

test('미리 읽기 시간 초과는 기억하지 않는다 — 다음 읽기가 다시 미리 읽는다', async () => {
  const verdicts: Array<{ ok: true } | { ok: false; reason: 'timeout' }> = [{ ok: false, reason: 'timeout' }, { ok: true }];
  let preflights = 0;
  const pool = trackedPool({
    createEngine: async () => ({ loadDocument() {}, releaseDocument() {} }) as never,
    preflight: new DocumentPreflight({ run: async () => { preflights += 1; return verdicts.shift()!; }, wasmVersion: () => 'test' }),
    storage: null,
  });
  const slow = await expectErr(pool.use('doc:s:1', bytesOf(8), () => {}, { untrusted: true }), 'SOURCE_UNREADABLE');
  assert.match(slow.message, /took too long/);
  await pool.use('doc:s:1', bytesOf(8), () => {}, { untrusted: true });
  assert.equal(preflights, 2);
  assert.ok(pool.has('doc:s:1'));
});

// ─── 실행기: documentId 읽기 ────────────────────────────

/** 이 채팅의 문서(live)와 다른 문서 하나를 가진 실행기 */
function foreignEnv(options: {
  closed?: (documentId: string) => Promise<ForeignDocumentSource>;
  live?: ForeignDocumentAccess['resolveLiveDocument'];
  pool?: ForeignDocumentPool;
  revision?: { revision: number };
} = {}) {
  const h = makeEnv(['이 채팅의 문서']);
  const other = makeEnv(['다른 문서의 첫 문단', '둘째 문단']);
  Object.assign(other.wasm, { loadDocument() {}, releaseDocument() {}, documentDigest: 'blake3:other' });
  const pool = options.pool ?? trackedPool({
    createEngine: async () => other.wasm as never,
    preflight: passPreflight,
    storage: null,
  });
  const executor = new AgentToolExecutor({
    wasm: h.wasm as never,
    editor: {} as never,
    documentState: { isDirty: () => false } as never,
    revision: (options.revision ?? h.revision) as never,
    pending: h.pending,
    foreignDocuments: { pool, resolveLiveDocument: options.live, resolveClosedDocument: options.closed },
  });
  const read = (tool: string, args: Record<string, unknown>) => executor.execute(
    tool, { documentId: DOC_B, ...args }, 'claude',
    { workflow: 'direct', source: { kind: 'document', documentId: DOC_B } },
  ) as Promise<Record<string, unknown>>;
  return { h, other, executor, pool, read };
}

const closedSource = (reads: { count: number } = { count: 0 }) => async (): Promise<ForeignDocumentSource> => ({
  stamp: '10:1',
  name: '보고서.hwp',
  read: async () => { reads.count += 1; return { bytes: new Uint8Array([4, 2]), fileName: '보고서.hwp' }; },
});

test('닫힌 문서의 get_structure 는 revision 없이 그 문서 이름을 머리에 싣고, 다시 읽어도 바이트를 읽지 않는다', async () => {
  const reads = { count: 0 };
  const { h, read } = foreignEnv({ closed: closedSource(reads) });
  const result = await read('get_structure', {});
  assert.equal(result['revision'], undefined);
  assert.equal(result['documentId'], DOC_B);
  assert.equal(result['name'], '보고서.hwp');
  assert.equal(result['dirty'], false);
  assert.equal(result['digest'], documentSourceDigest(new Uint8Array([4, 2])));
  const text = (result['mcpContent'] as Array<{ text: string }>)[0].text;
  assert.match(text.split('\n')[0], /^document "보고서\.hwp" · /);
  assert.match(text, /다른 문서의 첫 문단/);
  assert.doesNotMatch(text, /이 채팅의 문서/);

  const batch = await read('read_batch', { reads: [{ tool: 'get_text_range', args: { sectionIdx: 0, paraIdx: 1 } }] });
  assert.equal(batch['revision'], undefined);
  assert.equal((batch['results'] as Array<Record<string, unknown>>)[0]['text'], '둘째 문단');
  assert.equal(reads.count, 1, '같은 stamp 면 엔진을 다시 쓴다');
  assert.equal(h.body[0], '이 채팅의 문서');
});

test('이 창에 열린 문서는 그 엔진을 바로 읽고, 검토 대기 편집이 있으면 알린다', async () => {
  let closedAsked = 0;
  const live = makeEnv(['저장하지 않은 편집']);
  Object.assign(live.wasm, { documentDigest: 'blake3:live' });
  const { read } = foreignEnv({
    live: (documentId) => (documentId === DOC_B
      ? { wasm: live.wasm as never, name: '열린.hwpx', dirty: true, pendingReview: true }
      : null),
    closed: async () => { closedAsked += 1; throw new Error('닫힌 문서를 찾으면 안 된다'); },
  });
  const range = await read('get_text_range', { sectionIdx: 0, paraIdx: 0 });
  assert.equal(range['text'], '저장하지 않은 편집');
  assert.equal(range['pendingReview'], true);
  assert.equal(range['revision'], undefined);
  assert.equal(range['dirty'], undefined, 'dirty 는 문서를 훑는 읽기에만 싣는다');
  const structure = await read('get_structure', {});
  assert.equal(structure['dirty'], true);
  assert.equal(structure['digest'], 'blake3:live');
  assert.equal(closedAsked, 0);
});

test('다른 문서 읽기의 인자 규칙 — 쓰기·sinceRevision·항목별 documentId·확인되지 않은 문서', async () => {
  const { h, executor, read } = foreignEnv({ closed: closedSource() });
  const write = await expectErr(read('insert_text', {
    expectedRevision: h.revision.revision, sectionIdx: 0, paraIdx: 0, charOffset: 0, text: 'x',
  }), 'INVALID_ARGS');
  assert.match(write.message, /read-only/);
  assert.equal(h.body[0], '이 채팅의 문서');
  await expectErr(read('get_structure', { sinceRevision: 1 }), 'INVALID_ARGS');
  await expectErr(read('get_document_info', {}), 'INVALID_ARGS');

  const batch = await executor.execute('read_batch', {
    reads: [{ tool: 'get_text_range', args: { documentId: DOC_B, sectionIdx: 0, paraIdx: 0 } }],
  }, 'claude', { workflow: 'direct' }) as Record<string, unknown>;
  const item = (batch['results'] as Array<{ error?: { code: string } }>)[0];
  assert.equal(item.error?.code, 'INVALID_ARGS', '항목의 documentId 로 이 문서를 읽으면 안 된다');

  await expectErr(executor.execute('get_structure', { documentId: DOC_B }, 'claude', { workflow: 'direct' }), 'SOURCE_NOT_FOUND');
});

test('미리 읽기에 실패한 문서는 공유 엔진에 오르지 않고, 실패를 기억해 다시 미리 읽지 않는다', async () => {
  let preflights = 0;
  let engines = 0;
  const pool = trackedPool({
    createEngine: async () => { engines += 1; return { loadDocument() {}, releaseDocument() {} } as never; },
    preflight: new DocumentPreflight({ run: async () => { preflights += 1; return { ok: false, reason: 'trap' }; }, wasmVersion: () => 'test' }),
    storage: null,
  });
  let stamp = 1;
  let reads = 0;
  const { read } = foreignEnv({
    pool,
    closed: async () => ({
      stamp: `5:${stamp}`,
      name: '깨진.hwp',
      read: async () => { reads += 1; return { bytes: new Uint8Array([6, 6]), fileName: '깨진.hwp' }; },
    }),
  });
  await expectErr(read('get_structure', {}), 'SOURCE_UNREADABLE');
  await expectErr(read('get_structure', {}), 'SOURCE_UNREADABLE');
  assert.equal(reads, 1, '같은 stamp 의 실패는 바이트를 다시 읽지 않는다');
  stamp = 2;
  await expectErr(read('get_text_range', { sectionIdx: 0, paraIdx: 0 }), 'SOURCE_UNREADABLE');
  assert.equal(reads, 2);
  assert.equal(preflights, 1, '같은 바이트는 한 번만 미리 읽는다');
  assert.equal(engines, 0);
  assert.equal(engineTrap(), null);
});

test('다른 창이 쥔 데스크톱 문서와 권한을 받지 못한 브라우저 파일은 각자의 오류로 알린다', async () => {
  const row = (extra: Partial<RecentDoc> = {}): RecentDoc => ({
    id: 'r1', documentId: DOC_B, sourceDigest: 'blake3:x', fileName: '보고서.hwp', sourceFormat: 'hwp', openedAt: 1, ...extra,
  });
  const desktopRead = (reason: 'owned' | 'missing' | 'unreadable') => createRecentDocumentResolver({
    listRecent: async () => [row()],
    inspect: async () => new Map([['r1', { state: 'present', fileName: '보고서.hwp', stamp: '100:5', source: 'desktop' }]]),
    readNative: async () => ({ ok: false, reason }),
  });
  await expectErr(foreignEnv({ closed: desktopRead('owned') }).read('get_structure', {}), 'DOCUMENT_OPEN_ELSEWHERE');
  await expectErr(foreignEnv({ closed: desktopRead('missing') }).read('get_structure', {}), 'SOURCE_NOT_FOUND');

  // 잠긴 파일·내려받지 않은 클라우드 파일은 잠깐의 실패다 — 다음 읽기가 다시 읽는다.
  let locked = true;
  let nativeReads = 0;
  const flaky = createRecentDocumentResolver({
    listRecent: async () => [row()],
    inspect: async () => new Map([['r1', { state: 'present', fileName: '보고서.hwp', stamp: '100:5', source: 'desktop' }]]),
    readNative: async () => {
      nativeReads += 1;
      return locked ? { ok: false, reason: 'unreadable' } : { ok: true, bytes: new Uint8Array([4, 2]), fileName: '보고서.hwp' };
    },
  });
  const flakyEnv = foreignEnv({ closed: flaky });
  const lockedError = await expectErr(flakyEnv.read('get_structure', {}), 'SOURCE_UNREADABLE');
  assert.match(lockedError.message, /right now/);
  locked = false;
  assert.match(String(((await flakyEnv.read('get_structure', {}))['mcpContent'] as Array<{ text: string }>)[0].text), /다른 문서의 첫 문단/);
  assert.equal(nativeReads, 2);

  const handle = {
    name: '보고서.hwp', getFile: async () => { throw new Error('권한 없이 읽으면 안 된다'); },
    createWritable: async () => { throw new Error('쓰지 않는다'); },
    queryPermission: async () => 'prompt' as const,
  };
  const browser = createRecentDocumentResolver({
    listRecent: async () => [row({ handle })],
    inspect: async () => new Map([['r1', { state: 'unknown' }]]),
    readNative: async () => null,
  });
  await expectErr(foreignEnv({ closed: browser }).read('get_text_range', { sectionIdx: 0, paraIdx: 0 }), 'SOURCE_PERMISSION_REQUIRED');

  const large = createRecentDocumentResolver({
    listRecent: async () => [row()],
    inspect: async () => new Map([['r1', { state: 'present', fileName: '큰.hwp', stamp: `${30 * 1024 * 1024}:5`, source: 'desktop' }]]),
    readNative: async () => { throw new Error('너무 큰 파일은 읽지 않는다'); },
  });
  await expectErr(foreignEnv({ closed: large }).read('get_structure', {}), 'SOURCE_TOO_LARGE');
});

test('최근 문서 기록에 없는 문서도 데스크톱이 documentId 로 기억한 위치에서 읽고, 없으면 이 기기에 없다고 알린다', async () => {
  const remembered = createRecentDocumentResolver({
    listRecent: async () => [],
    inspect: async (rows) => new Map(rows.map((row) => [row.id, row.documentId === DOC_B
      ? { state: 'present' as const, fileName: '구성원.hwp', stamp: '2:9', source: 'desktop' as const }
      : { state: 'unknown' as const }])),
    readNative: async () => ({ ok: true, bytes: new Uint8Array([4, 2]), fileName: '구성원.hwp' }),
  });
  const result = await foreignEnv({ closed: remembered }).read('get_text_range', { sectionIdx: 0, paraIdx: 0 });
  assert.equal(result['name'], '구성원.hwp');
  assert.equal(result['text'], '다른 문서의 첫 문단');

  const nowhere = createRecentDocumentResolver({
    listRecent: async () => [],
    inspect: async (rows) => new Map(rows.map((row) => [row.id, { state: 'unknown' as const }])),
    readNative: async () => null,
  });
  const missing = await expectErr(foreignEnv({ closed: nowhere }).read('get_structure', {}), 'SOURCE_NOT_FOUND');
  assert.match(missing.message, /not available on this device/);
});

// ─── 서식 틀 ────────────────────────────────────────────

const template = {
  id: 'tpl-1', name: '양식', originalName: '양식.hwpx', format: 'hwpx', size: 1, pageCount: 1, sectionCount: 1,
  contentHash: 'x', revision: 3, createdAt: '', updatedAt: '',
} as const;

test('read_batch 안의 get_structure 도 다른 문서·서식 틀 이름을 머리에 싣고 이 채팅의 revision 을 드러내지 않는다', async () => {
  const live = { revision: 77 };
  const { read } = foreignEnv({ closed: closedSource(), revision: live });
  const batch = await read('read_batch', { reads: [{ tool: 'get_structure', args: {} }] });
  const text = String((batch['results'] as Array<Record<string, unknown>>)[0]['text']);
  assert.match(text, /^document "보고서\.hwp" · /);
  assert.doesNotMatch(text, /revision/);
  const delta = await read('read_batch', { reads: [{ tool: 'get_structure', args: { sinceRevision: 1 } }] });
  assert.equal((delta['results'] as Array<{ error?: { code: string } }>)[0].error?.code, 'INVALID_ARGS');

  const source = makeEnv(['서식 틀 제목']);
  Object.assign(source.wasm, { loadDocument() {}, releaseDocument() {} });
  const h = makeEnv(['본문']);
  const executor = new AgentToolExecutor({
    wasm: h.wasm as never,
    editor: {} as never,
    documentState: { isDirty: () => false } as never,
    revision: live as never,
    pending: h.pending,
    loadTemplateBytes: async () => new Uint8Array([1]),
    foreignDocuments: { pool: trackedPool({ createEngine: async () => source.wasm as never, storage: null }) },
  });
  const templateBatch = await executor.execute('read_batch', {
    documentId: 'template', reads: [{ tool: 'get_structure', args: {} }],
  }, 'claude', { workflow: 'direct', template }) as Record<string, unknown>;
  const templateText = String((templateBatch['results'] as Array<Record<string, unknown>>)[0]['text']);
  assert.match(templateText, /^template tpl-1 revision 3 · /);
  assert.doesNotMatch(templateText, /revision 77/);
});

test('documentId:"template" 구조 읽기가 이식 매핑 문을 열고, 서식 틀 쪽 설정 이식이 그 엔진에서 돈다', async () => {
  const h = makeEnv(['본문']);
  const pages: unknown[] = [];
  Object.assign(h.wasm, { setPageDef: (_section: number, def: unknown) => { pages.push(def); return '{"ok":true}'; } });
  const source = makeEnv(['서식 틀 제목', '서식 틀 본문']);
  Object.assign(source.wasm, { loadDocument() {}, releaseDocument() {}, getPageDef: () => ({ width: 59528, height: 84188 }) });
  let loads = 0;
  const executor = new AgentToolExecutor({
    wasm: h.wasm as never,
    editor: {} as never,
    documentState: { isDirty: () => false } as never,
    revision: h.revision,
    pending: h.pending,
    loadTemplateBytes: async () => { loads += 1; return new Uint8Array([1]); },
    foreignDocuments: { pool: trackedPool({ createEngine: async () => source.wasm as never, storage: null }) },
  });
  const capability = { workflow: 'direct' as const, template };
  const apply = () => executor.execute('template_apply_section_layout', {
    expectedRevision: h.revision.revision, templateRevision: 3,
    mappings: [{ templateSectionIdx: 0, targetSectionIdx: 0 }], components: ['page'],
  }, 'claude', capability) as Promise<Record<string, unknown>>;

  await executor.execute('get_structure', {}, 'claude', capability);
  await expectErr(apply(), 'TEMPLATE_MAPPING_REQUIRED');
  // 서식 틀 일부만 읽어서는 매핑 문이 열리지 않는다.
  await executor.execute('get_structure', { documentId: 'template', range: { sectionIdx: 0, fromPara: 0, toPara: 0 } }, 'claude', capability);
  await executor.execute('read_batch', {
    documentId: 'template', reads: [{ tool: 'get_structure', args: { range: { sectionIdx: 0, fromPara: 1, toPara: 1 } } }],
  }, 'claude', capability);
  await expectErr(apply(), 'TEMPLATE_MAPPING_REQUIRED');

  const structure = await executor.execute('get_structure', { documentId: 'template' }, 'claude', capability) as Record<string, unknown>;
  assert.equal(structure['templateId'], 'tpl-1');
  assert.equal(structure['templateRevision'], 3);
  assert.equal(structure['revision'], undefined);
  assert.match((structure['mcpContent'] as Array<{ text: string }>)[0].text, /^template tpl-1 revision 3 · [\s\S]*서식 틀 제목/);

  const applied = await apply();
  assert.equal(applied['pending'], true);
  assert.deepEqual(pages, [{ width: 59528, height: 84188 }]);
  assert.equal(loads, 1, '읽기와 이식이 같은 서식 틀 엔진을 쓴다');
  await expectErr(executor.execute('template_get_structure', { templateRevision: 3 }, 'claude', capability), 'UNKNOWN_TOOL');
});

// ─── 문서 목록 (list_documents) ─────────────────────────

test('list_documents 는 문서 없이도 돌고, 열린 문서를 먼저·겹친 문서는 한 번만·이름으로 거르고·50개에서 자른다', async () => {
  const unloaded = new Proxy({}, { get: () => () => { throw new Error('문서가 로드되지 않았습니다'); } });
  const known = (documentId: string, name: string, openedAt: number, extra: Partial<KnownDocument> = {}): KnownDocument => (
    { documentId, name, format: 'hwpx', openedAt, state: 'closed', ...extra }
  );
  const recent = [
    known('b', '보고서 초안.hwpx', 50),
    known('c', 'Budget 2027.hwp', 40),
    ...Array.from({ length: 60 }, (_, i) => known(`r${i}`, `기록 ${i}.hwp`, 30 - i / 100)),
  ];
  const executor = new AgentToolExecutor({
    wasm: unloaded as never,
    editor: {} as never,
    documentState: { isDirty: () => false } as never,
    revision: makeEnv(['']).revision,
    pending: makeEnv(['']).pending,
    foreignDocuments: {
      pool: trackedPool({ storage: null }),
      listDocuments: async () => ({
        open: [known('a', '열린 문서.hwpx', 10, { dirty: true }), known('b', '보고서 초안.hwpx', 60, { dirty: false })],
        recent,
      }),
    },
  });
  const list = (args: Record<string, unknown>) => executor.execute('list_documents', args, 'claude', { workflow: 'question' }) as
    Promise<{ documents: Array<Record<string, unknown>>; truncated: boolean }>;

  const all = await list({});
  assert.deepEqual(all.documents.slice(0, 3).map((row) => [row['documentId'], row['state']]), [['b', 'open'], ['a', 'open'], ['c', 'closed']]);
  assert.equal(all.documents[1]['dirty'], true);
  assert.equal(all.documents[2]['dirty'], undefined, '닫힌 문서에는 dirty 가 없다');
  assert.equal(all.documents.filter((row) => row['documentId'] === 'b').length, 1);
  assert.equal(all.documents.length, 50);
  assert.equal(all.truncated, true);

  const byName = await list({ query: '보고서'.normalize('NFD') });
  assert.deepEqual(byName.documents.map((row) => row['documentId']), ['b']);
  assert.equal(byName.truncated, false);
  assert.deepEqual((await list({ query: 'budget' })).documents.map((row) => row['documentId']), ['c']);
});

// ─── 경로로 고른 파일 (file: 핸들) ──────────────────────

test('file: 핸들은 크기·수정 시각이 같으면 받은 바이트를 다시 쓰고, 바뀌면 새로 받는다', async () => {
  const h = makeEnv(['이 채팅의 문서']);
  const other = makeEnv(['파일의 첫 문단']);
  Object.assign(other.wasm, { loadDocument() {}, releaseDocument() {} });
  const fetched: FileDocumentSource[] = [];
  const executor = new AgentToolExecutor({
    wasm: h.wasm as never,
    editor: {} as never,
    documentState: { isDirty: () => false } as never,
    revision: h.revision,
    pending: h.pending,
    loadFileSource: async (source) => { fetched.push(source); return { bytes: new Uint8Array([7, fetched.length]), fileName: source.name }; },
    foreignDocuments: { pool: trackedPool({ createEngine: async () => other.wasm as never, preflight: passPreflight, storage: null }) },
  });
  const source = (mtimeMs: number): FileDocumentSource => ({ kind: 'file', handle: 'h1', name: '외부.hwp', size: 2, mtimeMs });
  const read = (mtimeMs: number) => executor.execute('get_text_range', { documentId: 'file:h1', sectionIdx: 0, paraIdx: 0 }, 'claude', {
    workflow: 'question', source: source(mtimeMs),
  }) as Promise<Record<string, unknown>>;

  const first = await read(100);
  assert.equal(first['documentId'], 'file:h1');
  assert.equal(first['name'], '외부.hwp');
  assert.equal(first['text'], '파일의 첫 문단');
  assert.equal(first['revision'], undefined);
  await read(100);
  assert.equal(fetched.length, 1, '같은 파일이면 다시 받지 않는다');
  await read(200);
  assert.equal(fetched.length, 2, '수정 시각이 바뀌면 새로 받는다');

  await expectErr(executor.execute('get_structure', { documentId: 'file:h2' }, 'claude', {
    workflow: 'question', source: source(100),
  }), 'SOURCE_NOT_FOUND');
  await expectErr(executor.execute('get_structure', { documentId: 'file:h1' }, 'claude', {
    workflow: 'question', source: { ...source(100), size: FOREIGN_DOCUMENT_MAX_BYTES + 1 },
  }), 'SOURCE_TOO_LARGE');
  assert.equal(fetched.length, 2);
});

test('파일 원본 응답 — 404 는 SOURCE_NOT_FOUND, 한도를 넘는 응답은 SOURCE_TOO_LARGE', async () => {
  const source: FileDocumentSource = { kind: 'file', handle: 'h1', name: '외부.hwp', size: 3, mtimeMs: 1 };
  await expectErr(readFileSourceResponse(source, new Response('{"error":{"code":"NOT_FOUND"}}', { status: 404 })), 'SOURCE_NOT_FOUND');
  await expectErr(readFileSourceResponse(source, new Response('', { status: 409 })), 'SOURCE_UNREADABLE');
  await expectErr(readFileSourceResponse(source, new Response('', {
    headers: { 'content-length': String(FOREIGN_DOCUMENT_MAX_BYTES + 1) },
  })), 'SOURCE_TOO_LARGE');
  const read = await readFileSourceResponse(source, new Response(new Uint8Array([1, 2, 3]), { headers: { 'X-Document-Mtime': '1' } }));
  assert.deepEqual([...read.bytes], [1, 2, 3]);
  assert.equal(read.fileName, '외부.hwp');
});

test('확인한 뒤 바뀐 파일의 바이트는 옛 열쇠로 담지 않고, 다음 읽기는 새로 받는다', async () => {
  const source: FileDocumentSource = { kind: 'file', handle: 'h1', name: '외부.hwp', size: 3, mtimeMs: 100 };
  const changed = await expectErr(readFileSourceResponse(source, new Response(new Uint8Array([1, 2, 3]), {
    headers: { 'X-Document-Mtime': '200' },
  })), 'SOURCE_UNREADABLE');
  assert.match(changed.message, /read it again/);
  await expectErr(readFileSourceResponse(source, new Response(new Uint8Array([1, 2, 3, 4]), {
    headers: { 'X-Document-Mtime': '100' },
  })), 'SOURCE_UNREADABLE');

  const engines = engineFactory();
  const pool = trackedPool({ createEngine: engines.createEngine, preflight: passPreflight, storage: null });
  const responses = [
    new Response(new Uint8Array([1, 2, 3]), { headers: { 'X-Document-Mtime': '200' } }),
    new Response(new Uint8Array([1, 2, 3]), { headers: { 'X-Document-Mtime': '100' } }),
  ];
  const use = () => pool.use(fileSourceKey(source), () => readFileSourceResponse(source, responses.shift()!), () => 'read', { untrusted: true });
  await expectErr(use(), 'SOURCE_UNREADABLE');
  assert.equal(pool.has(fileSourceKey(source)), false);
  assert.equal(await use(), 'read', '바뀐 판을 거절한 기억이 같은 열쇠의 다음 읽기를 막지 않는다');
});

test('다른 문서 읽기 권한은 채팅 권한 목록으로 받아들인다', () => {
  assert.deepEqual(readChatPermissionGrants(['other-documents', 'browser']), ['other-documents', 'browser']);
  assert.deepEqual(readChatPermissionGrants(['other-documents', 'unknown']), []);
});
