import crypto from 'node:crypto';

export const CLAUDE_TEST_ORG = '0b7c2f4e-1a2b-4c3d-8e9f-001122334455';
export const CLAUDE_TEST_API_ORG = '9f8e7d6c-5b4a-4321-8fed-cba987654321';
const ROOT_PARENT = '00000000-0000-4000-8000-000000000000';

/**
 * 가짜 claude.ai — 2026-10-28 에 실제 화면에서 기록한 모양만 흉내 낸다.
 * 입력창 <div data-testid="chat-input" contenteditable="true" class="tiptap ProseMirror">,
 * 보내기 <button type="button" data-testid="chat-input-send" aria-label="Send message"> (form 밖).
 * Enter 로는 보내지 않고(키 처리가 아예 없다) 단추를 눌러야만 보낸다. 못 보낸 초안은 다음 방문에도 입력창에 남는다(draft).
 * 프로젝트 화면(/project/<uuid>)에서 보내면 주소가 /chat/<uuid> 로 바뀐다.
 * Playwright route 로 https://claude.ai/** 를 받아 네트워크에 나가지 않는다.
 *
 * drift: 'composer'(입력창 표지가 바뀜), 'send-button'(보내기 단추 표지가 바뀜 — 눌리면 보내지만 추측해서는 안 된다),
 * 'projects'(프로젝트 목록 모양이 바뀜), 'conversation'(대화 조회 모양이 바뀜).
 * retries: 차례마다 지난 답(다시 생성하기 전 가지)을 트리에 남긴다. current_leaf_message_uuid 사슬만 따라야 한다.
 * limit: 보내기(/completion)가 429 와 anthropic-ratelimit-unified-reset(유닉스 초)을 돌려준다.
 */
export function createClaudeFixture({ signedIn = true, projects = [], answerDelayMs = 300, drift = null, challenge = false,
  draft = '', retries = false, limit = null } = {}) {
  const state = {
    signedIn, projects: projects.map((project) => ({ archived_at: null, ...project })), conversations: new Map(),
    sent: [], completions: 0, answerDelayMs, drift, challenge, draft, retries, limit,
  };
  const answerOf = (prompt) => `**답**: ${prompt}\n\n- 항목`;

  const composer = () => (state.drift === 'composer'
    ? '<textarea data-testid="prompt-input" aria-label="Write your prompt" style="width:600px;height:48px"></textarea>'
    : '<div data-testid="chat-input" contenteditable="true" class="tiptap ProseMirror" role="textbox" aria-label="Write your prompt to Claude" style="min-height:24px;width:600px"></div>');
  const sendButton = () => (state.drift === 'send-button'
    ? '<button type="button" id="send" data-testid="composer-submit" aria-label="Submit" disabled>↑</button>'
    : '<button type="button" id="send" data-testid="chat-input-send" aria-label="Send message" disabled>↑</button>');

  const page = () => `<!doctype html><html><head><meta charset="utf-8"><title>Claude</title></head><body>
<main>
  <div id="thread"></div>
  <fieldset id="composer">${composer()}${sendButton()}</fieldset>
  <button type="button" id="stop" aria-label="Stop response" hidden>■</button>
  <div id="error" role="alert"></div>
</main>
<script>
const ORG = ${JSON.stringify(CLAUDE_TEST_ORG)};
const DELAY = ${state.answerDelayMs};
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const projectId = new RegExp('^/project/(' + UUID + ')').exec(location.pathname)?.[1] ?? null;
let conversationId = new RegExp('^/chat/(' + UUID + ')').exec(location.pathname)?.[1] ?? null;
const thread = document.querySelector('#thread');
const editor = document.querySelector('[contenteditable="true"], textarea');
const send = document.querySelector('#send');
const stop = document.querySelector('#stop');
const textOf = () => (editor.tagName === 'TEXTAREA' ? editor.value : editor.innerText).trim();
const refresh = () => { send.disabled = !textOf(); };
editor.addEventListener('input', refresh);
// 앞선 시도가 못 보낸 초안이 입력창에 그대로 있다.
const draft = ${JSON.stringify(state.draft)};
if (draft) { if (editor.tagName === 'TEXTAREA') editor.value = draft; else editor.textContent = draft; }
refresh();
const render = (sender, text, streaming) => {
  const box = document.createElement('div');
  if (sender === 'assistant') box.setAttribute('data-is-streaming', streaming ? 'true' : 'false');
  else box.setAttribute('data-testid', 'user-message');
  box.textContent = text;
  thread.append(box);
  return box;
};
// 채팅을 다시 열면 지금 가지의 메시지를 그린다.
if (conversationId) {
  fetch('/api/organizations/' + ORG + '/chat_conversations/' + conversationId + '?tree=True&rendering_mode=messages')
    .then((r) => r.json()).then((body) => {
      const byId = new Map((body.chat_messages ?? []).map((m) => [m.uuid, m]));
      const chain = [];
      for (let id = body.current_leaf_message_uuid; id && byId.has(id); id = byId.get(id).parent_message_uuid) chain.unshift(byId.get(id));
      chain.forEach((m) => render(m.sender, m.text, false));
    }).catch(() => {});
}
// Enter 는 다루지 않는다. 보내기 단추만 보낸다.
send.addEventListener('click', async () => {
  const prompt = textOf();
  if (!prompt) return;
  if (editor.tagName === 'TEXTAREA') editor.value = ''; else editor.textContent = '';
  refresh();
  const human = render('human', prompt, false);
  const reply = render('assistant', '', true);
  stop.hidden = false;
  if (!conversationId) {
    conversationId = crypto.randomUUID();
    history.pushState({}, '', '/chat/' + conversationId);
    await fetch('/api/organizations/' + ORG + '/chat_conversations', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ uuid: conversationId, name: '', project_uuid: projectId }) });
  }
  const response = await fetch('/api/organizations/' + ORG + '/chat_conversations/' + conversationId + '/completion', {
    method: 'POST', headers: { 'content-type': 'application/json', accept: 'text/event-stream' }, body: JSON.stringify({ prompt, attachments: [], files: [] }),
  });
  if (!response.ok) {
    human.remove(); reply.remove(); stop.hidden = true;
    document.querySelector('#error').textContent = response.status === 429 ? 'You have reached your usage limit.' : 'Something went wrong.';
    return;
  }
  const sent = await response.json();
  setTimeout(() => { reply.setAttribute('data-is-streaming', 'false'); reply.textContent = sent.answer; stop.hidden = true; }, DELAY);
});
</script></body></html>`;

  const json = (route, body, status = 200, headers = {}) => route.fulfill({ status, contentType: 'application/json', headers, body: JSON.stringify(body) });

  const message = (sender, text, parent, extra = {}) => ({
    uuid: crypto.randomUUID(), sender, index: 0, parent_message_uuid: parent, created_at: new Date().toISOString(),
    text, content: [{ type: 'text', text }], ...extra,
  });

  /** 대화 조회: 답은 answerDelayMs 가 지나야 트리에 나오고, 그때 current_leaf_message_uuid 가 답으로 옮겨진다. */
  const conversationBody = (conversation) => {
    const now = Date.now();
    const chat_messages = [];
    let leaf = null;
    for (const turn of conversation.turns) {
      chat_messages.push(turn.human);
      leaf = turn.human.uuid;
      if (turn.stale) chat_messages.push(turn.stale);
      if (now >= turn.at + state.answerDelayMs) { chat_messages.push(turn.assistant); leaf = turn.assistant.uuid; }
    }
    chat_messages.forEach((entry, index) => { entry.index = index; });
    if (state.drift === 'conversation') return { uuid: conversation.uuid, project: { uuid: conversation.projectId }, messages: chat_messages };
    return {
      uuid: conversation.uuid, name: '', project_uuid: conversation.projectId, is_temporary: false,
      current_leaf_message_uuid: leaf, chat_messages,
    };
  };

  async function handle(route) {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== 'https://claude.ai') return route.abort();
    if (state.challenge) return route.fulfill({ status: 403, headers: { 'cf-mitigated': 'challenge' }, contentType: 'text/html', body: '<title>Just a moment...</title>' });
    if (!url.pathname.startsWith('/api/')) return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: page() });
    if (!state.signedIn) return json(route, { type: 'error', error: { type: 'permission_error', message: 'Invalid authorization' } }, 403);

    if (url.pathname === '/api/organizations') {
      // API 전용 조직이 먼저 온다. 채팅 조직(capabilities 에 chat)을 골라야 한다.
      return json(route, [
        { uuid: CLAUDE_TEST_API_ORG, name: 'API', capabilities: ['api'] },
        { uuid: CLAUDE_TEST_ORG, name: 'Personal', capabilities: ['chat', 'claude_max'] },
      ]);
    }
    if (url.pathname === '/api/account') return json(route, { uuid: crypto.randomUUID(), email_address: 'user@example.com' });

    const org = new RegExp(`^/api/organizations/(${CLAUDE_TEST_ORG})(/.*)$`).exec(url.pathname);
    if (!org) return json(route, { type: 'error', error: { type: 'not_found_error' } }, 404);
    const rest = org[2];
    const method = request.method();

    if (rest === '/projects' && method === 'GET') {
      if (state.drift === 'projects') return json(route, { data: state.projects });
      return json(route, state.projects);
    }
    if (rest === '/projects' && method === 'POST') {
      const body = JSON.parse(request.postData() ?? '{}');
      const project = { uuid: crypto.randomUUID(), name: body.name, description: body.description, is_private: body.is_private, archived_at: null };
      state.projects.push(project);
      return json(route, project, 201);
    }
    if (rest === '/chat_conversations' && method === 'POST') {
      const body = JSON.parse(request.postData() ?? '{}');
      const conversation = { uuid: body.uuid, projectId: body.project_uuid ?? null, turns: [] };
      state.conversations.set(conversation.uuid, conversation);
      return json(route, { uuid: conversation.uuid, name: '', project_uuid: conversation.projectId }, 201);
    }
    const completion = /^\/chat_conversations\/([0-9a-f-]{36})\/completion$/.exec(rest);
    if (completion && method === 'POST') {
      state.completions += 1;
      if (state.limit !== null) {
        return json(route, { type: 'error', error: { type: 'rate_limit_error', message: 'usage limit reached' } }, 429, { 'anthropic-ratelimit-unified-reset': String(state.limit) });
      }
      const conversation = state.conversations.get(completion[1]);
      if (!conversation) return json(route, { type: 'error', error: { type: 'not_found_error' } }, 404);
      const { prompt } = JSON.parse(request.postData() ?? '{}');
      const parent = conversation.turns.at(-1)?.assistant.uuid ?? ROOT_PARENT;
      const human = message('human', prompt, parent);
      const turn = {
        human, at: Date.now(),
        stale: state.retries ? message('assistant', `(지난 답) ${prompt}`, human.uuid, { stop_reason: 'stop_sequence' }) : null,
        assistant: message('assistant', answerOf(prompt), human.uuid, { stop_reason: 'stop_sequence' }),
      };
      conversation.turns.push(turn);
      state.sent.push({ conversationId: conversation.uuid, projectId: conversation.projectId, prompt });
      // 보낸 글은 더 이상 초안으로 남지 않는다.
      state.draft = '';
      return json(route, { answer: turn.assistant.text });
    }
    const read = /^\/chat_conversations\/([0-9a-f-]{36})$/.exec(rest);
    if (read && method === 'GET') {
      const conversation = state.conversations.get(read[1]);
      if (!conversation) return json(route, { type: 'error', error: { type: 'not_found_error' } }, 404);
      return json(route, conversationBody(conversation));
    }
    return json(route, { type: 'error', error: { type: 'not_found_error' } }, 404);
  }

  return { state, handle, answerOf };
}
