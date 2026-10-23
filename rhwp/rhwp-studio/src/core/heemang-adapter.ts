import type { Address, Caret, Doc, DocState, Engine, FontRequests, Located, LocateRequest, NavigateRequest, PageInfo as HmPage, ParagraphInfo, Rect, SelectRequest } from '../../vendor/hm-wasm/hm_wasm';
import type { DocumentInfo, PageInfo } from './types';
import type { FileSystemFileHandleLike } from '../command/file-system-access';
import type { RuntimeFontMetricsApi } from './desktop-fonts';
import { blake3Hex } from './content-hash';
import { EngineNotSupportedError, nextDocumentGeneration, nextDocumentInstance, receiveEngineFonts } from './engine-support';
import { resolveCanvasKitFontPlan, type WebFontLoadOptions } from './font-loader';
import { decodeWebFont, streamWebFontDecoders } from '../../../rhwp-shared/fonts/font-index-core.mjs';
import { readResponseBytesWithLimit } from './document-input-limits';
import { Player, decodePacket, patchImage, type PagePacket } from '../view/heemang-player';

const PX_PER_HU = 96 / 7200;
function unsupportedMargin(): never { throw new EngineNotSupportedError('쪽 여백 정보'); }
let runtime: Promise<Awaited<ReturnType<typeof initializeRuntime>>> | undefined;

async function initializeRuntime() {
  const { default: init, Engine, familyNames, capabilities } = await import('../../vendor/hm-wasm/hm_wasm');
  const { memory } = await init();
  const contract = JSON.parse(capabilities()) as { contract: number; packet: number };
  if (contract.contract !== 1 || contract.packet !== 1) throw new EngineNotSupportedError('hm-wasm 계약 버전');
  const engine = new Engine();
  const registered = new Set<string>();
  let faces = 0;
  const families = new Set<string>();
  const normalize = (name: string) => name.toLowerCase().replace(/\s/g, '');
  const register = (label: string, bytes: Uint8Array) => {
    for (const name of JSON.parse(familyNames(bytes)) as string[]) families.add(normalize(name));
    faces += engine.addFont(label, bytes);
  };
  let assets: { name: string; url: string; families: string[] }[] = [];
  const loadedAssets = new Set<string>();
  const readAsset = async (asset: { name: string; url: string }) => {
    const res = await fetch(asset.url);
    if (!res.ok) throw new Error(`Heemang 글꼴 읽기 실패: ${asset.name}`);
    return new Uint8Array(await res.arrayBuffer());
  };
  receiveEngineFonts((label, bytes) => {
    const key = `${label}:${bytes.byteLength}`;
    if (registered.has(key)) return;
    register(label, bytes);
    registered.add(key);
  });
  // 배포에 한컴 자산을 넣지 않는다. 명시적으로 설정한 개발용 파일만 받는다.
  if (import.meta.env.DEV && import.meta.env.VITE_HEEMANG_FONT_ASSETS === '1') {
    const response = await fetch('/__heemang-fonts/manifest.json');
    if (!response.ok) throw new Error(`Heemang 글꼴 목록 오류: ${response.status}`);
    assets = await response.json();
    for (const asset of assets.filter(a => /\.dat$/i.test(a.name))) {
      const bytes = await readAsset(asset);
      if (/^fontmap\.dat$/i.test(asset.name)) engine.addFontMap(bytes);
      else if (/^hftinfo\.dat$/i.test(asset.name)) engine.addHftInfo(bytes);
      else if (/\.dat$/i.test(asset.name)) engine.addCodeTable(bytes);
    }
  }
  const hasFamily = (name: string) => families.has(normalize(name));
  const loadDevFonts = async (requests: FontRequests) => {
    const wanted = new Set<string>();
    const first = (names: string[]) => {
      const name = names.find(n => hasFamily(n) || assets.some(a => a.families.some(f => normalize(f) === normalize(n))));
      if (name) wanted.add(normalize(name));
    };
    for (const request of requests.faces) { first(request.candidates); first(request.standIns); }
    for (const defaults of requests.classDefaults) first(defaults);
    // 수식 서체는 현재 fontRequests의 문서 face 목록에 없다.
    first(['HYhwpEQ', 'HancomEQN', 'Latin Modern Math']);
    for (const asset of assets) {
      if (loadedAssets.has(asset.url) || !asset.families.some(f => wanted.has(normalize(f)))) continue;
      register(asset.name, await readAsset(asset));
      loadedAssets.add(asset.url);
    }
  };
  return { engine, player: new Player(engine), memory, fontCount: () => faces, register, hasFamily, loadDevFonts };
}

/** Phase 1: 한 문서를 소유하며, 편집·저장 API는 노출하지 않는다. */
export class HeemangAdapter {
  readonly engineKind = 'heemang' as const;
  readonly readOnly = true;
  private engine!: Engine;
  private player!: Player;
  private memory!: WebAssembly.Memory;
  private fontCount!: () => number;
  private register!: (label: string, bytes: Uint8Array) => void;
  private hasFamily!: (name: string) => boolean;
  private loadDevFonts!: (requests: FontRequests) => Promise<void>;
  private readonly webFonts = new Map<string, Promise<void>>();
  private doc: Doc | null = null;
  private packets = new Map<number, PagePacket>();
  private _fileName = '';
  private _digest: string | null = null;
  documentGeneration = 0;
  documentInstance = nextDocumentInstance();
  currentFileHandle: FileSystemFileHandleLike | null = null;
  onFileNameChanged?: (name: string) => void;
  onExternalImagesInjected?: (count: number) => void;

  async initialize(): Promise<void> {
    runtime ??= initializeRuntime().catch(error => { runtime = undefined; throw error; });
    Object.assign(this, await runtime);
  }

  getRuntimeFontMetricsApi(): RuntimeFontMetricsApi {
    // desktop-fonts가 부분집합을 만들기 전에 보낸 전체 파일을 receiveEngineFonts로 받는다.
    return { register: () => JSON.stringify({ registered: true }), hasBaked: () => false };
  }

  async prepareFonts(names: string[], options: WebFontLoadOptions): Promise<void> {
    await this.loadDevFonts(JSON.parse(this.document().fontRequests()));
    const plan = resolveCanvasKitFontPlan(names, options);
    const decoder = streamWebFontDecoders();
    await Promise.all(plan.sources.map(source => {
      if (source.aliases.some(alias => this.hasFamily(alias))) return;
      let pending = this.webFonts.get(source.url);
      if (!pending) {
        pending = (async () => {
          const response = await fetch(source.url, { signal: AbortSignal.timeout(6000) });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const bytes = await readResponseBytesWithLimit(response, 32 * 1024 * 1024, '글꼴');
          const sfnt = await decodeWebFont(bytes, { decompress: decoder, maxBytes: 32 * 1024 * 1024 });
          this.register(source.url, sfnt);
        })().catch(error => { console.warn(`[Heemang] ${source.url} 글꼴 등록 실패:`, error); });
        this.webFonts.set(source.url, pending);
      }
      return pending;
    }));
    if (!this.fontCount()) throw new EngineNotSupportedError('글꼴 파일이 필요합니다. 로컬 TTF·OTF·TTC·HFT 글꼴을 연결해 주세요.');
    this.refreshLayout();
  }

  private document(): Doc {
    if (!this.doc) throw new Error('문서가 로드되지 않았습니다');
    return this.doc;
  }
  get isNewDocument(): boolean { return false; }
  get fileName(): string { return this._fileName; }
  set fileName(name: string) { this._fileName = name; this.onFileNameChanged?.(name); }
  get documentDigest(): string | null { return this._digest; }
  adoptSourceDigest(digest: string): void { this._digest = digest; }
  hasLoadedDocument(): boolean { return this.doc !== null; }
  get pageCount(): number { return this.doc ? this.state().pageCount : 0; }
  state(): DocState { return JSON.parse(this.document().state()); }
  get wasmMemoryBytes(): number { return this.memory.buffer.byteLength; }

  releaseDocument(): void {
    this.doc?.close();
    this.doc?.free();
    this.doc = null;
    this.packets.clear();
    this.currentFileHandle = null;
    this._digest = null;
    this.documentGeneration = nextDocumentGeneration();
    this.documentInstance = nextDocumentInstance();
  }

  loadDocument(bytes: Uint8Array, name = ''): DocumentInfo {
    // 잘못된 입력은 현재 문서를 닫지 않는다.
    const next = this.engine.open(bytes);
    this.releaseDocument();
    this.doc = next;
    this._digest = `blake3:${blake3Hex(bytes)}`;
    this.fileName = name;
    try { return this.getDocumentInfo(); }
    catch (error) { this.releaseDocument(); throw error; }
  }
  loadTrustedLocalFileOnce(bytes: Uint8Array, name?: string): DocumentInfo { return this.loadDocument(bytes, name); }
  getSourceFormat(): string { return this.state().format === 'hwp5' ? 'hwp' : 'hwpx'; }
  getDocumentInfo(): DocumentInfo {
    const requests = JSON.parse(this.document().fontRequests()) as FontRequests;
    return {
      version: 'hm-wasm/1', sectionCount: this.getSectionCount(), pageCount: this.pageCount,
      encrypted: false, fallbackFont: '',
      // fontNames는 모든 대체 후보까지 펼친다. 호스트에는 문서가 요청한 이름만 보낸다.
      fontsUsed: [...new Set([...requests.faces.map(face => face.name), '함초롬바탕', '함초롬돋움', 'HYhwpEQ', 'Latin Modern Math'])],
    };
  }
  getSectionCount(): number { return Math.max(-1, ...this.hmPages().map(p => p.section)) + 1; }
  private hmPages(): HmPage[] { return JSON.parse(this.document().pages()); }
  getAllPageInfo(): PageInfo[] {
    return this.hmPages().map(p => ({
      pageIndex: p.index, pageNumber: p.number, sectionIndex: p.section,
      width: p.width * PX_PER_HU, height: p.height * PX_PER_HU,
      // hm-wasm/1은 여백을 제공하지 않는다. 0으로 꾸미지 않고, 소비자가 읽으면 거절한다.
      get marginLeft() { return unsupportedMargin(); },
      get marginRight() { return unsupportedMargin(); },
      get marginTop() { return unsupportedMargin(); },
      get marginBottom() { return unsupportedMargin(); },
      get marginHeader() { return unsupportedMargin(); },
      get marginFooter() { return unsupportedMargin(); },
    }));
  }
  getPageInfo(index: number): PageInfo {
    const page = this.getAllPageInfo()[index];
    if (!page) throw new RangeError(`No page ${index}`);
    return page;
  }
  refreshLayout(): void { this.packets.clear(); }

  page(index: number): PagePacket {
    const state = this.state();
    const cached = this.packets.get(index);
    if (cached?.fontGeneration === state.fontGeneration && cached.layoutEpoch === state.layoutEpoch) {
      this.packets.delete(index);
      this.packets.set(index, cached);
      return cached;
    }
    // wasm-bindgen 반환값도 다음 엔진 호출 전에 소유 바이트로 복사한다.
    const packet = decodePacket(this.document().page(index).slice());
    this.packets.set(index, packet);
    while (this.packets.size > 8) this.packets.delete(this.packets.keys().next().value!);
    return packet;
  }

  renderPageToCanvas(index: number, canvas: HTMLCanvasElement, scale: number): void {
    const packet = this.page(index);
    canvas.width = Math.ceil(packet.width * PX_PER_HU * scale);
    canvas.height = Math.ceil(packet.height * PX_PER_HU * scale);
    canvas.dataset.heemangPage = String(index);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas2D를 사용할 수 없습니다');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    this.player.paint(ctx, packet, 96 * scale, (item, dpi) =>
      patchImage(this.document().patch(index, item, dpi).slice(), (w, h) => new OffscreenCanvas(w, h)));
  }

  locate(request: LocateRequest): Located | Caret | null { return JSON.parse(this.document().locate(JSON.stringify(request))); }
  select(request: SelectRequest): Rect[] {
    if (JSON.stringify([request.from.section, request.from.steps ?? []]) !== JSON.stringify([request.to.section, request.to.steps ?? []])) {
      throw new EngineNotSupportedError('서로 다른 문단 목록 사이의 선택');
    }
    return JSON.parse(this.document().select(JSON.stringify(request)));
  }
  navigate(request: NavigateRequest): Located | null { return JSON.parse(this.document().navigate(JSON.stringify(request))); }
  paragraphs(section: number, steps: Address['steps'] = [], from = 0, count = 1024): ParagraphInfo[] {
    return JSON.parse(this.document().query(JSON.stringify({ kind: 'paragraphs', list: { section, steps }, from, count })));
  }
  getParagraphText(section: number, para: number): string { return this.paragraphs(section, [], para, 1)[0]?.text ?? ''; }
  getParagraphCount(section: number): number {
    let count = 0;
    while (true) {
      const page = this.paragraphs(section, [], count);
      count += page.length;
      if (page.length < 1024) return count;
    }
  }
  isSubsecondHotpatchEnabled(): boolean { return false; }
  hasTableTransposeClipboard(): boolean { return false; }
  hasInternalClipboard(): boolean { return false; }
  hasHmlExportCapability(): boolean { return false; }
  getShowControlCodes(): boolean { return false; }
  getShowParagraphMarks(): boolean { return false; }
  getClipEnabled(): boolean { return true; }
}
