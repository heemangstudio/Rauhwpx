import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';
registerHooks({
  load(url, context, next) {
    return url.endsWith('.css')
      ? { format: 'module', source: 'export default {};', shortCircuit: true }
      : next(url, context);
  },
});
const { AgentBridgeImpl, normalizeReferenceFile, normalizeReferenceSearchHit } =
  await import('../src/agent/bridge.ts');
const { PendingRequestRegistry } = await import('../src/agent/pending-requests.ts');

test('reference aliases normalize values and reject incomplete metadata', () => {
  const fallback = { scope: 'chat' as const, scopeId: 'chat-1' };
  assert.deepEqual(
    normalizeReferenceFile(
      {
        referenceId: 'file-1',
        filename: 'notes.txt',
        byteLength: 12,
        contentType: 'text/plain',
        state: 'ready',
        uploadedAt: '2026-01-01',
      },
      fallback,
    ),
    {
      id: 'file-1',
      name: 'notes.txt',
      size: 12,
      mimeType: 'text/plain',
      status: 'ready',
      createdAt: '2026-01-01',
      kind: 'document',
      ...fallback,
    },
  );
  for (const value of [
    null,
    [],
    'file',
    {},
    { id: 'f' },
    { id: '', name: 'n' },
  ]) {
    assert.equal(normalizeReferenceFile(value, fallback), null);
  }
  for (const size of [-1, Infinity, 'invalid']) {
    assert.equal(
      normalizeReferenceFile({ id: 'f', name: 'n', size }, fallback)?.size,
      0,
    );
  }
});

test('search aliases preserve hostile snippets as data and normalize optional values', () => {
  const snippet = '<img src=x onerror="window.compromised=true">';
  assert.deepEqual(
    normalizeReferenceSearchHit(
      {
        fileId: 'f',
        filename: 'n',
        text: snippet,
        score: 'invalid',
        page: null,
        chunkIndex: -1,
      },
      { scope: 'document', scopeId: 'd' },
    ),
    {
      referenceId: 'f',
      name: 'n',
      snippet,
      score: 0,
      page: null,
      scope: 'document',
      scopeId: 'd',
    },
  );
  for (const value of [null, [], {}, { fileId: 1, filename: 'n' }]) {
    assert.equal(
      normalizeReferenceSearchHit(value, { scope: 'chat', scopeId: 't' }),
      null,
    );
  }
});

test('reference requests send the selected scope and correct endpoint capability', async (t) => {
  const requests: { url: URL; headers: Headers }[] = [];
  t.mock.method(
    globalThis,
    'fetch',
    async (url: string, init?: RequestInit) => {
      requests.push({ url: new URL(url), headers: new Headers(init?.headers) });
      return Response.json({
        files: [{ referenceId: 'f', filename: 'notes.txt' }],
      });
    },
  );
  // The network is the test boundary; URL construction, capability selection, parsing and normalization are production methods.
  const bridge = Object.assign(Object.create(AgentBridgeImpl.prototype), {
    httpBaseUrl: 'http://hub.test',
    sessionId: 'session-1',
    referenceToken: 'references-capability',
    templateToken: 'templates-capability',
  });
  const files = await bridge.listReferences('chat', 'chat-1');
  assert.equal(files[0].scopeId, 'chat-1');
  assert.equal(requests[0].url.pathname, '/reference-files');
  assert.equal(requests[0].url.searchParams.get('sessionId'), 'session-1');
  assert.equal(requests[0].url.searchParams.get('scope'), 'chat');
  assert.equal(requests[0].url.searchParams.get('scopeId'), 'chat-1');
  assert.equal(
    requests[0].headers.get('Authorization'),
    'Bearer references-capability',
  );
  await bridge.referenceFetch('http://hub.test/templates/template-1');
  assert.equal(
    requests[1].headers.get('Authorization'),
    'Bearer templates-capability',
  );
  t.mock.method(globalThis, 'fetch', async () =>
    Response.json({ error: { message: 'scope denied' } }, { status: 403 }),
  );
  await assert.rejects(
    bridge.listReferences('document', 'other-document'),
    /scope denied/,
  );
});

test('draft staging waits for the bound chat and rejects a changed or disconnected chat', async (t) => {
  const frames: any[] = [];
  const uploads: string[] = [];
  t.mock.method(globalThis, 'fetch', async (url: string) => {
    uploads.push(url);
    return Response.json({ staged: {
      id: 'draft-file', name: 'notes.txt', scopeId: 'draft-chat',
      expiresAt: '2026-10-11T00:00:00Z',
    } });
  });
  const bridge = Object.assign(Object.create(AgentBridgeImpl.prototype), {
    state: 'connected', requests: new PendingRequestRegistry(), requestSeq: 0, threadId: '',
    documentId: null, documentName: null,
    httpBaseUrl: 'http://hub.test', sessionId: 'session-1', referenceToken: 'reference-capability',
    sendJson: (frame: unknown) => { frames.push(frame); return true; },
  });
  const file = new File(['draft attachment'], 'notes.txt', { type: 'text/plain' });
  const staging = bridge.stageReference('draft-chat', file);
  assert.equal(frames[0].type, 'reference-stage-bind');
  assert.equal(frames[0].threadId, 'draft-chat');
  assert.equal(uploads.length, 0, 'HTTP staging cannot race ahead of the scope acknowledgment');
  bridge.handleMessage({ type: 'reference-stage-bound', requestId: frames[0].requestId, threadId: 'draft-chat' });
  assert.equal((await staging).scopeId, 'draft-chat');
  assert.equal(uploads.length, 1);

  const changedChat = bridge.stageReference('draft-chat', file);
  bridge.handleMessage({ type: 'reference-stage-bound', requestId: frames[1].requestId, threadId: 'active-other-chat' });
  await assert.rejects(changedChat, /현재 채팅이 바뀌었습니다/);
  assert.equal(uploads.length, 1, 'a different authoritative chat must not receive the attachment');

  for (const field of ['threadId', 'documentId']) {
    const stale = bridge.stageReference('draft-chat', file);
    const frame = frames.at(-1);
    const previous = bridge[field];
    bridge[field] = 'changed-context';
    bridge.handleMessage({ type: 'reference-stage-bound', requestId: frame.requestId, threadId: 'draft-chat' });
    await assert.rejects(stale, /현재 채팅이 바뀌었습니다/);
    bridge[field] = previous;
  }
  const controller = new AbortController();
  const cancelled = bridge.stageReference('draft-chat', file, controller.signal);
  const cancelledFrame = frames.at(-1);
  controller.abort();
  bridge.handleMessage({ type: 'reference-stage-bound', requestId: cancelledFrame.requestId, threadId: 'draft-chat' });
  await assert.rejects(cancelled, (error: Error) => error.name === 'AbortError');
  assert.equal(uploads.length, 1, 'stale context and cancelled drafts never reach HTTP staging');

  bridge.sendJson = () => false;
  await assert.rejects(bridge.stageReference('draft-chat', file), /서버 연결을 확인하고 다시 시도/);
  assert.equal(uploads.length, 1);
});
