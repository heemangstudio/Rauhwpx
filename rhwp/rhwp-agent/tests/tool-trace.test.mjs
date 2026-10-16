import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createBrowserEvidenceWriter, browserEvidenceArgsHash, writeBrowserEvidence } from '../tool-trace.mjs';

function fixture(t, options) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rhwp-browser-evidence-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'snapshots.jsonl');
  const writer = createBrowserEvidenceWriter(file, options);
  t.after(() => writer.close());
  return { dir, file, writer, read: () => fs.readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse) };
}
function row() {
  const args = { tabId: 'tab-1', snapshotId: 'snap-before', navigationEpoch: 2, controllerEpoch: 3, ref: 'e1', text: 'never-store-argument' };
  return { delivered: true, tool: 'browser_click', callId: 'provider-call-1', argsHash: browserEvidenceArgsHash(args), args,
    actor: { sessionId: 'session-1', threadId: 'thread-1', documentId: 'doc-1', agentId: 'thread-1:root', taskId: null, isHuman: false, clientId: 'omit-client', accounts: 'omit-accounts' },
    hub: { seq: 8, clientId: 12, turnId: 'turn-1', agent: 'pi', authorization: 'omit-hub-auth' },
    result: { ok: true, runtime: 'omit-runtime', accounts: ['omit-account'], auth: 'omit-auth', snapshot: {
      snapshotId: 'snap-after', tabId: 'tab-1', navigationEpoch: 2, controllerEpoch: 3,
      url: 'https://example.test/masked', title: '[masked]', text: 'Page [masked]', selectedText: '', truncated: false, compact: true,
      auth: 'omit-snapshot-auth', handles: { e1: 'omit-handle' },
      elements: [{ ref: 'e1', tag: 'input', role: 'textbox', inputType: 'password', name: 'Password', text: '[masked]', value: '[masked]',
        sensitive: true, disabled: false, inViewport: true, autocomplete: 'current-password', formSensitive: true,
        rect: { x: 1, y: 2, width: 3, height: 4, raw: 'omit-geometry' }, raw: 'omit-element-raw', account: 'omit-element-account' }],
    } } };
}

test('argument hashes are canonical JSON SHA256 without storing argument text', () => {
  assert.equal(browserEvidenceArgsHash({ b: [2, { y: 4, x: 3 }], a: 1 }), browserEvidenceArgsHash({ a: 1, b: [2, { x: 3, y: 4 }] }));
  assert.equal(browserEvidenceArgsHash({}), '44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a');
  assert.notEqual(browserEvidenceArgsHash({ a: [1, 2] }), browserEvidenceArgsHash({ a: [2, 1] }));
  const cyclic = {}; cyclic.self = cyclic;
  assert.equal(browserEvidenceArgsHash(cyclic), null);
  assert.equal(browserEvidenceArgsHash({ value: Infinity }), null);
});

test('disabled capture and failed delivery/result never create a file', t => {
  const f = fixture(t);
  assert.equal(createBrowserEvidenceWriter(null).write(row()).status, 'skipped');
  for (const change of [{ delivered: false }, { result: { ok: false, snapshot: row().result.snapshot } }, { result: { ok: true } }, { actor: { ...row().actor, isHuman: true } }, { actor: { ...row().actor, taskId: 'worker', agentId: 'thread-1:task:worker' } }]) {
    assert.equal(f.writer.write({ ...row(), ...change }).status, 'skipped');
  }
  assert.equal(fs.existsSync(f.file), false);
  const previous = process.env.RHWP_BROWSER_BENCH_EVIDENCE_FILE;
  delete process.env.RHWP_BROWSER_BENCH_EVIDENCE_FILE;
  try { assert.equal(writeBrowserEvidence(row()).status, 'skipped'); }
  finally { if (previous !== undefined) process.env.RHWP_BROWSER_BENCH_EVIDENCE_FILE = previous; }
});

test('successful delivered snapshots preserve masked DTOs and omit all nonwhitelisted data', t => {
  const f = fixture(t), source = row();
  assert.deepEqual(f.writer.write(source), { status: 'written' });
  const [saved] = f.read();
  assert.equal(saved.schema, 1); assert.equal(saved.kind, 'browser-snapshot');
  assert.equal(saved.callId, source.callId); assert.equal(saved.argsHash, source.argsHash);
  assert.deepEqual(saved.hub, { seq: 8, clientId: 12, turnId: 'turn-1', agent: 'pi' }); assert.ok(Number.isFinite(saved.t));
  assert.deepEqual(saved.actor, { sessionId: 'session-1', threadId: 'thread-1', documentId: 'doc-1', agentId: 'thread-1:root', taskId: null, isHuman: false });
  assert.deepEqual(saved.args, { tabId: 'tab-1', snapshotId: 'snap-before', ref: 'e1', navigationEpoch: 2, controllerEpoch: 3 });
  assert.equal(saved.snapshot.text, source.result.snapshot.text);
  assert.equal(saved.snapshot.elements[0].value, '[masked]');
  assert.deepEqual(saved.snapshot.elements[0].rect, { x: 1, y: 2, width: 3, height: 4 });
  const raw = fs.readFileSync(f.file, 'utf8');
  assert.doesNotMatch(raw, /omit-|never-store-argument/);
  assert.equal(fs.statSync(f.file).mode & 0o777, 0o600);
  assert.deepEqual(source.result.snapshot.elements[0].rect, { x: 1, y: 2, width: 3, height: 4, raw: 'omit-geometry' });
});

test('ambiguous call identity and invalid snapshot record bounded capture errors', t => {
  const f = fixture(t);
  assert.deepEqual(f.writer.write({ ...row(), callId: null }), { status: 'error', code: 'missing-call-identity', recorded: true });
  assert.equal(f.writer.write(row()).code, 'capture-stopped');
  const g = fixture(t);
  const invalid = row(); invalid.result.snapshot.navigationEpoch = -1;
  assert.equal(g.writer.write(invalid).code, 'invalid-snapshot');
  const records = [...f.read(), ...g.read()];
  assert.equal(records.length, 2);
  for (const saved of records) {
    assert.equal(saved.kind, 'browser-snapshot-capture-error');
    assert.equal(saved.actor.sessionId, 'session-1'); assert.equal(saved.hub.turnId, 'turn-1');
    assert.equal('snapshot' in saved, false);
  }
});

test('snapshot and total byte caps retain an error marker when space permits', t => {
  const f = fixture(t, { maxSnapshotBytes: 100, maxTotalBytes: 4096 });
  assert.equal(f.writer.write(row()).code, 'snapshot-limit');
  assert.equal(f.read()[0].code, 'snapshot-limit');

  const sample = row(); sample.result.snapshot.text = 'x'.repeat(70000);
  const g = fixture(t, { maxSnapshotBytes: 100000, maxTotalBytes: 160000 });
  assert.equal(g.writer.write(sample).status, 'written');
  const overflow = g.writer.write(sample);
  assert.deepEqual(overflow, { status: 'error', code: 'total-limit', recorded: true });
  assert.equal(g.read()[1].code, 'total-limit');
  assert.ok(fs.statSync(g.file).size <= 160000);
  const finalSize = fs.statSync(g.file).size;
  for (let i = 0; i < 10; i++) assert.equal(g.writer.write(sample).code, 'capture-stopped');
  assert.equal(fs.statSync(g.file).size, finalSize);

  const h = fixture(t, { maxTotalBytes: 70000 });
  assert.equal(h.writer.write(row()).status, 'written');
  const longIdentity = row(), escaped = '"'.repeat(1024);
  for (const key of ['sessionId', 'threadId', 'documentId']) longIdentity.actor[key] = escaped;
  longIdentity.actor.agentId = '"'.repeat(1019) + ':root';
  longIdentity.callId = escaped; longIdentity.tool = escaped;
  longIdentity.hub.turnId = escaped; longIdentity.hub.agent = escaped;
  assert.deepEqual(h.writer.write(longIdentity), { status: 'error', code: 'total-limit', recorded: true });
  assert.equal(h.read()[1].callId, escaped);
  assert.ok(fs.statSync(h.file).size <= 70000);
});

test('exclusive no-follow output cannot overwrite existing files or symlink targets', t => {
  const f = fixture(t);
  fs.writeFileSync(f.file, 'existing-private-data');
  assert.equal(f.writer.write(row()).status, 'error');
  assert.equal(fs.readFileSync(f.file, 'utf8'), 'existing-private-data');
  const target = path.join(f.dir, 'target'); fs.writeFileSync(target, 'private-target');
  const link = path.join(f.dir, 'link'); fs.symlinkSync(target, link);
  const writer = createBrowserEvidenceWriter(link); t.after(() => writer.close());
  assert.equal(writer.write(row()).status, 'error');
  assert.equal(fs.readFileSync(target, 'utf8'), 'private-target');
  assert.equal(fs.lstatSync(link).isSymbolicLink(), true);
});

test('unavailable output, invalid limits, and closed writers fail without throwing', t => {
  const f = fixture(t);
  const unavailable = createBrowserEvidenceWriter(path.join(f.dir, 'missing', 'evidence'));
  assert.equal(unavailable.write(row()).status, 'error');
  assert.equal(unavailable.write(row()).status, 'error');
  assert.equal(createBrowserEvidenceWriter(f.file, { maxTotalBytes: -1 }).write(row()).status, 'error');
  f.writer.close(); assert.equal(f.writer.write(row()).status, 'error');
  assert.equal(fs.existsSync(f.file), false);
});

test('a synchronous write error disables further capture without escaping to the tool caller', t => {
  const f = fixture(t);
  assert.equal(f.writer.write(row()).status, 'written');
  let attempts = 0;
  const original = fs.writeSync;
  const mocked = t.mock.method(fs, 'writeSync', (...args) => {
    if (Buffer.isBuffer(args[1]) && args[1].toString().includes('"kind":"browser-snapshot"')) {
      attempts++; throw Object.assign(new Error('fixture disk failure'), { code: 'EIO' });
    }
    return original(...args);
  });
  try {
    assert.deepEqual(f.writer.write(row()), { status: 'error', code: 'write-failed' });
    assert.deepEqual(f.writer.write(row()), { status: 'error', code: 'writer-unavailable' });
    assert.equal(attempts, 1);
  } finally { mocked.mock.restore(); }
  assert.equal(f.read().length, 1, 'the earlier valid record survives, so the caller must retain the later error status');
  assert.equal(f.read()[0].callId, 'provider-call-1');
});
