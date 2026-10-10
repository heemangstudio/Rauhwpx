import type { SidebarBridge } from '../../agent/bridge.ts';
import type { BrowserDownload, BrowserResult } from '../../agent/types.ts';
import { loadPdfjs, pdfDocumentParams } from '../../agent/pdf-render.ts';
import type { PDFDocumentProxy, RenderTask } from 'pdfjs-dist';

/** 프로젝트가 없어도 받은 원본을 열 수 있는 사용자 받은함. 이동은 기존 바이트의 불투명 ID를 쓴다. */
export function createBrowserDownloadInbox(options: { bridge: SidebarBridge; getProjectId(): string | null; onImported(job: BrowserDownload): void }) {
  const root = document.createElement('section'); root.className = 'ag-download-inbox'; root.setAttribute('aria-label', '일반 받은 파일');
  const heading = document.createElement('h3'); heading.textContent = '받은 파일';
  const list = document.createElement('div'); list.className = 'ag-download-inbox-list';
  const message = document.createElement('p'); message.setAttribute('role', 'status');
  const viewer = document.createElement('section'); viewer.className = 'ag-download-inbox-viewer'; viewer.hidden = true; viewer.setAttribute('aria-label', '받은 PDF');
  const toolbar = document.createElement('div'); const name = document.createElement('strong'); const pageLabel = document.createElement('span'); const canvas = document.createElement('canvas');
  function button(label: string, text: string, action: () => void, host: HTMLElement): HTMLButtonElement {
    const node = document.createElement('button'); node.type = 'button'; node.textContent = text; node.setAttribute('aria-label', label); node.addEventListener('click', action); host.append(node); return node;
  }
  const previous = button('이전 PDF 페이지', '←', () => { if (page > 1) { page--; void renderPage(); } }, toolbar);
  const next = button('다음 PDF 페이지', '→', () => { if (pdf && page < pdf.numPages) { page++; void renderPage(); } }, toolbar);
  toolbar.append(pageLabel);
  button('받은 PDF 닫기', '닫기', closeViewer, toolbar); viewer.append(name, toolbar, canvas);
  root.append(heading, message, list, viewer);
  let jobs: BrowserDownload[] = []; let visible = false; let disposed = false; let sequence = 0; let viewerSequence = 0; let pdf: PDFDocumentProxy | null = null; let page = 1; let render: RenderTask | null = null;
  function paint(): void {
    list.replaceChildren();
    const inbox = jobs.filter((job) => !job.target.projectId && !job.inboxMovedAt);
    message.textContent = inbox.length ? '프로젝트 없이 받은 자료입니다.' : '프로젝트 없이 받은 자료가 여기에 모입니다.';
    const labels: Record<BrowserDownload['state'], string> = { downloading: '받는 중', downloaded: '열 수 있음', importing: '프로젝트로 이동 중', imported: '프로젝트에 저장됨', cancelled: '취소됨', interrupted: '연결 끊김', 'import-failed': '프로젝트 이동 실패' };
    for (const job of inbox) {
      const row = document.createElement('article'); row.className = 'ag-download-inbox-row'; row.dataset.downloadId = job.downloadId;
      const title = document.createElement('strong'); title.textContent = job.filename;
      const status = document.createElement('span'); status.textContent = `${labels[job.state]} · ${(job.size / 1024).toFixed(0)} KB`;
      row.append(title, status);
      if (job.error) { const failed = document.createElement('p'); failed.textContent = typeof job.error === 'string' ? job.error : job.error.message ?? '파일 처리를 완료하지 못했습니다.'; row.append(failed); }
      if (['downloaded', 'imported', 'importing', 'import-failed'].includes(job.state)) button('받은 파일 열기', '열기', () => { void open(job); }, row);
      if (options.getProjectId() && ['downloaded', 'import-failed'].includes(job.state)) button('현재 프로젝트로 이동', '프로젝트로 이동', () => {
        const projectId = options.getProjectId(); if (!projectId) return;
        void options.bridge.importBrowserDownload(job.downloadId, projectId).then((imported) => {
          jobs = jobs.map((entry) => entry.downloadId === imported.downloadId ? imported : entry); paint(); options.onImported(imported);
        }).catch((error) => { message.textContent = error instanceof Error ? error.message : String(error); });
      }, row);
      list.append(row);
    }
  }
  async function refresh(): Promise<void> {
    const token = ++sequence;
    try {
      const response = await options.bridge.requestBrowser<BrowserResult>('downloads', { action: 'list' });
      if (disposed || token !== sequence) return;
      jobs = response.downloads ?? response.jobs ?? []; paint();
    } catch (error) { if (!disposed && token === sequence) message.textContent = error instanceof Error ? error.message : String(error); }
  }
  function closeViewer(): void { viewerSequence++; render?.cancel(); render = null; if (pdf) void pdf.destroy(); pdf = null; viewer.hidden = true; canvas.width = 1; canvas.height = 1; }
  async function renderPage(): Promise<void> {
    const current = pdf; if (!current) return;
    const token = viewerSequence; render?.cancel();
    try {
      const pdfPage = await current.getPage(page); if (disposed || token !== viewerSequence || current !== pdf) return;
      const original = pdfPage.getViewport({ scale: 1 }); const scale = Math.min(1.5, Math.max(280, viewer.clientWidth - 24) / original.width);
      const viewport = pdfPage.getViewport({ scale }); const dpr = Math.min(devicePixelRatio || 1, 2);
      canvas.width = Math.floor(viewport.width * dpr); canvas.height = Math.floor(viewport.height * dpr); canvas.style.width = `${viewport.width}px`; canvas.style.height = `${viewport.height}px`;
      render = pdfPage.render({ canvasContext: canvas.getContext('2d')!, viewport, transform: dpr === 1 ? undefined : [dpr, 0, 0, dpr, 0, 0] }); await render.promise;
      if (disposed || token !== viewerSequence) return;
      pageLabel.textContent = `${page} / ${current.numPages}`; previous.disabled = page === 1; next.disabled = page === current.numPages;
    } catch (error) { if (error instanceof Error && error.name !== 'RenderingCancelledException') message.textContent = error.message; }
  }
  async function open(job: BrowserDownload): Promise<void> {
    closeViewer(); const token = viewerSequence;
    viewer.hidden = false; name.textContent = job.filename; pageLabel.textContent = '여는 중…';
    try {
      const bytes = new Uint8Array(await (await options.bridge.readBrowserDownload(job.downloadId)).arrayBuffer());
      if (disposed || token !== viewerSequence) return;
      if (String.fromCharCode(...bytes.slice(0, 5)) !== '%PDF-') throw new Error('이 파일은 PDF가 아닙니다. 원본은 받은 파일에 보관되어 있습니다.');
      const loaded = await (await loadPdfjs()).getDocument(pdfDocumentParams(bytes)).promise;
      if (disposed || token !== viewerSequence) { void loaded.destroy(); return; }
      pdf = loaded; page = 1; await renderPage();
      viewer.scrollIntoView({ block: 'nearest' });
    } catch (error) { if (!disposed && token === viewerSequence) { message.textContent = error instanceof Error ? error.message : String(error); pageLabel.textContent = '열지 못함'; } }
  }
  const unsubscribe = options.bridge.onBrowserEvent((event) => {
    if (!event.job) return;
    jobs = [event.job, ...jobs.filter((job) => job.downloadId !== event.job!.downloadId)]; if (visible) paint();
  });
  return { root, open, setVisible(next: boolean) { visible = next; if (next) { void refresh(); if (pdf) void renderPage(); } }, refresh,
    dispose() { disposed = true; sequence++; unsubscribe(); closeViewer(); root.remove(); }, };
}
