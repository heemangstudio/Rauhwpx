import { randomBytes } from 'node:crypto';
import http from 'node:http';

/**
 * In-process stand-in for the parts of OpenRouter the gift service uses:
 * provisioning (/keys), key info (/key), /models and /chat/completions with SSE.
 * Streams pause between chunks until `release()` is called, so a test (or the live
 * check) can see each chunk arrive on its own.
 */
export function createFakeOpenRouter({ provisioningKey = 'pk-test', autoRelease = 0 } = {}) {
  const keys = new Map(); // hash → { name, key, limit, usage, byokUsage, includeByok, disabled }
  const calls = [];
  const chats = [];
  let createFailure = null; // { status, createAnyway }
  let patchFailure = null; // status
  let patchHold = null; // promise the next PATCH response waits for, after the change is applied
  let chatFailure = null; // { status, body }
  let chatReply = 'hello';
  let chatSpend = { credit: 0.0125, byok: 0.25 }; // what one chat completion costs
  let waiters = [];
  const release = () => { const w = waiters; waiters = []; w.forEach((fn) => fn()); };
  const gate = () => (autoRelease > 0
    ? new Promise((resolve) => setTimeout(resolve, autoRelease))
    : new Promise((resolve) => waiters.push(resolve)));

  const json = (res, status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  // Like OpenRouter: `usage` is credit spend, `byok_usage` provider-key spend; the limit counts
  // BYOK spend only when the key was created with include_byok_in_limit.
  const spent = (k) => k.usage + (k.includeByok ? k.byokUsage : 0);
  const keyInfo = (hash, k) => ({
    hash, name: k.name, label: `${k.key.slice(0, 12)}...`, disabled: k.disabled,
    limit: k.limit, usage: k.usage, byok_usage: k.byokUsage, include_byok_in_limit: k.includeByok,
    limit_remaining: Math.max(0, k.limit - spent(k)), limit_reset: k.limitReset ?? null,
    // The fake never crosses a month, so this month's usage is all of it.
    usage_monthly: k.usage, byok_usage_monthly: k.byokUsage,
  });
  const byKey = (auth) => [...keys.entries()].find(([, k]) => `Bearer ${k.key}` === auth);

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://fake');
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null;
    const auth = req.headers.authorization;
    calls.push({ method: req.method, path: url.pathname, search: url.search, auth, body });
    const management = auth === `Bearer ${provisioningKey}`;

    if (url.pathname === '/api/v1/keys' && req.method === 'POST') {
      if (!management) return json(res, 401, { error: { code: 401, message: 'no' } });
      const failure = createFailure;
      createFailure = null;
      const hash = randomBytes(8).toString('hex');
      const key = `sk-or-v1-${randomBytes(16).toString('hex')}`;
      if (!failure || failure.createAnyway) keys.set(hash, { name: body.name, key, limit: body.limit, limitReset: body.limit_reset ?? null, usage: 0, byokUsage: 0, includeByok: body.include_byok_in_limit === true, disabled: false });
      if (failure) return json(res, failure.status, { error: { code: failure.status, message: 'boom' } });
      return json(res, 201, { key, data: keyInfo(hash, keys.get(hash)) });
    }
    if (url.pathname === '/api/v1/keys' && req.method === 'GET') {
      if (!management) return json(res, 401, { error: { code: 401, message: 'no' } });
      const offset = Number(url.searchParams.get('offset') ?? 0);
      return json(res, 200, { data: [...keys.entries()].slice(offset, offset + 100).map(([h, k]) => keyInfo(h, k)) });
    }
    const keyPath = url.pathname.match(/^\/api\/v1\/keys\/([^/]+)$/);
    if (keyPath) {
      if (!management) return json(res, 401, { error: { code: 401, message: 'no' } });
      const k = keys.get(keyPath[1]);
      if (!k) return json(res, 404, { error: { code: 404, message: 'not found' } });
      if (req.method === 'DELETE') { keys.delete(keyPath[1]); return json(res, 200, { deleted: true }); }
      if (req.method === 'PATCH') {
        if (patchFailure) { const status = patchFailure; patchFailure = null; return json(res, status, { error: { code: status, message: 'boom' } }); }
        if (body.disabled !== undefined) k.disabled = body.disabled;
        if (body.limit !== undefined) k.limit = body.limit;
        if (body.limit_reset !== undefined) k.limitReset = body.limit_reset;
        if (patchHold) { const held = patchHold; patchHold = null; await held; }
        return json(res, 200, { data: keyInfo(keyPath[1], k) });
      }
    }
    if (url.pathname === '/api/v1/key') {
      const found = byKey(auth);
      if (!found) return json(res, 401, { error: { code: 401, message: 'User not found.' } });
      return json(res, 200, { data: { ...keyInfo(...found), is_free_tier: false } });
    }
    if (url.pathname === '/api/v1/models') {
      return json(res, 200, { data: [
        { id: 'anthropic/claude-sonnet-5.5', name: 'Claude Sonnet 5.5' },
        { id: 'anthropic/claude-opus-5.5', name: 'Claude Opus 5.5' },
        { id: 'openai/gpt-6', name: 'GPT-6' },
      ] });
    }
    if (url.pathname === '/api/v1/chat/completions') {
      const found = byKey(auth);
      if (!found || found[1].disabled) return json(res, 401, { error: { code: 401, message: 'User not found.' } });
      const [, k] = found;
      if (chatFailure) { const { status, body: error } = chatFailure; chatFailure = null; return json(res, status, error); }
      const chat = { body, closed: false, finished: false };
      chats.push(chat);
      res.on('close', () => { chat.closed = !chat.finished; });
      if (spent(k) >= k.limit) {
        return json(res, 403, { error: { code: 403, message: 'Key limit exceeded (total limit).', metadata: { limit_source: 'openrouter_key_limit' } } });
      }
      k.byokUsage += chatSpend.byok; // Claude via the owner's BYOK key
      k.usage += chatSpend.credit; // OpenRouter's 5% BYOK fee
      if (!body.stream) {
        chat.finished = true;
        const usage = chatSpend.byok
          ? { cost: chatSpend.credit, is_byok: true, cost_details: { upstream_inference_cost: chatSpend.byok } }
          : { cost: chatSpend.credit, is_byok: false };
        return json(res, 200, { id: 'gen-1', model: body.model, choices: [{ message: { role: 'assistant', content: chatReply } }], usage });
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      for (const word of ['Hel', 'lo', ' there']) {
        if (res.destroyed) return;
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: word } }] })}\n\n`);
        await gate();
      }
      if (res.destroyed) return;
      chat.finished = true;
      res.end('data: [DONE]\n\n');
      return;
    }
    json(res, 404, { error: { code: 404, message: 'not found' } });
  });

  return {
    server,
    keys,
    calls,
    chats,
    release,
    failNextCreate(status, { createAnyway = false } = {}) { createFailure = { status, createAnyway }; },
    failNextPatch(status) { patchFailure = status; },
    /** The next PATCH changes the key at once but answers only after the returned function is called. */
    failNextChat(status, body) { chatFailure = { status, body }; },
    /** What each later chat completion costs: `credit` on OpenRouter credits, `byok` on the owner's provider key. */
    setChatSpend(spend) { chatSpend = { credit: 0, byok: 0, ...spend }; },
    setChatReply(text) { chatReply = text; },
    holdNextPatch() { let resume; patchHold = new Promise((resolve) => { resume = resolve; }); return resume; },
    async listen(port = 0) {
      await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
      return `http://127.0.0.1:${server.address().port}/api/v1`;
    },
    close() {
      release();
      server.closeAllConnections?.();
      return new Promise((resolve) => server.close(resolve));
    },
  };
}
