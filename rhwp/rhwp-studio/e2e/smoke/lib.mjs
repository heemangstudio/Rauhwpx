/** 스모크 흐름 공용 도우미 — 모든 대기는 관찰 가능한 상태를 기준으로 하고 시간 상한을 둔다. */

/** 조건이 참이 될 때까지 기다린다. 실패 메시지에 기다린 상태 이름을 넣는다. */
export async function waitFor(page, label, predicate, ...args) {
  try {
    await page.waitForFunction(predicate, { timeout: 15000, polling: 'raf' }, ...args);
  } catch (error) {
    throw new Error(`timed out waiting for ${label}`, { cause: error });
  }
}

/** 앱을 열고 엔진·캔버스·입력 처리기가 준비될 때까지 기다린다. */
export async function loadApp(page, url) {
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await waitFor(page, 'app ready', () => window.__wasm && window.__canvasView && window.__inputHandler && window.__eventBus);
}

/** 사용자가 새 문서를 만드는 경로(create-new-document)로 빈 문서를 연다. */
export async function newDocument(page) {
  const result = await page.evaluate(() => new Promise((resolve) => {
    const requestId = crypto.randomUUID();
    const off = window.__eventBus.on('create-new-document:done', (payload) => {
      if (payload.requestId !== requestId) return;
      off();
      resolve(payload);
    });
    window.__eventBus.emit('create-new-document', { skipUnsavedGuard: true, requestId });
  }));
  if (!result.ok) throw new Error(result.error || 'new document failed');
  await waitFor(page, 'blank page', () => window.__wasm.pageCount > 0 && document.querySelector('#scroll-content canvas'));
}

/** 파일 열기와 같은 open-document-bytes 경로로 문서를 연다. source 는 /samples 이름이거나 바이트 배열이다. */
export async function openDocument(page, source, fileName = source) {
  await page.evaluate(async (src, name) => {
    let bytes;
    if (typeof src === 'string') {
      const response = await fetch(`/samples/${src.split('/').map(encodeURIComponent).join('/')}`);
      if (!response.ok) throw new Error(`sample ${src}: HTTP ${response.status}`);
      bytes = new Uint8Array(await response.arrayBuffer());
    } else {
      bytes = new Uint8Array(src);
    }
    const requestId = crypto.randomUUID();
    await new Promise((resolve, reject) => {
      const off = window.__eventBus.on('open-document-bytes:done', (payload) => {
        if (payload?.requestId !== requestId) return;
        off();
        if (payload.ok) resolve(); else reject(new Error(payload.error || 'open failed'));
      });
      window.__eventBus.emit('open-document-bytes', {
        bytes, fileName: name, requestId, suppressDialogs: true, skipUnsavedGuard: true,
      });
    });
  }, source, fileName);
  await waitFor(page, 'document pages', () => window.__wasm.pageCount > 0 && document.querySelector('#scroll-content canvas'));
}

/** 본문 문단 텍스트. */
export function paraText(page, paraIdx = 0, sectionIdx = 0) {
  return page.evaluate((s, p) => window.__wasm.getTextRange(s, p, 0, 10000), sectionIdx, paraIdx);
}

/** 본문 전체 텍스트(문단을 줄바꿈으로 잇는다). */
export function bodyText(page, sectionIdx = 0) {
  return page.evaluate((s) => {
    const count = window.__wasm.getParagraphCount(s);
    return Array.from({ length: count }, (_, p) => window.__wasm.getTextRange(s, p, 0, 10000)).join('\n');
  }, sectionIdx);
}

/** 첫 쪽 본문을 클릭해 편집 포커스를 준다. */
export async function clickPage(page) {
  const box = await (await page.$('#scroll-content canvas')).boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + 120);
  await waitFor(page, 'editor focus', () => document.activeElement === window.__inputHandler.textarea);
}

export async function shortcut(page, key, { shift = false } = {}) {
  await page.keyboard.down('Control');
  if (shift) await page.keyboard.down('Shift');
  await page.keyboard.press(key);
  if (shift) await page.keyboard.up('Shift');
  await page.keyboard.up('Control');
}

/** 메뉴바 항목을 사용자처럼 연다(mousedown 으로 메뉴 상태 갱신) 그리고 명령을 누른다. */
export async function runMenuCommand(page, menu, cmd) {
  await page.evaluate((menuLabel, command) => {
    const item = [...document.querySelectorAll('#menu-bar .menu-item')]
      .find((el) => el.querySelector('.menu-title')?.textContent.trim() === menuLabel);
    item.querySelector('.menu-title').dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    const entry = document.querySelector(`.md-item[data-cmd="${command}"]`);
    if (!entry || entry.classList.contains('disabled')) throw new Error(`${command} is not available`);
    entry.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  }, menu, cmd);
}

/** 첫 쪽 캔버스의 불투명하고 어두운 픽셀(글자·선)이 min 이상 그려질 때까지 기다리고 그 수를 돌려준다. */
export async function waitForInk(page, min) {
  const count = (threshold) => {
    const source = document.querySelector('#scroll-content canvas');
    if (!source?.width) return threshold === undefined ? 0 : false;
    const copy = document.createElement('canvas');
    copy.width = source.width;
    copy.height = source.height;
    const ctx = copy.getContext('2d');
    ctx.drawImage(source, 0, 0);
    const { data } = ctx.getImageData(0, 0, copy.width, copy.height);
    let ink = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] > 128 && data[i] + data[i + 1] + data[i + 2] < 384) ink += 1;
    }
    return threshold === undefined ? ink : ink >= threshold;
  };
  try {
    await page.waitForFunction(count, { timeout: 15000 }, min);
  } catch (error) {
    throw new Error(`first page has ${await page.evaluate(count)} ink pixels, expected ${min}`, { cause: error });
  }
  return page.evaluate(count);
}
