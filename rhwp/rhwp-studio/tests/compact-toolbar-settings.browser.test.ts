import assert from 'node:assert/strict';
import test from 'node:test';
import { resolve } from 'node:path';
import { createServer } from 'vite';
import puppeteer from 'puppeteer-core';
import { browserExecutable, browserLaunchArgs } from './browser-support.ts';

// Windows 는 문서 메뉴가 ☰ 안에 접혀 있어, 한 줄 도구 상자를 편집 설정 첫 묶음에서도 바꾼다.
test('편집 설정 첫 묶음의 한 줄 도구 상자 스위치가 헤더·메뉴·저장값을 함께 바꾼다', { timeout: 30_000 }, async () => {
  const server = await createServer({
    configFile: resolve(import.meta.dirname, '../vite.sidebar.config.ts'),
    server: { port: 0, open: false }, logLevel: 'error',
  });
  await server.listen();
  const browser = await puppeteer.launch({ executablePath: browserExecutable(), headless: true, args: browserLaunchArgs() });
  try {
    const page = await browser.newPage();
    const address = server.httpServer!.address() as { port: number };
    await page.goto(`http://127.0.0.1:${address.port}`);
    // 앱 모듈이 서로를 부르는 /@fs/ 주소로 불러와야 userSettings 가 한 인스턴스로 남는다.
    const src = `/@fs/${resolve(import.meta.dirname, '../src').replace(/\\/g, '/').replace(/^\//, '')}`;
    const result = await page.evaluate(async (src: string) => {
      const { createEditingSettings } = await import(`${src}/ui/agent-sidebar/settings-editing.ts`);
      const { userSettings } = await import(`${src}/core/user-settings.ts`);
      const { applyCompactToolbar } = await import(`${src}/command/commands/view.ts`);
      const { COMPACT_TOOLBAR_ATTR } = await import(`${src}/ui/compact-toolbar.ts`);

      // 미리보기 조작 막대에도 같은 id 의 자리 표시가 있어 편집기 헤더만 남긴다.
      document.querySelectorAll('#studio-header, #icon-toolbar').forEach((node) => node.remove());
      const header = document.createElement('div');
      header.id = 'studio-header';
      header.innerHTML = `
        <div class="md-item" data-cmd="view:toolbox-compact"><span class="md-label">한 줄로 보기</span></div>
        <div id="icon-toolbar" class="collapsed"></div>`;
      document.body.append(header);
      const menuItem = header.querySelector<HTMLElement>('[data-cmd="view:toolbox-compact"]')!;
      const state = () => ({
        header: header.hasAttribute(COMPACT_TOOLBAR_ATTR),
        menuChecked: menuItem.getAttribute('aria-checked'),
        toolboxCollapsed: header.querySelector('#icon-toolbar')!.classList.contains('collapsed'),
        stored: userSettings.getViewSettings().compactToolbar,
      });

      const base = userSettings.getEditorScalarSettings();
      base.view.compactToolbar = false;
      userSettings.tryApplyEditorScalarSettings(base);
      // 편집기 런타임처럼 미리보기와 저장 뒤 모두 헤더에 반영한다.
      const runtime = {
        preview: (settings: typeof base) => applyCompactToolbar(settings.view.compactToolbar),
        committed: (settings: typeof base) => applyCompactToolbar(settings.view.compactToolbar),
      };
      let dirty = false;
      const settings = createEditingSettings({ runtime, onDirtyChange: (next) => { dirty = next; } });
      document.body.append(settings.element);
      settings.open();

      const firstGroup = settings.element.querySelector('.ag-settings-group')!;
      const title = firstGroup.querySelector('.ag-settings-group-title')?.textContent;
      const toggle = firstGroup.querySelector<HTMLInputElement>('input[role="switch"][aria-label="한 줄 도구 상자"]');
      if (!toggle) return { title, found: false };
      const initial = { checked: toggle.checked, ...state() };

      toggle.click();
      const previewed = { dirty, ...state() };

      const cancel = Array.from(settings.element.querySelectorAll<HTMLButtonElement>('.ag-settings-apply-footer button'))
        .find((button) => button.textContent === '취소')!;
      cancel.click();
      const cancelled = { dirty, checked: toggle.checked, ...state() };

      toggle.click();
      const applied = settings.apply();
      const committed = { applied, dirty, checked: toggle.checked, ...state() };

      // 메뉴로 끄면 다시 연 설정도 꺼진 값을 보인다.
      userSettings.setCompactToolbar(false);
      applyCompactToolbar(false);
      settings.open();
      const reopened = { checked: toggle.checked, ...state() };
      settings.dispose();
      return { title, found: true, initial, previewed, cancelled, committed, reopened };
    }, src);

    assert.equal(result.title, '화면과 보기');
    assert.equal(result.found, true, '첫 묶음에 한 줄 도구 상자 스위치가 있어야 한다');
    assert.deepEqual(result.initial, { checked: false, header: false, menuChecked: null, toolboxCollapsed: true, stored: false });
    // 초안은 저장 없이 헤더에 미리 보이고, 펼쳐 둔 기본 도구 상자와 메뉴 체크도 맞춘다.
    assert.deepEqual(result.previewed, { dirty: true, header: true, menuChecked: 'true', toolboxCollapsed: false, stored: false });
    assert.deepEqual(result.cancelled, { dirty: false, checked: false, header: false, menuChecked: 'false', toolboxCollapsed: false, stored: false });
    assert.deepEqual(result.committed, { applied: true, dirty: false, checked: true, header: true, menuChecked: 'true', toolboxCollapsed: false, stored: true });
    assert.deepEqual(result.reopened, { checked: false, header: false, menuChecked: 'false', toolboxCollapsed: false, stored: false });
  } finally {
    await browser.close();
    await server.close();
  }
});
