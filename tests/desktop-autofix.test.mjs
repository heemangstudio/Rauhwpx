import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import {
  buildAutofixReportPayload,
  claudeAutofixArgv,
  claudeResultText,
  codexAutofixArgv,
  codexPlanType,
  createAutofixService,
  createAutofixSettingsStore,
  defaultAutofixSettings,
  executeAutofixAgent,
  normalizeAutofixSettings,
  checkCliIdentity,
  classifyCleanup,
  parseAutofixAnswer,
  piAutofixArgv,
  probeAutofixProvider,
  probeGiftProvider,
} from '../desktop/autofix.mjs';
import { createTreeWatcher, findRunOrphans, killSurvivors, parsePsListing, parseWindowsProcessListing, treeMembers } from '../desktop/autofix-process.mjs';

const genuine = async (agent) => ({ ok: true, version: agent === 'codex' ? '0.163.0' : '2.1.304' });

function jwt(claims) {
  const part = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${part({ alg: 'none' })}.${part(claims)}.sig`;
}

function codexAuth(plan) {
  return JSON.stringify({
    auth_mode: 'chatgpt',
    tokens: { id_token: jwt({ 'https://api.openai.com/auth': plan ? { chatgpt_plan_type: plan } : {} }), access_token: 'x', refresh_token: 'y' },
  });
}

function fakeCliSetup({ codex = { authenticated: true, authMethod: 'oauth' }, claude = { authenticated: true, authMethod: 'oauth' } } = {}) {
  const auth = { codex, claude };
  return {
    binPath: (agent) => `/managed/bin/${agent}`,
    authStatus: async (agent) => auth[agent],
    envFor: (agent) => ({ AGENT: agent }),
  };
}

test('settings normalize to opt-in defaults and keep the priority order', () => {
  assert.deepEqual(normalizeAutofixSettings(null), defaultAutofixSettings());
  assert.equal(defaultAutofixSettings().enabled, false);
  const settings = normalizeAutofixSettings({
    enabled: true,
    providers: [
      { id: 'claude', enabled: false, model: 'claude-made-up', effort: 'ultra' },
      { id: 'claude', enabled: true },
      { id: 'gemini', enabled: true },
    ],
  });
  assert.equal(settings.enabled, true);
  assert.equal(settings.decided, false);
  assert.deepEqual(settings.providers, [
    { id: 'claude', enabled: false, model: 'claude-sonnet-5-5', effort: 'medium' },
    { id: 'codex', enabled: true, model: 'sol', effort: 'low' },
  ]);
  // 예전 기본값(Opus 5.5)으로 저장한 파일은 사용자가 고른 값으로 남는다.
  const saved = normalizeAutofixSettings({ providers: [{ id: 'codex' }, { id: 'claude', model: 'claude-opus-5-5' }] });
  assert.equal(saved.providers[1].model, 'claude-opus-5-5');
  const codex = normalizeAutofixSettings({ providers: [{ id: 'codex', model: 'gpt-6-luna', effort: 'ultra' }] }).providers[0];
  assert.deepEqual(codex, { id: 'codex', enabled: true, model: 'luna', effort: 'ultra' });
});

test('settings store survives a corrupt file and persists normalized patches', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'autofix-settings-'));
  try {
    const filePath = path.join(dir, 'autofix-settings.json');
    await writeFile(filePath, '{"enabled": tru');
    const changes = [];
    const store = createAutofixSettingsStore({ filePath, onChange: (value) => changes.push(value) });
    assert.deepEqual(await store.get(), defaultAutofixSettings());
    const saved = await store.set({ enabled: true, decided: true, providers: [{ id: 'claude', effort: 'nope' }] });
    assert.equal(saved.enabled, true);
    assert.deepEqual(saved.providers.map((entry) => entry.id), ['claude', 'codex']);
    assert.equal(saved.providers[0].effort, 'medium');
    assert.deepEqual(changes, [saved]);
    const reread = createAutofixSettingsStore({ filePath });
    assert.deepEqual(await reread.get(), saved);
    assert.deepEqual(JSON.parse(readFileSync(filePath, 'utf8')), saved);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('codex plan comes from the login token', () => {
  assert.equal(codexPlanType(JSON.parse(codexAuth('free'))), 'free');
  assert.equal(codexPlanType(JSON.parse(codexAuth('plus'))), 'plus');
  assert.equal(codexPlanType(JSON.parse(codexAuth(null))), null);
  assert.equal(codexPlanType({ OPENAI_API_KEY: 'sk-x' }), null);
});

test('provider probe: managed binary first, PATH second, bundled Claude last', async () => {
  const base = { baseEnv: { PATH: '/usr/bin' }, home: '/home/u', platform: 'linux', readFileImpl: async () => codexAuth('plus'), verifyIdentity: genuine };
  const managed = await probeAutofixProvider('codex', { ...base, cliSetup: fakeCliSetup(), exists: (file) => file === '/managed/bin/codex' || file === '/usr/bin/codex' });
  assert.equal(managed.available, true);
  assert.equal(managed.command, '/managed/bin/codex');
  assert.equal(managed.env.AGENT, 'codex');

  const onPath = await probeAutofixProvider('codex', { ...base, cliSetup: fakeCliSetup(), exists: (file) => file === '/usr/bin/codex' });
  assert.equal(onPath.command, '/usr/bin/codex');

  const bundled = await probeAutofixProvider('claude', { ...base, cliSetup: fakeCliSetup(), bundledClaudeBin: '/sdk/claude', exists: (file) => file === '/sdk/claude' });
  assert.deepEqual([bundled.available, bundled.command, bundled.source], [true, '/sdk/claude', 'bundled']);

  const missing = await probeAutofixProvider('codex', { ...base, cliSetup: fakeCliSetup(), exists: () => false });
  assert.deepEqual(missing, { available: false, reason: 'missing' });

  const signedOut = await probeAutofixProvider('claude', { ...base, cliSetup: fakeCliSetup({ claude: { authenticated: false } }), exists: (file) => file === '/managed/bin/claude' });
  assert.deepEqual(signedOut, { available: false, reason: 'signed-out' });
});

test('a free ChatGPT Codex login is unavailable; API keys and unknown plans are not', async () => {
  const probe = (auth, cliSetup = fakeCliSetup()) => probeAutofixProvider('codex', {
    cliSetup, baseEnv: {}, home: '/home/u', platform: 'linux', exists: (file) => file === '/managed/bin/codex', readFileImpl: async () => auth, verifyIdentity: genuine,
  });
  assert.deepEqual(await probe(codexAuth('free')), { available: false, reason: 'free-plan' });
  assert.equal((await probe(codexAuth(null))).available, true);
  assert.equal((await probe(codexAuth('pro'))).available, true);
  const apiKey = fakeCliSetup({ codex: { authenticated: true, authMethod: 'api-key' } });
  assert.equal((await probe(codexAuth('free'), apiKey)).available, true);
});

test('argv grants full access with the configured model and effort', () => {
  const codex = codexAutofixArgv({ model: 'gpt-6-sol', effort: 'low', cwd: '/data', outputFile: '/tmp/out.txt' });
  assert.equal(codex[0], 'exec');
  assert.ok(codex.includes('--dangerously-bypass-approvals-and-sandbox'));
  assert.deepEqual(codex.slice(codex.indexOf('-m'), codex.indexOf('-m') + 2), ['-m', 'gpt-6-sol']);
  assert.ok(codex.includes('model_reasoning_effort="low"'));
  assert.deepEqual(codex.slice(codex.indexOf('-C'), codex.indexOf('-C') + 2), ['-C', '/data']);
  assert.deepEqual(codex.slice(codex.indexOf('-o'), codex.indexOf('-o') + 2), ['-o', '/tmp/out.txt']);
  assert.equal(codex.at(-1), '-');

  const claude = claudeAutofixArgv({ model: 'claude-opus-5-5', effort: 'medium' });
  assert.ok(claude.includes('-p'));
  assert.deepEqual(claude.slice(claude.indexOf('--output-format'), claude.indexOf('--output-format') + 2), ['--output-format', 'json']);
  assert.deepEqual(claude.slice(claude.indexOf('--model'), claude.indexOf('--model') + 2), ['--model', 'claude-opus-5-5']);
  assert.deepEqual(claude.slice(claude.indexOf('--effort'), claude.indexOf('--effort') + 2), ['--effort', 'medium']);
  assert.deepEqual(claude.slice(claude.indexOf('--permission-mode'), claude.indexOf('--permission-mode') + 2), ['--permission-mode', 'bypassPermissions']);
  assert.ok(claude.includes('--dangerously-skip-permissions'));
});

test('answers parse from fenced JSON, Claude result envelopes, and reject garbage', () => {
  const answer = { fixed: true, cause: '잘린 파일', touched: ['/data/a.json', 7], suggestedFix: '원자적 쓰기' };
  assert.deepEqual(parseAutofixAnswer(`Done.\n\`\`\`json\n${JSON.stringify(answer)}\n\`\`\``), { ...answer, touched: ['/data/a.json'] });
  assert.equal(parseAutofixAnswer('I fixed it!'), null);
  assert.equal(parseAutofixAnswer('{"fixed": "yes"}'), null);
  const envelope = JSON.stringify({ type: 'result', is_error: false, result: JSON.stringify(answer) });
  assert.equal(parseAutofixAnswer(claudeResultText(envelope)).fixed, true);
  assert.equal(claudeResultText(JSON.stringify({ type: 'result', is_error: true, result: 'boom' })), null);
  assert.equal(claudeResultText('not json'), null);
});

function fakeChild({ onSpawn = () => {}, exitCode = 0, hang = false } = {}) {
  const calls = [];
  const spawnProcess = (command, argv, options) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    let stdin = '';
    child.stdin = { on() {}, end: (text) => { stdin += text; } };
    calls.push({ command, argv, options, child, stdin: () => stdin });
    setImmediate(() => {
      onSpawn({ argv, child });
      if (!hang) setImmediate(() => { child.exitCode = exitCode; child.emit('close', exitCode); });
    });
    return child;
  };
  return { spawnProcess, calls };
}

test('executor pipes the prompt, hides the window, and reads the Codex last message file', async () => {
  const { spawnProcess, calls } = fakeChild({
    onSpawn: ({ argv }) => writeFileSync(argv[argv.indexOf('-o') + 1], '{"fixed":true,"cause":"c","touched":[],"suggestedFix":"s"}'),
  });
  const terminated = [];
  const run = await executeAutofixAgent({
    provider: 'codex', command: '/bin/codex', env: { PATH: '/usr/bin' }, model: 'gpt-6-sol', effort: 'low', prompt: 'PROMPT',
    cwd: '/data', platform: 'linux', nodeCommand: '/usr/bin/node', spawnProcess, terminate: (child) => { terminated.push(child); return Promise.resolve(true); },
    listProcesses: async () => [],
  });
  assert.equal(run.code, 0);
  assert.equal(parseAutofixAnswer(run.finalText).fixed, true);
  assert.equal(calls[0].stdin(), 'PROMPT');
  assert.equal(calls[0].options.windowsHide, true);
  assert.equal(calls[0].options.cwd, '/data');
  assert.equal(calls[0].options.shell, false);
  assert.equal(calls[0].options.detached, true, 'own process group on POSIX');
  assert.equal(calls[0].options.env.NO_COLOR, '1');
  assert.equal(calls[0].options.env.BROWSER, 'true');
  assert.ok(calls[0].argv.includes('check_for_update_on_startup=false'));
  assert.deepEqual(terminated, [calls[0].child]);
  assert.equal(run.cleanup, 'clean');
});

test('on Windows the agent gets a hidden console, no shell and no detached console, and batch shims are refused', async () => {
  const { spawnProcess, calls } = fakeChild();
  const run = await executeAutofixAgent({
    provider: 'claude', command: 'C:\\Tools\\claude.exe', env: { Path: 'C:\\Windows' }, model: 'claude-sonnet-5-5', effort: 'medium', prompt: 'P',
    cwd: 'C:\\data', platform: 'win32', nodeCommand: 'C:\\App\\HamaEditor.exe', spawnProcess, terminate: async () => true,
    listProcesses: async () => [],
  });
  assert.equal(run.code, 0);
  assert.equal(calls[0].options.windowsHide, true);
  assert.equal(calls[0].options.detached, false);
  assert.equal(calls[0].options.shell, false);
  assert.equal(calls[0].options.env.DISABLE_AUTOUPDATER, '1');
  assert.equal(calls[0].options.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, '1');
  assert.equal(calls[0].options.env.BROWSER, undefined);

  const refused = await executeAutofixAgent({
    provider: 'claude', command: 'C:\\nowhere\\claude.cmd', env: {}, model: 'm', effort: 'medium', prompt: 'P',
    cwd: 'C:\\data', platform: 'win32', nodeCommand: 'C:\\App\\HamaEditor.exe', spawnProcess, terminate: async () => true,
    listProcesses: async () => [],
  });
  assert.equal(refused.code, null);
  assert.equal(calls.length, 1, 'never spawned through cmd.exe');
});

test('executor kills the tree on timeout', async () => {
  const { spawnProcess, calls } = fakeChild({ hang: true });
  const terminated = [];
  const run = await executeAutofixAgent({
    provider: 'claude', command: '/bin/claude', env: {}, model: 'claude-opus-5-5', effort: 'medium', prompt: 'P',
    cwd: '/data', platform: 'linux', nodeCommand: '/usr/bin/node', spawnProcess, timeoutMs: 20,
    terminate: (child) => { terminated.push(child); child.exitCode = null; child.emit('close', null); return Promise.resolve(true); },
    listProcesses: async () => [],
  });
  assert.equal(run.timedOut, true);
  assert.equal(terminated[0], calls[0].child);
  assert.equal(run.cleanup, 'forced');
});

test('an abort (app quit, window closed) goes through the same cleanup', async () => {
  const { spawnProcess } = fakeChild({ hang: true });
  const controller = new AbortController();
  setTimeout(() => controller.abort('app quit'), 10);
  const run = await executeAutofixAgent({
    provider: 'claude', command: '/bin/claude', env: {}, model: 'm', effort: 'medium', prompt: 'P', cwd: '/data', platform: 'linux',
    nodeCommand: '/usr/bin/node', spawnProcess, signal: controller.signal, listProcesses: async () => [],
    terminate: (child) => { child.emit('close', null); return Promise.resolve(true); },
  });
  assert.equal(run.aborted, true);
  assert.equal(run.cleanup, 'forced');
});

test('survivors that lost their parent are found and killed after the CLI exits', async () => {
  const start = (n) => `Tue Oct 21 10:00:0${n} 2026`;
  // 100 = CLI, 101 = its shell, 102 = a background job the shell started in its own session.
  let phase = 'running';
  const killed = [];
  const list = async () => {
    if (phase === 'running') {
      return [
        { pid: 1, ppid: 0, pgid: 1, start: start(0) },
        { pid: 100, ppid: 50, pgid: 100, start: start(1) },
        { pid: 101, ppid: 100, pgid: 100, start: start(2) },
        { pid: 102, ppid: 101, pgid: 102, start: start(3) },
      ];
    }
    // CLI 와 셸은 끝났고, 102 는 launchd(1) 아래로 넘어갔다. 103 은 같은 PID 가 아니라 무관한 프로세스다.
    return [
      { pid: 1, ppid: 0, pgid: 1, start: start(0) },
      ...(killed.includes(102) ? [] : [{ pid: 102, ppid: 1, pgid: 102, start: start(3) }]),
      { pid: 101, ppid: 1, pgid: 101, start: start(9) },
    ];
  };
  const watcher = createTreeWatcher({ rootPid: 100, list, intervalMs: 1_000_000 });
  await watcher.snapshot();
  await watcher.stop();
  assert.deepEqual([...watcher.tracked.keys()].sort(), [100, 101, 102]);
  phase = 'exited';
  const result = await killSurvivors({ tracked: watcher.tracked, list, kill: async (pid) => { killed.push(pid); }, settleMs: 0 });
  assert.deepEqual(killed, [102], 'the reused PID 101 is left alone');
  assert.deepEqual(result, { found: 1, remaining: 0 });
  assert.equal(classifyCleanup({ forced: false, stragglers: 1, outcome: true, survivors: result }), 'forced');
  assert.equal(classifyCleanup({ forced: false, stragglers: 0, outcome: true, survivors: { found: 0, remaining: 0 } }), 'clean');
  assert.equal(classifyCleanup({ forced: false, stragglers: 0, outcome: true, survivors: { found: 1, remaining: 1 } }), 'uncertain');
  assert.equal(classifyCleanup({ forced: false, stragglers: null, outcome: null, survivors: { found: 0, remaining: null } }), 'uncertain');
});

test('process listings parse on macOS and Windows', () => {
  const mac = parsePsListing('  100     1   100   501 Tue Oct 21 10:00:01 2026\n  101   100   100   501 Tue Oct 21 10:00:02 2026\n');
  assert.deepEqual(mac[1], { pid: 101, ppid: 100, pgid: 100, uid: 501, start: 'Tue Oct 21 10:00:02 2026' });
  const win = parseWindowsProcessListing('4,0,\r\n100,50,133000000000000000\r\n101,100,133000000000000001\r\n');
  assert.deepEqual(treeMembers(100, win).map((row) => row.pid).sort(), [100, 101]);
});

test('identity probe rejects a fake claude or codex and an older CLI missing our flags', () => {
  const claudeHelp = '--print --output-format --model --effort --permission-mode bypassPermissions --dangerously-skip-permissions --no-session-persistence --setting-sources --strict-mcp-config';
  assert.deepEqual(checkCliIdentity('claude', '2.1.304 (Claude Code)\n', claudeHelp), { ok: true, version: '2.1.304' });
  assert.equal(checkCliIdentity('claude', 'claude 1.0.0\n', claudeHelp).ok, false, 'a script named claude');
  assert.equal(checkCliIdentity('claude', '2.1.304 (Claude Code)', claudeHelp.replace('--effort ', '')).reason, 'unsupported-flags:--effort');
  assert.equal(checkCliIdentity('codex', 'codex-cli 0.163.0', '').ok, false);
  assert.equal(checkCliIdentity('codex', 'codex 0.163.0', '--skip-git-repo-check').ok, false);
  assert.equal(checkCliIdentity('pi', '1.1.0', 'something else --print').ok, false);
});

test('a fake claude on PATH is skipped for the next genuine candidate', async () => {
  const probe = await probeAutofixProvider('claude', {
    cliSetup: fakeCliSetup(), baseEnv: { PATH: '/usr/bin' }, home: '/home/u', platform: 'linux', bundledClaudeBin: '/sdk/claude',
    exists: (file) => file === '/usr/bin/claude' || file === '/sdk/claude',
    verifyIdentity: async (agent, command) => (command === '/usr/bin/claude' ? { ok: false, reason: 'not-genuine' } : { ok: true, version: '2.1.304' }),
  });
  assert.deepEqual([probe.available, probe.command, probe.source, probe.version], [true, '/sdk/claude', 'bundled', '2.1.304']);
  const none = await probeAutofixProvider('claude', {
    cliSetup: fakeCliSetup(), baseEnv: { PATH: '/usr/bin' }, home: '/home/u', platform: 'linux',
    exists: (file) => file === '/usr/bin/claude', verifyIdentity: async () => ({ ok: false, reason: 'not-genuine' }),
  });
  assert.equal(none.available, false);
  assert.match(none.reason, /^not-genuine/);
});

function serviceHarness({ settings = { enabled: true }, available = { codex: true, claude: true }, gift = null, finalText, code = 0, executeDelay = 0 } = {}) {
  const probed = [];
  const executed = [];
  const reports = [];
  const store = { get: async () => normalizeAutofixSettings(settings) };
  const service = createAutofixService({
    settings: store,
    probe: async (agent) => {
      probed.push(agent);
      return available[agent] ? { available: true, command: `/bin/${agent}`, env: {}, source: 'path' } : { available: false, reason: 'missing' };
    },
    probeGift: gift === null ? null : async () => {
      probed.push('gift');
      return gift ? { available: true, command: '/bin/pi', env: {}, source: 'gift', baseUrl: 'https://gift.example' } : { available: false, reason: 'gift-inactive' };
    },
    resolveModel: async (entry) => (entry.id === 'codex' ? `gpt-6-${entry.model}` : entry.model),
    buildPrompt: async () => 'PROMPT',
    execute: async (options) => {
      executed.push(options);
      if (executeDelay) await new Promise((resolve) => setTimeout(resolve, executeDelay));
      return { code, timedOut: false, stdout: '', stderr: '', finalText: finalText ?? '{"fixed":true,"cause":"c","touched":["/x"],"suggestedFix":"s"}' };
    },
    sendReport: async (report) => { reports.push(report); return { ok: true, id: 'fb_1' }; },
  });
  return { service, probed, executed, reports };
}

test('disabled feature is unavailable without probing or spawning', async () => {
  const { service, probed, executed } = serviceHarness({ settings: { enabled: false } });
  assert.deepEqual(await service.run({ surface: 's', title: 't' }), { status: 'unavailable' });
  assert.deepEqual(probed, []);
  assert.deepEqual(executed, []);
});

test('providers run in priority order, skipping disabled and unavailable ones', async () => {
  let harness = serviceHarness();
  assert.deepEqual(await harness.service.run({ surface: 's', title: 't' }), { status: 'fixed', provider: 'codex' });
  assert.equal(harness.executed[0].model, 'gpt-6-sol');
  assert.equal(harness.executed[0].effort, 'low');

  harness = serviceHarness({ settings: { enabled: true, providers: [{ id: 'claude' }, { id: 'codex' }] } });
  assert.equal((await harness.service.run({})).provider, 'claude');

  harness = serviceHarness({ settings: { enabled: true, providers: [{ id: 'codex', enabled: false }, { id: 'claude' }] } });
  assert.equal((await harness.service.run({})).provider, 'claude');
  assert.deepEqual(harness.probed, ['claude']);

  harness = serviceHarness({ available: { codex: false, claude: true } });
  const result = await harness.service.run({});
  assert.deepEqual(result, { status: 'fixed', provider: 'claude' });
  assert.equal(harness.executed[0].model, 'claude-sonnet-5-5');
  assert.equal(harness.executed[0].effort, 'medium');

  harness = serviceHarness({ available: { codex: false, claude: false } });
  assert.deepEqual(await harness.service.run({}), { status: 'unavailable' });
  assert.deepEqual(harness.executed, []);
});

test('only a clean exit with fixed:true counts as fixed', async () => {
  assert.equal((await serviceHarness({ finalText: 'sorry, could not' }).service.run({})).status, 'failed');
  assert.equal((await serviceHarness({ code: 1 }).service.run({})).status, 'failed');
  assert.equal((await serviceHarness({ finalText: '{"fixed":false,"cause":"","touched":[],"suggestedFix":""}' }).service.run({})).status, 'failed');
});

test('concurrent requests join the in-flight run', async () => {
  const { service, executed } = serviceHarness({ executeDelay: 30 });
  const [first, second] = await Promise.all([service.run({ title: 'a' }), service.run({ title: 'b' })]);
  assert.equal(first, second);
  assert.equal(executed.length, 1);
  await service.run({ title: 'c' });
  assert.equal(executed.length, 2);
});

test('the report carries the agent answer but no screenshot, document, or chat', async () => {
  const { service, reports } = serviceHarness();
  await service.run({ surface: 'renderer-crash', title: '화면 멈춤', attempts: 2 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(reports.length, 1);
  const { status, provider, model, request, answer, durationMs } = reports[0];
  const payload = buildAutofixReportPayload({
    installId: 'install-1',
    createdAt: '2026-10-20T00:00:00.000Z',
    status,
    request,
    answer,
    meta: { appVersion: '2.1.0', autofix: { status, provider, model, surface: request.surface, attempts: request.attempts, durationMs } },
    log: 'log tail',
  });
  assert.equal(payload.screenshot, undefined);
  assert.equal(payload.document, undefined);
  assert.equal(payload.chat, undefined);
  assert.match(payload.message, /^\[자동 수정\] 고침 · renderer-crash: 화면 멈춤/);
  assert.match(payload.message, /건드린 것:\n- \/x/);
  assert.match(payload.message, /개발자 제안: s/);
  assert.equal(payload.meta.autofix.provider, 'codex');
  assert.equal(payload.meta.autofix.attempts, 2);
  assert.equal(payload.log, 'log tail');
});

test('gift credit runs only after Codex and Claude are both unusable', async () => {
  let harness = serviceHarness({ gift: true });
  assert.equal((await harness.service.run({})).provider, 'codex');
  assert.deepEqual(harness.probed, ['codex']);

  harness = serviceHarness({ available: { codex: false, claude: false }, gift: true });
  assert.deepEqual(await harness.service.run({}), { status: 'fixed', provider: 'gift' });
  assert.deepEqual(harness.probed, ['codex', 'claude', 'gift']);
  assert.equal(harness.executed[0].model, 'anthropic/claude-sonnet-5.5');
  assert.equal(harness.executed[0].effort, 'medium');

  harness = serviceHarness({ settings: { enabled: true, providers: [{ id: 'codex', enabled: false }, { id: 'claude', enabled: false }] }, gift: true });
  assert.equal((await harness.service.run({})).provider, 'gift');

  harness = serviceHarness({ available: { codex: false, claude: false }, gift: false });
  assert.deepEqual(await harness.service.run({}), { status: 'unavailable' });
  assert.deepEqual(harness.executed, []);

  harness = serviceHarness({ settings: { enabled: false }, gift: true });
  assert.deepEqual(await harness.service.run({}), { status: 'unavailable' });
  assert.deepEqual(harness.probed, []);
});

test('gift probe needs a claimed gift with balance and never passes the own OpenRouter key', async () => {
  const active = { available: true, active: true, claimed: true, lease: 'lease.sig', baseUrl: 'https://api.example/v1/gift/openrouter', remainingUsd: 12.5 };
  const probe = (gift, extra = {}) => probeGiftProvider({
    credentials: async () => gift,
    piBin: '/pi/bin/pi',
    agentDir: '/data/autofix-pi',
    baseEnv: { PATH: '/usr/bin', OPENROUTER_API_KEY: 'sk-or-own-key', ANTHROPIC_API_KEY: 'sk-ant' },
    home: '/home/u',
    platform: 'linux',
    exists: (file) => file === '/pi/bin/pi',
    verifyIdentity: async () => ({ ok: true, version: '1.1.0' }),
    ...extra,
  });
  const ok = await probe(active);
  assert.equal(ok.available, true);
  assert.equal(ok.env.OPENROUTER_API_KEY, 'lease.sig');
  assert.equal(ok.env.PI_CODING_AGENT_DIR, '/data/autofix-pi');
  assert.equal(ok.env.ANTHROPIC_API_KEY, undefined);
  assert.equal(ok.baseUrl, 'https://api.example/v1/gift/openrouter');

  assert.equal((await probe({ ...active, claimed: false, active: false })).available, false, 'unclaimed');
  assert.equal((await probe({ ...active, remainingUsd: 0 })).available, false, 'no balance');
  assert.equal((await probe({ ...active, active: false, lease: null })).available, false, 'inactive');
  assert.equal((await probe(null)).available, false, 'no gift (own key only)');
  assert.equal((await probe({ ...active, baseUrl: 'https://openrouter.ai/api/v1' })).available, false, 'direct OpenRouter');
  assert.deepEqual(await probe(active, { exists: () => false }), { available: false, reason: 'missing' });
});

test('Pi argv runs the gift model headless with the default tools', () => {
  const argv = piAutofixArgv({ model: 'anthropic/claude-sonnet-5.5', effort: 'medium' });
  assert.ok(argv.includes('-p'));
  assert.deepEqual(argv.slice(argv.indexOf('--model'), argv.indexOf('--model') + 2), ['--model', 'openrouter/anthropic/claude-sonnet-5.5']);
  assert.deepEqual(argv.slice(argv.indexOf('--thinking'), argv.indexOf('--thinking') + 2), ['--thinking', 'medium']);
  assert.ok(!argv.some((arg) => /^--(?:no-)?tools$|^--exclude-tools$|^-nt$/.test(arg)));
});

test('orphans the agent left in its working folder are found; daemons, other users and older processes are not', async () => {
  const since = Date.parse('Tue Oct 21 10:00:00 2026');
  const row = (pid, extra) => ({ pid, ppid: 1, pgid: 900, uid: 501, start: 'Tue Oct 21 10:00:05 2026', ...extra });
  const listing = [
    row(201),                                        // 작업 폴더 안의 고아 → 찾는다
    row(202, { pgid: 202 }),                         // 그룹 리더(데몬·앱)
    row(203, { uid: 0 }),                            // 다른 사용자
    row(204, { start: 'Tue Oct 21 09:00:00 2026' }), // 실행 전에 시작
    row(205),                                        // 다른 폴더
    row(206, { ppid: 77 }),                          // 부모가 살아 있음
  ];
  const cwds = new Map([[201, '/data/user/sub'], [202, '/data/user'], [203, '/data/user'], [204, '/data/user'], [205, '/tmp'], [206, '/data/user']]);
  const found = await findRunOrphans({
    listing, tracked: new Map(), since, uid: 501, dir: '/data/user',
    readCwd: async (pids) => new Map(pids.map((pid) => [pid, cwds.get(pid)])), resolvePath: async (file) => file,
  });
  assert.deepEqual(found.map((item) => item.pid), [201]);
});
