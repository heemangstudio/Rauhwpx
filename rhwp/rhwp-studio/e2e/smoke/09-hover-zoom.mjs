import assert from 'node:assert/strict';
import { clickPage, newDocument, runMenuCommand, waitFor } from './lib.mjs';

async function hoverBorder(page, type) {
  const point = await page.evaluate((kind) => {
    const { sectionIndex, parentParaIndex, controlIndex } = window.__inputHandler.getCursorPosition();
    const cell = window.__wasm.getTableCellBboxes(sectionIndex, parentParaIndex, controlIndex, 0)[0];
    const view = window.__canvasView;
    const zoom = view.getViewportManager().getZoom();
    const content = document.querySelector('#scroll-content');
    const box = content.getBoundingClientRect();
    const scroll = view.getVirtualScroll();
    window.__hoverTable = { sectionIndex, parentParaIndex, controlIndex };
    return {
      x: box.left + scroll.getPageLeftResolved(0, content.clientWidth)
        + (kind === 'row' ? cell.x + cell.w / 3 : cell.x + cell.w) * zoom,
      y: box.top + scroll.getPageOffset(0)
        + (kind === 'row' ? cell.y + cell.h : cell.y + cell.h / 2) * zoom,
    };
  }, type);
  await page.mouse.move(point.x + 8, point.y + 8);
  await page.mouse.move(point.x, point.y);
  await waitFor(page, `${type} border hover`, (kind) => {
    const marker = document.querySelector('.table-resize-layer > div > div');
    return marker && (kind === 'row' ? marker.offsetWidth > marker.offsetHeight : marker.offsetHeight > marker.offsetWidth);
  }, type);
  return point;
}

/** 매 프레임 실제 엔진의 셀 경계와 DOM 마커를 비교한다. 포인터가 경계를 벗어나면 숨겨도 된다. */
async function checkZoomFrames(page) {
  const detached = await page.evaluate(async () => {
    const view = window.__canvasView;
    const viewport = view.getViewportManager();
    const scroll = view.getVirtualScroll();
    for (let frame = 0; frame < 240; frame++) {
      await new Promise(requestAnimationFrame);
      const content = document.querySelector('#scroll-content');
      const origin = content.getBoundingClientRect();
      const zoom = viewport.getZoom();
      const ref = window.__hoverTable;
      const cells = window.__wasm.getTableCellBboxes(ref.sectionIndex, ref.parentParaIndex, ref.controlIndex, 0);
      const segments = [...document.querySelectorAll('.table-resize-layer > div > div')];
      for (const segment of segments) {
        const box = segment.getBoundingClientRect();
        const row = box.width > box.height;
        const attached = cells.some((cell) => {
          const left = origin.left + scroll.getPageLeftResolved(cell.pageIndex, content.clientWidth) + cell.x * zoom;
          const top = origin.top + scroll.getPageOffset(cell.pageIndex) + cell.y * zoom;
          const right = left + cell.w * zoom;
          const bottom = top + cell.h * zoom;
          return row
            ? Math.min(Math.abs(box.y + box.height / 2 - top), Math.abs(box.y + box.height / 2 - bottom)) < 1
              && box.right > left && box.left < right
            : Math.min(Math.abs(box.x + box.width / 2 - left), Math.abs(box.x + box.width / 2 - right)) < 1
              && box.bottom > top && box.top < bottom;
        });
        if (!attached) return { frame, zoom, marker: { x: box.x, y: box.y, width: box.width, height: box.height } };
      }
      if (frame >= 2 && !viewport.isZoomAnimating()) return null;
    }
    throw new Error('zoom did not settle within 240 animation frames');
  });
  assert.equal(detached, null, `hover marker detached during zoom: ${JSON.stringify(detached)}`);
}

async function cellHoverPeers(page) {
  await page.evaluate(() => {
    const { sectionIndex: sec, parentParaIndex: para, controlIndex: ctrl } = window.__hoverTable;
    window.__wasm.insertTextInCell(sec, para, ctrl, 0, 0, 0, 'Hover link');
    window.__wasm.insertHyperlink({ section: sec, para, cellPath: [[ctrl, 0, 0]] }, 0, 10, 'https://example.com/hover');
    window.__wasm.setCellProperties(sec, para, ctrl, 2, { cellProtect: true });
    window.__eventBus.emit('document-changed');
  });
  const point = (cellIndex, link = false) => page.evaluate((index, isLink) => {
    const { sectionIndex: sec, parentParaIndex: para, controlIndex: ctrl } = window.__hoverTable;
    const cell = window.__wasm.getTableCellBboxes(sec, para, ctrl, 0).find((item) => item.cellIdx === index);
    const rect = isLink ? window.__wasm.getSelectionRectsByPath(sec, para,
      [{ controlIndex: ctrl, cellIndex: index, cellParaIndex: 0 }], 0, 0, 0, 10)[0] : null;
    const content = document.querySelector('#scroll-content');
    const box = content.getBoundingClientRect();
    const view = window.__canvasView;
    const zoom = view.getViewportManager().getZoom();
    return {
      x: box.left + view.getVirtualScroll().getPageLeftResolved(0, content.clientWidth) + (rect ? rect.x + rect.width / 2 : cell.x + cell.w / 2) * zoom,
      y: box.top + view.getVirtualScroll().getPageOffset(0) + (rect ? rect.y + rect.height / 2 : cell.y + cell.h / 2) * zoom,
    };
  }, cellIndex, link);
  await hoverBorder(page, 'row');
  let target = await point(0, true);
  await page.mouse.move(target.x, target.y);
  await waitFor(page, 'hyperlink hover replaces table marker', () => window.__inputHandler.container.title === 'https://example.com/hover'
    && !document.querySelector('.table-resize-layer > div'));
  target = await point(2);
  await page.mouse.move(target.x, target.y);
  await waitFor(page, 'protected cell hover', () => document.querySelector('.protected-cell-hover-guard')?.style.display === 'flex');
  await page.evaluate(() => {
    const viewport = window.__canvasView.getViewportManager();
    viewport.setZoom(viewport.getZoom() * 1.05);
    if (document.querySelector('.protected-cell-hover-guard')?.style.display === 'flex') throw new Error('zoom retained stale protected-cell guard');
  });
  target = await point(2);
  await page.mouse.move(target.x + 2, target.y);
  await page.mouse.move(target.x, target.y);
  await waitFor(page, 'protected hover restored after zoom', () => document.querySelector('.protected-cell-hover-guard')?.style.display === 'flex');
  target = await point(0, true);
  await page.mouse.move(target.x, target.y);
  await waitFor(page, 'hyperlink hover replaces protected guard', () => window.__inputHandler.container.title === 'https://example.com/hover'
    && document.querySelector('.protected-cell-hover-guard')?.style.display !== 'flex');
  await page.evaluate(() => {
    window.__canvasView.getViewportManager().setZoom(1.5);
    if (window.__inputHandler.container.title || document.querySelector('.protected-cell-hover-guard')?.style.display === 'flex') {
      throw new Error('zoom retained stale hyperlink/protected hover feedback');
    }
  });
}

async function connectorHover(page) {
  await newDocument(page);
  await page.evaluate(() => {
    const result = window.__wasm.createShapeControl({ sectionIdx: 0, paraIdx: 0, charOffset: 0,
      shapeType: 'rectangle', width: 10800, height: 7200, horzOffset: 7200, vertOffset: 7200 });
    if (!result.ok) throw new Error('connector fixture shape failed');
    window.__eventBus.emit('document-changed');
    window.__inputHandler.enterShapePlacementMode('connector-straight');
  });
  const point = await page.evaluate(() => {
    const ctrl = window.__wasm.getPageControlLayout(0).controls.find((item) => item.type === 'shape');
    const content = document.querySelector('#scroll-content');
    const rect = content.getBoundingClientRect();
    const view = window.__canvasView;
    const zoom = view.getViewportManager().getZoom();
    return { x: rect.left + view.getVirtualScroll().getPageLeftResolved(0, content.clientWidth) + (ctrl.x + ctrl.w / 2) * zoom,
      y: rect.top + view.getVirtualScroll().getPageOffset(0) + ctrl.y * zoom + 1 };
  });
  await page.mouse.move(point.x, point.y);
  await waitFor(page, 'connector hover points', () => document.querySelectorAll('.connector-points-overlay > div').length === 4);
  await page.mouse.click(point.x, point.y);
  await page.mouse.move(point.x + 20, point.y + 20);
  await waitFor(page, 'started connector preview', () => document.querySelector('.connector-preview line'));
  await page.evaluate(() => {
    window.__canvasView.getViewportManager().setZoom(1.2);
    if (document.querySelector('.connector-points-overlay, .connector-preview')) throw new Error('zoom retained stale connector hover');
  });
  await waitFor(page, 'stationary pointer restores connector preview', () => document.querySelector('.connector-preview line'));
  await waitFor(page, 'connector preview start follows the shape connection point', () => {
    const start = window.__inputHandler.connectorStartRef;
    const line = document.querySelector('.connector-preview line');
    if (!line || !start) return false;
    const content = document.querySelector('#scroll-content');
    const view = window.__canvasView;
    const zoom = view.getViewportManager().getZoom();
    return Math.abs(Number(line.getAttribute('x1')) - view.getVirtualScroll().getPageLeftResolved(0, content.clientWidth) - start.x * zoom) < 1
      && Math.abs(Number(line.getAttribute('y1')) - view.getVirtualScroll().getPageOffset(0) - start.y * zoom) < 1;
  });
  await page.keyboard.press('Escape');
}

export default {
  name: 'hover overlays stay aligned through direct and smooth zoom',
  async run({ page }) {
    await newDocument(page);
    await clickPage(page);
    await runMenuCommand(page, '표', 'table:create');
    await waitFor(page, 'table grid picker', () => document.querySelector('.table-create-grid'));
    await page.click('.table-create-cell[data-row="1"][data-col="1"]');
    await waitFor(page, 'first table cell', () => window.__inputHandler.getCursorPosition().cellIndex === 0);

    for (const type of ['row', 'col']) {
      for (const zoom of [1.4, 0.8]) {
        await hoverBorder(page, type);
        await page.evaluate((value) => window.__canvasView.getViewportManager().setZoom(value), zoom);
        await checkZoomFrames(page);
        await page.evaluate(() => window.__canvasView.getViewportManager().setScrollTop(0));
        await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        await hoverBorder(page, type);
      }
      for (const deltaY of [-180, 180]) {
        await hoverBorder(page, type);
        const before = await page.evaluate(() => window.__canvasView.getViewportManager().getZoom());
        await page.keyboard.down('Control');
        try { await page.mouse.wheel({ deltaY }); }
        finally { await page.keyboard.up('Control'); }
        await checkZoomFrames(page);
        const after = await page.evaluate(() => window.__canvasView.getViewportManager().getZoom());
        assert.ok(deltaY < 0 ? after > before : after < before, 'Ctrl+wheel changes the document zoom');
        await waitFor(page, 'stationary pointer restores border hover after anchored zoom', () => document.querySelector('.table-resize-layer > div > div'));
        await hoverBorder(page, type);
      }
    }

    const point = await hoverBorder(page, 'row');
    // 같은 프레임에 편집기를 벗어나도 예약된 hover 가 마커를 되살리지 않아야 한다.
    await page.evaluate(({ x, y }) => {
      const container = window.__inputHandler.container;
      container.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: x, clientY: y }));
      container.dispatchEvent(new MouseEvent('mouseleave', { relatedTarget: document.body }));
    }, point);
    await waitFor(page, 'hover cleared after leaving editor', () => !document.querySelector('.table-resize-layer > div'));
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await page.$('.table-resize-layer > div'), null, 'queued hover cannot recreate a marker after leaving');
    await hoverBorder(page, 'row');
    await cellHoverPeers(page);
    await connectorHover(page);
  },
};
