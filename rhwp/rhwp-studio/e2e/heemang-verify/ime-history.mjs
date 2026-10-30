/** Real Studio input/history checks, with the same fixture Pi hub as the other engine checks. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import * as L from './lib.mjs';
import ime from '../smoke/06-ime.mjs';
import { newDocument, clickPage, shortcut, waitFor, paraText } from '../smoke/lib.mjs';

const out = process.env.HV_OUT || L.ensureOut('ime-history');
process.env.HV_CANDIDATE_VITE_PORT ||= '7733';
fs.mkdirSync(out, { recursive:true });
let app, browser, session;
try {
  const port = Number(process.env.HV_CANDIDATE_VITE_PORT) || 7733;
  app = await L.startApp('candidate', L.candidateRoot, port + 1);
  browser = await L.launchBrowser();
  session = await L.newPage(browser);
  const { page, log } = session;
  await L.loadApp(page, app.url);
  await ime.run({ page });

  await newDocument(page);
  await clickPage(page);
  const cdp = await page.createCDPSession();
  for (const text of ['ㄸ','따','땅']) {
    await cdp.send('Input.imeSetComposition', { text, selectionStart:text.length, selectionEnd:text.length });
  }
  await waitFor(page, 'uncommitted preedit visible', () => window.__wasm.getTextRange(0,0,0,100) === '땅');
  await page.keyboard.press('Escape');
  await cdp.send('Input.imeSetComposition', { text:'', selectionStart:0, selectionEnd:0 });
  await waitFor(page, 'cancel restores original text and closes composition', () =>
    window.__wasm.getTextRange(0,0,0,100) === '' && !window.__inputHandler.isComposing && !window.__inputHandler.compositionAnchor);
  const cancelled = await page.evaluate(() => ({
    text:window.__wasm.getTextRange(0,0,0,100),
    canUndo:window.__inputHandler.history.canUndo(),
    canRedo:window.__inputHandler.history.canRedo(),
    position:window.__inputHandler.cursor.getPosition(),
  }));
  assert.equal(cancelled.canUndo, false, 'cancel does not add an application history step');
  assert.equal(cancelled.canRedo, false);
  await cdp.send('Input.insertText', { text:'다' });
  await waitFor(page, 'typing after cancel uses original anchor', () => window.__wasm.getTextRange(0,0,0,100) === '다');
  await shortcut(page, 'KeyZ');
  await waitFor(page, 'undo after cancel', () => window.__wasm.getTextRange(0,0,0,100) === '');
  await shortcut(page, 'KeyZ', {shift:true});
  await waitFor(page, 'redo after cancel', () => window.__wasm.getTextRange(0,0,0,100) === '다');
  assert.equal(log.pageErrors.length,0);
  const result = { runtime:app.url, fixtureHub:true, committedImeUndoRedo:true, cancelled, finalText:await paraText(page), pageErrors:log.pageErrors };
  fs.writeFileSync(path.join(out,'result.json'),JSON.stringify(result,null,2));
  console.log(JSON.stringify(result));
} finally {
  await session?.context.close();
  await L.closeBrowser(browser);
  await app?.stop();
}
