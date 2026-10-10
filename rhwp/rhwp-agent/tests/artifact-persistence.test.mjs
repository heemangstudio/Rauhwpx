import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

import { ArtifactStore, defaultGeneratedArtifactRoot } from '../artifact-store.mjs';
import { authorizeToolCall } from '../planning-state.mjs';
import { TemplateStore } from '../template-store.mjs';
import { registerCopyLayoutArtifact } from '../template-perfection.mjs';
import { filterToolDefinitions } from '../tools.mjs';

const CFB = await fs.readFile(new URL('../../saved/blank2010.hwp', import.meta.url));
const MCP_SCRIPT = fileURLToPath(new URL('../mcp-stdio.mjs', import.meta.url));
const OWNER = Object.freeze({ threadId: 'thread-owner', documentId: 'doc-1' });
const COPY_LAYOUT_TEMPLATE = Object.freeze({
  kind: 'copy-layout', jobId: 'job-1', quality: 'verified', pageCount: 1, sectionCount: 1, registeredTemplateId: null,
});

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-artifact-persist-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const persistDir = path.join(root, 'generated-artifacts');
  let sequence = 0;
  // 허브를 다시 켜면 세션 작업 폴더도 새로 생긴다. 보관 폴더만 같다.
  const open = (options = {}) => {
    const workDir = path.join(root, `work-${sequence += 1}`);
    return fs.mkdir(workDir, { recursive: true }).then(() => new ArtifactStore({
      rootDir: workDir, persistDir, ...options,
    }));
  };
  const publish = async (store, fileName = '신청서 - Layout.hwp', owner = OWNER) => {
    const source = path.join(store.rootDir, 'out.hwp');
    await fs.writeFile(source, CFB);
    return store.publish({ filePath: source, fileName, owner });
  };
  return { root, persistDir, open, publish };
}

test('generated artifacts survive a hub restart with their owner and template metadata', async (t) => {
  const { open, publish } = await fixture(t);
  const before = await open();
  const published = await publish(before);
  assert.deepEqual(published.owner, OWNER);
  await before.annotate(published.artifactId, { template: COPY_LAYOUT_TEMPLATE });

  const after = await open();
  const described = await after.describe(published.artifactId);
  assert.equal(described.fileName, '신청서 - Layout.hwp');
  assert.equal(described.checksum, published.checksum);
  assert.deepEqual(described.owner, OWNER);
  assert.deepEqual(described.template, COPY_LAYOUT_TEMPLATE);
  const read = await after.read(published.artifactId);
  assert.deepEqual(Buffer.from(read.bytes), CFB);
});

test('missing, legacy and damaged artifacts read as gone', async (t) => {
  const { root, persistDir, open, publish } = await fixture(t);
  const store = await open();
  await assert.rejects(store.describe('artifact_never_published_1234'), { code: 'ARTIFACT_NOT_FOUND' });

  // 이 수정 전처럼 메모리에만 있던 문서는 허브를 다시 켜면 사라진다.
  const legacyRoot = path.join(root, 'legacy');
  await fs.mkdir(legacyRoot);
  const legacy = new ArtifactStore({ rootDir: legacyRoot });
  await fs.writeFile(path.join(legacyRoot, 'out.hwp'), CFB);
  const legacyArtifact = await legacy.publish({ filePath: path.join(legacyRoot, 'out.hwp') });
  await assert.rejects((await open()).read(legacyArtifact.artifactId), { code: 'ARTIFACT_NOT_FOUND' });

  const published = await publish(store);
  const blob = path.join(persistDir, `${published.artifactId}.bin`);
  const damaged = Buffer.from(CFB);
  damaged[damaged.length - 1] ^= 0xff;
  await fs.writeFile(blob, damaged);
  await assert.rejects((await open()).read(published.artifactId), { code: 'ARTIFACT_NOT_FOUND' });
  await fs.rm(blob);
  await assert.rejects((await open()).describe(published.artifactId), { code: 'ARTIFACT_NOT_FOUND' });
});

test('old generated artifacts are pruned from disk', async (t) => {
  const { persistDir, open, publish } = await fixture(t);
  let clock = Date.parse('2026-01-01T00:00:00Z');
  const now = () => clock;
  const old = await publish(await open({ now }));
  clock += 91 * 24 * 60 * 60 * 1000;
  const fresh = await publish(await open({ now }));
  const names = await fs.readdir(persistDir);
  assert.equal(names.some((name) => name.startsWith(old.artifactId)), false);
  assert.equal(names.includes(`${fresh.artifactId}.json`), true);
  assert.equal(names.includes(`${fresh.artifactId}.bin`), true);
});

test('a copy-layout result registers as a template by artifactId after a restart', async (t) => {
  const { root, open, publish } = await fixture(t);
  const templateStore = await new TemplateStore({ rootDir: path.join(root, 'templates') }).init();
  const before = await open();
  const published = await publish(before);
  await before.annotate(published.artifactId, { template: COPY_LAYOUT_TEMPLATE });
  const plain = await publish(before, 'plain.hwp');

  const after = await open();
  const args = { artifactId: published.artifactId };
  await assert.rejects(
    registerCopyLayoutArtifact({ artifactStore: after, templateStore, threadId: 'other-thread', args }),
    { code: 'ARTIFACT_NOT_FOUND' },
  );
  await assert.rejects(
    registerCopyLayoutArtifact({ artifactStore: after, templateStore, threadId: OWNER.threadId, args: { artifactId: plain.artifactId } }),
    { code: 'COPY_LAYOUT_JOB_NOT_READY' },
  );
  // 작업 기록(jobId)은 허브와 함께 사라졌다. 안내 문구가 artifactId를 가리켜야 한다.
  await assert.rejects(
    registerCopyLayoutArtifact({
      artifactStore: after, templateStore, threadId: OWNER.threadId,
      args: { jobId: '00000000-0000-4000-8000-000000000000' },
    }),
    (error) => error.code === 'COPY_LAYOUT_JOB_NOT_FOUND' && /artifactId/.test(error.message),
  );

  const first = await registerCopyLayoutArtifact({ artifactStore: after, templateStore, threadId: OWNER.threadId, args });
  assert.equal(first.alreadyRegistered, false);
  assert.equal(first.template.name, '신청서');
  assert.equal(templateStore.get(first.template.id).pageCount, 1);

  const again = await registerCopyLayoutArtifact({
    artifactStore: await open(), templateStore, threadId: OWNER.threadId, args,
  });
  assert.equal(again.alreadyRegistered, true);
  assert.equal(again.template.id, first.template.id);
});

test('template registration is offered in every root chat mode, including read-only chat', () => {
  for (const profile of ['direct', 'question', 'planning', 'awaiting-approval', 'implementing']) {
    assert.ok(
      filterToolDefinitions(profile).some((definition) => definition.name === 'register_copy_layout_template'),
      profile,
    );
  }
  assert.equal(filterToolDefinitions('copy-layout-worker').some((definition) => definition.name === 'register_copy_layout_template'), false);
  const category = filterToolDefinitions('direct').find((definition) => definition.name === 'register_copy_layout_template').category;
  for (const [workflow, phase] of [['question', null], ['plan', 'planning'], ['direct', null]]) {
    assert.equal(authorizeToolCall({
      category, tool: 'register_copy_layout_template', workflow, phase, expectedEpoch: 1, receivedEpoch: 1,
    }), true);
  }
});

test('MCP resource probes succeed with empty lists', { timeout: 20_000 }, async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [MCP_SCRIPT],
    env: {
      ...process.env,
      RHWP_WS_URL: 'ws://127.0.0.1:9/mcp',
      RHWP_SESSION_ID: 'resource-probe',
      RHWP_AGENT_NAME: 'codex',
      RHWP_TOOL_PROFILE: 'question',
    },
    stderr: 'ignore',
  });
  const client = new Client({ name: 'probe', version: '0.0.0' });
  await client.connect(transport);
  try {
    assert.ok(client.getServerCapabilities()?.resources);
    assert.deepEqual((await client.listResources()).resources, []);
    assert.deepEqual((await client.listResourceTemplates()).resourceTemplates, []);
    await assert.rejects(client.readResource({ uri: 'rhwp://missing' }), /no MCP resources/);
    assert.ok((await client.listTools()).tools.some((tool) => tool.name === 'register_copy_layout_template'));
  } finally {
    await client.close();
  }
});

test('generated artifacts default to app data beside templates', () => {
  assert.equal(
    defaultGeneratedArtifactRoot({}, 'darwin', '/Users/andy'),
    '/Users/andy/Library/Application Support/rhwp/generated-artifacts',
  );
  assert.equal(defaultGeneratedArtifactRoot({ RHWP_ARTIFACTS_DIR: '/tmp/a' }, 'linux', '/home/a'), path.resolve('/tmp/a'));
});
