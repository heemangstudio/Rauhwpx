import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { AgentInstructionsStore } from '../agent-instructions.mjs';
import { hubDataBase, importRebrandedHubData } from '../rebrand-import.mjs';
import { ReferenceStore } from '../reference-store.mjs';
import { TemplateStore } from '../template-store.mjs';

const HWP = Buffer.concat([
  Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]),
  Buffer.from('test-template'),
]);

async function fixture(t) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-rebrand-import-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const env = { APPDATA: home, XDG_DATA_HOME: home };
  const base = hubDataBase(env, process.platform, home);
  return {
    env,
    home,
    source: (name) => path.join(base, 'hamaeditor', name),
    target: (name) => path.join(base, 'rhwp', name),
    run: (options = {}) => importRebrandedHubData({ env, home, ...options }),
  };
}

async function write(file, content) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content);
}

test('2.0.11 hub data joins the original folders and stays readable by the real stores', async (t) => {
  const data = await fixture(t);
  // 2.0.10 data already in the original folders.
  await (await new TemplateStore({ rootDir: data.target('templates') }).init()).add({
    name: '월간 보고서', originalName: 'a.hwp', bytes: HWP, format: 'hwp', pageCount: 1, sectionCount: 1,
  });
  await (await new ReferenceStore({ root: data.target('references') }).init()).addBuffer({
    scope: 'global', name: 'old.txt', mimeType: 'text/plain', bytes: Buffer.from('2.0.10 note'),
  });
  await new AgentInstructionsStore({ rootDir: data.target('agent-instructions') }).init();
  await write(path.join(data.target('usage'), 'events.jsonl'), '{"ts":1,"agent":"claude"}\n');

  // What 2.0.11 wrote during its day.
  await (await new TemplateStore({ rootDir: data.source('templates') }).init()).add({
    name: '월간 보고서', originalName: 'b.hwp', bytes: HWP, format: 'hwp', pageCount: 1, sectionCount: 1,
  });
  await (await new ReferenceStore({ root: data.source('references') }).init()).addBuffer({
    scope: 'global', name: 'new.txt', mimeType: 'text/plain', bytes: Buffer.from('2.0.11 note'),
  });
  const instructions = await new AgentInstructionsStore({ rootDir: data.source('agent-instructions') }).init();
  await instructions.update('항상 존댓말로 답하세요.', { expectedRevision: instructions.revision });
  await write(path.join(data.source('skills'), 'meeting-notes', 'SKILL.md'), '---\nname: meeting-notes\n---\n');
  await write(path.join(data.source('skills'), 'meeting-notes', '.hamaeditor-origin.json'), '{"source":"app"}');
  await write(path.join(data.source('usage'), 'events.jsonl'), '{"ts":1,"agent":"claude"}\n{"ts":2,"agent":"codex"}\n');
  await write(path.join(data.source('writing-style'), 'style.md'), '짧게 쓴다.');
  await write(path.join(data.source('writing-style'), 'metadata.json'), '{"updatedAt":"2026-10-09T00:00:00.000Z"}');

  await data.run();

  const { templates } = (await new TemplateStore({ rootDir: data.target('templates') }).init()).list();
  assert.deepEqual(templates.map((template) => template.name).sort(), ['월간 보고서', '월간 보고서 (2)']);
  const references = (await new ReferenceStore({ root: data.target('references') }).init())
    .list({ scope: 'global' }).map((file) => file.name).sort();
  assert.deepEqual(references, ['new.txt', 'old.txt']);
  const merged = await new AgentInstructionsStore({ rootDir: data.target('agent-instructions') }).init();
  assert.equal(merged.content.trim(), '항상 존댓말로 답하세요.');
  assert.ok(merged.revision > 1, 'a changed file gets a new revision so stale drafts are refused');
  const skill = await fs.readdir(path.join(data.target('skills'), 'meeting-notes'));
  assert.deepEqual(skill.sort(), ['.rhwp-origin.json', 'SKILL.md'], 'imported app skills stay editable');
  assert.equal(
    await fs.readFile(path.join(data.target('usage'), 'events.jsonl'), 'utf8'),
    '{"ts":1,"agent":"claude"}\n{"ts":2,"agent":"codex"}\n',
  );
  assert.equal(await fs.readFile(path.join(data.target('writing-style'), 'style.md'), 'utf8'), '짧게 쓴다.');

  // The 2.0.11 folders stay, and a skill deleted after the import does not come back.
  await fs.rm(path.join(data.target('skills'), 'meeting-notes'), { recursive: true });
  assert.deepEqual(await data.run(), {});
  await assert.rejects(fs.stat(path.join(data.target('skills'), 'meeting-notes')), { code: 'ENOENT' });
  await fs.stat(path.join(data.source('skills'), 'meeting-notes', 'SKILL.md'));
});

test('a merge the real store would refuse is rolled back so the hub still starts', async (t) => {
  const data = await fixture(t);
  await (await new ReferenceStore({ root: data.target('references') }).init()).addBuffer({
    scope: 'global', name: 'old.txt', mimeType: 'text/plain', bytes: Buffer.from('2.0.10 note'),
  });
  await (await new ReferenceStore({ root: data.source('references') }).init()).addBuffer({
    scope: 'global', name: 'new.txt', mimeType: 'text/plain', bytes: Buffer.from('2.0.11 note'),
  });
  const before = await fs.readFile(path.join(data.target('references'), 'metadata.json'), 'utf8');
  const blobsBefore = await fs.readdir(path.join(data.target('references'), 'blobs'));

  const result = await data.run({
    validators: {
      references: async (root) => { await new ReferenceStore({ root, maxGlobalFiles: 1 }).init(); },
    },
  });

  assert.match(result.references.error, /reference files/);
  assert.equal(await fs.readFile(path.join(data.target('references'), 'metadata.json'), 'utf8'), before);
  assert.deepEqual(await fs.readdir(path.join(data.target('references'), 'blobs')), blobsBefore);
  const reopened = await new ReferenceStore({ root: data.target('references') }).init();
  assert.deepEqual(reopened.list({ scope: 'global' }).map((file) => file.name), ['old.txt']);
});

test('a folder the user pointed elsewhere is left alone', async (t) => {
  const data = await fixture(t);
  await write(path.join(data.source('skills'), 'meeting-notes', 'SKILL.md'), '---\nname: meeting-notes\n---\n');
  await importRebrandedHubData({ env: { ...data.env, RHWP_SKILLS_DIR: '/elsewhere' }, home: data.home });
  await assert.rejects(fs.stat(data.target('skills')), { code: 'ENOENT' });
});
