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
