import { createWebAssistantStore } from './web-assistant-store.mjs';

/**
 * ask_claude — 사용자가 로그인한 claude.ai 를 앱 안 브라우저(데스크톱 네이티브 런타임)의 보이지 않는 탭으로 움직여
 * "HamaEditor" 프로젝트의 채팅에 질문하고 답을 받는다. Claude.ai 메모리에는 공개 API 가 없어서 웹을 쓴다.
 * 비공식 자동화라 화면이 바뀌면 추측하지 않고 CLAUDE_UI_CHANGED 로 멈춘다.
 *
 * 참고한 공개 구현(코드는 가져오지 않았다): tkattkat/open-claude(MIT, Electron 세션으로 내부 API),
 * jackwener/OpenCLI(Apache-2.0, CDP 로 claude.ai 화면 조작), jahwag/ClaudeSync(MIT, 프로젝트 API).
 * 조직 /api/organizations, 프로젝트 /api/organizations/{org}/projects, 대화
 * /api/organizations/{org}/chat_conversations/{uuid}?tree=True&rendering_mode=messages (current_leaf_message_uuid 에서 부모로).
 * 입력창 [data-testid="chat-input"](ProseMirror), 답이 나오는 동안 [data-is-streaming="true"].
 */

export const CLAUDE_ORIGIN = 'https://claude.ai';
export const CLAUDE_PROJECT_NAME = 'HamaEditor';
export const CLAUDE_ERROR_CODES = Object.freeze([
  'CLAUDE_DISABLED', 'CLAUDE_UNAVAILABLE', 'CLAUDE_SIGNED_OUT', 'CLAUDE_CHALLENGE', 'CLAUDE_LIMIT', 'CLAUDE_UI_CHANGED', 'CLAUDE_TIMEOUT',
]);
export const CLAUDE_DEFAULT_TIMEOUT_MS = 120_000;
export const CLAUDE_MAX_ANSWER_CHARS = 20_000;
export const CLAUDE_MAX_QUESTION_CHARS = 8_000;

/** 허브의 Claude 브라우저 행위자. 정책은 이 행위자에게 claude.ai 만 연다(browser-policy). 탭은 사용자 화면에 나오지 않는다. */
export const CLAUDE_ACTOR = Object.freeze({
  threadId: 'claude', agentId: 'claude:driver', projectId: null, documentId: null,
  sessionId: null, taskId: null, isHuman: false, system: 'claude',
});
export const claudeActor = (sessionId) => Object.freeze({ ...CLAUDE_ACTOR, sessionId: typeof sessionId === 'string' && sessionId ? sessionId : null });

export function claudeError(code, message) {
  return Object.assign(new Error(message), { name: 'ClaudeError', code });
}

const MESSAGES = {
  CLAUDE_SIGNED_OUT: 'Claude.ai is signed out in the app browser. Ask the user to sign in from Settings → AI → Claude, then try again.',
  CLAUDE_CHALLENGE: 'Claude.ai asked for a human check. Ask the user to open Settings → AI → Claude and complete it, then try again.',
  CLAUDE_LIMIT: 'The user\'s Claude.ai usage limit is reached. Continue without Claude.ai.',
  CLAUDE_UI_CHANGED: 'The Claude.ai page no longer matches what HamaEditor expects, so nothing was guessed. Continue without Claude.ai.',
  CLAUDE_TIMEOUT: 'Claude.ai did not finish answering in time. The chat is saved; ask again later or continue without it.',
};
const fail = (code, detail) => claudeError(code, detail ? `${MESSAGES[code]} (${detail})` : MESSAGES[code]);

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

/** claude.ai 프로젝트 첫 화면(/project/<uuid>)만 받는다. */
export function claudeProjectUrl(value) {
  try {
    const url = new URL(value);
    const match = new RegExp(`^/project/(${UUID})/?$`).exec(url.pathname);
    return url.origin === CLAUDE_ORIGIN && match ? `${CLAUDE_ORIGIN}/project/${match[1]}` : null;
  } catch { return null; }
}

/** claude.ai 채팅(/chat/<uuid>)만 받는다. 쿼리와 해시는 버린다. */
export function claudeChatUrl(value) {
  try {
    const url = new URL(value);
    const match = new RegExp(`^/chat/(${UUID})/?$`).exec(url.pathname);
    return url.origin === CLAUDE_ORIGIN && match ? `${CLAUDE_ORIGIN}/chat/${match[1]}` : null;
  } catch { return null; }
}

const projectIdOf = (value) => new RegExp(`/project/(${UUID})`).exec(String(value ?? ''))?.[1] ?? null;
const conversationIdOf = (value) => new RegExp(`/chat/(${UUID})(?:[/?#]|$)`).exec(String(value ?? ''))?.[1] ?? null;

/** 켜기 설정과 HamaEditor 채팅 → Claude.ai 채팅 주소 지도(web-assistant-store). */
export function createClaudeStore({ filePath, logger = null, platform = process.platform }) {
  return createWebAssistantStore({ filePath, logger, platform, label: 'claude', projectUrl: claudeProjectUrl, chatUrl: claudeChatUrl });
}

// ─── 페이지 안에서 도는 함수(직렬화되어 page.evaluate 로 간다 — 바깥 변수를 쓰지 않는다) ───

/** 로그인 확인과 채팅 조직. 페이지가 쓰는 조직 조회와 같다. */
export async function pageClaudeSession() {
  const response = await fetch('/api/organizations', { credentials: 'include', headers: { accept: 'application/json' } });
  if (response.status === 403 && response.headers.get('cf-mitigated') === 'challenge') return { challenge: true };
  const body = await response.json().catch(() => null);
  if (!response.ok || !Array.isArray(body)) return { signedIn: false, status: response.status };
  const chat = body.filter((org) => typeof org?.uuid === 'string' && Array.isArray(org.capabilities) && org.capabilities.includes('chat'));
  const org = chat[0] ?? null;
  if (!org) return { signedIn: false, status: response.status };
  const account = await fetch('/api/account', { credentials: 'include', headers: { accept: 'application/json' } })
    .then((r) => (r.ok ? r.json() : null)).catch(() => null);
  const email = account?.email_address ?? account?.account?.email_address ?? null;
  return { signedIn: true, orgId: org.uuid, email: typeof email === 'string' ? email : null };
}

/** 이름이 같은 보관되지 않은 프로젝트를 찾고, 없으면 만든다(create 일 때). 모양이 다르면 shape:false. */
export async function pageClaudeProject({ orgId, name, create }) {
  const headers = { accept: 'application/json', 'content-type': 'application/json', 'anthropic-client-platform': 'web_claude_ai' };
  const list = await fetch(`/api/organizations/${orgId}/projects`, { credentials: 'include', headers });
  if (list.status === 403 && list.headers.get('cf-mitigated') === 'challenge') return { challenge: true };
  if (list.status === 401) return { signedIn: false };
  const projects = await list.json().catch(() => null);
  if (!list.ok || !Array.isArray(projects)) return { shape: false, status: list.status };
  const found = projects.find((project) => project?.name === name && !project.archived_at && typeof project.uuid === 'string');
  if (found || !create) return { shape: true, uuid: found?.uuid ?? null };
  const made = await fetch(`/api/organizations/${orgId}/projects`, {
    method: 'POST', credentials: 'include', headers,
    body: JSON.stringify({ name, description: 'HamaEditor 에이전트가 묻는 질문', is_private: true }),
  });
  if (made.status === 403 && made.headers.get('cf-mitigated') === 'challenge') return { challenge: true };
  const project = await made.json().catch(() => null);
  if (!made.ok || typeof project?.uuid !== 'string') return { shape: false, status: made.status };
  return { shape: true, uuid: project.uuid, created: true };
}

/** 보이는 입력창 하나. 없으면 null. */
export function pageClaudeComposerState() {
  const editors = [...document.querySelectorAll('[data-testid="chat-input"][contenteditable="true"], [data-testid="chat-input"] [contenteditable="true"], .ProseMirror[contenteditable="true"]')]
    .filter((element) => { const box = element.getBoundingClientRect(); return box.width > 0 && box.height > 0; });
  const editor = editors.at(-1) ?? null;
  return { ready: !!editor, text: editor ? editor.innerText.trim() : '', focused: !!editor && (document.activeElement === editor || editor.contains(document.activeElement)) };
}

export function pageClaudeFocusComposer() {
  const editors = [...document.querySelectorAll('[data-testid="chat-input"][contenteditable="true"], [data-testid="chat-input"] [contenteditable="true"], .ProseMirror[contenteditable="true"]')]
    .filter((element) => { const box = element.getBoundingClientRect(); return box.width > 0 && box.height > 0; });
  const editor = editors.at(-1);
  if (!editor) return false;
  editor.focus();
  return document.activeElement === editor || editor.contains(document.activeElement);
}

/** 답이 나오는 중인가. data-is-streaming 이 주 신호이고, 중지 단추는 언어마다 달라 보조 신호다. */
export function pageClaudeStreaming() {
  const streaming = [...document.querySelectorAll('[data-is-streaming]')].some((element) => element.getAttribute('data-is-streaming') === 'true');
  const stop = [...document.querySelectorAll('button[aria-label]')].some((button) => {
    const box = button.getBoundingClientRect();
    return box.width > 0 && box.height > 0 && /^(Stop response|응답 중지|중지)$/i.test(button.getAttribute('aria-label').trim());
  });
  const responses = document.querySelectorAll('[data-is-streaming]').length;
  return { streaming, stop, responses, text: [...document.querySelectorAll('[data-is-streaming]')].at(-1)?.textContent?.length ?? 0 };
}

/**
 * 대화를 읽는다. current_leaf_message_uuid 에서 부모로 거슬러 지금 가지만 모은다.
 * before 에 없던 사람 메시지 중 question 머리를 담은 것 다음의 답을 모은다.
 */
export async function pageClaudeReadAnswer({ orgId, conversationId, before, head }) {
  const response = await fetch(`/api/organizations/${orgId}/chat_conversations/${conversationId}?tree=True&rendering_mode=messages&render_all_tools=true`, { credentials: 'include', headers: { accept: 'application/json' } });
  if (response.status === 403 && response.headers.get('cf-mitigated') === 'challenge') return { challenge: true };
  if (response.status === 401) return { signedIn: false };
  const body = await response.json().catch(() => null);
  if (!response.ok || !body || !Array.isArray(body.chat_messages)) return { shape: false, status: response.status };
  const byId = new Map(body.chat_messages.filter((message) => typeof message?.uuid === 'string').map((message) => [message.uuid, message]));
  const chain = [];
  for (let id = body.current_leaf_message_uuid, guard = 0; id && byId.has(id) && guard < 5000; guard++) {
    const message = byId.get(id);
    chain.unshift(message);
    id = message.parent_message_uuid;
  }
  const textOf = (message) => {
    const blocks = Array.isArray(message.content) ? message.content : [];
    const text = blocks.filter((block) => block?.type === 'text' && typeof block.text === 'string').map((block) => block.text).join('');
    return text || (typeof message.text === 'string' ? message.text : '');
  };
  const squash = (value) => value.replace(/\s+/g, ' ').trim();
  const seen = new Set(before ?? []);
  const start = chain.findIndex((message) => message.sender === 'human' && !seen.has(message.uuid) && squash(textOf(message)).includes(head));
  if (start < 0) return { shape: true, found: false, projectId: body.project_uuid ?? body.project?.uuid ?? null, messages: chain.map((message) => message.uuid) };
  const replies = chain.slice(start + 1).filter((message) => message.sender === 'assistant');
  const answer = replies.map(textOf).map((text) => text.trim()).filter(Boolean).join('\n\n');
  return {
    shape: true, found: true, answer, replied: replies.length > 0,
    stopReason: replies.at(-1)?.stop_reason ?? null,
    projectId: body.project_uuid ?? body.project?.uuid ?? null,
    temporary: body.is_temporary === true,
  };
}

/** 지금 대화의 메시지 id 목록(보내기 전 스냅숏). 새 채팅이면 빈 목록. */
export async function pageClaudeMessageIds({ orgId, conversationId }) {
  const response = await fetch(`/api/organizations/${orgId}/chat_conversations/${conversationId}?tree=True&rendering_mode=messages`, { credentials: 'include', headers: { accept: 'application/json' } });
  const body = await response.json().catch(() => null);
  return response.ok && Array.isArray(body?.chat_messages) ? body.chat_messages.map((message) => message?.uuid).filter((id) => typeof id === 'string') : null;
}

// ─── 허브 쪽 구동기 ───

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * @param {{ browser: { drive: Function, available: () => boolean }, store: ReturnType<typeof createClaudeStore>,
 *   timeoutMs?: number, maxAnswerChars?: number, pollMs?: number, stepTimeoutMs?: number, now?: () => number }} options
 * browser.drive(actor, { url }, (page) => …) 는 Claude 행위자의 보이지 않는 탭 하나에서 작업을 차례로 돌린다(owned-browser-service).
 */
export function createClaudeDriver({ browser, store, timeoutMs = CLAUDE_DEFAULT_TIMEOUT_MS, maxAnswerChars = CLAUDE_MAX_ANSWER_CHARS,
  pollMs = 500, stepTimeoutMs = 15_000, now = Date.now }) {
  let queue = Promise.resolve();
  const serial = (operation) => {
    const task = queue.then(operation, operation);
    queue = task.catch(() => {});
    return task;
  };

  const assertAvailable = () => {
    if (!store.enabled()) throw claudeError('CLAUDE_DISABLED', 'Claude is turned off in Settings → AI.');
    if (!browser.available()) throw claudeError('CLAUDE_UNAVAILABLE', 'Claude.ai works only in the HamaEditor desktop app with its built-in browser.');
  };

  /** 한 작업 동안 Cloudflare 확인과 사용 한도(보내기 429)를 지켜본다. */
  const watchPage = (page) => {
    const state = { challenged: false, limited: null };
    const onResponse = (response) => {
      try {
        const url = new URL(response.url());
        if (url.origin !== CLAUDE_ORIGIN) return;
        if (response.status() === 403 && response.headers()['cf-mitigated'] === 'challenge') state.challenged = true;
        if (response.status() === 429 && /\/completion$/.test(url.pathname)) state.limited = response.headers()['anthropic-ratelimit-unified-reset'] ?? 'unknown';
      } catch {}
    };
    page.on('response', onResponse);
    return { state, dispose: () => page.off('response', onResponse) };
  };

  const run = async (deadline, watcher, step) => {
    const remaining = deadline - now();
    if (remaining <= 0) throw fail('CLAUDE_TIMEOUT');
    let timer;
    try {
      return await Promise.race([step(), new Promise((_, reject) => { timer = setTimeout(() => reject(fail('CLAUDE_TIMEOUT')), remaining); })]);
    } catch (error) {
      if (watcher.state.limited && error?.code !== 'CLAUDE_SIGNED_OUT') throw limitError(watcher.state.limited);
      throw watcher.state.challenged && error?.code !== 'CLAUDE_SIGNED_OUT' ? fail('CLAUDE_CHALLENGE') : error;
    } finally { clearTimeout(timer); }
  };

  const limitError = (reset) => {
    const at = Number(reset);
    return fail('CLAUDE_LIMIT', Number.isFinite(at) && at > 0 ? `resets ${new Date(at * 1000).toISOString()}` : undefined);
  };

  const evaluate = async (page, fn, arg) => {
    try { return await page.evaluate(fn, arg); }
    catch (error) {
      if (/Execution context was destroyed|navigation/i.test(String(error?.message))) { await page.waitForLoadState('domcontentloaded').catch(() => {}); return page.evaluate(fn, arg); }
      throw error;
    }
  };

  const goto = async (page, url) => {
    const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch((error) => { throw fail('CLAUDE_UI_CHANGED', `navigation failed: ${String(error?.message ?? error).split('\n')[0].slice(0, 120)}`); });
    if (response?.status() === 403 && response.headers()['cf-mitigated'] === 'challenge') throw fail('CLAUDE_CHALLENGE');
  };

  const onClaude = (page) => { try { return new URL(page.url()).origin === CLAUDE_ORIGIN; } catch { return false; } };

  const waitFor = async (check, { until, label, interval = pollMs }) => {
    for (;;) {
      const value = await check();
      if (value) return value;
      if (now() >= until) throw fail('CLAUDE_UI_CHANGED', label);
      await sleep(interval);
    }
  };

  const ensureSignedIn = async (page) => {
    const session = await evaluate(page, pageClaudeSession);
    if (session?.challenge) throw fail('CLAUDE_CHALLENGE');
    if (!session?.signedIn) throw fail('CLAUDE_SIGNED_OUT');
    return session;
  };

  const ensureProject = async (page, orgId) => {
    const cached = store.projectUrl();
    if (cached) return cached;
    const found = await evaluate(page, pageClaudeProject, { orgId, name: CLAUDE_PROJECT_NAME, create: true });
    if (found?.challenge) throw fail('CLAUDE_CHALLENGE');
    if (found?.signedIn === false) throw fail('CLAUDE_SIGNED_OUT');
    if (!found?.shape || !found.uuid) throw fail('CLAUDE_UI_CHANGED', `projects ${found?.status ?? 'unreadable'}`);
    const url = claudeProjectUrl(`${CLAUDE_ORIGIN}/project/${found.uuid}`);
    await store.setProjectUrl(url);
    return url;
  };

  const openChat = async (page, chatKey, projectUrl) => {
    const known = store.chatUrl(chatKey);
    if (known) {
      await goto(page, known);
      // 지운 채팅은 다른 주소로 옮겨진다. 그때는 프로젝트에서 새 채팅을 시작한다.
      if (conversationIdOf(page.url()) === conversationIdOf(known)) return known;
      await store.forgetChat(chatKey);
    }
    await goto(page, projectUrl);
    // 사용자가 프로젝트를 지웠으면 다른 주소로 옮겨진다. 부른 쪽이 다시 찾거나 만든다.
    return projectIdOf(page.url()) === projectIdOf(projectUrl) ? null : false;
  };

  const squash = (value) => value.replace(/\s+/g, ' ').trim();

  const send = async (page, question, until) => {
    await waitFor(async () => (await evaluate(page, pageClaudeComposerState)).ready, { until: Math.min(until, now() + stepTimeoutMs), label: 'composer' });
    if (!await evaluate(page, pageClaudeFocusComposer)) throw fail('CLAUDE_UI_CHANGED', 'composer focus');
    await page.keyboard.insertText(question);
    const head = squash(question).slice(0, 40);
    await waitFor(async () => squash((await evaluate(page, pageClaudeComposerState)).text).includes(head), { until: Math.min(until, now() + 5_000), label: 'composer text' });
    await page.keyboard.press('Enter');
    return head;
  };

  /** 끝남: 답이 나오는 표시가 없고 한동안 그대로이며, 대화 조회가 우리 질문 다음의 답을 준다. */
  const awaitAnswer = async (page, { orgId, projectUrl, before, head }, until) => {
    // 새 채팅은 보낸 뒤 /chat/<uuid> 로 옮겨진다.
    const conversationId = await waitFor(() => conversationIdOf(page.url()), { until: Math.min(until, now() + stepTimeoutMs), label: 'chat address' });
    let stableSince = null;
    let lastSignature = '';
    for (;;) {
      const view = await evaluate(page, pageClaudeStreaming);
      const signature = `${view.streaming}|${view.stop}|${view.responses}|${view.text}`;
      const settled = !view.streaming && !view.stop;
      if (signature !== lastSignature) { lastSignature = signature; stableSince = settled ? now() : null; }
      else if (settled && stableSince === null) stableSince = now();
      if (settled && now() - stableSince >= 1_000) {
        const read = await evaluate(page, pageClaudeReadAnswer, { orgId, conversationId, before, head });
        if (read?.challenge) throw fail('CLAUDE_CHALLENGE');
        if (read?.signedIn === false) throw fail('CLAUDE_SIGNED_OUT');
        if (!read?.shape) throw fail('CLAUDE_UI_CHANGED', `conversation ${read?.status ?? 'unreadable'}`);
        if (read.temporary) throw fail('CLAUDE_UI_CHANGED', 'temporary chat');
        if (read.projectId && read.projectId !== projectIdOf(projectUrl)) throw fail('CLAUDE_UI_CHANGED', 'chat is outside the HamaEditor project');
        if (read.found && read.replied && read.answer) return { conversationId, answer: read.answer };
      }
      if (now() >= until) throw fail('CLAUDE_TIMEOUT');
      await sleep(pollMs);
    }
  };

  return {
    /** @param {{ chatKey: string, question: string, sessionId?: string }} input */
    ask: (input) => {
      // 기한은 대기열에 들어온 때부터 센다. 앞선 질문을 기다린 시간도 한도에 든다.
      const deadline = now() + timeoutMs;
      return serial(() => askNow(input, deadline));
    },
    /** 설정 줄의 상태. check 면 보이지 않는 탭으로 로그인을 확인한다(sessionId 는 그 탭을 붙일 편집기 창). */
    status: ({ check = false, sessionId = null } = {}) => serial(async () => {
      const base = { enabled: store.enabled(), available: browser.available(), projectUrl: store.projectUrl() };
      if (!check || !base.enabled || !base.available) return { ...base, signedIn: null };
      return browser.drive(claudeActor(sessionId), { url: `${CLAUDE_ORIGIN}/` }, async (page) => {
        const watcher = watchPage(page);
        try {
          return await run(now() + 30_000, watcher, async () => {
            if (!onClaude(page)) await goto(page, `${CLAUDE_ORIGIN}/`);
            const session = await evaluate(page, pageClaudeSession);
            if (session?.challenge) throw fail('CLAUDE_CHALLENGE');
            return { ...base, signedIn: session?.signedIn === true, ...(session?.signedIn && session.email ? { account: session.email } : {}) };
          });
        } finally { watcher.dispose(); }
      });
    }),
  };

  async function askNow(input, deadline) {
    assertAvailable();
    const chatKey = String(input?.chatKey ?? '');
    const question = String(input?.question ?? '').trim();
    if (!chatKey) throw claudeError('INVALID_ARGS', 'ask_claude needs an active HamaEditor chat');
    if (!question || question.length > CLAUDE_MAX_QUESTION_CHARS) throw claudeError('INVALID_ARGS', `Ask a question of 1–${CLAUDE_MAX_QUESTION_CHARS} characters`);
    if (now() >= deadline) throw fail('CLAUDE_TIMEOUT');
    const startUrl = store.chatUrl(chatKey) ?? store.projectUrl() ?? `${CLAUDE_ORIGIN}/`;
    return browser.drive(claudeActor(input?.sessionId), { url: startUrl }, async (page) => {
      const watcher = watchPage(page);
      let chatUrl = null;
      try {
        return await run(deadline, watcher, async () => {
          if (!onClaude(page)) await goto(page, startUrl);
          const { orgId } = await ensureSignedIn(page);
          let projectUrl = await ensureProject(page, orgId);
          chatUrl = await openChat(page, chatKey, projectUrl);
          if (chatUrl === false) {
            await store.setProjectUrl(null);
            projectUrl = await ensureProject(page, orgId);
            chatUrl = await openChat(page, chatKey, projectUrl);
            if (chatUrl === false) throw fail('CLAUDE_UI_CHANGED', 'project page');
          }
          const existing = conversationIdOf(page.url());
          const before = existing ? await evaluate(page, pageClaudeMessageIds, { orgId, conversationId: existing }) ?? [] : [];
          const head = await send(page, question, deadline);
          const result = await awaitAnswer(page, { orgId, projectUrl, before, head }, deadline);
          chatUrl = claudeChatUrl(page.url()) ?? chatUrl;
          if (!chatUrl) throw fail('CLAUDE_UI_CHANGED', 'chat address');
          await store.setChatUrl(chatKey, chatUrl);
          const truncated = result.answer.length > maxAnswerChars;
          return { chatUrl, answer: truncated ? `${result.answer.slice(0, maxAnswerChars)}\n\n[…]` : result.answer, ...(truncated ? { truncated: true } : {}) };
        });
      } catch (error) {
        // 보낸 뒤 실패해도 채팅은 Claude.ai 에 남았다. 다음 질문이 같은 채팅을 이어 가게 주소를 기억한다.
        const landed = claudeChatUrl(page.url());
        if (landed) await store.setChatUrl(chatKey, landed).catch(() => {});
        throw error;
      } finally { watcher.dispose(); }
    });
  }
}
