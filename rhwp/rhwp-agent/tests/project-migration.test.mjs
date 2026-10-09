import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { ProjectStore } from '../project-store.mjs';
import { createReferenceCatalog } from '../reference-catalog.mjs';
import { ReferenceStore, scopesForReferenceSession } from '../reference-store.mjs';
import { ReferenceStore as V1ReferenceStore } from './fixtures/reference-store-v1.mjs';

async function tempDir(t, label) {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), `rhwp-${label}-`));
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  return parent;
}

/** 새 빌드의 부팅 순서: 두 저장소 → 프로젝트 → 문서 이주 → 복구. */
async function bootNewBuild(referencesRoot, projectsRoot) {
  const catalog = await createReferenceCatalog({ referencesRoot, projectsRoot }).init();
  const projects = await new ProjectStore({ root: projectsRoot, referenceStore: catalog }).init();
  await projects.migrateDocumentReferences();
  await projects.repairReferences();
  return { catalog, projects };
}

test('the last v1 build still boots on references/ after the new build migrated and added files', async (t) => {
  const parent = await tempDir(t, 'reference-downgrade');
  const referencesRoot = path.join(parent, 'references');
  const projectsRoot = path.join(parent, 'projects');

  // 옛 빌드가 남긴 자료.
  const v1 = await new V1ReferenceStore({ root: referencesRoot }).init();
  const documentFile = await v1.addBuffer({ scope: 'document', scopeId: 'doc-old', name: '지침.txt', bytes: Buffer.from('문서 범위 지침 본문') });
  const chatFile = await v1.addBuffer({ scope: 'chat', scopeId: 'chat-old', name: '메모.txt', bytes: Buffer.from('채팅 범위 메모 본문') });
  const metadataBefore = await fs.readFile(path.join(referencesRoot, 'metadata.json'), 'utf8');

  const { catalog, projects } = await bootNewBuild(referencesRoot, projectsRoot);
  const projectId = projects.projectIdForDocument('doc-old');
  assert.ok(projectId);
  assert.equal(await projects.migrateChatReferences('chat-old', projectId), 1);
  const items = (await projects.get(projectId)).items;
  assert.deepEqual(items.map((item) => item.fileId).sort(), [documentFile.id, chatFile.id].sort());
  // 새 빌드에서는 옮긴 기록이 legacy 범위에서 사라지고, 같은 id 로 프로젝트에서 읽힌다.
  assert.deepEqual(catalog.list({ scope: 'document', scopeId: 'doc-old' }), []);
  const scopes = scopesForReferenceSession({ threadId: 'chat-old', documentId: 'doc-old', projectId });
  assert.match((await catalog.readChunk({ fileId: documentFile.id, chunkId: 'c0', scopes })).text, /지침 본문/);
  // 이주는 references/metadata.json 을 건드리지 않는다.
  assert.equal(await fs.readFile(path.join(referencesRoot, 'metadata.json'), 'utf8'), metadataBefore);

  // 새 빌드가 공용 자료를 더해도 옛 형식으로 쓴다.
  const globalFile = await catalog.addBuffer({ scope: 'global', name: '공용.txt', bytes: Buffer.from('공용 자료 본문') });
  assert.equal(JSON.parse(await fs.readFile(path.join(referencesRoot, 'metadata.json'), 'utf8')).schemaVersion, 1);
  assert.deepEqual((await fs.readdir(referencesRoot)).sort(), ['blobs', 'metadata.json', 'objects', 'staging']);

  // 옛 빌드로 돌아가도 부팅되고, 옛 자료와 새 공용 자료가 모두 읽힌다.
  const downgraded = await new V1ReferenceStore({ root: referencesRoot }).init();
  const all = [
    { scope: 'global', scopeId: 'global' },
    { scope: 'document', scopeId: 'doc-old' },
    { scope: 'chat', scopeId: 'chat-old' },
  ];
  assert.deepEqual(downgraded.listAccessible(all).map((file) => file.id).sort(), [documentFile.id, chatFile.id, globalFile.id].sort());
  for (const file of [documentFile, chatFile, globalFile]) {
    assert.ok((await downgraded.readChunk({ fileId: file.id, chunkId: 'c0', scopes: all })).text.length > 0);
  }
  assert.equal(downgraded.quarantinedUploads.size, 0);
});

test('migration lives entirely in the projects folder it writes to', async (t) => {
  const parent = await tempDir(t, 'reference-migration-isolated');
  const referencesRoot = path.join(parent, 'references');
  const v1 = await new V1ReferenceStore({ root: referencesRoot }).init();
  const documentFile = await v1.addBuffer({ scope: 'document', scopeId: 'doc-shared', name: 'a.txt', bytes: Buffer.from('공유 본문') });
  const metadataBefore = await fs.readFile(path.join(referencesRoot, 'metadata.json'), 'utf8');

  // 진짜 references/ 와 임시 프로젝트 폴더가 섞인 개발 허브 — 임시 폴더를 지워도 진짜 자료는 그대로다.
  const temporary = path.join(parent, 'temp-projects');
  const first = await bootNewBuild(referencesRoot, temporary);
  assert.equal((await first.projects.get(first.projects.projectIdForDocument('doc-shared'))).items.length, 1);
  await fs.rm(temporary, { recursive: true, force: true });

  const real = await bootNewBuild(referencesRoot, path.join(parent, 'projects'));
  const projectId = real.projects.projectIdForDocument('doc-shared');
  assert.equal((await real.projects.get(projectId)).items[0].fileId, documentFile.id);
  assert.equal(await fs.readFile(path.join(referencesRoot, 'metadata.json'), 'utf8'), metadataBefore);
  await assert.rejects(
    real.projects.adoptReferences('pzzzzzzzzzz', [documentFile]),
    (error) => error.code === 'PROJECT_NOT_FOUND',
  );
});

test('an accidental v2 references/metadata.json is split back to v1 and its project files are recovered', async (t) => {
  const parent = await tempDir(t, 'reference-interim');
  const referencesRoot = path.join(parent, 'references');
  const v1 = await new V1ReferenceStore({ root: referencesRoot }).init();
  const kept = await v1.addBuffer({ scope: 'global', name: '공용.txt', bytes: Buffer.from('남는 공용 본문') });
  const moved = await v1.addBuffer({ scope: 'document', scopeId: 'doc-x', name: '옮겨진.txt', bytes: Buffer.from('옮겨진 본문') });
  // 잠시 쓰였던 빌드가 남긴 모양: 문서 기록이 project 범위로 바뀐 schemaVersion 2.
  const metadataPath = path.join(referencesRoot, 'metadata.json');
  const v1Metadata = JSON.parse(await fs.readFile(metadataPath, 'utf8'));
  const lostProject = 'pabcdefghij';
  await fs.writeFile(metadataPath, `${JSON.stringify({
    schemaVersion: 2,
    files: v1Metadata.files.map((file) => (file.id === moved.id ? { ...file, scope: 'project', scopeId: lostProject } : file)),
    aliases: {},
  })}\n`);

  const { catalog, projects } = await bootNewBuild(referencesRoot, path.join(parent, 'projects'));
  const legacy = JSON.parse(await fs.readFile(metadataPath, 'utf8'));
  assert.equal(legacy.schemaVersion, 1);
  assert.deepEqual(legacy.files.map((file) => file.id), [kept.id]);
  assert.equal(catalog.getFile(moved.id).scopeId, lostProject);
  const recovered = await projects.get(lostProject);
  assert.equal(recovered.name, '복구된 자료');
  assert.deepEqual(recovered.items.map((item) => item.fileId), [moved.id]);

  const downgraded = await new V1ReferenceStore({ root: referencesRoot }).init();
  assert.deepEqual(downgraded.list({ scope: 'global' }).map((file) => file.id), [kept.id]);
});

test('objects from an older text version are re-extracted beside, never rewritten', async (t) => {
  const parent = await tempDir(t, 'reference-text-version');
  const referencesRoot = path.join(parent, 'references');
  const v1 = await new V1ReferenceStore({ root: referencesRoot }).init();
  const file = await v1.addBuffer({ scope: 'global', name: 'join.txt', bytes: Buffer.from('hello world from the new join') });
  // 옛 추출이 다르게 이어 붙인 글을 흉내 낸다(같은 길이라 기록 개수와 맞는다).
  const objectPath = path.join(referencesRoot, 'objects', `${file.sha256}.json`);
  const object = JSON.parse(await fs.readFile(objectPath, 'utf8'));
  object.chunks[0].text = object.chunks[0].text.replace('hello', 'HELLO');
  await fs.writeFile(objectPath, `${JSON.stringify(object)}\n`);
  const objectBefore = await fs.readFile(objectPath, 'utf8');
  const metadataBefore = await fs.readFile(path.join(referencesRoot, 'metadata.json'), 'utf8');

  const { catalog } = await bootNewBuild(referencesRoot, path.join(parent, 'projects'));
  const scopes = [{ scope: 'global', scopeId: 'global' }];
  assert.match((await catalog.readChunk({ fileId: file.id, chunkId: 'c0', scopes })).text, /^HELLO/);
  await catalog.settleUpgrades();
  assert.match((await catalog.readChunk({ fileId: file.id, chunkId: 'c0', scopes })).text, /^hello/);
  await catalog.activateScopes(scopes);
  assert.equal(catalog.search({ query: 'hello', scopes })[0].fileId, file.id);

  assert.equal(await fs.readFile(objectPath, 'utf8'), objectBefore);
  assert.equal(await fs.readFile(path.join(referencesRoot, 'metadata.json'), 'utf8'), metadataBefore);
  assert.deepEqual(await fs.readdir(path.join(referencesRoot, 'objects')), [`${file.sha256}.json`]);
  const downgraded = await new V1ReferenceStore({ root: referencesRoot }).init();
  assert.match((await downgraded.readChunk({ fileId: file.id, chunkId: 'c0', scopes })).text, /^HELLO/);
});

test('project files deduplicate by content, keep old ids as aliases, and coalesce metadata commits', async (t) => {
  const parent = await tempDir(t, 'reference-project-files');
  let writes = 0;
  let failNext = false;
  const persistMetadata = async (file, value) => {
    writes += 1;
    await new Promise((resolve) => setTimeout(resolve, 20));
    if (failNext) {
      failNext = false;
      throw Object.assign(new Error('simulated disk failure'), { code: 'EIO' });
    }
    await fs.writeFile(file, `${JSON.stringify(value)}\n`);
  };
  const store = await new ReferenceStore({ format: 'project', root: path.join(parent, 'files'), persistMetadata }).init();
  const first = 'pqrstuvwxyz';
  const second = 'pabcdefghij';
  writes = 0;
  const added = await Promise.all(Array.from({ length: 6 }, (_, index) => store.addBuffer({
    scope: 'project', scopeId: first, name: `f${index}.txt`, bytes: Buffer.from(`본문 ${index}`),
  })));
  assert.ok(writes < 6, `expected coalesced metadata writes, got ${writes}`);
  assert.equal(JSON.parse(await fs.readFile(store.metadataPath, 'utf8')).files.length, 6);

  const kept = await store.addBuffer({ scope: 'project', scopeId: second, name: 'same.txt', bytes: Buffer.from('본문 0') });
  const merged = await store.rescope({ fileId: added[0].id, to: { scope: 'project', scopeId: second } });
  assert.equal(merged.id, kept.id);
  assert.equal(merged.aliasedFrom, added[0].id);
  assert.equal(store.getFile(added[0].id).id, kept.id);

  failNext = true;
  await assert.rejects(
    store.addBuffer({ scope: 'project', scopeId: first, name: 'lost.txt', bytes: Buffer.from('사라질 본문') }),
    /simulated disk failure/,
  );
  assert.equal(store.list({ scope: 'project', scopeId: first }).length, 5);
  await assert.rejects(
    store.addBuffer({ scope: 'global', name: 'x.txt', bytes: Buffer.from('x') }),
    (error) => error.code === 'REFERENCE_SCOPE_INVALID',
  );
});
