import http from 'node:http';

/**
 * In-process stand-ins for the hosted Rau upstreams: Anthropic (`POST /v1/messages`) and OpenRouter's
 * Anthropic-compatible `POST /api/v1/messages`. Both answer the happy path in the Anthropic Messages
 * shape, streamed or not, echoing the model they were asked for. `next(...)` queues a scripted answer
 * for the next call:
 *   { status, json }       an error (or any JSON) answer
 *   { network: true }      drop the connection without an answer
 *   { cutAfter: n }        stream n events, pause, then drop the connection
 *   { hold: true }         stream message_start and a few deltas, then wait for release()
 *   { errorEvent: type }   answer 200 and stream an `error` event first
 *   { id, cost, text }     override the happy answer's id, OpenRouter cost or text
 */

export const USAGE = {
  input_tokens: 1000,
  output_tokens: 1,
  cache_read_input_tokens: 2000,
  cache_creation_input_tokens: 500,
  cache_creation: { ephemeral_5m_input_tokens: 500, ephemeral_1h_input_tokens: 0 },
};
export const OUTPUT_TOKENS = 300;
/** USAGE with OUTPUT_TOKENS at Haiku 4.5 list prices: 1000 × $1 + 300 × $5 + 2000 × $0.10 + 500 × $1.25 per MTok. */
export const HAIKU_CALL_USD = 0.003325;

const sse = (type, data) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;

function events({ id, model, cost }) {
  return [
    sse('message_start', { message: { id, type: 'message', role: 'assistant', model, content: [], usage: USAGE } }),
    sse('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }),
    sse('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'Hello' } }),
    sse('content_block_delta', { index: 0, delta: { type: 'text_delta', text: ' there' } }),
    sse('content_block_stop', { index: 0 }),
    sse('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: OUTPUT_TOKENS, ...(cost !== undefined ? { cost } : {}) } }),
    sse('message_stop', {}),
  ];
}

function message({ id, model, cost, text = 'Hello there' }) {
  return {
    id,
    type: 'message',
    role: 'assistant',
    model,
    content: [{ type: 'thinking', thinking: '' }, { type: 'text', text }, { type: 'text', text: '!' }],
    stop_reason: 'end_turn',
    usage: { ...USAGE, output_tokens: OUTPUT_TOKENS, ...(cost !== undefined ? { cost } : {}) },
  };
}

function createFake(path, idPrefix, defaultCost) {
  const calls = [];
  const queue = [];
  let waiters = [];
  const release = () => { const w = waiters; waiters = []; w.forEach((fn) => fn()); };
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null;
    const call = { method: req.method, path: new URL(req.url, 'http://fake').pathname, headers: req.headers, body, closed: false, finished: false };
    calls.push(call);
    res.on('close', () => { call.closed = !call.finished; });
    if (`${req.method} ${call.path}` !== `POST ${path}`) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end('{}'); return; }
    const script = queue.shift() ?? {};
    if (script.network) { req.socket.destroy(); return; }
    if (script.status) {
      res.writeHead(script.status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(script.json ?? {}));
      call.finished = true;
      return;
    }
    const args = { id: script.id ?? `${idPrefix}_${calls.length}`, model: body.model, cost: script.cost ?? defaultCost, text: script.text };
    if (!body?.stream) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(message(args)));
      call.finished = true;
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    if (script.errorEvent) {
      res.end(sse('error', { error: { type: script.errorEvent, message: 'Overloaded' } }));
      call.finished = true;
      return;
    }
    for (const [index, event] of events(args).entries()) {
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

/** Anthropic direct. Reports no cost, like the real API. */
export function createFakeAnthropic() {
  return createFake('/v1/messages', 'msg_anthropic', undefined);
}

/** OpenRouter's `/messages`; listen with the `/api/v1` prefix. Reports `usage.cost` (default $0.0004). */
export function createFakeOpenRouter() {
  return createFake('/api/v1/messages', 'gen-or', 0.0004);
}
