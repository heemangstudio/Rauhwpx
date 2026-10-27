import crypto from 'node:crypto';

/**
 * 가짜 chatgpt.com — 2026-10 에 실제 화면에서 기록한 표지만 흉내 낸다(data-turn-key, data-talvt-turn-state,
 * data-conversation-role, [data-app-action-sidebar-project-create], #chatgpt-project-name, .ProseMirror).
 * Playwright route 로 https://chatgpt.com/** 를 받아 네트워크에 나가지 않는다.
 */
export function createChatgptFixture({ signedIn = true, projects = [], answerDelayMs = 300, drift = null, challenge = false } = {}) {
  const state = { signedIn, projects: [...projects], conversations: new Map(), sent: [], answerDelayMs, drift, challenge, lateTurnsMs: 0, draft: '' };
  const slugOf = (project) => `${project.id}-${project.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;

  const page = () => `<!doctype html><html><head><meta charset="utf-8"><title>ChatGPT</title></head><body>
<nav>
  <button data-app-action-sidebar-section-toggle type="button">프로젝트</button>
  ${state.drift === 'project-button' ? '' : '<button type="button" aria-label="새 프로젝트 추가" data-app-action-sidebar-project-create></button>'}
</nav>
<main><h1 id="title"></h1><div id="thread"></div>
  ${state.drift === 'composer' ? '<textarea id="prompt"></textarea>' : '<div class="ProseMirror" contenteditable="true" role="textbox" aria-label="ChatGPT에게 물어보세요" style="min-height:24px;width:400px"></div>'}
  <button type="button" id="stop" aria-label="중지" hidden></button>
</main>
<script>
const delay = ${state.answerDelayMs};
const freezeTurns = ${state.drift === 'turns' ? 'true' : 'false'};
const path = location.pathname;
const thread = document.querySelector('#thread');
const projectMatch = /^\\/g\\/(g-p-[0-9a-f]{32})[^/]*\\/(project|c\\/([0-9a-f-]{36}))/.exec(path);
let conversationId = projectMatch?.[3] ?? null;
const renderTurn = (turn) => {
  const box = document.createElement('div');
  box.setAttribute('data-turn-key', turn.userId);
  box.innerHTML = '<div class="user"></div><div data-talvt-turn-state="' + (turn.done ? 'complete' : 'in_progress') + '"><div data-conversation-role="assistant"><div class="md"></div></div></div>';
  box.querySelector('.user').textContent = turn.question;
  box.querySelector('.md').textContent = turn.done ? turn.answer : '';
  thread.append(box);
  return box;
};
// 실제 화면처럼 기존 채팅의 옛 차례는 늦게 그려질 수 있고(lateTurnsMs), 못 보낸 초안이 입력창에 남아 있을 수 있다(draft).
if (conversationId) setTimeout(() => fetch('/backend-api/test/turns/' + conversationId).then(r => r.json()).then(turns => turns.forEach(renderTurn)), ${state.lateTurnsMs});
if (conversationId && ${JSON.stringify(state.draft)}) document.querySelector('.ProseMirror').textContent = ${JSON.stringify(state.draft)};
document.querySelector('#title').textContent = projectMatch ? 'HamaEditor' : '홈';
document.querySelector('[data-app-action-sidebar-project-create]')?.addEventListener('click', () => {
  const dialog = document.createElement('div');
  dialog.setAttribute('role', 'dialog');
  dialog.innerHTML = '<form><input id="chatgpt-project-name" name="project-name" value=""><footer><button type="button" aria-haspopup="menu">기본 메모리</button><button type="submit" disabled>프로젝트 만들기</button></footer></form>';
  document.body.append(dialog);
  const input = dialog.querySelector('input'), submit = dialog.querySelector('button[type=submit]');
  input.addEventListener('input', () => { submit.disabled = !input.value.trim(); });
  dialog.querySelector('form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const project = await fetch('/backend-api/projects', { method: 'POST', body: JSON.stringify({ name: input.value, memory_scope: 'unset' }) }).then(r => r.json());
    location.assign('/g/' + project.slug + '/project');
  });
});
const editor = document.querySelector('.ProseMirror');
editor?.addEventListener('keydown', async (event) => {
  if (event.key !== 'Enter') return;
  event.preventDefault();
  const question = editor.innerText.trim();
  editor.textContent = '';
  const sent = await fetch('/backend-api/f/conversation', { method: 'POST', body: JSON.stringify({ conversationId, projectId: projectMatch?.[1] ?? null, question }) }).then(r => r.json());
  if (!conversationId) { conversationId = sent.conversationId; history.pushState({}, '', '/g/' + sent.slug + '/c/' + conversationId); }
  if (freezeTurns) return;
  const stop = document.querySelector('#stop');
  stop.hidden = false;
  // 실제 화면처럼 새 차례는 잠깐 complete 로 보였다가 in_progress 로 바뀐다.
  const box = renderTurn({ userId: sent.userId, question, done: true, answer: '' });
  setTimeout(() => box.querySelector('[data-talvt-turn-state]').setAttribute('data-talvt-turn-state', 'in_progress'), 30);
  setTimeout(() => {
    box.querySelector('[data-talvt-turn-state]').setAttribute('data-talvt-turn-state', 'complete');
    box.querySelector('.md').textContent = sent.answer;
    stop.hidden = true;
  }, delay);
});
</script></body></html>`;

  const json = (route, body, status = 200, headers = {}) => route.fulfill({ status, contentType: 'application/json', headers, body: JSON.stringify(body) });

  async function handle(route) {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== 'https://chatgpt.com') return route.abort();
    if (state.challenge) return route.fulfill({ status: 403, headers: { 'cf-mitigated': 'challenge' }, contentType: 'text/html', body: '<title>Just a moment...</title>' });
    if (url.pathname === '/api/auth/session') {
      return json(route, state.signedIn ? { accessToken: 'test-token', user: { email: 'user@example.com' } } : {});
    }
    if (url.pathname.startsWith('/backend-api/')) {
      if (state.signedIn && request.headers().authorization !== 'Bearer test-token' && !url.pathname.startsWith('/backend-api/test/') && request.method() === 'GET') return json(route, { detail: 'unauthorized' }, 401);
      if (url.pathname === '/backend-api/gizmos/snorlax/sidebar') {
        if (state.drift === 'project-list') return json(route, { results: [] });
        return json(route, { items: state.projects.map((project) => ({ gizmo: { gizmo: { id: project.id, short_url: slugOf(project), display: { name: project.name } } } })), cursor: null });
      }
      if (url.pathname === '/backend-api/projects' && request.method() === 'POST') {
        const body = JSON.parse(request.postData() ?? '{}');
        const project = { id: `g-p-${crypto.randomBytes(16).toString('hex')}`, name: body.name, memoryScope: body.memory_scope };
        state.projects.push(project);
        return json(route, { id: project.id, slug: slugOf(project) });
      }
      if (url.pathname === '/backend-api/f/conversation' && request.method() === 'POST') {
        const body = JSON.parse(request.postData() ?? '{}');
        const project = state.projects.find((entry) => entry.id === body.projectId);
        const conversationId = body.conversationId ?? crypto.randomUUID();
        const conversation = state.conversations.get(conversationId) ?? { id: conversationId, projectId: body.projectId, turns: [] };
        state.conversations.set(conversationId, conversation);
        const turn = { userId: crypto.randomUUID(), assistantId: crypto.randomUUID(), question: body.question, answer: `**답**: ${body.question}\n\n- 항목`, at: Date.now() };
        conversation.turns.push(turn);
        state.sent.push({ conversationId, projectId: body.projectId, question: body.question });
        return json(route, { conversationId, slug: project ? slugOf(project) : body.projectId, userId: turn.userId, answer: turn.answer });
      }
      const turnsMatch = /^\/backend-api\/test\/turns\/([0-9a-f-]{36})$/.exec(url.pathname);
      if (turnsMatch) {
        const conversation = state.conversations.get(turnsMatch[1]);
        return json(route, (conversation?.turns ?? []).map((turn) => ({ ...turn, done: true })));
      }
      const conversationMatch = /^\/backend-api\/conversation\/([0-9a-f-]{36})$/.exec(url.pathname);
      if (conversationMatch) {
        const conversation = state.conversations.get(conversationMatch[1]);
        if (!conversation) return json(route, { detail: 'not found' }, 404);
        const mapping = { root: { id: 'root', parent: null, message: null } };
        let parent = 'root';
        for (const turn of conversation.turns) {
          const done = Date.now() >= turn.at + state.answerDelayMs;
          mapping[turn.userId] = { id: turn.userId, parent, message: { id: turn.userId, author: { role: 'user' }, content: { content_type: 'text', parts: [turn.question] }, status: 'finished_successfully' } };
          mapping[turn.assistantId] = { id: turn.assistantId, parent: turn.userId, message: { id: turn.assistantId, author: { role: 'assistant' }, recipient: 'all', content: { content_type: 'text', parts: [done ? `${turn.answer}citeturn0search0` : ''] }, status: done ? 'finished_successfully' : 'in_progress', end_turn: done ? true : null } };
          parent = turn.assistantId;
        }
        return json(route, { conversation_id: conversation.id, gizmo_id: conversation.projectId, is_temporary_chat: false, memory_scope: 'global_enabled', current_node: parent, mapping });
      }
      return json(route, {});
    }
    return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: page() });
  }
  return { state, handle, slugOf };
}
