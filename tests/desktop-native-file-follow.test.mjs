import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  NATIVE_FILE_CONFLICT_CODE,
  NATIVE_FILE_MISSING_CODE,
  NATIVE_FILE_MOVED_INTO_OPEN_CODE,
  NATIVE_FILE_UNAVAILABLE_CODE,
  NativeFileHandleRegistry,
  nativePathOwnershipKey,
  parseWindowsFileIdLookupOutput,
} from '../desktop/native-file-handles.mjs';
import { DocumentLeaseManager } from '../desktop/document-leases.mjs';

// Saves must keep landing in the file the user is editing after Explorer (or
// another program) renames or moves it, and must never recreate the old name
// or write into a different file.

const windowsOnly = { skip: process.platform !== 'win32' };

function cfbBytes(fill) {
  const bytes = new Uint8Array(1536).fill(fill);
  bytes.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
  bytes.set([0xfe, 0xff], 28);
  bytes.set([9, 0], 30);
  return bytes;
}

async function withDirectory(t, run) {
  const directory = await mkdtemp(join(tmpdir(), 'rauhwpx-follow-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return run(directory);
}

/** A registry wired the way desktop/main.mjs wires it. */
function desktop(options = {}) {
  const leases = new DocumentLeaseManager();
  const moved = [];
  const registry = new NativeFileHandleRegistry({
    moveLeases: (moves) => leases.movePaths(moves),
    onEntriesMoved: (moves, { reason }) => moved.push(...moves.map((move) => ({ ...move, reason }))),
    ...options,
  });
  return { registry, leases, moved };
}

/** Opens a document in a window and saves it the way the IPC handler does. */
async function openDocument({ registry, leases }, sessionId, filePath, documentId = `${sessionId}-document`) {
  const opened = await registry.create(sessionId, filePath);
  assert.equal(opened.ok, true);
  const handleId = opened.descriptor.handleId;
  const identity = { documentId, sourceDigest: `blake3:${documentId}` };
  const reservation = leases.reserve(sessionId, identity, registry.pathForSender(sessionId, handleId));
  leases.commit(sessionId, reservation.reservationId);
  return {
    handleId,
    save: (bytes) => registry.write(sessionId, handleId, bytes, identity, leases),
    path: () => registry.sourcePathForSender(sessionId, handleId),
  };
}

test('a document renamed in Explorer saves into the renamed file, not a new file under the old name', async (t) => {
  await withDirectory(t, async (directory) => {
    const original = join(directory, 'report.hwp');
    await writeFile(original, cfbBytes(1));
    const app = desktop();
    const document = await openDocument(app, 'window-a', original);

    const renamed = join(directory, '최종 보고서.hwp');
    await rename(original, renamed);
    const saved = await document.save(cfbBytes(2));

    assert.equal(saved.name, '최종 보고서.hwp');
    assert.deepEqual(await readdir(directory), ['최종 보고서.hwp']);
    assert.deepEqual(await readFile(renamed), Buffer.from(cfbBytes(2)));
    assert.equal(document.path(), renamed);
    // The window keeps its claim on the document under the new name.
    assert.equal(app.leases.ownerForPath(nativePathOwnershipKey(renamed)), 'window-a');
    assert.equal(app.leases.ownerForPath(nativePathOwnershipKey(original)), null);
    assert.deepEqual(app.moved.map(({ reason, name }) => ({ reason, name })), [{ reason: 'followed', name: '최종 보고서.hwp' }]);

    await document.save(cfbBytes(3));
    assert.deepEqual(await readFile(renamed), Buffer.from(cfbBytes(3)));
  });
});

test('a rename that only changes letter case survives the next save', async (t) => {
  await withDirectory(t, async (directory) => {
    const original = join(directory, 'report.hwp');
    await writeFile(original, cfbBytes(1));
    const app = desktop();
    const document = await openDocument(app, 'window-a', original);

    await rename(original, join(directory, 'Report.hwp'));
    const saved = await document.save(cfbBytes(2));

    assert.equal(saved.name, 'Report.hwp');
    assert.deepEqual(await readdir(directory), ['Report.hwp']);
    assert.deepEqual(await readFile(join(directory, 'Report.hwp')), Buffer.from(cfbBytes(2)));
  });
});

test('renaming a document right after a save is not mistaken for an outside change', windowsOnly, async (t) => {
  await withDirectory(t, async (directory) => {
    const original = join(directory, 'report.hwp');
    await writeFile(original, cfbBytes(1));
    const app = desktop();
    const document = await openDocument(app, 'window-a', original);

    // The save briefly removes the name, so Windows name tunneling hands the
    // next file renamed onto it the old creation time.
    await document.save(cfbBytes(2));
    await rename(original, join(directory, 'Report.hwp'));
    await document.save(cfbBytes(3));

    assert.deepEqual(await readdir(directory), ['Report.hwp']);
    assert.deepEqual(await readFile(join(directory, 'Report.hwp')), Buffer.from(cfbBytes(3)));
  });
});

test('a document whose folder was renamed saves into the renamed folder', async (t) => {
  await withDirectory(t, async (directory) => {
    await mkdir(join(directory, '2025'));
    const original = join(directory, '2025', 'report.hwp');
    await writeFile(original, cfbBytes(1));
    const app = desktop();
    const document = await openDocument(app, 'window-a', original);

    await rename(join(directory, '2025'), join(directory, '2025 final'));
    await document.save(cfbBytes(2));

    assert.deepEqual((await readdir(directory)).sort(), ['2025 final']);
    assert.deepEqual(await readFile(join(directory, '2025 final', 'report.hwp')), Buffer.from(cfbBytes(2)));
  });
});

test('a document moved to another folder on the same drive is found by its file id', windowsOnly, async (t) => {
  await withDirectory(t, async (directory) => {
    await mkdir(join(directory, 'inbox'));
    await mkdir(join(directory, 'projects', 'q4'), { recursive: true });
    const original = join(directory, 'inbox', '보고서.hwp');
    await writeFile(original, cfbBytes(1));
    const app = desktop();
    const document = await openDocument(app, 'window-a', original);

    const moved = join(directory, 'projects', 'q4', '보고서 (최종) ①.hwp');
    await rename(original, moved);
    const saved = await document.save(cfbBytes(2));

    assert.equal(saved.name, '보고서 (최종) ①.hwp');
    assert.deepEqual(await readdir(join(directory, 'inbox')), []);
    assert.deepEqual(await readFile(moved), Buffer.from(cfbBytes(2)));
  });
});

test('a renamed document is followed even after a new file takes its old name, and that file is left alone', async (t) => {
  await withDirectory(t, async (directory) => {
    const original = join(directory, 'report.hwp');
    await writeFile(original, cfbBytes(1));
    const app = desktop();
    const document = await openDocument(app, 'window-a', original);

    const renamed = join(directory, 'report (old).hwp');
    await rename(original, renamed);
    await writeFile(original, cfbBytes(7));
    await document.save(cfbBytes(2));

    assert.deepEqual(await readFile(renamed), Buffer.from(cfbBytes(2)));
    assert.deepEqual(await readFile(original), Buffer.from(cfbBytes(7)));
  });
});

test('a deleted document is reported missing; nothing is written under its name or into a copy', async (t) => {
  await withDirectory(t, async (directory) => {
    const original = join(directory, 'report.hwp');
    await writeFile(original, cfbBytes(1));
    const app = desktop();
    const document = await openDocument(app, 'window-a', original);

    const copy = join(directory, 'report - copy.hwp');
    await copyFile(original, copy);
    await rm(original);
    await assert.rejects(document.save(cfbBytes(2)), { code: NATIVE_FILE_MISSING_CODE });

    assert.deepEqual(await readdir(directory), ['report - copy.hwp']);
    assert.deepEqual(await readFile(copy), Buffer.from(cfbBytes(1)));
  });
});

test('a document on an unplugged drive is reported unavailable, not deleted', async (t) => {
  await withDirectory(t, async (directory) => {
    await mkdir(join(directory, 'usb', '과제'), { recursive: true });
    const original = join(directory, 'usb', '과제', 'report.hwp');
    await writeFile(original, cfbBytes(1));
    const app = desktop();
    const document = await openDocument(app, 'window-a', original);

    await rm(join(directory, 'usb'), { recursive: true });
    await assert.rejects(document.save(cfbBytes(2)), { code: NATIVE_FILE_UNAVAILABLE_CODE });
    assert.deepEqual(await app.registry.locate('window-a', document.handleId), { name: 'report.hwp', state: 'unavailable' });
    assert.deepEqual(await readdir(directory), []);
  });
});

test('a document moved into the Recycle Bin is not followed there', windowsOnly, async (t) => {
  await withDirectory(t, async (directory) => {
    const original = join(directory, 'report.hwp');
    await writeFile(original, cfbBytes(1));
    const app = desktop();
    const document = await openDocument(app, 'window-a', original);

    const bin = join(directory, '$Recycle.Bin', 'S-1-5-21-test');
    await mkdir(bin, { recursive: true });
    await rename(original, join(bin, '$R0A1B2C.hwp'));
    await assert.rejects(document.save(cfbBytes(2)), { code: NATIVE_FILE_MISSING_CODE });
    assert.deepEqual(await readFile(join(bin, '$R0A1B2C.hwp')), Buffer.from(cfbBytes(1)));
  });
});

test('a renamed document another program changed is followed but not overwritten', async (t) => {
  await withDirectory(t, async (directory) => {
    const original = join(directory, 'report.hwp');
    await writeFile(original, cfbBytes(1));
    const app = desktop();
    const document = await openDocument(app, 'window-a', original);

    const renamed = join(directory, 'report v2.hwp');
    await rename(original, renamed);
    await writeFile(renamed, cfbBytes(5));
    await assert.rejects(document.save(cfbBytes(2)), { code: NATIVE_FILE_CONFLICT_CODE });

    assert.deepEqual(await readFile(renamed), Buffer.from(cfbBytes(5)));
    assert.equal(document.path(), renamed);
  });
});

test('two open documents whose names were swapped each save into their own file', async (t) => {
  await withDirectory(t, async (directory) => {
    const first = join(directory, 'a.hwp');
    const second = join(directory, 'b.hwp');
    await writeFile(first, cfbBytes(1));
    await writeFile(second, cfbBytes(2));
    const app = desktop();
    const documentA = await openDocument(app, 'window-a', first);
    const documentB = await openDocument(app, 'window-b', second);

    await rename(first, join(directory, 'swap.hwp'));
    await rename(second, first);
    await rename(join(directory, 'swap.hwp'), second);

    await documentA.save(cfbBytes(11));
    assert.deepEqual(await readFile(second), Buffer.from(cfbBytes(11)));
    assert.deepEqual(await readFile(first), Buffer.from(cfbBytes(2)));
    await documentB.save(cfbBytes(22));
    assert.deepEqual(await readFile(first), Buffer.from(cfbBytes(22)));
    assert.deepEqual(await readFile(second), Buffer.from(cfbBytes(11)));
    assert.equal(app.leases.ownerForPath(nativePathOwnershipKey(second)), 'window-a');
    assert.equal(app.leases.ownerForPath(nativePathOwnershipKey(first)), 'window-b');
  });
});

test('a document renamed onto another open document whose file is gone is refused, not merged', async (t) => {
  await withDirectory(t, async (directory) => {
    const first = join(directory, 'a.hwp');
    const second = join(directory, 'b.hwp');
    await writeFile(first, cfbBytes(1));
    await writeFile(second, cfbBytes(2));
    const app = desktop();
    const documentA = await openDocument(app, 'window-a', first);
    await openDocument(app, 'window-b', second);

    await rm(second);
    await rename(first, second);
    await assert.rejects(documentA.save(cfbBytes(11)), { code: NATIVE_FILE_MOVED_INTO_OPEN_CODE });
    assert.deepEqual(await readFile(second), Buffer.from(cfbBytes(1)));
  });
});

test('a new file under a renamed document\'s old name opens on its own instead of focusing that window', async (t) => {
  await withDirectory(t, async (directory) => {
    const original = join(directory, 'report.hwp');
    await writeFile(original, cfbBytes(1));
    const app = desktop();
    const document = await openDocument(app, 'window-a', original);

    const renamed = join(directory, 'report (old).hwp');
    await rename(original, renamed);
    await writeFile(original, cfbBytes(7));

    assert.equal(await app.registry.ownerForPath(original), null);
    const opened = await app.registry.create('window-b', original);
    assert.equal(opened.ok, true);
    assert.equal(document.path(), renamed);
  });
});

test('a save killed mid-publish is restored before the next save instead of being reported missing', async (t) => {
  await withDirectory(t, async (directory) => {
    const original = join(directory, 'report.hwp');
    await writeFile(original, cfbBytes(1));
    const app = desktop();
    const document = await openDocument(app, 'window-a', original);

    await rename(original, join(directory, 'report.rauhwpx-recovery-0123456789ab.hwp'));
    await document.save(cfbBytes(2));

    assert.deepEqual(await readdir(directory), ['report.hwp']);
    assert.deepEqual(await readFile(original), Buffer.from(cfbBytes(2)));
  });
});

test('renaming in the app after an Explorer rename renames the file being edited', async (t) => {
  await withDirectory(t, async (directory) => {
    const original = join(directory, 'report.hwp');
    await writeFile(original, cfbBytes(1));
    const app = desktop();
    const document = await openDocument(app, 'window-a', original);

    await rename(original, join(directory, 'draft.hwp'));
    const renamed = await app.registry.renameHandle('window-a', document.handleId, 'final.hwp');

    assert.equal(renamed.descriptor.name, 'final.hwp');
    assert.deepEqual(await readdir(directory), ['final.hwp']);
    await document.save(cfbBytes(2));
    assert.deepEqual(await readFile(join(directory, 'final.hwp')), Buffer.from(cfbBytes(2)));
  });
});

test('renaming in the app does not adopt a change another program made first', async (t) => {
  await withDirectory(t, async (directory) => {
    const original = join(directory, 'report.hwp');
    await writeFile(original, cfbBytes(1));
    const app = desktop();
    const document = await openDocument(app, 'window-a', original);

    await writeFile(original, cfbBytes(5));
    await app.registry.renameHandle('window-a', document.handleId, 'final.hwp');
    await assert.rejects(document.save(cfbBytes(2)), { code: NATIVE_FILE_CONFLICT_CODE });
    assert.deepEqual(await readFile(join(directory, 'final.hwp')), Buffer.from(cfbBytes(5)));
  });
});

test('renaming in the app refuses device names and names a locked document instead of failing raw', async (t) => {
  await withDirectory(t, async (directory) => {
    const original = join(directory, 'report.hwp');
    await writeFile(original, cfbBytes(1));
    let attempts = 0;
    const app = desktop({
      platform: 'win32',
      renameImpl: async () => {
        attempts += 1;
        throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' });
      },
    });
    const document = await openDocument(app, 'window-a', original);

    for (const name of ['CON.hwp', 'nul.hwp', 'COM1.hwp', 'lpt9 .hwp']) {
      await assert.rejects(
        app.registry.renameHandle('window-a', document.handleId, name),
        (error) => error.renameRefusal === 'invalid',
      );
    }
    await assert.rejects(
      app.registry.renameHandle('window-a', document.handleId, 'final.hwp'),
      (error) => error.renameRefusal === 'in-use',
    );
    // A scanner holding the file for a moment is waited out before giving up.
    assert.ok(attempts > 1);
    assert.deepEqual(await readdir(directory), ['report.hwp']);
    await document.save(cfbBytes(2));
  });
});

test('reopening a closed document follows its rename instead of opening the new file under its old name', async (t) => {
  await withDirectory(t, async (directory) => {
    const original = join(directory, 'report.hwp');
    await writeFile(original, cfbBytes(1));
    const before = desktop();
    const opened = await before.registry.create('window-a', original);
    before.registry.rememberDocument('document-a', 'window-a', opened.descriptor.handleId, undefined);
    const bookmarks = before.registry.dumpBookmarks();

    // The app restarts; meanwhile the document is renamed and another file takes the name.
    const renamed = join(directory, 'report (final).hwp');
    await rename(original, renamed);
    await writeFile(original, cfbBytes(7));
    const after = desktop();
    after.registry.loadBookmarks(JSON.parse(JSON.stringify(bookmarks)), { strict: true });

    const reopened = await after.registry.reopenDocument('window-b', 'document-a');
    assert.equal(reopened.ok, true);
    assert.equal(reopened.descriptor.name, 'report (final).hwp');
    assert.equal(after.registry.bookmarkPathFor('document-a'), renamed);
  });
});

test('the document home does not guess between two identical copies of a vanished document', async (t) => {
  await withDirectory(t, async (directory) => {
    const original = join(directory, 'report.hwp');
    await writeFile(original, cfbBytes(1));
    const app = desktop();
    const opened = await app.registry.create('window-a', original);
    app.registry.rememberDocument('document-a', 'window-a', opened.descriptor.handleId, undefined);
    app.registry.releaseHandle('window-a', opened.descriptor.handleId);

    await copyFile(original, join(directory, 'copy 1.hwp'));
    await copyFile(original, join(directory, 'copy 2.hwp'));
    await rm(original);
    assert.equal(await app.registry.relocateDocument('window-a', 'document-a'), null);

    await rm(join(directory, 'copy 2.hwp'));
    assert.deepEqual(await app.registry.relocateDocument('window-a', 'document-a'), { fileName: 'copy 1.hwp' });
  });
});

test('document leases move together, so swapped names never collide', () => {
  const leases = new DocumentLeaseManager();
  for (const [sessionId, path] of [['window-a', 'c:\\docs\\a.hwp'], ['window-b', 'c:\\docs\\b.hwp']]) {
    const reservation = leases.reserve(sessionId, { documentId: sessionId, sourceDigest: null }, path);
    leases.commit(sessionId, reservation.reservationId);
  }
  assert.equal(leases.movePaths([
    { sessionId: 'window-a', from: 'c:\\docs\\a.hwp', to: 'c:\\docs\\b.hwp' },
    { sessionId: 'window-b', from: 'c:\\docs\\b.hwp', to: 'c:\\docs\\a.hwp' },
  ]), 2);
  assert.equal(leases.ownerForPath('c:\\docs\\b.hwp'), 'window-a');
  assert.equal(leases.ownerForPath('c:\\docs\\a.hwp'), 'window-b');
  assert.equal(leases.validateSaveTarget('window-a', { documentId: 'window-a', sourceDigest: null }, 'c:\\docs\\b.hwp'), true);

  // A path held by an unrelated claim refuses the whole move and changes nothing.
  assert.throws(() => leases.movePaths([{ sessionId: 'window-a', from: 'c:\\docs\\b.hwp', to: 'c:\\docs\\a.hwp' }]), /already owned/);
  assert.equal(leases.ownerForPath('c:\\docs\\b.hwp'), 'window-a');
});

test('the file id lookup reads the path out of localized fsutil output', () => {
  assert.equal(
    parseWindowsFileIdLookupOutput('A random link name to this file is \\\\?\\C:\\Users\\me\\문서\\보고서 ①.hwpx\r\n'),
    'C:\\Users\\me\\문서\\보고서 ①.hwpx',
  );
  assert.equal(
    parseWindowsFileIdLookupOutput('이 파일의 임의 링크 이름: \\\\?\\D:\\공유\\a.hwp\r\n'),
    'D:\\공유\\a.hwp',
  );
  assert.equal(parseWindowsFileIdLookupOutput('… \\\\?\\UNC\\server\\share\\a.hwp\n'), '\\\\server\\share\\a.hwp');
  assert.equal(parseWindowsFileIdLookupOutput('Error:  The parameter is incorrect.\r\n'), null);
});
