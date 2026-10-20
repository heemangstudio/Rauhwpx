import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { chmod, copyFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  NATIVE_FILE_CONFLICT_CODE,
  NATIVE_FILE_IN_USE_CODE,
  NATIVE_FILE_READ_ONLY_CODE,
  NativeFileHandleRegistry,
  fingerprintNativeFile,
  recoverInterruptedNativeSave,
  writeNativeFileAtomically,
} from '../desktop/native-file-handles.mjs';
import { DocumentLeaseManager } from '../desktop/document-leases.mjs';

const windowsOnly = { skip: process.platform !== 'win32' };

function cfbBytes(fill) {
  const bytes = new Uint8Array(1536).fill(fill);
  bytes.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
  bytes.set([0xfe, 0xff], 28);
  bytes.set([9, 0], 30);
  return bytes;
}

async function withDirectory(t, run) {
  const directory = await mkdtemp(join(tmpdir(), 'rauhwpx-native-save-'));
  t.after(async () => {
    await chmod(directory, 0o700).catch(() => {});
    for (const name of await readdir(directory, { recursive: true }).catch(() => [])) {
      await chmod(join(directory, name), 0o600).catch(() => {});
    }
    await rm(directory, { recursive: true, force: true });
  });
  return run(directory);
}

function errorWithCode(code) {
  return Object.assign(new Error(code), { code });
}

/** Opens a document through the registry and saves it the way the IPC handler does. */
async function openForSave(filePath) {
  const registry = new NativeFileHandleRegistry();
  const opened = await registry.create('session-a', filePath);
  assert.equal(opened.ok, true);
  const handleId = opened.descriptor.handleId;
  const identity = { documentId: 'document-a', sourceDigest: 'blake3:a' };
  const leases = new DocumentLeaseManager();
  const reservation = leases.reserve('session-a', identity, registry.pathForSender('session-a', handleId));
  leases.commit('session-a', reservation.reservationId);
  return {
    registry,
    save: (bytes) => registry.write('session-a', handleId, bytes, identity, leases),
  };
}

test('Windows saves an existing document whose path is longer than MAX_PATH', windowsOnly, async (t) => {
  await withDirectory(t, async (root) => {
    let directory = root;
    while (directory.length < 280) directory = join(directory, '부서별 제출본 취합 폴더 이름');
    await mkdir(directory, { recursive: true });
    const target = join(directory, '2026년 상반기 주요업무 추진계획 보고서(최종 수정본).hwp');
    await writeFile(target, cfbBytes(1));

    const { save } = await openForSave(target);
    await save(cfbBytes(2));
    await save(cfbBytes(3));

    assert.deepEqual(new Uint8Array(await readFile(target)), cfbBytes(3));
    assert.deepEqual(await readdir(directory), ['2026년 상반기 주요업무 추진계획 보고서(최종 수정본).hwp']);
  });
});

test('Windows keeps an explicit document ACL across a long-path save', windowsOnly, async (t) => {
  await withDirectory(t, async (root) => {
    let directory = root;
    while (directory.length < 240) directory = join(directory, '권한이 지정된 폴더');
    await mkdir(directory, { recursive: true });
    const target = join(directory, '보안 문서.hwp');
    await writeFile(target, cfbBytes(1));
    const icacls = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'icacls.exe');
    // An explicit, non-inherited grant that the temp file next to it lacks.
    execFileSync(icacls, [`\\\\?\\${target}`, '/grant', '*S-1-5-32-545:(R)'], { windowsHide: true });

    await writeNativeFileAtomically(target, cfbBytes(2));

    const acl = execFileSync(icacls, [`\\\\?\\${target}`], { windowsHide: true, encoding: 'utf8' });
    assert.match(acl, /BUILTIN\\Users:\(R\)|S-1-5-32-545:\(R\)|:\(R\)/);
    assert.deepEqual(new Uint8Array(await readFile(target)), cfbBytes(2));
  });
});

test('Windows reports a read-only document instead of an EPERM about a temp file', windowsOnly, async (t) => {
  await withDirectory(t, async (directory) => {
    const target = join(directory, '읽기 전용.hwp');
    await writeFile(target, cfbBytes(1));
    await chmod(target, 0o444);

    const { save } = await openForSave(target);
    await assert.rejects(save(cfbBytes(2)), (error) => {
      assert.equal(error.code, NATIVE_FILE_READ_ONLY_CODE);
      assert.doesNotMatch(error.message, /\.tmp/);
      return true;
    });
    assert.deepEqual(new Uint8Array(await readFile(target)), cfbBytes(1));
    assert.deepEqual(await readdir(directory), ['읽기 전용.hwp']);
  });
});

test('Windows waits out a scanner that holds the document exclusively for a moment', windowsOnly, async (t) => {
  await withDirectory(t, async (directory) => {
    const target = join(directory, '보고서.hwp');
    await writeFile(target, cfbBytes(1));
    const { save } = await openForSave(target);

    // FileShare.None, released after 400 ms, the way antivirus and sync clients do.
    const script = [
      `$f = [System.IO.File]::Open($env:LOCK_TARGET, 'Open', 'Read', 'None')`,
      `[Console]::Out.WriteLine('locked'); [Console]::Out.Flush()`,
      'Start-Sleep -Milliseconds 400',
      '$f.Close()',
    ].join('; ');
    const holder = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      env: { ...process.env, LOCK_TARGET: target },
      windowsHide: true,
    });
    const exited = new Promise((resolve) => holder.once('exit', resolve));
    t.after(() => holder.kill());
    await new Promise((resolve, reject) => {
      holder.stdout.on('data', (chunk) => { if (String(chunk).includes('locked')) resolve(); });
      holder.once('exit', () => reject(new Error('lock holder exited before locking')));
    });

    await save(cfbBytes(2));
    await exited;
    assert.deepEqual(new Uint8Array(await readFile(target)), cfbBytes(2));
    assert.deepEqual(await readdir(directory), ['보고서.hwp']);
  });
});

test('a sharing violation that outlasts the retries names the cause, not the temp file', async (t) => {
  await withDirectory(t, async (directory) => {
    const target = join(directory, 'report.hwp');
    await writeFile(target, cfbBytes(1));
    await assert.rejects(
      writeNativeFileAtomically(target, cfbBytes(2), {
        platform: 'win32',
        windowsSystemRoot: 'C:\\Windows',
        runCommandImpl: async () => {},
        renameImpl: async () => { throw errorWithCode('EBUSY'); },
        sleep: async () => {},
      }),
      { code: NATIVE_FILE_IN_USE_CODE },
    );
    assert.deepEqual(new Uint8Array(await readFile(target)), cfbBytes(1));
    assert.deepEqual(await readdir(directory), ['report.hwp']);
  });
});

test('a brief sharing violation on the Windows copy step is retried', async (t) => {
  await withDirectory(t, async (directory) => {
    const target = join(directory, 'report.hwp');
    await writeFile(target, cfbBytes(1));
    let failures = 2;
    await writeNativeFileAtomically(target, cfbBytes(2), {
      platform: 'win32',
      windowsSystemRoot: 'C:\\Windows',
      runCommandImpl: async () => {},
      copyFileImpl: async (from, to, mode) => {
        if (failures-- > 0) {
          await writeFile(to, 'partial');
          throw errorWithCode('EBUSY');
        }
        return copyFile(from, to, mode);
      },
      sleep: async () => {},
    });
    assert.deepEqual(new Uint8Array(await readFile(target)), cfbBytes(2));
    assert.deepEqual(await readdir(directory), ['report.hwp']);
  });
});

test('a file id that changes on rename (FAT, exFAT) is not a conflict when the content matches', async (t) => {
  await withDirectory(t, async (directory) => {
    const target = join(directory, 'report.hwp');
    await writeFile(target, cfbBytes(1));
    const expected = await fingerprintNativeFile(target);
    const fields = JSON.parse(expected.generation);
    await writeNativeFileAtomically(target, cfbBytes(2), {
      expectedFingerprint: expected,
      // exFAT renumbers the file index on rename; a leftover link drops nlink.
      fingerprintImpl: async (path) => {
        const moved = await fingerprintNativeFile(path);
        const movedFields = JSON.parse(moved.generation);
        movedFields[1] = String(BigInt(fields[1] ?? 0) + 1n);
        movedFields[3] = '2';
        return { ...moved, generation: JSON.stringify(movedFields) };
      },
    });
    assert.deepEqual(new Uint8Array(await readFile(target)), cfbBytes(2));
  });
});

test('a moved-aside document with different content is still a conflict', async (t) => {
  await withDirectory(t, async (directory) => {
    const target = join(directory, 'report.hwp');
    await writeFile(target, cfbBytes(1));
    const expected = await fingerprintNativeFile(target);
    await writeFile(target, cfbBytes(9));
    await assert.rejects(
      writeNativeFileAtomically(target, cfbBytes(2), { expectedFingerprint: expected }),
      { code: NATIVE_FILE_CONFLICT_CODE },
    );
    assert.deepEqual(new Uint8Array(await readFile(target)), cfbBytes(9));
  });
});

test('reopening a document after a save was killed mid-publish restores the original', async (t) => {
  await withDirectory(t, async (directory) => {
    const target = join(directory, '결재 문서.hwp');
    // What a kill between the rename-aside and the publish leaves behind,
    // with both the current and the 2.x recovery naming.
    await writeFile(join(directory, '결재 문서.rauhwpx-recovery-6124-0b1c2d3e-aaaa-bbbb-cccc-111122223333.hwp'), cfbBytes(1));
    await writeFile(join(directory, '결재 문서.hwp.rauhwpx-6124-0b1c2d3e.tmp'), cfbBytes(2));

    const { registry, save } = await openForSave(target);
    assert.deepEqual(new Uint8Array(await readFile(target)), cfbBytes(1));
    await save(cfbBytes(3));
    assert.deepEqual(new Uint8Array(await readFile(target)), cfbBytes(3));
    assert.equal(
      (await readdir(directory)).some((name) => name.includes('.rauhwpx-recovery-')),
      false,
    );
    assert.equal(await registry.ownerForPath(target), 'session-a');
  });
});

test('the document home restores an interrupted save instead of showing the document as missing', async (t) => {
  await withDirectory(t, async (directory) => {
    const target = join(directory, 'report.hwpx');
    await writeFile(target, 'placeholder');
    const registry = new NativeFileHandleRegistry();
    const opened = await registry.create('session-a', target);
    registry.rememberDocument('document-a', 'session-a', opened.descriptor.handleId);
    registry.releaseHandle('session-a', opened.descriptor.handleId);
    await rm(target);
    await writeFile(join(directory, 'report.rauhwpx-recovery-0123456789ab.hwpx'), 'last good bytes');

    const state = await registry.inspectDocument('document-a');
    assert.equal(state.state, 'present');
    assert.equal(await readFile(target, 'utf8'), 'last good bytes');
  });
});

test('recovery never replaces a document that is present', async (t) => {
  await withDirectory(t, async (directory) => {
    const target = join(directory, 'report.hwp');
    await writeFile(target, cfbBytes(5));
    const leftover = join(directory, 'report.rauhwpx-recovery-0123456789ab.hwp');
    await writeFile(leftover, cfbBytes(1));
    assert.equal(await recoverInterruptedNativeSave(target), false);
    assert.deepEqual(new Uint8Array(await readFile(target)), cfbBytes(5));
    assert.deepEqual(new Uint8Array(await readFile(leftover)), cfbBytes(1));
  });
});

test('recovery picks the newest copy and ignores other documents', async (t) => {
  await withDirectory(t, async (directory) => {
    const target = join(directory, 'report.hwp');
    const { utimes } = await import('node:fs/promises');
    const older = join(directory, 'report.rauhwpx-recovery-aaaaaaaaaaaa.hwp');
    const newer = join(directory, 'report.rauhwpx-recovery-bbbbbbbbbbbb.hwp');
    await writeFile(older, cfbBytes(1));
    await writeFile(newer, cfbBytes(2));
    await writeFile(join(directory, 'report2.rauhwpx-recovery-cccccccccccc.hwp'), cfbBytes(3));
    await writeFile(join(directory, 'report.rauhwpx-recovery-dddddddddddd.hwpx'), 'other format');
    await utimes(older, new Date(1_000_000), new Date(1_000_000));
    assert.equal(await recoverInterruptedNativeSave(target, { logger: null }), true);
    assert.deepEqual(new Uint8Array(await readFile(target)), cfbBytes(2));
  });
});

test('helper files stay within the name-length limit for a very long document name', async (t) => {
  await withDirectory(t, async (directory) => {
    const name = `${'가'.repeat(220)}.hwp`;
    const target = join(directory, name);
    await writeFile(target, cfbBytes(1));
    await writeNativeFileAtomically(target, cfbBytes(2));
    assert.deepEqual(new Uint8Array(await readFile(target)), cfbBytes(2));
    assert.deepEqual(await readdir(directory), [name]);
  });
});

test('Windows keeps NFC and NFD spellings of one name apart, as NTFS does', windowsOnly, async (t) => {
  await withDirectory(t, async (directory) => {
    const nfc = join(directory, '보고서.hwp'.normalize('NFC'));
    const nfd = join(directory, '보고서.hwp'.normalize('NFD'));
    await writeFile(nfc, cfbBytes(1));
    await writeFile(nfd, cfbBytes(2));
    assert.equal((await readdir(directory)).length, 2);

    const registry = new NativeFileHandleRegistry();
    const original = await registry.create('session-a', nfc);
    // Save As onto the other file must target that file, not reuse the open one.
    const target = await registry.createSaveTarget('session-a', nfd);
    assert.equal(original.ok && target.ok, true);
    assert.equal(target.created, true);
    assert.notEqual(target.descriptor.handleId, original.descriptor.handleId);
    assert.equal(await registry.isSameEntry('session-a', original.descriptor.handleId, target.descriptor.handleId), false);
  });
});

test('a document opened through its 8.3 alias keeps its real name and saves in its own format', windowsOnly, async (t) => {
  await withDirectory(t, async (directory) => {
    const target = join(directory, 'quarterly report.hwpx');
    await writeFile(target, 'placeholder');
    const short = execFileSync('cmd.exe', ['/d', '/s', '/c', `"for %I in ("${target}") do @echo %~sI"`], {
      windowsHide: true,
      windowsVerbatimArguments: true,
      encoding: 'utf8',
    }).trim();
    if (!/~\d/.test(short)) {
      t.skip('this volume does not generate 8.3 names');
      return;
    }
    const registry = new NativeFileHandleRegistry();
    const opened = await registry.create('session-a', short);
    assert.equal(opened.ok, true);
    assert.equal(opened.descriptor.name, 'quarterly report.hwpx');
  });
});
