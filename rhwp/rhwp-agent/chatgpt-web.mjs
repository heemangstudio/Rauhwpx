import { createWebAssistantStore } from './web-assistant-store.mjs';

/**
 * ask_chatgpt — 사용자가 로그인한 chatgpt.com 을 앱 안 브라우저(데스크톱 네이티브 런타임)로 움직여
 * "HamaEditor" 프로젝트의 채팅에 질문하고 답을 받는다. ChatGPT 메모리에는 API 가 없어서 웹을 쓴다.
 * 비공식 자동화라 화면이 바뀌면 추측하지 않고 CHATGPT_UI_CHANGED 로 멈춘다.
 *
 * 화면 표지(2026-10 확인): 프로젝트 만들기 [data-app-action-sidebar-project-create] → #chatgpt-project-name,
 * 입력창 .ProseMirror[contenteditable=true], 대화 한 차례 [data-turn-key=사용자 메시지 id],
 * 진행 [data-talvt-turn-state=in_progress|complete]. 답은 페이지가 쓰는 대화 조회로 마크다운 그대로 읽는다.
 */

export const CHATGPT_ORIGIN = 'https://chatgpt.com';
export const CHATGPT_PROJECT_NAME = 'HamaEditor';
export const CHATGPT_ERROR_CODES = Object.freeze([
  'CHATGPT_DISABLED', 'CHATGPT_UNAVAILABLE', 'CHATGPT_SIGNED_OUT', 'CHATGPT_CHALLENGE', 'CHATGPT_UI_CHANGED', 'CHATGPT_TIMEOUT',
]);
export const CHATGPT_DEFAULT_TIMEOUT_MS = 120_000;
export const CHATGPT_MAX_ANSWER_CHARS = 20_000;
export const CHATGPT_MAX_QUESTION_CHARS = 8_000;

/**
 * 허브의 ChatGPT 브라우저 행위자. 정책은 이 행위자에게 ChatGPT 사이트만 연다(browser-policy).
 * 탭 하나를 모든 채팅이 함께 쓰고, 데스크톱 탭은 지금 묻는 편집기 창(sessionId)에 붙는다.
 */
export const CHATGPT_ACTOR = Object.freeze({
  threadId: 'chatgpt', agentId: 'chatgpt:driver', projectId: null, documentId: null,
  sessionId: null, taskId: null, isHuman: false, system: 'chatgpt',
});
export const chatgptActor = (sessionId) => Object.freeze({ ...CHATGPT_ACTOR, sessionId: typeof sessionId === 'string' && sessionId ? sessionId : null });

export function chatgptError(code, message) {
  return Object.assign(new Error(message), { name: 'ChatgptError', code });
}

const MESSAGES = {
  CHATGPT_SIGNED_OUT: 'ChatGPT is signed out in the app browser. Ask the user to sign in from Settings → AI → ChatGPT, then try again.',
  CHATGPT_CHALLENGE: 'ChatGPT asked for a human check. Ask the user to open chatgpt.com in the app browser and complete it, then try again.',
  CHATGPT_UI_CHANGED: 'The ChatGPT page no longer matches what HamaEditor expects, so nothing was guessed. Continue without ChatGPT.',
  CHATGPT_TIMEOUT: 'ChatGPT did not finish answering in time. The chat is saved; ask again later or continue without it.',
};
const fail = (code, detail) => chatgptError(code, detail ? `${MESSAGES[code]} (${detail})` : MESSAGES[code]);

/** chatgpt.com 의 프로젝트 첫 화면(/g/g-p-…/project)만 받는다. */
export function chatgptProjectUrl(value) {
  try {
    const url = new URL(value);
    const match = /^\/g\/(g-p-[0-9a-f]{32}(?:-[a-z0-9-]{1,80})?)\/project\/?$/.exec(url.pathname);
    return url.origin === CHATGPT_ORIGIN && match ? `${CHATGPT_ORIGIN}/g/${match[1]}/project` : null;
  } catch { return null; }
}

/** 프로젝트 안의 채팅(/g/g-p-…/c/<uuid>)만 받는다. 쿼리와 해시는 버린다. */
export function chatgptChatUrl(value) {
  try {
    const url = new URL(value);
    const match = /^\/g\/(g-p-[0-9a-f]{32}(?:-[a-z0-9-]{1,80})?)\/c\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/?$/.exec(url.pathname);
    return url.origin === CHATGPT_ORIGIN && match ? `${CHATGPT_ORIGIN}/g/${match[1]}/c/${match[2]}` : null;
  } catch { return null; }
}

const projectIdOf = (value) => /\/g\/(g-p-[0-9a-f]{32})/.exec(String(value ?? ''))?.[1] ?? null;
const conversationIdOf = (value) => /\/c\/([0-9a-f-]{36})(?:[/?#]|$)/.exec(String(value ?? ''))?.[1] ?? null;

/** 켜기 설정과 HamaEditor 채팅 → ChatGPT 채팅 주소 지도(web-assistant-store). */
export function createChatgptStore({ filePath, logger = null, platform = process.platform }) {
  return createWebAssistantStore({ filePath, logger, platform, label: 'chatgpt', projectUrl: chatgptProjectUrl, chatUrl: chatgptChatUrl });
}

// ─── 페이지 안에서 도는 함수(직렬화되어 page.evaluate 로 간다 — 바깥 변수를 쓰지 않는다) ───

/** 로그인 확인. 페이지가 쓰는 세션 조회와 같다. */
export async function pageSession() {
  const response = await fetch('/api/auth/session', { credentials: 'include' });
  if (response.status === 403 && response.headers.get('cf-mitigated') === 'challenge') return { challenge: true };
  const body = await response.json().catch(() => null);
  return { signedIn: typeof body?.accessToken === 'string' && body.accessToken.length > 0, email: typeof body?.user?.email === 'string' ? body.user.email : null };
}

/** 프로젝트 목록(사이드바 조회)에서 이름이 같은 프로젝트를 찾는다. 모양이 다르면 shape:false. */
export async function pageFindProject(name) {
  const session = await fetch('/api/auth/session', { credentials: 'include' }).then((r) => r.json()).catch(() => null);
  if (!session?.accessToken) return { signedIn: false };
  let cursor = null;
  for (let page = 0; page < 10; page++) {
    const query = new URLSearchParams({ conversations_per_gizmo: '0' });
    if (cursor) query.set('cursor', cursor);
    const response = await fetch(`/backend-api/gizmos/snorlax/sidebar?${query}`, { headers: { authorization: `Bearer ${session.accessToken}` }, credentials: 'include' });
    if (response.status === 403 && response.headers.get('cf-mitigated') === 'challenge') return { challenge: true };
    const body = await response.json().catch(() => null);
    if (!response.ok || !Array.isArray(body?.items)) return { shape: false, status: response.status };
    for (const item of body.items) {
      const gizmo = item?.gizmo?.gizmo;
      if (gizmo?.display?.name === name && /^g-p-[0-9a-f]{32}/.test(String(gizmo.short_url ?? gizmo.id ?? ''))) {
        return { shape: true, slug: String(gizmo.short_url ?? gizmo.id) };
      }
    }
    cursor = typeof body.cursor === 'string' && body.cursor ? body.cursor : null;
    if (!cursor) break;
  }
  return { shape: true, slug: null };
}

/** 페이지 로딩 진행: 문서가 끝났는지와 지금까지 받은 리소스 수. */
export function pageLoadProgress() {
  return { complete: document.readyState === 'complete', resources: performance.getEntriesByType('resource').length };
}

/** 보이는 입력창 하나. 없으면 null. */
export function pageComposerState() {
  const editors = [...document.querySelectorAll('.ProseMirror[contenteditable="true"]')]
    .filter((element) => { const box = element.getBoundingClientRect(); return box.width > 0 && box.height > 0; });
  const editor = editors.at(-1) ?? null;
  return { ready: !!editor, text: editor ? editor.innerText.trim() : '', focused: !!editor && (document.activeElement === editor || editor.contains(document.activeElement)) };
}

export function pageFocusComposer() {
  const editors = [...document.querySelectorAll('.ProseMirror[contenteditable="true"]')]
    .filter((element) => { const box = element.getBoundingClientRect(); return box.width > 0 && box.height > 0; });
  const editor = editors.at(-1);
  if (!editor) return false;
  editor.focus();
  return document.activeElement === editor || editor.contains(document.activeElement);
}

/** 입력창과 같은 form 의 보내기(submit) 단추를 누른다. 2026-10 의 ChatGPT 는 Enter 로 보내지 않는다. 단추가 없으면 false. */
export function pageSubmitComposer() {
  const editor = [...document.querySelectorAll('.ProseMirror[contenteditable="true"]')]
    .filter((element) => { const box = element.getBoundingClientRect(); return box.width > 0 && box.height > 0; }).at(-1);
  const submit = editor?.closest('form')?.querySelector('button[type="submit"]:not([disabled])');
  if (!submit) return false;
  submit.click();
  return true;
}

/** 화면에 있는 대화 차례: 열쇠(사용자 메시지 id)와 글. */
export function pageTurns() {
  return [...document.querySelectorAll('[data-turn-key]')]
    .map((element) => ({ key: element.getAttribute('data-turn-key'), text: element.innerText.slice(0, 2000) }))
    .filter((turn) => turn.key);
}

/** 입력창에 남은 초안을 지운다(앞선 시도가 못 보낸 글). */
export function pageClearComposer() {
  const editor = [...document.querySelectorAll('.ProseMirror[contenteditable="true"]')]
    .filter((element) => { const box = element.getBoundingClientRect(); return box.width > 0 && box.height > 0; }).at(-1);
  if (!editor) return false;
  editor.focus();
  if (!editor.innerText.trim()) return true;
  document.getSelection()?.selectAllChildren(editor);
  document.execCommand('delete');
  return !editor.innerText.trim();
}

/** 대화에 이미 있는 메시지 id. 아직 없는 대화(새 채팅)는 빈 목록이다. */
export async function pageMessageIds(conversationId) {
  const session = await fetch('/api/auth/session', { credentials: 'include' }).then((r) => r.json()).catch(() => null);
  if (!session?.accessToken) return [];
  const response = await fetch(`/backend-api/conversation/${conversationId}`, { headers: { authorization: `Bearer ${session.accessToken}` }, credentials: 'include' });
  const body = response.ok ? await response.json().catch(() => null) : null;
  if (!body || typeof body.mapping !== 'object') return [];
  return Object.entries(body.mapping).flatMap(([id, node]) => [id, node?.message?.id]).filter((id) => typeof id === 'string');
}

/** 한 차례의 진행 상태. 중지 단추는 입력창 근처의 aria-label 로 본다(언어마다 다르므로 보조 신호다). */
export function pageTurnState(turnKey) {
  const turn = [...document.querySelectorAll('[data-turn-key]')].find((element) => element.getAttribute('data-turn-key') === turnKey);
  const states = turn ? [...turn.querySelectorAll('[data-talvt-turn-state]')].map((element) => element.getAttribute('data-talvt-turn-state')) : [];
  const stop = [...document.querySelectorAll('button[aria-label]')].some((button) => {
    const box = button.getBoundingClientRect();
    return box.width > 0 && box.height > 0 && /^(중지|정지|Stop|Stop generating|Stop streaming)$/i.test(button.getAttribute('aria-label').trim());
  });
  return { present: !!turn, assistant: !!turn?.querySelector('[data-conversation-role="assistant"]'), states, stop, text: turn ? turn.innerText.length : 0 };
}

/** 프로젝트 만들기 대화상자를 연다. */
export function pageOpenProjectDialog() {
  const create = document.querySelector('[data-app-action-sidebar-project-create]');
  if (!create) return { opened: false, reason: 'create-button' };
  create.click();
  return { opened: true };
}

export function pageProjectDialog() {
  const input = document.querySelector('#chatgpt-project-name');
  const form = input?.closest('form') ?? null;
  const submit = form?.querySelector('button[type="submit"]') ?? null;
  const memory = form?.querySelector('footer button[aria-haspopup="menu"]') ?? null;
  return { input: !!input, value: input?.value ?? '', submit: !!submit, disabled: submit?.disabled ?? true, memory: !!memory };
}

export function pageFocusProjectName() {
  const input = document.querySelector('#chatgpt-project-name');
  if (!input) return false;
  input.focus();
  input.select?.();
  return document.activeElement === input;
}

export function pageSubmitProject() {
  const submit = document.querySelector('#chatgpt-project-name')?.closest('form')?.querySelector('button[type="submit"]');
  if (!submit || submit.disabled) return false;
  submit.click();
  return true;
}

/**
 * 대화를 읽어 userMessageId 다음의 답을 모은다. 끝난 답만 done:true 다.
 * 인용 표지(사설 영역 …)는 지운다.
 */
export async function pageReadAnswer({ conversationId, userMessageId }) {
  const session = await fetch('/api/auth/session', { credentials: 'include' }).then((r) => r.json()).catch(() => null);
  if (!session?.accessToken) return { signedIn: false };
  const response = await fetch(`/backend-api/conversation/${conversationId}`, { headers: { authorization: `Bearer ${session.accessToken}` }, credentials: 'include' });
  if (response.status === 403 && response.headers.get('cf-mitigated') === 'challenge') return { challenge: true };
  const body = await response.json().catch(() => null);
  if (!response.ok || !body || typeof body.mapping !== 'object' || typeof body.current_node !== 'string') return { shape: false, status: response.status };
  const chain = [];
  for (let id = body.current_node, guard = 0; id && guard < 2000; guard++) {
    const node = body.mapping[id];
    if (!node) break;
    chain.unshift(node);
    id = node.parent;
  }
  const start = chain.findIndex((node) => node.id === userMessageId || node.message?.id === userMessageId);
  if (start < 0) return { shape: true, found: false };
  const replies = chain.slice(start + 1).map((node) => node.message).filter((message) => message?.author?.role === 'assistant');
  const texts = replies
    .filter((message) => message.content?.content_type === 'text' && (message.recipient ?? 'all') === 'all')
    .map((message) => (message.content.parts ?? []).filter((part) => typeof part === 'string').join(''))
    .map((text) => text.replace(/[^]*/g, '').trim())
    .filter(Boolean);
  const last = replies.at(-1);
  const done = !!last && last.end_turn === true && last.status === 'finished_successfully';
  return {
    shape: true, found: true, done, answer: texts.join('\n\n'),
    temporary: body.is_temporary_chat === true, memoryScope: typeof body.memory_scope === 'string' ? body.memory_scope : null,
  };
}

// ─── 허브 쪽 구동기 ───

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * @param {{ browser: { drive: Function, available: () => boolean }, store: ReturnType<typeof createChatgptStore>,
 *   timeoutMs?: number, maxAnswerChars?: number, pollMs?: number, stepTimeoutMs?: number, now?: () => number }} options
 * stepTimeoutMs 는 화면 표지 하나(입력창·새 차례·프로젝트 대화상자)를 기다리는 한도다. 넘으면 화면이 바뀐 것으로 본다.
 * browser.drive(actor, { url }, (page) => …) 는 ChatGPT 행위자의 탭 하나에서 작업을 차례로 돌린다(owned-browser-service).
 */
export function createChatgptDriver({ browser, store, timeoutMs = CHATGPT_DEFAULT_TIMEOUT_MS, maxAnswerChars = CHATGPT_MAX_ANSWER_CHARS,
  pollMs = 500, stepTimeoutMs = 15_000, settleMs = 750, now = Date.now }) {
  let queue = Promise.resolve();
  const serial = (operation) => {
    const task = queue.then(operation, operation);
    queue = task.catch(() => {});
    return task;
  };

  const assertAvailable = () => {
    if (!store.enabled()) throw chatgptError('CHATGPT_DISABLED', 'ChatGPT is turned off in Settings → AI.');
    if (!browser.available()) throw chatgptError('CHATGPT_UNAVAILABLE', 'ChatGPT works only in the HamaEditor desktop app with its built-in browser.');
  };

  /** 한 작업 동안 Cloudflare 확인(403 + cf-mitigated: challenge)을 지켜본다. */
  const watchChallenge = (page) => {
    const state = { challenged: false };
    const onResponse = (response) => {
      try {
        if (response.status() === 403 && response.headers()['cf-mitigated'] === 'challenge' && new URL(response.url()).origin === CHATGPT_ORIGIN) state.challenged = true;
      } catch {}
    };
    page.on('response', onResponse);
    return { state, dispose: () => page.off('response', onResponse) };
  };

  const run = async (deadline, page, watcher, step) => {
    const remaining = deadline - now();
    if (remaining <= 0) throw fail('CHATGPT_TIMEOUT');
    let timer;
    try {
      return await Promise.race([step(), new Promise((_, reject) => { timer = setTimeout(() => reject(fail('CHATGPT_TIMEOUT')), remaining); })]);
    } catch (error) {
      // 확인 페이지가 끼어든 실패는 화면 변화나 시간 초과가 아니라 사람 확인이 필요한 것이다.
      throw watcher.state.challenged && error?.code !== 'CHATGPT_SIGNED_OUT' ? fail('CHATGPT_CHALLENGE') : error;
    } finally { clearTimeout(timer); }
  };

  const evaluate = async (page, fn, arg) => {
    try { return await page.evaluate(fn, arg); }
    catch (error) {
      if (/Execution context was destroyed|navigation/i.test(String(error?.message))) { await page.waitForLoadState('domcontentloaded').catch(() => {}); return page.evaluate(fn, arg); }
      throw error;
    }
  };

  const goto = async (page, url) => {
    const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch((error) => { throw fail('CHATGPT_UI_CHANGED', `navigation failed: ${String(error?.message ?? error).split('\n')[0].slice(0, 120)}`); });
    if (response?.status() === 403 && response.headers()['cf-mitigated'] === 'challenge') throw fail('CHATGPT_CHALLENGE');
  };

  const onChatgpt = (page) => { try { return new URL(page.url()).origin === CHATGPT_ORIGIN; } catch { return false; } };

  /**
   * 페이지가 다 떴을 때 ready() 의 값을 돌려준다: 문서가 끝났고, ready() 가 참이고, 새 리소스가 settleMs 동안 없다.
   * 고정 시간이 아니라 진행을 본다. 리소스가 계속 들어오는 동안은 기다리고, 준비되지 않은 채 stepTimeoutMs 동안 진행이 없으면 멈춘다.
   */
  const waitUntilLoaded = async (page, ready, { until, label }) => {
    let signature = ''; let movedAt = now(); let readySince = null;
    for (;;) {
      const state = await evaluate(page, pageLoadProgress).catch(() => null);
      const value = state ? await ready() : null;
      const next = state ? `${state.complete}:${state.resources}` : `navigating:${now()}`;
      if (next !== signature) { signature = next; movedAt = now(); }
      if (value && state.complete) {
        // 준비된 뒤에도 리소스가 계속 오면(분석 요청 등) 최대 5초만 더 기다린다.
        readySince ??= now();
        if (now() - movedAt >= settleMs || now() - readySince >= 5_000) return value;
      } else readySince = null;
      if (now() >= until || !value && now() - movedAt >= stepTimeoutMs) throw fail('CHATGPT_UI_CHANGED', label);
      await sleep(Math.min(pollMs, 250));
    }
  };

  const waitFor = async (check, { until, label, interval = pollMs }) => {
    for (;;) {
      const value = await check();
      if (value) return value;
      if (now() >= until) throw fail('CHATGPT_UI_CHANGED', label);
      await sleep(interval);
    }
  };

  const ensureSignedIn = async (page) => {
    const session = await evaluate(page, pageSession);
    if (session?.challenge) throw fail('CHATGPT_CHALLENGE');
    if (!session?.signedIn) throw fail('CHATGPT_SIGNED_OUT');
    return session;
  };

  const ensureProject = async (page) => {
    const cached = store.projectUrl();
    if (cached) return cached;
    const found = await evaluate(page, pageFindProject, CHATGPT_PROJECT_NAME);
    if (found?.challenge) throw fail('CHATGPT_CHALLENGE');
    if (found?.signedIn === false) throw fail('CHATGPT_SIGNED_OUT');
    if (!found?.shape) throw fail('CHATGPT_UI_CHANGED', `project list ${found?.status ?? 'unreadable'}`);
    if (found.slug) {
      const url = chatgptProjectUrl(`${CHATGPT_ORIGIN}/g/${found.slug}/project`);
      if (!url) throw fail('CHATGPT_UI_CHANGED', 'project address');
      await store.setProjectUrl(url);
      return url;
    }
    // 없으면 화면의 "새 프로젝트" 대화상자로 만든다. 메모리는 기본값(기본 메모리)을 그대로 둔다.
    if (!onChatgpt(page)) await goto(page, `${CHATGPT_ORIGIN}/`);
    const until = now() + stepTimeoutMs;
    await waitFor(async () => (await evaluate(page, pageOpenProjectDialog)).opened, { until, label: 'new project button' });
    await waitFor(async () => { const dialog = await evaluate(page, pageProjectDialog); return dialog.input && dialog.submit && dialog.memory; }, { until, label: 'project dialog' });
    if (!await evaluate(page, pageFocusProjectName)) throw fail('CHATGPT_UI_CHANGED', 'project name field');
    await page.keyboard.insertText(CHATGPT_PROJECT_NAME);
    await waitFor(async () => { const dialog = await evaluate(page, pageProjectDialog); return dialog.value === CHATGPT_PROJECT_NAME && !dialog.disabled; }, { until, label: 'project name' });
    if (!await evaluate(page, pageSubmitProject)) throw fail('CHATGPT_UI_CHANGED', 'create project');
    const url = await waitFor(() => chatgptProjectUrl(page.url()), { until, label: 'project page' });
    await store.setProjectUrl(url);
    return url;
  };

  const openChat = async (page, chatKey, projectUrl) => {
    const known = store.chatUrl(chatKey);
    if (known && projectIdOf(known) === projectIdOf(projectUrl)) {
      await goto(page, known);
      // 지운 채팅은 다른 주소로 옮겨진다. 그때는 프로젝트에서 새 채팅을 시작한다.
      if (conversationIdOf(page.url()) === conversationIdOf(known)) return known;
      await store.forgetChat(chatKey);
    }
    await goto(page, projectUrl);
    // 사용자가 프로젝트를 지웠으면 다른 주소로 옮겨진다. 부른 쪽이 다시 찾거나 만든다.
    return projectIdOf(page.url()) === projectIdOf(projectUrl) ? null : false;
  };

  /** 기존 채팅을 열면 ChatGPT 가 주소를 고쳐 쓰며 화면을 다시 그린다. 주소가 1초 동안 그대로일 때까지 기다린다. */
  const settle = async (page, until) => {
    let url = page.url();
    let since = now();
    while (now() - since < 1_000 && now() < until) {
      await sleep(Math.min(pollMs, 250));
      if (page.url() !== url) { url = page.url(); since = now(); }
    }
  };

  const send = async (page, question, until) => {
    await settle(page, Math.min(until, now() + stepTimeoutMs));
    // 페이지가 다 뜬 뒤에만 입력창을 다룬다. 숨은 탭에서 claude.ai 는 스크립트 수백 개를 차례로 받아 20초 넘게 걸리기도 한다.
    await waitUntilLoaded(page, async () => (await evaluate(page, pageComposerState)).ready, { until, label: 'composer' });
    // 이미 있던 차례는 서버 대화에서 센다. 화면은 다시 그리는 중이면 옛 차례를 늦게 보여 새 차례로 오인하게 한다.
    const conversationId = conversationIdOf(page.url());
    const known = new Set([
      ...(await evaluate(page, pageTurns)).map((turn) => turn.key),
      ...(conversationId ? await evaluate(page, pageMessageIds, conversationId) : []),
    ]);
    if (!await evaluate(page, pageClearComposer)) throw fail('CHATGPT_UI_CHANGED', 'composer focus');
    if (!await evaluate(page, pageFocusComposer)) throw fail('CHATGPT_UI_CHANGED', 'composer focus');
    await page.keyboard.insertText(question);
    const squash = (value) => value.replace(/\s+/g, ' ').trim();
    const head = squash(question).slice(0, 40);
    await waitFor(async () => squash((await evaluate(page, pageComposerState)).text).includes(head), { until: Math.min(until, now() + 5_000), label: 'composer text' });
    // 보내기 단추가 있으면 그것을 누르고, 없을 때만 Enter 를 쓴다.
    const submit = async () => { if (!await evaluate(page, pageSubmitComposer)) await page.keyboard.press('Enter'); };
    await submit();
    // 새 차례는 처음 보는 열쇠이면서 이 질문을 담아야 한다.
    const fresh = async () => (await evaluate(page, pageTurns)).find((turn) => !known.has(turn.key) && squash(turn.text).includes(head))?.key ?? null;
    const sent = await waitFor(fresh, { until: Math.min(until, now() + 3_000), label: 'new turn' }).catch(() => null);
    if (sent) return sent;
    // 보내지 않았으면(입력창이 글을 그대로 가짐) 한 번 더 보낸다. 비었으면 보내는 중이니 기다리기만 한다.
    if (squash((await evaluate(page, pageComposerState)).text).includes(head)) await submit();
    return waitFor(fresh, { until: Math.min(until, now() + stepTimeoutMs), label: 'new turn' });
  };

  /** 끝남: 화면 차례가 complete 이고 중지 단추가 없고 한동안 그대로이며, 대화 조회가 끝난 답을 준다. */
  const awaitAnswer = async (page, userMessageId, until) => {
    let conversationId = null;
    let stableSince = null;
    let lastSignature = '';
    for (;;) {
      conversationId ??= conversationIdOf(page.url());
      const turn = await evaluate(page, pageTurnState, userMessageId);
      const signature = `${turn.states.join(',')}|${turn.stop}|${turn.text}`;
      const settled = turn.present && turn.assistant && turn.states.length > 0 && turn.states.every((state) => state === 'complete') && !turn.stop;
      if (signature !== lastSignature) { lastSignature = signature; stableSince = settled ? now() : null; }
      else if (settled && stableSince === null) stableSince = now();
      if (conversationId && settled && now() - stableSince >= 1_000) {
        const read = await evaluate(page, pageReadAnswer, { conversationId, userMessageId });
        if (read?.challenge) throw fail('CHATGPT_CHALLENGE');
        if (read?.signedIn === false) throw fail('CHATGPT_SIGNED_OUT');
        if (!read?.shape) throw fail('CHATGPT_UI_CHANGED', `conversation ${read?.status ?? 'unreadable'}`);
        if (read.temporary) throw fail('CHATGPT_UI_CHANGED', 'temporary chat');
        if (read.found && read.done) return { conversationId, answer: read.answer };
      }
      if (now() >= until) throw fail('CHATGPT_TIMEOUT');
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
    /** 설정 줄의 상태. check 면 앱 브라우저로 로그인을 확인한다(sessionId 는 그 탭을 붙일 편집기 창). */
    status: ({ check = false, sessionId = null } = {}) => serial(async () => {
      const base = { enabled: store.enabled(), available: browser.available(), projectUrl: store.projectUrl() };
      if (!check || !base.enabled || !base.available) return { ...base, signedIn: null };
      return browser.drive(chatgptActor(sessionId), { url: store.projectUrl() ?? `${CHATGPT_ORIGIN}/` }, async (page) => {
        const watcher = watchChallenge(page);
        try {
          return await run(now() + 30_000, page, watcher, async () => {
            if (!onChatgpt(page)) await goto(page, `${CHATGPT_ORIGIN}/`);
            const session = await evaluate(page, pageSession);
            if (session?.challenge) throw fail('CHATGPT_CHALLENGE');
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
      if (!chatKey) throw chatgptError('INVALID_ARGS', 'ask_chatgpt needs an active HamaEditor chat');
      if (!question || question.length > CHATGPT_MAX_QUESTION_CHARS) throw chatgptError('INVALID_ARGS', `Ask a question of 1–${CHATGPT_MAX_QUESTION_CHARS} characters`);
      if (now() >= deadline) throw fail('CHATGPT_TIMEOUT');
      const startUrl = store.chatUrl(chatKey) ?? store.projectUrl() ?? `${CHATGPT_ORIGIN}/`;
      return browser.drive(chatgptActor(input?.sessionId), { url: startUrl }, async (page) => {
        const watcher = watchChallenge(page);
        let chatUrl = null;
        try {
          return await run(deadline, page, watcher, async () => {
            if (!onChatgpt(page)) await goto(page, startUrl);
            await ensureSignedIn(page);
            let projectUrl = await ensureProject(page);
            chatUrl = await openChat(page, chatKey, projectUrl);
            if (chatUrl === false) {
              await store.setProjectUrl(null);
              projectUrl = await ensureProject(page);
              chatUrl = await openChat(page, chatKey, projectUrl);
              if (chatUrl === false) throw fail('CHATGPT_UI_CHANGED', 'project page');
            }
            await ensureSignedIn(page);
            const userMessageId = await send(page, question, deadline);
            const result = await awaitAnswer(page, userMessageId, deadline);
            chatUrl = chatgptChatUrl(page.url()) ?? chatUrl;
            if (!chatUrl) throw fail('CHATGPT_UI_CHANGED', 'chat address');
            await store.setChatUrl(chatKey, chatUrl);
            const truncated = result.answer.length > maxAnswerChars;
            return { chatUrl, answer: truncated ? `${result.answer.slice(0, maxAnswerChars)}\n\n[…]` : result.answer, ...(truncated ? { truncated: true } : {}) };
          });
        } catch (error) {
          // 보낸 뒤 실패해도 채팅은 ChatGPT 에 남았다. 다음 질문이 같은 채팅을 이어 가게 주소를 기억한다.
          const landed = chatgptChatUrl(page.url());
          if (landed) await store.setChatUrl(chatKey, landed).catch(() => {});
          throw error;
        } finally { watcher.dispose(); }
      });
  }
}
