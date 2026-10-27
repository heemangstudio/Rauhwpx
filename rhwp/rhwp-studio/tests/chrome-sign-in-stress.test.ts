import assert from 'node:assert/strict';
import test from 'node:test';
import { createChromeSignIn } from '../src/ui/agent-sidebar/chrome-sign-in.ts';

type Handler = (event: any) => void;
type Responder = (args: Record<string, unknown>) => Promise<unknown>;

function fakeHub() {
  const handlers = new Set<Handler>();
  const calls: Array<{ action: string; args: Record<string, unknown> }> = [];
  const responders = new Map<string, Responder>();
  const notes: string[] = [];
  const bridge = {
    async requestBrowser<T>(action: string, args: Record<string, unknown> = {}): Promise<T> {
      calls.push({ action, args });
      const respond = responders.get(action);
      if (respond) return await respond(args) as T;
      if (action === 'status') return { runtime: { signIn: null }, readiness: { passkeys: { supported: true } } } as T;
      return { runtime: { signIn: null } } as T;
    },
    onBrowserEvent(handler: Handler) { handlers.add(handler); return () => { handlers.delete(handler); }; },
  };
  const emit = (event: any) => { for (const handler of handlers) handler(event); };
  const signIn = createChromeSignIn(bridge, (message) => { notes.push(message); });
  return { signIn, calls, responders, notes, emit };
}
const failure = (code: string, message = code) => Object.assign(new Error(message), { code });
const tick = () => new Promise((resolve) => setImmediate(resolve));
const within = <T>(promise: Promise<T>, ms: number, label: string) => Promise.race([promise, new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${label} did not settle within ${ms} ms`)), ms).unref())]);

test('a failed finish shows one message, clears the bar and releases waiters', async (t) => {
  const hub = fakeHub(); t.after(() => hub.signIn.dispose());
  hub.responders.set('sign-in-site', async () => ({ runtime: { signIn: { mode: 'standalone-no-debug', site: 'site.example' } } }));
  await hub.signIn.start('https://site.example/login');
  assert.equal(hub.signIn.site(), 'site.example');
  const waiting = hub.signIn.settled();
  // 허브는 실패를 이벤트로도 알리고 요청 오류로도 돌려준다.
  hub.responders.set('sign-in-site-finish', async () => {
    hub.emit({ type: 'owned_browser_sign_in', site: 'site.example', ok: false, code: 'BROWSER_SITE_SIGN_IN_EMPTY' });
    hub.emit({ type: 'owned_browser_runtime', runtime: { mode: 'native', signIn: null } });
    throw failure('BROWSER_SITE_SIGN_IN_EMPTY');
  });
  await assert.rejects(hub.signIn.finish(), { code: 'BROWSER_SITE_SIGN_IN_EMPTY' });
  await within(waiting, 200, 'settled()');
  assert.equal(hub.signIn.site(), null);
  assert.equal(hub.notes.length, 1, `one failure message, got ${JSON.stringify(hub.notes)}`);
});

test('closing the Chrome window finishes without a Studio request and shows one success message', async (t) => {
  const hub = fakeHub(); t.after(() => hub.signIn.dispose());
  hub.responders.set('sign-in-site', async () => ({ runtime: { signIn: { mode: 'standalone-no-debug', site: 'chatgpt.com' } } }));
  await hub.signIn.start('https://chatgpt.com/');
  const waiting = hub.signIn.settled();
  hub.emit({ type: 'owned_browser_runtime', runtime: { mode: 'native', signIn: null } });
  hub.emit({ type: 'owned_browser_sign_in', site: 'chatgpt.com', ok: true });
  await within(waiting, 200, 'settled()');
  assert.equal(hub.signIn.site(), null);
  assert.deepEqual(hub.notes, ['chatgpt.com에 로그인했습니다']);
});

test('a start the hub refuses clears the optimistic bar and explains why', async (t) => {
  const hub = fakeHub(); t.after(() => hub.signIn.dispose());
  hub.responders.set('sign-in-site', async () => { throw failure('BROWSER_SIGN_IN_ACTIVE'); });
  await assert.rejects(hub.signIn.start('https://claude.ai/'), { code: 'BROWSER_SIGN_IN_ACTIVE' });
  assert.equal(hub.signIn.site(), null);
  await within(hub.signIn.settled(), 200, 'settled()');
  assert.deepEqual(hub.notes, ['진행 중인 로그인을 먼저 마치세요.']);
});

test('the bar shows the hub site, not the clicked host, once Chrome opens', async (t) => {
  const hub = fakeHub(); t.after(() => hub.signIn.dispose());
  hub.responders.set('sign-in-site', async () => {
    // beginHandoff 는 Chrome을 띄우는 동안 로그인 없는 상태를 먼저 알린다.
    hub.emit({ type: 'owned_browser_runtime', runtime: { mode: 'native', state: 'sign-in-starting', signIn: null } });
    return { runtime: { mode: 'managed', signIn: { mode: 'standalone-no-debug', site: 'openai.com' } } };
  });
  await hub.signIn.start('https://auth.openai.com/log-in');
  assert.equal(hub.signIn.site(), 'openai.com');
});

test('starting a second site while one is open tells the user instead of doing nothing', async (t) => {
  const hub = fakeHub(); t.after(() => hub.signIn.dispose());
  hub.responders.set('sign-in-site', async (args) => ({ runtime: { signIn: { mode: 'standalone-no-debug', site: new URL(String(args.url)).hostname } } }));
  await hub.signIn.start('https://chatgpt.com/');
  const before = hub.calls.filter((call) => call.action === 'sign-in-site').length;
  await hub.signIn.start('https://claude.ai/').catch(() => {});
  const asked = hub.calls.filter((call) => call.action === 'sign-in-site').length > before;
  assert.ok(asked || hub.notes.length > 0, 'the Claude Chrome button was ignored silently while the ChatGPT sign-in is open');
  assert.equal(hub.signIn.site(), 'chatgpt.com');
});

test('cancel during a slow Chrome launch clears the bar once the hub has returned to native', async (t) => {
  const hub = fakeHub(); t.after(() => hub.signIn.dispose());
  let release!: () => void;
  // 허브가 취소를 받아 Chrome 없이 네이티브로 돌아온 상태로 시작 요청을 끝낸다.
  hub.responders.set('sign-in-site', () => new Promise((resolve) => { release = () => resolve({ runtime: { mode: 'native', signIn: null } }); }));
  const start = hub.signIn.start('https://site.example/');
  await tick();
  assert.equal(hub.signIn.site(), 'site.example', 'the bar appears immediately');
  hub.responders.set('sign-in-site-cancel', async () => ({ runtime: { mode: 'native', signIn: null } }));
  await hub.signIn.cancel();
  release();
  await start.catch(() => {});
  assert.equal(hub.signIn.site(), null, 'the bar stays up although the hub reported no sign-in for both cancel and start');
  await within(hub.signIn.settled(), 200, 'settled()');
});

test('a hub reconnect without a sign-in clears a stale bar', async (t) => {
  const hub = fakeHub(); t.after(() => hub.signIn.dispose());
  hub.responders.set('sign-in-site', async () => ({ runtime: { signIn: { mode: 'standalone-no-debug', site: 'site.example' } } }));
  await hub.signIn.start('https://site.example/');
  const waiting = hub.signIn.settled();
  hub.emit({ type: 'owned_browser_runtime', payload: { runtime: { mode: 'native', signIn: null } } });
  await within(waiting, 200, 'settled()');
  assert.equal(hub.signIn.site(), null);
});
