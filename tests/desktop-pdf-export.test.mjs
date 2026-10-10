import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { installPdfExport, normalizePdfExportPath } from '../desktop/pdf-export.mjs';

function harness(pickedPath) {
  const handlers = new Map();
  const revealed = [];
  installPdfExport({
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    dialog: { showSaveDialog: async () => ({ canceled: !pickedPath, filePath: pickedPath }) },
    shell: { showItemInFolder: (filePath) => revealed.push(filePath) },
    BrowserWindow: { fromWebContents: () => ({}) },
    isTrustedSender: (event) => event.trusted !== false,
  });
  const sender = { printToPDF: async () => Buffer.from('%PDF-1.7 hamaeditor') };
  const invoke = (channel, arg, event = {}) => handlers.get(channel)({ sender, ...event }, arg);
  return { invoke, revealed };
}

test('PDF 내보내기는 고른 위치에 한 번만 쓰고 경로를 renderer 에 넘기지 않는다', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'rhwp-pdf-export-'));
  try {
    const { invoke, revealed } = harness(path.join(dir, '보고서.hwpx'));
    const target = await invoke('desktop:pick-pdf-export-path', { suggestedName: '보고서.hwpx' });
    assert.equal(target.fileName, '보고서.pdf');
    assert.ok(!JSON.stringify(target).includes(dir), 'renderer 는 토큰만 받는다');

    const result = await invoke('desktop:export-pdf', target.token);
    assert.equal(result.fileName, '보고서.pdf');
    assert.equal(await readFile(path.join(dir, '보고서.pdf'), 'utf8'), '%PDF-1.7 hamaeditor');
    assert.deepEqual(await readdir(dir), ['보고서.pdf'], '임시 파일을 남기지 않는다');

    await assert.rejects(invoke('desktop:export-pdf', target.token), /만료/);
    await invoke('desktop:reveal-pdf-export', result.exportId);
    assert.deepEqual(revealed, [path.join(dir, '보고서.pdf')]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('저장 대화상자를 취소하거나 신뢰하지 않는 창이 부르면 PDF 를 쓰지 않는다', async () => {
  const cancelled = harness(undefined);
  assert.equal(await cancelled.invoke('desktop:pick-pdf-export-path', {}), null);

  const { invoke } = harness(path.join(os.tmpdir(), 'never.pdf'));
  await assert.rejects(
    invoke('desktop:pick-pdf-export-path', {}, { trusted: false }),
    /Untrusted/,
  );
  await assert.rejects(invoke('desktop:export-pdf', 'forged-token'), /만료/);
});

test('사용자가 친 문서 확장자를 떼고 .pdf 를 한 번만 붙인다', () => {
  assert.equal(normalizePdfExportPath('/tmp/a.hwpx.pdf'), path.join('/tmp', 'a.pdf'));
  assert.equal(normalizePdfExportPath('/tmp/report'), path.join('/tmp', 'report.pdf'));
  assert.equal(normalizePdfExportPath('/tmp/v1.2 draft'), path.join('/tmp', 'v1.2 draft.pdf'));
});
