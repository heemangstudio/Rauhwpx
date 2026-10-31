import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  AgentInstructionsStore,
  DEFAULT_AGENT_INSTRUCTIONS,
  MAX_AGENT_INSTRUCTIONS_CHARS,
  defaultAgentInstructionsRoot,
} from '../agent-instructions.mjs';

test('app instructions are created as a private standalone AGENTS.md', async (t) => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-agent-instructions-'));
  t.after(() => fs.rm(rootDir, { recursive: true, force: true }));

  const store = await new AgentInstructionsStore({
    rootDir,
    now: () => '2026-08-24T00:00:00.000Z',
  }).init();
  const snapshot = store.snapshot();

  assert.equal(snapshot.fileName, 'AGENTS.md');
  assert.equal(snapshot.scope, 'rauhwpx-app');
  assert.equal(snapshot.revision, 1);
  assert.equal(snapshot.content, DEFAULT_AGENT_INSTRUCTIONS);
  assert.equal(await fs.readFile(path.join(rootDir, 'AGENTS.md'), 'utf8'), DEFAULT_AGENT_INSTRUCTIONS);
  const metadata = JSON.parse(await fs.readFile(path.join(rootDir, '.AGENTS.md.meta.json'), 'utf8'));
  assert.equal(metadata.revision, 1);
  assert.match(metadata.contentHash, /^[a-f0-9]{64}$/);
  if (process.platform !== 'win32') {
    assert.equal((await fs.stat(path.join(rootDir, 'AGENTS.md'))).mode & 0o777, 0o600);
    assert.equal((await fs.stat(path.join(rootDir, '.AGENTS.md.meta.json'))).mode & 0o777, 0o600);
  }
});

test('updates are newline-normalized and reject stale revisions', async (t) => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-agent-instructions-'));
  t.after(() => fs.rm(rootDir, { recursive: true, force: true }));
  const timestamps = ['2026-08-24T00:00:00.000Z', '2026-08-24T00:01:00.000Z'];
  const store = await new AgentInstructionsStore({ rootDir, now: () => timestamps.shift() }).init();

  const updated = await store.update('# 내 지시\r\n\r\n- 간결하게', { expectedRevision: 1 });
  assert.equal(updated.revision, 2);
  assert.equal(updated.content, '# 내 지시\n\n- 간결하게\n');
  assert.equal(updated.updatedAt, '2026-08-24T00:01:00.000Z');
  await assert.rejects(
    store.update('stale', { expectedRevision: 1 }),
    (error) => error?.code === 'INSTRUCTIONS_REVISION_CONFLICT',
  );
});

test('revision persists across restarts and keeps stale editor saves out', async (t) => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-agent-instructions-'));
  t.after(() => fs.rm(rootDir, { recursive: true, force: true }));
  const timestamps = [
    '2026-08-24T00:00:00.000Z',
    '2026-08-24T00:01:00.000Z',
    '2026-08-24T00:02:00.000Z',
  ];
  const store = await new AgentInstructionsStore({ rootDir, now: () => timestamps.shift() }).init();
  await store.update('revision two', { expectedRevision: 1 });
  await store.update('revision three', { expectedRevision: 2 });

  const reopened = await new AgentInstructionsStore({ rootDir }).init();
  assert.equal(reopened.snapshot().revision, 3);
  assert.equal(reopened.snapshot().content, 'revision three\n');
  await assert.rejects(
    reopened.update('stale after restart', { expectedRevision: 1 }),
    (error) => error?.code === 'INSTRUCTIONS_REVISION_CONFLICT',
  );
});

test('a missing AGENTS.md advances persisted revision and rejects stale saves', async (t) => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-agent-instructions-'));
  t.after(() => fs.rm(rootDir, { recursive: true, force: true }));
  const store = await new AgentInstructionsStore({ rootDir }).init();
  await store.update('revision two', { expectedRevision: 1 });
  await fs.rm(path.join(rootDir, 'AGENTS.md'));

  const reopened = await new AgentInstructionsStore({ rootDir }).init();
  assert.equal(reopened.snapshot().revision, 3);
  assert.equal(reopened.snapshot().content, DEFAULT_AGENT_INSTRUCTIONS);
  await assert.rejects(
    reopened.update('stale after content recovery', { expectedRevision: 2 }),
    (error) => error?.code === 'INSTRUCTIONS_REVISION_CONFLICT',
  );
  const repaired = JSON.parse(await fs.readFile(path.join(rootDir, '.AGENTS.md.meta.json'), 'utf8'));
  assert.equal(repaired.revision, 3);
});

test('Windows startup recovers instruction state left at the replacement gap', async (t) => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-agent-instructions-recovery-'));
  t.after(() => fs.rm(rootDir, { recursive: true, force: true }));
  const store = await new AgentInstructionsStore({ rootDir, platform: 'win32' }).init();
  await store.update('saved instructions', { expectedRevision: 1 });
  for (const name of ['AGENTS.md', '.AGENTS.md.meta.json']) {
    await fs.rename(path.join(rootDir, name), path.join(rootDir, `${name}.previous-write`));
  }

  const recovered = await new AgentInstructionsStore({ rootDir, platform: 'win32' }).init();
  assert.equal(recovered.snapshot().content, 'saved instructions\n');
  assert.equal(recovered.snapshot().revision, 2);
});

test('corrupt revision metadata is repaired without reviving stale saves', async (t) => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-agent-instructions-'));
  t.after(() => fs.rm(rootDir, { recursive: true, force: true }));
  const store = await new AgentInstructionsStore({ rootDir }).init();
  await store.update('revision two', { expectedRevision: 1 });
  const staleRevision = store.snapshot().revision;
  await fs.writeFile(path.join(rootDir, '.AGENTS.md.meta.json'), '{broken-json', 'utf8');

  const reopened = await new AgentInstructionsStore({ rootDir }).init();
  assert.ok(reopened.snapshot().revision > staleRevision);
  assert.equal(reopened.snapshot().content, 'revision two\n');
  await assert.rejects(
    reopened.update('stale after metadata repair', { expectedRevision: staleRevision }),
    (error) => error?.code === 'INSTRUCTIONS_REVISION_CONFLICT',
  );
  const repaired = JSON.parse(await fs.readFile(path.join(rootDir, '.AGENTS.md.meta.json'), 'utf8'));
  assert.equal(repaired.revision, reopened.snapshot().revision);
});

test('a symlinked revision sidecar is replaced without reading its target', async (t) => {
  if (process.platform === 'win32') return;
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-agent-instructions-'));
  const foreignDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-foreign-metadata-'));
  t.after(() => Promise.all([
    fs.rm(rootDir, { recursive: true, force: true }),
    fs.rm(foreignDir, { recursive: true, force: true }),
  ]));
  await new AgentInstructionsStore({ rootDir }).init();
  const metadataPath = path.join(rootDir, '.AGENTS.md.meta.json');
  const foreignPath = path.join(foreignDir, 'metadata.json');
  await fs.writeFile(foreignPath, '{"foreign":true}\n');
  await fs.rm(metadataPath);
  await fs.symlink(foreignPath, metadataPath);

  const reopened = await new AgentInstructionsStore({ rootDir }).init();
  assert.ok(reopened.snapshot().revision > 1);
  assert.equal((await fs.lstat(metadataPath)).isSymbolicLink(), false);
  assert.equal(await fs.readFile(foreignPath, 'utf8'), '{"foreign":true}\n');
});

test('instruction size is bounded and platform roots stay outside project workspaces', async (t) => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-agent-instructions-'));
  t.after(() => fs.rm(rootDir, { recursive: true, force: true }));
  const store = await new AgentInstructionsStore({ rootDir }).init();
  await assert.rejects(
    store.update('x'.repeat(MAX_AGENT_INSTRUCTIONS_CHARS + 1), { expectedRevision: 1 }),
    (error) => error?.code === 'INSTRUCTIONS_TOO_LARGE',
  );

  assert.equal(
    defaultAgentInstructionsRoot({}, 'darwin', '/Users/example'),
    '/Users/example/Library/Application Support/rhwp/agent-instructions',
  );
  assert.equal(
    defaultAgentInstructionsRoot({ APPDATA: 'C:\\Users\\example\\AppData\\Roaming' }, 'win32', 'C:\\Users\\example'),
    'C:\\Users\\example\\AppData\\Roaming\\rhwp\\agent-instructions',
  );
  assert.equal(
    defaultAgentInstructionsRoot({ APPDATA: 'relative\\roaming' }, 'win32', 'C:\\Users\\example'),
    'C:\\Users\\example\\AppData\\Roaming\\rhwp\\agent-instructions',
  );
  assert.equal(
    defaultAgentInstructionsRoot({ XDG_DATA_HOME: '/srv/user-data' }, 'linux', '/home/example'),
    '/srv/user-data/rhwp/agent-instructions',
  );
  assert.equal(
    defaultAgentInstructionsRoot({ XDG_DATA_HOME: 'relative/data' }, 'linux', '/home/example'),
    '/home/example/.local/share/rhwp/agent-instructions',
  );
  assert.equal(
    defaultAgentInstructionsRoot({ RHWP_AGENT_INSTRUCTIONS_DIR: 'relative/override' }, 'linux', '/home/example'),
    '/home/example/.local/share/rhwp/agent-instructions',
  );
});

test('loading stays bounded when AGENTS.md grows after stat', async (t) => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-agent-instructions-race-'));
  t.after(() => fs.rm(rootDir, { recursive: true, force: true }));
  const filePath = path.join(rootDir, 'AGENTS.md');
  await fs.writeFile(filePath, 'inside app');

  const racingFs = Object.create(fs);
  let appended = false;
  racingFs.open = async (candidate, flags) => {
    const handle = await fs.open(candidate, flags);
    if (candidate !== filePath) return handle;
    return {
      close: (...args) => handle.close(...args),
      read: (...args) => handle.read(...args),
      stat: async (...args) => {
        const stat = await handle.stat(...args);
        if (!appended) {
          appended = true;
          await fs.appendFile(filePath, 'x'.repeat((MAX_AGENT_INSTRUCTIONS_CHARS * 4) + 1));
        }
        return stat;
      },
    };
  };

  await assert.rejects(
    new AgentInstructionsStore({ rootDir, fsApi: racingFs }).init(),
    (error) => error?.code === 'INSTRUCTIONS_TOO_LARGE',
  );
});

test('prompt block carries the current app-scoped revision and content', async (t) => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-agent-instructions-'));
  t.after(() => fs.rm(rootDir, { recursive: true, force: true }));
  const store = await new AgentInstructionsStore({ rootDir }).init();
  const block = store.promptBlock();

  assert.match(block, /<app_agents_md trust="user-authored-instructions">/);
  assert.match(block, /"scope":"rauhwpx-app"/);
  assert.match(block, /"fileName":"AGENTS\.md"/);
});

test('a symlink cannot make app instructions read a file from another harness', async (t) => {
  if (process.platform === 'win32') return;
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-agent-instructions-'));
  const foreignDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-foreign-instructions-'));
  t.after(() => Promise.all([
    fs.rm(rootDir, { recursive: true, force: true }),
    fs.rm(foreignDir, { recursive: true, force: true }),
  ]));
  const foreign = path.join(foreignDir, 'AGENTS.md');
  await fs.writeFile(foreign, 'outside app');
  await fs.symlink(foreign, path.join(rootDir, 'AGENTS.md'));

  await assert.rejects(
    new AgentInstructionsStore({ rootDir }).init(),
    (error) => error?.code === 'INSTRUCTIONS_FILE_INVALID',
  );
});

async function createSymlinkSwapFs(filePath, foreignPath) {
  const racingFs = Object.create(fs);
  let swapped = false;
  let simulatedWindowsReparsePoint = false;
  racingFs.open = async (candidate, flags) => {
    if (candidate === filePath && !swapped) {
      swapped = true;
      await fs.rm(filePath, { force: true });
      try {
        await fs.symlink(foreignPath, filePath, process.platform === 'win32' ? 'file' : undefined);
      } catch (error) {
        if (process.platform !== 'win32' || error?.code !== 'EPERM') throw error;
        // Some Windows runners disallow test symlink creation. Model the same
        // open-to-foreign/lstat-as-reparse state so the Windows branch remains covered.
        simulatedWindowsReparsePoint = true;
        return fs.open(foreignPath, flags);
      }
    }
    return fs.open(candidate, flags);
  };
  racingFs.lstat = async (candidate, options) => {
    if (candidate === filePath && simulatedWindowsReparsePoint) {
      return { isFile: () => false, isSymbolicLink: () => true };
    }
    return fs.lstat(candidate, options);
  };
  return racingFs;
}

test('POSIX safe open rejects a symlink replacement during loading', async (t) => {
  if (process.platform === 'win32') return;
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-agent-instructions-race-'));
  const foreignDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-foreign-instructions-race-'));
  t.after(() => Promise.all([
    fs.rm(rootDir, { recursive: true, force: true }),
    fs.rm(foreignDir, { recursive: true, force: true }),
  ]));
  const filePath = path.join(rootDir, 'AGENTS.md');
  const foreignPath = path.join(foreignDir, 'AGENTS.md');
  await fs.writeFile(filePath, 'inside app');
  await fs.writeFile(foreignPath, 'outside app');

  await assert.rejects(
    new AgentInstructionsStore({
      rootDir,
      platform: 'linux',
      fsApi: await createSymlinkSwapFs(filePath, foreignPath),
    }).init(),
    (error) => error?.code === 'INSTRUCTIONS_FILE_INVALID',
  );
});

test('Windows file-id validation rejects a symlink replacement during loading', async (t) => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-agent-instructions-race-'));
  const foreignDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-foreign-instructions-race-'));
  t.after(() => Promise.all([
    fs.rm(rootDir, { recursive: true, force: true }),
    fs.rm(foreignDir, { recursive: true, force: true }),
  ]));
  const filePath = path.join(rootDir, 'AGENTS.md');
  const foreignPath = path.join(foreignDir, 'AGENTS.md');
  await fs.writeFile(filePath, 'inside app');
  await fs.writeFile(foreignPath, 'outside app');

  const racingFs = await createSymlinkSwapFs(filePath, foreignPath);
  await assert.rejects(
    new AgentInstructionsStore({ rootDir, platform: 'win32', fsApi: racingFs }).init(),
    (error) => error?.code === 'INSTRUCTIONS_FILE_INVALID',
  );
});

test('the old default that told agents to edit AGENTS.md is replaced once; edited files are left alone', async (t) => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-agent-instructions-'));
  t.after(() => fs.rm(rootDir, { recursive: true, force: true }));
  const store = await new AgentInstructionsStore({ rootDir }).init();
  assert.match(DEFAULT_AGENT_INSTRUCTIONS, /사용자만 고칩니다/);
  assert.doesNotMatch(DEFAULT_AGENT_INSTRUCTIONS, /지시 도구|제안할 수 있습니다/);
  const oldDefault = DEFAULT_AGENT_INSTRUCTIONS.replace(
    /- 이 파일은 사용자만 고칩니다[^\n]*\n- 사용자가 앞으로[^\n]*\n/,
    '- 사용자가 이 지시를 바꿔 달라고 요청하면 앱의 지시 도구를 통해 전체 수정본을 제출하세요. HamaEditor는 사용자에게 변경안을 보여 주고, 사용자가 승인한 뒤에만 저장합니다.\n'
      + '- 사용자가 같은 선호를 반복해서 말하거나 에이전트의 행동을 바로잡은 경우에는 지속해서 적용할 것이 명확한 선호를 선제적으로 제안할 수 있습니다. 변경은 작고 구체적으로 유지하고, 무엇을 제안했는지 사용자에게 알리세요.\n'
      + '- 일회성 작업 세부 정보, 비밀, 인증 정보 또는 추론한 민감한 사실은 저장하지 마세요. 범위가 넓거나 모호한 변경을 하기 전에는 사용자에게 확인하세요.\n',
  );
  const written = await store.update(oldDefault, { expectedRevision: store.snapshot().revision });
  const reopened = await new AgentInstructionsStore({ rootDir }).init();
  assert.equal(reopened.snapshot().content, DEFAULT_AGENT_INSTRUCTIONS);
  assert.equal(reopened.snapshot().revision, written.revision + 1);
  const edited = await reopened.update(`${oldDefault}- 내가 더한 줄\n`, { expectedRevision: reopened.snapshot().revision });
  const again = await new AgentInstructionsStore({ rootDir }).init();
  assert.equal(again.snapshot().content, edited.content);
});
