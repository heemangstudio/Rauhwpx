import assert from 'node:assert/strict';
import test from 'node:test';

import { setAutofixApi, type AutofixSettings, type DesktopAutofixApi } from '../src/ui/autofix/autofix.ts';
import { startAutofixIntro, type AutofixIntroDeps } from '../src/ui/autofix/autofix-intro.ts';

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function fakeApi(initial: Partial<AutofixSettings>) {
  let settings: AutofixSettings = {
    enabled: false,
    decided: false,
    providers: [
      { id: 'codex', enabled: true, model: 'sol', effort: 'low' },
      { id: 'claude', enabled: true, model: 'claude-opus-5-5', effort: 'medium' },
    ],
    ...initial,
  };
  const patches: Array<Partial<AutofixSettings>> = [];
  const api: DesktopAutofixApi = {
    run: async () => ({ status: 'failed' }),
    getSettings: async () => ({ ...settings }),
    setSettings: async (patch) => {
      patches.push(patch);
      settings = { ...settings, ...patch };
      return { ...settings };
    },
    onChange: () => () => {},
  };
  return { api, patches, settings: () => settings };
}

function run(deps: Partial<AutofixIntroDeps> & { answer?: boolean } = {}) {
  let opens = 0;
  const intro = startAutofixIntro({
    whenReady: async () => {},
    isSetupComplete: () => true,
    isSetupActive: () => false,
    onSetupInactive: () => () => {},
    open: async () => { opens += 1; return deps.answer ?? false; },
    ...deps,
  });
  return { intro, opens: () => opens };
}

test('the intro opens once for a desktop user who finished setup but never answered', async (t) => {
  const fake = fakeApi({ decided: false });
  setAutofixApi(fake.api);
  t.after(() => setAutofixApi(undefined));
  const { intro, opens } = run();
  await settle();
  await settle();
  assert.equal(opens(), 1);
  intro.dispose();
});

test('later and enable both record the answer, and only enable turns it on', async (t) => {
  t.after(() => setAutofixApi(undefined));
  for (const answer of [false, true]) {
    const fake = fakeApi({ decided: false });
    setAutofixApi(fake.api);
    const { intro } = run({ answer });
    await settle();
    await settle();
    await settle();
    assert.equal(fake.settings().decided, true);
    assert.equal(fake.settings().enabled, answer);
    intro.dispose();
  }
});

test('the intro stays closed on the web, after an answer, and during a first-run setup', async (t) => {
  t.after(() => setAutofixApi(undefined));
  setAutofixApi(null);
  const web = run();
  await settle();
  assert.equal(web.opens(), 0);

  setAutofixApi(fakeApi({ decided: true }).api);
  const answered = run();
  await settle();
  await settle();
  assert.equal(answered.opens(), 0);

  setAutofixApi(fakeApi({ decided: false }).api);
  const firstRun = run({ isSetupComplete: () => false });
  await settle();
  await settle();
  assert.equal(firstRun.opens(), 0);
});

test('an open setup window or a blocking dialog delays the intro until it clears', async (t) => {
  t.after(() => setAutofixApi(undefined));
  setAutofixApi(fakeApi({ decided: false }).api);
  let setupActive = true;
  let release: (() => void) | null = null;
  let blocked = true;
  const { intro, opens } = run({
    isSetupActive: () => setupActive,
    onSetupInactive: (listener) => { release = listener; return () => { release = null; }; },
    isBlocked: () => blocked,
    retryMs: 5,
  });
  await settle();
  await settle();
  assert.equal(opens(), 0);
  setupActive = false;
  release!();
  await settle();
  assert.equal(opens(), 0, 'still blocked by a dialog');
  blocked = false;
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(opens(), 1);
  intro.dispose();
});

test('an intro left open closes without answering when another window answers first', async (t) => {
  const fake = fakeApi({ decided: false });
  const listeners = new Set<(next: AutofixSettings) => void>();
  fake.api.onChange = (callback) => { listeners.add(callback); return () => listeners.delete(callback); };
  setAutofixApi(fake.api);
  t.after(() => setAutofixApi(undefined));
  let closedByOtherWindow = false;
  const { intro } = run({
    open: (signal) => new Promise((resolve) => {
      signal.addEventListener('abort', () => { closedByOtherWindow = true; resolve(false); });
    }),
  });
  for (let index = 0; index < 4; index += 1) await settle();
  for (const listener of listeners) listener({ ...fake.settings(), decided: true, enabled: true });
  for (let index = 0; index < 4; index += 1) await settle();
  assert.equal(closedByOtherWindow, true);
  assert.deepEqual(fake.patches, [], 'the answer from the other window is kept');
  intro.dispose();
});
