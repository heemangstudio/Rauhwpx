import { randomUUID } from 'node:crypto';
import { rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';
import { safeSuggestedFilename } from './safe-filename.mjs';

/** Studio opens its hidden PDF render surface with this window name. */
export const PDF_EXPORT_FRAME_NAME = 'rhwp-pdf-export';

const TARGET_TTL_MS = 10 * 60_000;
const DOCUMENT_EXTENSIONS = new Set(['.pdf', '.hwp', '.hwpx', '.hml', '.rhwpx']);

/** Strip document extensions the user typed and apply `.pdf` exactly once. */
export function normalizePdfExportPath(filePath) {
  let stem = basename(filePath);
  while (DOCUMENT_EXTENSIONS.has(extname(stem).toLowerCase())) {
    stem = stem.slice(0, -extname(stem).length);
  }
  return join(dirname(filePath), `${stem || 'document'}.pdf`);
}

/** Options for the hidden child window that renders the PDF pages. */
export function pdfExportWindowOptions(preloadPath) {
  return {
    show: false,
    skipTaskbar: true,
    width: 1120,
    height: 820,
    title: 'Rauhwpx',
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // 숨은 창에서도 글꼴 로드와 animation frame 대기가 멈추지 않게 한다.
      backgroundThrottling: false,
    },
  };
}

async function writeFileAtomically(filePath, bytes) {
  const tempPath = join(dirname(filePath), `.${basename(filePath)}.${randomUUID()}.tmp`);
  try {
    await writeFile(tempPath, bytes);
    await rename(tempPath, filePath);
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => {});
    throw error;
  }
}

/**
 * Direct PDF export. The renderer picks a destination first, renders the pages
 * into a hidden same-origin window, and that window asks main to print itself
 * to PDF. Paths never cross from the renderer: it only holds opaque tokens.
 */
export function installPdfExport({
  ipcMain,
  dialog,
  shell,
  BrowserWindow,
  isTrustedSender,
  now = () => Date.now(),
}) {
  const targets = new Map();
  const exported = new Map();

  const assertTrusted = (event) => {
    if (!isTrustedSender(event)) throw new Error('Untrusted renderer IPC sender');
  };

  ipcMain.handle('desktop:pick-pdf-export-path', async (event, options = {}) => {
    assertTrusted(event);
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window) throw new Error('PDF export sender window is unavailable');
    const suggestedName = safeSuggestedFilename(options.suggestedName, 'document');
    const suggestedStem = DOCUMENT_EXTENSIONS.has(extname(suggestedName).toLowerCase())
      ? basename(suggestedName, extname(suggestedName))
      : suggestedName;
    const picked = await dialog.showSaveDialog(window, {
      defaultPath: suggestedStem,
      filters: [{ name: 'PDF', extensions: ['pdf'] }],
      properties: ['showOverwriteConfirmation', 'createDirectory'],
    });
    if (picked.canceled || !picked.filePath) return null;
    const filePath = normalizePdfExportPath(picked.filePath);
    for (const [token, target] of targets) {
      if (target.expiresAt <= now()) targets.delete(token);
    }
    const token = randomUUID();
    targets.set(token, { filePath, expiresAt: now() + TARGET_TTL_MS });
    return { token, fileName: basename(filePath) };
  });

  ipcMain.handle('desktop:export-pdf', async (event, token) => {
    assertTrusted(event);
    const target = targets.get(String(token ?? ''));
    targets.delete(String(token ?? ''));
    if (!target || target.expiresAt <= now()) throw new Error('PDF 저장 위치가 만료되었습니다.');
    const pdf = await event.sender.printToPDF({
      printBackground: true,
      preferCSSPageSize: true,
      margins: { marginType: 'none' },
    });
    await writeFileAtomically(target.filePath, pdf);
    const exportId = randomUUID();
    exported.set(exportId, target.filePath);
    if (exported.size > 20) exported.delete(exported.keys().next().value);
    return { exportId, fileName: basename(target.filePath), byteLength: pdf.byteLength };
  });

  ipcMain.handle('desktop:reveal-pdf-export', (event, exportId) => {
    assertTrusted(event);
    const filePath = exported.get(String(exportId ?? ''));
    if (filePath) shell.showItemInFolder(filePath);
  });
}
