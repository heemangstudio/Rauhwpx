import test from 'node:test';
import assert from 'node:assert/strict';
import { link, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  NativeFileHandleRegistry,
  sweepStaleNativeSaveHelpers,
  writeNativeFileAtomically,
} from '../desktop/native-file-handles.mjs';
import { DocumentLeaseManager } from '../desktop/document-leases.mjs';

const HOUR_MS = 60 * 60 * 1000;

function cfbBytes(fill) {
  const bytes = new Uint8Array(1536).fill(fill);
  bytes.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
  bytes.set([0xfe, 0xff], 28);
  bytes.set([9, 0], 30);
  return bytes;
}

async function withDirectory(t, run) {
  const directory = await mkdtemp(join(tmpdir(), 'rauhwpx-native-helpers-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return run(directory);
}

/** A later launch: helpers left by a killed save are long untouched by then. */
function laterSweep(filePath, options = {}) {
  return sweepStaleNativeSaveHelpers(filePath, { ...options, now: () => Date.now() + HOUR_MS });
}

async function sortedNames(directory) {
  return (await readdir(directory)).sort();
}

// Helpers a save killed at different points leaves behind, plus files the sweep must keep.
async function plantLeftovers(directory) {
  const stale = [
    'report.hwp.rauhwpx-0123456789ab.tmp',
    'report.hwp.rauhwpx-ba9876543210.link-probe',
    'report.rauhwpx-recovery-00112233aabb.hwp',
  ];
  const kept = [
    'notes.txt',
    'other.hwp.rauhwpx-0123456789ab.tmp',
    'report.hwp.rauhwpx-backup.tmp',
    'report.rauhwpx-recovery-00112233aabb.hwpx',
  ];
  for (const name of [...stale, ...kept]) await writeFile(join(directory, name), cfbBytes(9));
  return { stale, kept };
}

function openRegistry(registry, target) {
  return registry.create('session-a', target).then((opened) => {
    assert.equal(opened.ok, true);
    const handleId = opened.descriptor.handleId;
    const identity = { documentId: 'document-a', sourceDigest: 'blake3:a' };
    const leases = new DocumentLeaseManager();
    const reservation = leases.reserve('session-a', identity, registry.pathForSender('session-a', handleId));
    leases.commit('session-a', reservation.reservationId);
    return (bytes) => registry.write('session-a', handleId, bytes, identity, leases);
  });
}

test('opening and saving a document clears helpers a killed save left beside it', async (t) => {
  await withDirectory(t, async (directory) => {
    const target = join(directory, 'report.hwp');
    await writeFile(target, cfbBytes(1));
    const { stale, kept } = await plantLeftovers(directory);

    // Just written: the helpers may still belong to a save in another process.
    await openRegistry(new NativeFileHandleRegistry(), target);
    assert.deepEqual(await sortedNames(directory), ['report.hwp', ...stale, ...kept].sort());

    const save = await openRegistry(new NativeFileHandleRegistry({ sweepHelpersImpl: laterSweep }), target);
    assert.deepEqual(await sortedNames(directory), ['report.hwp', ...kept].sort());
    assert.deepEqual(new Uint8Array(await readFile(target)), cfbBytes(1));

    // A crash after the open leaves a temp link to the published document.
    const leftover = join(directory, 'report.hwp.rauhwpx-cafef00dbeef.tmp');
    await link(target, leftover);
    await save(cfbBytes(2));
    assert.deepEqual(await sortedNames(directory), ['report.hwp', ...kept].sort());
    assert.deepEqual(new Uint8Array(await readFile(target)), cfbBytes(2));
  });
});

test('the sweep keeps every helper while the document is missing or empty', async (t) => {
  await withDirectory(t, async (directory) => {
    const target = join(directory, 'report.hwp');
    const { stale, kept } = await plantLeftovers(directory);

    assert.deepEqual(await laterSweep(target), []);
    await writeFile(target, new Uint8Array());
    assert.deepEqual(await laterSweep(target), []);
    assert.deepEqual(await sortedNames(directory), ['report.hwp', ...stale, ...kept].sort());
  });
});

test('the sweep never removes the helpers of a save in progress', async (t) => {
  await withDirectory(t, async (directory) => {
    const target = join(directory, 'report.hwp');
    await writeFile(target, cfbBytes(1));
    let sweptDuringSave = null;
    const fingerprint = await writeNativeFileAtomically(target, cfbBytes(2), {
      linkImpl: async (source, destination) => {
        await link(source, destination);
        // The publish link exists, so the target and every helper are on disk.
        if (destination === target) sweptDuringSave = await laterSweep(target);
      },
    });

    assert.equal(fingerprint.state, 'file');
    assert.deepEqual(sweptDuringSave, []);
    assert.deepEqual(await readdir(directory), ['report.hwp']);
    assert.deepEqual(new Uint8Array(await readFile(target)), cfbBytes(2));
  });
});
