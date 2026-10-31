import http from 'node:http';

import { ignorePortProbe } from './port-probe.mjs';

/**
 * In-process stand-ins for the Hama upstreams: Anthropic (`POST /v1/messages`) and OpenRouter
 * (`POST /api/v1/messages`, Anthropic-compatible, and `POST /api/v1/chat/completions`).
 * Each answers the happy path by default; `next(...)` queues a scripted answer for the next call:
 *   { status, json }       an error (or any JSON) answer
 *   { network: true }      drop the connection without an answer
 *   { cutAfter: n }        stream n events, pause, then drop the connection
 *   { hold: true }         stream message_start and one delta, then wait for release()
 *   { errorEvent: type }   answer 200 and stream an `error` event first
 *   { id, provider, cost } override the happy answer's id / provider / cost
 */

export const ANTHROPIC_USAGE = {
  input_tokens: 1000,
  output_tokens: 1,
  cache_read_input_tokens: 2000,
  cache_creation_input_tokens: 500,
  cache_creation: { ephemeral_5m_input_tokens: 500, ephemeral_1h_input_tokens: 0 },
};
export const OUTPUT_TOKENS = 300;

const sse = (type, data) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;

function claudeEvents({ id, provider, cost }) {
  return [
    sse('message_start', { message: { id, type: 'message', role: 'assistant', model: 'claude-haiku-5-5', content: [], ...(provider ? { provider } : {}), usage: ANTHROPIC_USAGE } }),
    sse('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }),
    sse('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'Hello' } }),
    sse('content_block_delta', { index: 0, delta: { type: 'text_delta', text: ' there' } }),
    sse('content_block_stop', { index: 0 }),
    sse('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: OUTPUT_TOKENS, ...(cost !== undefined ? { cost } : {}) } }),
    sse('message_stop', {}),
  ];
}

function cheapChunks({ id, provider, model, cost }) {
  const chunk = (extra) => `data: ${JSON.stringify({ id, provider, model, object: 'chat.completion.chunk', ...extra })}\n\n`;
  return [
    chunk({ choices: [{ index: 0, delta: { role: 'assistant', content: 'Hi' } }] }),
    chunk({ choices: [{ index: 0, delta: { content: ' you' }, finish_reason: 'stop' }] }),
    chunk({ choices: [], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, cost } }),
    'data: [DONE]\n\n',
  ];
}

function createFake(handlers) {
  const calls = [];
  const queue = [];
  let waiters = [];
  const release = () => { const w = waiters; waiters = []; w.forEach((fn) => fn()); };
  const server = http.createServer(async (req, res) => {
    if (ignorePortProbe(req, res)) return;
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null;
    const call = { method: req.method, path: new URL(req.url, 'http://fake').pathname, headers: req.headers, body, closed: false, finished: false };
    calls.push(call);
    res.on('close', () => { call.closed = !call.finished; });
    const handler = handlers[`${req.method} ${call.path}`];
    if (!handler) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end('{}'); return; }
    const script = queue.shift() ?? {};
    if (script.network) { req.socket.destroy(); return; }
    if (script.status) {
      res.writeHead(script.status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(script.json ?? {}));
      call.finished = true;
      return;
    }
    const events = handler(body, script, calls.length);
    if (!body?.stream) {
      // Non-streamed: the handler's JSON form.
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(events.json));
      call.finished = true;
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    if (script.errorEvent) {
      res.end(sse('error', { error: { type: script.errorEvent, message: 'Overloaded' } }));
      call.finished = true;
      return;
    }
    const list = events.stream;
    for (const [index, event] of list.entries()) {
      if (res.destroyed) return;
      if (script.cutAfter !== undefined && index === script.cutAfter) {
        // Let the first events reach the proxy (and its client) before the connection drops.
        await new Promise((resolve) => setTimeout(resolve, 50));
        req.socket.destroy();
        return;
      }
      if (script.hold && index === 4) await new Promise((resolve) => waiters.push(resolve));
      if (res.destroyed) return;
      res.write(event);
    }
    call.finished = true;
    res.end();
  });
  return {
    server,
    calls,
    release,
    next(...scripts) { queue.push(...scripts); },
    async listen(prefix = '') {
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      return `http://127.0.0.1:${server.address().port}${prefix}`;
    },
    close() {
      release();
      server.closeAllConnections?.();
      return new Promise((resolve) => server.close(resolve));
    },
  };
}

export function createFakeAnthropic() {
  return createFake({
    'POST /v1/messages': (body, script, n) => {
      const id = script.id ?? `msg_anthropic_${n}`;
      return {
        stream: claudeEvents({ id }),
        json: { id, type: 'message', role: 'assistant', model: 'claude-haiku-5-5', content: [{ type: 'text', text: 'Hello' }], usage: { ...ANTHROPIC_USAGE, output_tokens: OUTPUT_TOKENS } },
      };
    },
  });
}

export function createFakeOpenRouter() {
  return createFake({
    'POST /api/v1/messages': (body, script, n) => {
      const id = script.id ?? `gen-or-msg-${n}`;
      return { stream: claudeEvents({ id, provider: script.provider ?? 'Anthropic', cost: script.cost ?? 0.0004 }), json: null };
    },
    'POST /api/v1/chat/completions': (body, script, n) => {
      const id = script.id ?? `gen-cheap-${n}`;
      const args = { id, provider: script.provider ?? 'DeepInfra', model: body.model, cost: script.cost ?? 0.00002 };
      return {
        stream: cheapChunks(args),
        json: { id, provider: args.provider, model: body.model, choices: [{ index: 0, message: { role: 'assistant', content: 'Hi you' } }], usage: { prompt_tokens: 100, completion_tokens: 20, cost: args.cost } },
      };
    },
  });
}
