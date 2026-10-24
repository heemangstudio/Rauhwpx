import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer as createHttpServer } from 'node:http';
import { createRequire } from 'node:module';
import { createServer as createViteServer } from 'vite';
import { liveUsagePlugin } from '../sidebar-preview/live-usage-plugin.mjs';
import { requestLiveTokenUsage, requestLiveUsage } from '../src/sidebar-preview/live-usage.ts';

const require = createRequire(new URL('../../rhwp-agent/package.json', import.meta.url));
const { WebSocketServer } = require('ws');

test('live sidebar token audit sends each period and refresh to the hub, then handles reports and errors', async () => {
  const frames: Record<string, unknown>[] = [];
  let replyType = 'token-usage';
  const hub = createHttpServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/healthz') res.end(JSON.stringify({ launchId: 'test-launch' }));
    else if (req.method === 'POST' && req.url?.startsWith('/sessions/')) {
      res.end(JSON.stringify({ capabilities: { studio: 'test-capability' } }));
    } else if (req.method === 'DELETE' && req.url?.startsWith('/sessions/')) res.end('{}');
    else { res.statusCode = 404; res.end('{}'); }
  });
  const wss = new WebSocketServer({ server: hub, path: '/studio' });
  wss.on('connection', (socket: any) => socket.on('message', (bytes: Buffer) => {
    const frame = JSON.parse(String(bytes));
    frames.push(frame);
    if (frame.type === 'usage-request') {
      socket.send(JSON.stringify({ type: 'usage-report', requestId: frame.requestId,
        usage: { providers: {}, limits: {} } }));
    } else if (replyType === 'token-usage-error') {
      socket.send(JSON.stringify({ type: 'token-usage-error', requestId: frame.requestId,
        message: 'audit failed' }));
    } else {
      socket.send(JSON.stringify({ type: replyType, requestId: frame.requestId,
        days: frame.days, generatedAt: 123, totalTokens: 456, sessions: 1,
        providers: [], daily: [], errors: ['one unreadable log'] }));
    }
  }));
  await new Promise<void>((resolve) => hub.listen(0, '127.0.0.1', resolve));
  const hubUrl = `http://127.0.0.1:${(hub.address() as { port: number }).port}`;
  const vite = await createViteServer({ configFile: false, plugins: [liveUsagePlugin(hubUrl)],
    optimizeDeps: { noDiscovery: true, entries: [] },
    server: { host: '127.0.0.1', port: 0 } });
  const originalFetch = globalThis.fetch;
  try {
    await vite.listen();
    const origin = `http://127.0.0.1:${(vite.httpServer!.address() as { port: number }).port}`;
    globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => originalFetch(
      typeof input === 'string' && input.startsWith('/') ? origin + input : input, init,
    )) as typeof fetch;

    for (const days of [7, 30, 90] as const) {
      const report = await requestLiveTokenUsage(days, days === 90);
      assert.equal(report.days, days);
      assert.equal(report.totalTokens, 456);
      assert.deepEqual(report.errors, ['one unreadable log']);
    }
    assert.deepEqual(frames.slice(0, 3).map(({ type, days, refresh }) => ({ type, days, refresh })), [
      { type: 'token-usage-request', days: 7, refresh: false },
      { type: 'token-usage-request', days: 30, refresh: false },
      { type: 'token-usage-request', days: 90, refresh: true },
    ]);
    assert.deepEqual(await requestLiveUsage(), { providers: {}, limits: {} });

    replyType = 'token-usage-error';
    await assert.rejects(requestLiveTokenUsage(7, true), /audit failed/);
    replyType = 'usage-report';
    await assert.rejects(requestLiveTokenUsage(7), /실제 토큰 사용량 응답이 없어요/);
    assert.equal(frames.at(-1)?.type, 'token-usage-request');
  } finally {
    globalThis.fetch = originalFetch;
    await vite.close();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    await new Promise<void>((resolve) => hub.close(() => resolve()));
  }
});
