// Opt-in paid verification: actual Windows CLI login, streamed edits, reconnect and resume.
// CHROME_PATH=... node e2e/provider-stream-live.test.mjs --allow-provider-usage
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { startLiveStack, installEventCapture, resetEventCapture, readEventCapture, startFreshChat, sendThroughComposer } from '../bench/agent-live-common.mjs';

assert.ok(process.argv.includes('--allow-provider-usage'), 'This test spends provider quota; pass --allow-provider-usage explicitly.');
const results = [];
for (const [agent, model] of [['codex', 'gpt-6-luna'], ['claude', 'claude-haiku-5-5']]) {
  const stack = await startLiveStack({ agent, model, tag: `${agent}-stream-verify` });
  let browser;
  try {
    const { launchBrowser, createNewDocument } = await import('./helpers.mjs');
    browser = await launchBrowser();
    const page = await browser.newPage();
    page.on('dialog', (dialog) => dialog.type() === 'beforeunload' ? dialog.accept() : dialog.dismiss());
    await page.setViewport({ width: 1440, height: 1000 });
    // helpers.mjs caches VITE_URL, so navigate explicitly for each isolated stack.
    await page.goto(`http://127.0.0.1:${stack.vitePort}`);
    await page.waitForFunction(() => Boolean(window.__wasm && window.__canvasView), { timeout: 30000 });
    await createNewDocument(page);
    await installEventCapture(page);
    await startFreshChat(page, { agent, model, effort: 'low' });
    const markers = [];
    for (let turn = 1; turn <= 2; turn++) {
      const marker = `WINDOWS_${agent.toUpperCase()}_RESUME_${turn}_OK`;
      markers.push(marker);
      await resetEventCapture(page);
      await page.waitForFunction(() => document.querySelector('#agent-sidebar')?.dataset.composerReady === 'true', { timeout: 15000 });
      const via = await sendThroughComposer(page, `Use the rhwp MCP tools to append the exact text ${marker} to paragraph 0 in section 0 of the open document. Read it back to verify the edit. Reply with ${marker}. Do not use subagents or external tools.`);
      assert.equal(via, 'composer');
      await page.waitForFunction(() => window.__liveEvents?.some((event) => event.type === 'turn-end'), { timeout: 120000 });
      const capture = await readEventCapture(page);
      assert.equal(capture.events.filter((event) => event.type === 'turn-end').length, 1);
      assert.ok(['completed', 'end_turn'].includes(capture.events.find((event) => event.type === 'turn-end').stopReason), JSON.stringify(capture.events));
      assert.ok(capture.text.includes(marker), `missing streamed answer: ${capture.text}`);
      const text = await page.evaluate(() => window.__wasm.getTextRange(0, 0, 0, window.__wasm.getParagraphLength(0, 0)));
      for (const expected of markers) assert.ok(text.includes(expected), `document lost ${expected}: ${text}`);
      results.push({ agent, model, turn, url: page.url(), text, streamed: capture.text, errors: capture.events.filter((event) => event.type === 'error') });
      console.log(JSON.stringify(results.at(-1)));
      if (turn === 1) {
        await page.evaluate(() => window.__agentBridge.ws.close());
        await page.waitForFunction(() => window.__agentBridge.getConnectionState() !== 'connected');
        await page.evaluate(() => window.__agentBridge.reconnectNow());
        await page.waitForFunction(() => window.__agentBridge.getConnectionState() === 'connected', { timeout: 30000 });
        await page.waitForFunction((value) => window.__wasm.getTextRange(0, 0, 0, window.__wasm.getParagraphLength(0, 0)).includes(value), {}, marker);
      }
    }
    await page.screenshot({ path: fileURLToPath(new URL(`../../target/${agent}-stream-live.png`, import.meta.url)) });
  } finally {
    await browser?.close();
    await stack.stop();
    fs.writeFileSync(fileURLToPath(new URL('../../target/provider-stream-live.json', import.meta.url)), JSON.stringify(results, null, 2));
  }
}
