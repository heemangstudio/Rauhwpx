import assert from 'node:assert/strict';
import test from 'node:test';

import {
  EXTENSION_FETCH_CHUNK_MAX_BYTES,
  readExtensionDocumentBytes,
  type ExtensionMessageRuntime,
} from '../src/core/extension-file-transfer.ts';

type Message = Record<string, unknown>;

function chunkRuntime(
  source: Uint8Array,
  format: 'number-array' | 'array-buffer',
  mutate?: (response: Message, message: Message) => Message,
): ExtensionMessageRuntime & { calls: Message[] } {
  const transferId = 'transfer-test-0001';
  const chunkBytes = 4;
  const calls: Message[] = [];
  return {
    calls,
    async sendMessage(message) {
      calls.push(message);
      if (message.type === 'fetch-file-start') {
        return {
          transferId,
          byteLength: source.byteLength,
          chunkBytes,
          chunkCount: Math.ceil(source.byteLength / chunkBytes),
        };
      }
      if (message.type === 'fetch-file-chunk') {
        const index = message.index as number;
        const offset = index * chunkBytes;
        const view = source.subarray(offset, Math.min(offset + chunkBytes, source.byteLength));
        const response: Message = {
          transferId,
          index,
          offset,
          byteLength: view.byteLength,
          done: offset + view.byteLength === source.byteLength,
          data: format === 'number-array' ? Array.from(view) : view.slice().buffer,
        };
        return mutate ? mutate(response, message) : response;
      }
      if (message.type === 'fetch-file-close') return { ok: true };
      throw new Error(`Unexpected message: ${String(message.type)}`);
    },
    getURL() { return 'chrome-extension://test/'; },
  };
}

test('reassembles bounded Chrome number-array chunks and always closes', async () => {
  const source = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  const runtime = chunkRuntime(source, 'number-array');
  assert.deepEqual(await readExtensionDocumentBytes(runtime, 'blob:local-document', 20), source);
  assert.deepEqual(runtime.calls.map((call) => call.type), [
    'fetch-file-start',
    'fetch-file-chunk',
    'fetch-file-chunk',
    'fetch-file-chunk',
    'fetch-file-close',
  ]);
});

test('reassembles exact Firefox ArrayBuffer chunks', async () => {
  const source = new Uint8Array([9, 8, 7, 6, 5, 4, 3]);
  const runtime = chunkRuntime(source, 'array-buffer');
  assert.deepEqual(await readExtensionDocumentBytes(runtime, 'blob:local-document', 20), source);
  assert.equal(runtime.calls.at(-1)?.type, 'fetch-file-close');
});

test('rejects oversized start metadata before requesting chunks and still closes', async () => {
  const calls: Message[] = [];
  const runtime: ExtensionMessageRuntime = {
    async sendMessage(message) {
      calls.push(message);
      if (message.type === 'fetch-file-start') {
        return {
          transferId: 'transfer-test-0002',
          byteLength: 21,
          chunkBytes: 4,
          chunkCount: 6,
        };
      }
      return { ok: true };
    },
  };
  await assert.rejects(
    () => readExtensionDocumentBytes(runtime, 'blob:local-document', 20),
    /exceeds 20 bytes/,
  );
  assert.deepEqual(calls.map((call) => call.type), ['fetch-file-start', 'fetch-file-close']);
});

test('closes a transfer id even when a malformed start also reports an error', async () => {
  const calls: Message[] = [];
  const runtime: ExtensionMessageRuntime = {
    async sendMessage(message) {
      calls.push(message);
      if (message.type === 'fetch-file-start') {
        return { transferId: 'transfer-test-err1', error: 'start failed' };
      }
      return { ok: true };
    },
  };
  await assert.rejects(
    () => readExtensionDocumentBytes(runtime, 'blob:local-document', 20),
    /start failed/,
  );
  assert.deepEqual(calls.map((call) => call.type), ['fetch-file-start', 'fetch-file-close']);
});

test('rejects malformed order, size, and payload responses and closes each transfer', async () => {
  const cases: Array<(response: Message) => Message> = [
    (response) => ({ ...response, index: 1 }),
    (response) => ({ ...response, offset: 1 }),
    (response) => ({ ...response, byteLength: 3 }),
    (response) => ({ ...response, done: true }),
    (response) => ({ ...response, data: [1, 2, 3, 999] }),
    (response) => ({ ...response, data: new ArrayBuffer(3) }),
  ];
  for (const mutate of cases) {
    let mutated = false;
    const runtime = chunkRuntime(new Uint8Array([1, 2, 3, 4, 5]), 'number-array', (response) => {
      if (mutated) return response;
      mutated = true;
      return mutate(response);
    });
    await assert.rejects(
      () => readExtensionDocumentBytes(runtime, 'blob:local-document', 20),
      /malformed|out of order/,
    );
    assert.equal(runtime.calls.at(-1)?.type, 'fetch-file-close');
  }
});

test('rejects an advertised chunk above the 256 KiB wire bound before allocation', async () => {
  const calls: Message[] = [];
  const runtime: ExtensionMessageRuntime = {
    async sendMessage(message) {
      calls.push(message);
      if (message.type === 'fetch-file-start') {
        return {
          transferId: 'transfer-test-0003',
          byteLength: 1,
          chunkBytes: EXTENSION_FETCH_CHUNK_MAX_BYTES + 1,
          chunkCount: 1,
        };
      }
      return { ok: true };
    },
  };
  await assert.rejects(
    () => readExtensionDocumentBytes(runtime, 'blob:local-document'),
    /chunk size is malformed/,
  );
  assert.deepEqual(calls.map((call) => call.type), ['fetch-file-start', 'fetch-file-close']);
});

test('keeps Safari on its bounded ArrayBuffer transport', async () => {
  const calls: Message[] = [];
  const source = new Uint8Array([4, 3, 2, 1]);
  const runtime: ExtensionMessageRuntime = {
    getURL() { return 'safari-web-extension://test/'; },
    async sendMessage(message) {
      calls.push(message);
      return { data: source.slice().buffer };
    },
  };
  assert.deepEqual(await readExtensionDocumentBytes(runtime, 'file:///local/a.hwp', 20), source);
  assert.deepEqual(calls.map((call) => call.type), ['fetch-file']);
});

test('fails closed for every remote URL before extension messaging', async () => {
  const calls: Message[] = [];
  const runtime: ExtensionMessageRuntime = {
    async sendMessage(message) { calls.push(message); return {}; },
  };
  for (const url of [
    'https://example.com/a.hwp',
    'http://93.184.216.34/a.hwp',
    'https://example.com/redirect.hwp',
    ' \t\nhttps://example.com/canonicalized.hwp',
  ]) {
    await assert.rejects(
      () => readExtensionDocumentBytes(runtime, url),
      { code: 'REMOTE_PROXY_UNAVAILABLE', requirement: 'SERVER_FETCH_REQUIRED' },
    );
  }
  assert.deepEqual(calls, []);
});

// 확장 쪽 라우터는 원격 문서를 대신 받아 주지 않는다 — 바이트를 싣지 않고 정해진 오류만 돌려준다.
const VIEWER_SENDER = { url: 'chrome-extension://rhwp-test/viewer.html' };

for (const [browser, runtimeGlobal] of [['chrome', 'chrome'], ['firefox', 'browser']] as const) {
  test(`${browser} service worker refuses every remote fetch-file message without bytes`, async () => {
    const g = globalThis as Record<string, unknown>;
    const previous = g[runtimeGlobal];
    g[runtimeGlobal] = { runtime: { id: 'rhwp-test', getURL: (path: string) => `chrome-extension://rhwp-test/${path}` } };
    try {
      const { dispatchRuntimeMessage } = await import(`../../rhwp-${browser}/sw/message-router.js`);
      for (const type of ['fetch-file-start', 'fetch-file-chunk', 'fetch-file-close']) {
        const responses: Message[] = [];
        dispatchRuntimeMessage(
          { type, url: 'https://example.com/a.hwp', transferId: 'transfer-test-0001', index: 0 },
          VIEWER_SENDER,
          (response: Message) => responses.push(response),
        );
        assert.equal(responses.length, 1);
        assert.equal(responses[0].code, 'REMOTE_PROXY_UNAVAILABLE', type);
        assert.equal(responses[0].requirement, 'SERVER_FETCH_REQUIRED');
        assert.equal('data' in responses[0], false);
      }
    } finally {
      g[runtimeGlobal] = previous;
    }
  });
}

test('safari background refuses remote fetch-file without fetching', async () => {
  const g = globalThis as Record<string, unknown>;
  const previous = { browser: g.browser, fetch: g.fetch, security: g.RHWPFetchSecurity };
  let listener: ((message: Message, sender: unknown, respond: (r: Message) => void) => unknown) | null = null;
  let fetched = 0;
  const event = { addListener() {} };
  g.browser = {
    runtime: {
      getURL: (path: string) => `safari-web-extension://rhwp-test/${path}`,
      onMessage: { addListener(fn: typeof listener) { listener = fn; } },
      onInstalled: event,
    },
    storage: { local: { get: async (defaults: unknown) => defaults, set: async () => {} } },
    contextMenus: { removeAll() {}, create() {}, onClicked: event },
    action: { onClicked: event },
    tabs: { create() {} },
    i18n: { getMessage: () => '' },
  };
  g.fetch = async () => { fetched += 1; return new Response(new Uint8Array([1])); };
  const log = console.log;
  console.log = () => {};
  try {
    // 배포 빌드처럼 보안 모듈을 먼저 전역에 올린다.
    await import('../../rhwp-safari/src/fetch-security.js');
    await import('../../rhwp-safari/src/background.js');
    assert.ok(listener, 'background must register a runtime message listener');
    const responses: Message[] = [];
    listener!(
      { type: 'fetch-file', url: 'https://example.com/a.hwp' },
      { url: 'safari-web-extension://rhwp-test/viewer.html' },
      (response) => responses.push(response),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(responses[0]?.code, 'REMOTE_PROXY_UNAVAILABLE');
    assert.equal('data' in responses[0], false);
    assert.equal(fetched, 0);
  } finally {
    g.browser = previous.browser;
    g.fetch = previous.fetch;
    g.RHWPFetchSecurity = previous.security;
    console.log = log;
  }
});
