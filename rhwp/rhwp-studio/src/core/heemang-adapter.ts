import type { Address, Affinity, Caret, CharPatch, Copied, Doc, DocState as HmDocState, EditOp, Engine, FaceCandidates, FontFileSource, FontRequests, Located, LocateRequest, Match, NavigateRequest, PageInfo as HmPage, ParagraphInfo, ParaPatch, Receipt, Rect, SearchResult, Selected, SelectRequest, Selection } from '../../vendor/hm-wasm/hm_wasm';
import { copyAddress, copySelection, editingText, formattingPatch, replacementOps, sameAddress, isCellSelection, type EditingSelection, type CellSelection, type TextSelection } from './heemang-editing';
import type { DocumentInfo, PageInfo } from './types';
import type { FileSystemFileHandleLike } from '../command/file-system-access';
import { getSystemFontHost, loadDesktopFontIndex, type RuntimeFontMetricsApi } from './desktop-fonts';
import { blake3Hex, setBlake3WasmApi } from './content-hash';
import { EngineNotSupportedError, nextDocumentGeneration, nextDocumentInstance, receiveEngineFonts, type EngineFontReader } from './engine-support';
import { resolveCanvasKitFontPlan, type WebFontLoadOptions } from './font-loader';
import { decodeWebFont, streamWebFontDecoders } from '../../../rhwp-shared/fonts/font-index-core.mjs';
import { readResponseBytesWithLimit } from './document-input-limits';
import { Pictures, Player, decodePacket, patchImage, type PagePacket } from '../view/heemang-player';
import { guardHeemangEngineCalls } from './engine-trap';

export type { Address, Affinity, Caret, CharPatch, Copied, Located, LocateRequest, Match, Motion, NavigateRequest, ParagraphInfo, ParaPatch, Receipt, Rect, SearchResult, Selected, SelectRequest, Step } from '../../vendor/hm-wasm/hm_wasm';
export type { TextSelection, CellSelection, EditingSelection } from './heemang-editing';
export type DocState = Omit<HmDocState, 'format'> & { format: 'hwp5' | 'hwpx' | 'hwp3' };
export interface EditResult { caret: Located; anchor?: Located | null; receipt: Receipt; selection?: EditingSelection }
export interface CutResult { clipboard: Copied; edit: EditResult | null }
export interface ReplaceAllResult { count: number; edit: EditResult | null }

const PX_PER_HU = 96 / 7200;
function unsupportedMargin(): never { throw new EngineNotSupportedError('쪽 여백 정보'); }
let runtime: Promise<Awaited<ReturnType<typeof initializeRuntime>>> | undefined;
// native clipboard는 같은 Engine의 문서들이 공유한다.
let internalClipboard: { engine: Engine; text: string } | null = null;

type FontAsset = { name: string; url: string; size: number; families: string[]; host?: boolean };
const normalize = (name: string) => name.toLowerCase().replace(/\s/g, '');
const copyKey = (name: string, size: number) => `${name.split(/[\\/]/).pop()!.toLowerCase()}:${size}`;
const fontFile = (b: Uint8Array): FontFileSource => ({ size: b.length, read: (o: number, n: number) => b.subarray(o, o + n) });

async function initializeRuntime() {
  const { default: init, Blake3Hasher, Doc, Engine, fileFamilyNames, capabilities, brotliDecompress } = await import('../../vendor/hm-wasm/hm_wasm');
  const { memory } = await init();
  guardHeemangEngineCalls(Doc.prototype);
  setBlake3WasmApi(() => new Blake3Hasher());
  const contract = JSON.parse(capabilities()) as { contract: number; packet: number };
  if (contract.contract !== 1 || contract.packet !== 1) throw new EngineNotSupportedError('hm-wasm 계약 버전');
  const engine = new Engine();
  const registered = new Set<string>();
  const sources = new Map<string, EngineFontReader>();
  let faces = 0;
  const families = new Set<string>();
  const register = (label: string, bytes: Uint8Array, names?: string[], name = label, refill = false) => {
    const key = copyKey(name, bytes.length);
    if (!refill && registered.has(key)) return;
    const file = fontFile(bytes);
    const added = engine.addFontFile(label, file);
    if (!added && !refill) return;
    for (const family of names ?? JSON.parse(fileFamilyNames(file)) as string[]) families.add(normalize(family));
    faces += added;
    registered.add(key);
  };
  const assets: FontAsset[] = [];
  const loadedAssets = new Set<string>();
  const pending = new Map<string, Promise<void>>();
  const readAsset = async (asset: FontAsset) => {
    const res = await fetch(asset.url);
    if (!res.ok) throw new Error(`Heemang 글꼴 읽기 실패: ${asset.name}`);
    return new Uint8Array(await res.arrayBuffer());
  };
  receiveEngineFonts((label, bytes, read) => {
    if (read) sources.set(label, read);
    register(label, bytes);
  });
  // 배포에 한컴 자산을 넣지 않는다. 명시적으로 설정한 개발용 파일만 받는다.
  if (import.meta.env.DEV && import.meta.env.VITE_HEEMANG_FONT_ASSETS === '1') {
    const response = await fetch('/__heemang-fonts/manifest.json');
    if (!response.ok) throw new Error(`Heemang 글꼴 목록 오류: ${response.status}`);
    assets.push(...await response.json());
    for (const asset of assets) sources.set(asset.url, () => readAsset(asset));
    for (const asset of assets.filter(a => /\.dat$/i.test(a.name))) {
      const bytes = await readAsset(asset);
      if (/^fontmap\.dat$/i.test(asset.name)) engine.addFontMap(bytes);
      else if (/^hftinfo\.dat$/i.test(asset.name)) engine.addHftInfo(bytes);
      else engine.addCodeTable(bytes);
    }
  }
  const hasFamily = (name: string) => families.has(normalize(name));
  const hasAvailableFamily = (name: string) => hasFamily(name) || assets.some(a => a.families.some(f => normalize(f) === normalize(name)));
  const loadFonts = async (requests: FontRequests) => {
    // 일반 실행에서도 호스트 색인에서 엔진이 고른 대체 서체를 직접 연결한다.
    const host = getSystemFontHost();
    if (host) {
      const index = await loadDesktopFontIndex();
      for (const face of index.faces) {
        const url = `heemang-host:${face.id}`;
        if (sources.has(url)) continue;
        assets.push({ name: face.path, url, size: face.size, families: face.families, host: true });
        sources.set(url, () => host.read(face.id));
      }
    }
    const wanted = new Set<string>();
    const first = (names: string[] = []) => names.find(hasAvailableFamily);
    const want = (name: string | undefined) => { if (name) wanted.add(normalize(name)); };
    for (const request of requests.faces) want(first(request.candidates));
    const defaults = first(requests.classDefaults[0]);
    for (const name of defaults ? [defaults] : requests.classDefaults.slice(1).map(first)) want(name);
    for (const name of requests.fallbacks ?? []) want(first([name]));
    const copies = new Set(registered);
    await Promise.all(assets.map(asset => {
      const key = copyKey(asset.name, asset.size);
      if (loadedAssets.has(asset.url) || copies.has(key) || !asset.families.some(f => wanted.has(normalize(f)))) return;
      copies.add(key);
      let load = pending.get(asset.url);
      if (!load) {
        load = (async () => {
          const bytes = await sources.get(asset.url)!();
          if (!bytes) throw new Error(`Heemang 글꼴 읽기 실패: ${asset.name}`);
          const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
          register(asset.url, view, asset.host ? undefined : asset.families, asset.name);
          loadedAssets.add(asset.url);
        })().finally(() => pending.delete(asset.url));
        pending.set(asset.url, load);
      }
      return load;
    }));
  };
  const refillOutlines = async () => {
    const paths = JSON.parse(engine.outlineRequests()) as string[];
    const loads = paths.filter(path => sources.has(path)).map(path => {
      let load = pending.get(path);
      if (!load) {
        load = (async () => {
          const bytes = await sources.get(path)!();
          if (!bytes) throw new Error(`Heemang 글꼴 다시 읽기 실패: ${path}`);
          register(path, bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes), [], path, true);
        })().finally(() => pending.delete(path));
        pending.set(path, load);
      }
      return load;
    });
    await Promise.all(loads);
    return loads.length > 0;
  };
  // Brotli DecompressionStream 이 없는 브라우저(Chrome 포함)는 엔진의 해제기로 WOFF2 를 읽는다.
  const webFontDecoders = () => ({
    brotli: (data: Uint8Array, outLength: number) => brotliDecompress(data, outLength),
    ...streamWebFontDecoders(),
  });
  return { engine, player: new Player(engine), memory, fontCount: () => faces, register, hasFamily, hasAvailableFamily, loadFonts, refillOutlines, sources, webFontDecoders };
}

/** 문서와 엔진의 편집·선택 이력을 연결한다. */
export class HeemangAdapter {
  readonly engineKind = 'heemang' as const;
  get readOnly(): boolean { return !this.doc || !this.editable; }
  private engine!: Engine;
  private player!: Player;
  private memory!: WebAssembly.Memory;
  private fontCount!: () => number;
  private register!: (label: string, bytes: Uint8Array) => void;
  private hasFamily!: (name: string) => boolean;
  private hasAvailableFamily!: (name: string) => boolean;
  private loadFonts!: (requests: FontRequests) => Promise<void>;
  private refillOutlines!: () => Promise<boolean>;
  private sources!: Map<string, EngineFontReader>;
  private webFontDecoders!: () => { brotli?: (data: Uint8Array, outLength: number) => Uint8Array | Promise<Uint8Array>; zlib?: (data: Uint8Array, outLength: number) => Promise<Uint8Array> };
  private fontsPrepared = false;
  private readonly canvasPaints = new Map<HTMLCanvasElement, { index: number; scale: number }>();
  private pictureFrame = 0;
  private readonly pictures = new Pictures(() => {
    if (this.pictureFrame) return;
    this.pictureFrame = requestAnimationFrame(() => {
      this.pictureFrame = 0;
      for (const [canvas, { index, scale }] of this.canvasPaints) {
        if (!canvas.isConnected) { this.canvasPaints.delete(canvas); continue; }
        this.renderPageToCanvas(index, canvas, scale);
      }
    });
  });
  private readonly webFonts = new Map<string, Promise<void>>();
  private doc: Doc | null = null;
  private packets = new Map<number, PagePacket>();
  private pageMetadata: { doc: Doc; layoutEpoch: number; fontGeneration: number; pages: HmPage[] } | null = null;
  private _fileName = '';
  private sourceFormat = 'hwpx';
  private _digest: string | null = null;
  private editable = false;
  // native가 아직 선택을 반환하지 않는 서식·rich paste 경로만 보완한다.
  private readonly selectionFallbacks = new Map<number, { before: EditingSelection; after: EditingSelection }>();
  private historyId = 0;
  private serialized: { instance: number; epoch: number; digest: string } | null = null;
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
    const doc = this.document();
    const current = () => this.doc === doc;
    const requests = () => JSON.parse(doc.fontRequests()) as FontRequests;
    await this.loadFonts(requests());
    if (!current()) return;
    // 등록한 face에 없는 문자의 fallback도 첫 레이아웃 전에 연결한다.
    await this.loadFonts(requests());
    if (!current()) return;
    const req = requests();
    const defaults = req.classDefaults;
    const satisfied = req.faces.every(face => face.candidates.some(this.hasFamily))
      && (!defaults.some(list => list.length) || defaults.some(list => list.some(this.hasFamily)))
      && (req.fallbacks ?? []).every(name => !this.hasAvailableFamily(name) || this.hasFamily(name));
    if (!satisfied) {
      const plan = resolveCanvasKitFontPlan(names.filter(name => !this.hasFamily(name)), options);
      const decoder = this.webFontDecoders();
      await Promise.all(plan.sources.map(source => {
        if (source.aliases.some(alias => this.hasFamily(alias))) return;
        let pending = this.webFonts.get(source.url);
        if (!pending) {
          const read = async () => {
            const response = await fetch(source.url, { signal: AbortSignal.timeout(6000) });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const bytes = await readResponseBytesWithLimit(response, 32 * 1024 * 1024, '글꼴');
            return decodeWebFont(bytes, { decompress: decoder, maxBytes: 32 * 1024 * 1024 });
          };
          this.sources.set(source.url, read);
          pending = read().then(bytes => this.register(source.url, bytes))
            .catch(error => { console.warn(`[Heemang] ${source.url} 글꼴 등록 실패:`, error); });
          this.webFonts.set(source.url, pending);
        }
        return pending;
      }));
      if (!current()) return;
      await this.loadFonts(requests());
      if (!current()) return;
    }
    if (!this.fontCount()) throw new EngineNotSupportedError('글꼴 파일이 필요합니다. 로컬 TTF·OTF·TTC·HFT 글꼴을 연결해 주세요.');
    doc.state();
    await this.loadFonts(requests());
    if (!current()) return;
    this.fontsPrepared = true;
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
  adoptSourceDigest(digest: string): void { if (this.doc) this._digest = digest; }
  hasLoadedDocument(): boolean { return this.doc !== null; }
  get pageCount(): number { return this.doc && this.fontsPrepared ? this.state().pageCount : 0; }
  state(): DocState { return JSON.parse(this.document().state()); }
  get wasmMemoryBytes(): number { return this.memory.buffer.byteLength; }

  releaseDocument(): void {
    if (this.pictureFrame) cancelAnimationFrame(this.pictureFrame);
    this.pictureFrame = 0;
    this.pictures.clear();
    this.canvasPaints.clear();
    this.doc?.close();
    this.doc?.free();
    this.doc = null;
    this.fontsPrepared = false;
    this.packets.clear();
    this.pageMetadata = null;
    this.currentFileHandle = null;
    this._digest = null;
    this.editable = false;
    this.serialized = null;
    this.historyId = 0;
    this.selectionFallbacks.clear();
    this.documentGeneration = nextDocumentGeneration();
    this.documentInstance = nextDocumentInstance();
  }

  loadDocument(bytes: Uint8Array, name = ''): DocumentInfo {
    // 잘못된 입력은 현재 문서를 닫지 않는다.
    const next = this.engine.open(bytes);
    this.releaseDocument();
    this.doc = next;
    // open이 검증한 ZIP은 HWPX, CFB·HWP3는 HWP다. 여기서 state를 읽으면 조판된다.
    this.sourceFormat = bytes[0] === 0x50 && bytes[1] === 0x4b ? 'hwpx' : 'hwp';
    this.editable = this.sourceFormat === 'hwpx' || [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1].every((b, i) => bytes[i] === b);
    this._digest = `blake3:${blake3Hex(bytes)}`;
    this.fileName = name;
    try { return this.getDocumentInfo(); }
    catch (error) { this.releaseDocument(); throw error; }
  }
  loadTrustedLocalFileOnce(bytes: Uint8Array, name?: string): DocumentInfo { return this.loadDocument(bytes, name); }
  getSourceFormat(): string { return this.sourceFormat; }
  getDocumentInfo(): DocumentInfo {
    const requests = JSON.parse(this.document().fontRequests()) as FontRequests;
    return {
      version: 'hm-wasm/1', sectionCount: this.fontsPrepared ? this.getSectionCount() : 1, pageCount: this.fontsPrepared ? this.pageCount : 0,
      encrypted: false, fallbackFont: '',
      // fontNames는 모든 대체 후보까지 펼친다. 호스트에는 문서가 요청한 이름만 보낸다.
      fontsUsed: [...new Set(requests.faces.map(face => face.name))],
    };
  }
  getSectionCount(): number { return Math.max(-1, ...this.hmPages().map(p => p.section)) + 1; }
  private hmPages(): HmPage[] {
    const doc = this.document();
    // state는 대기 중인 조판과 공유 엔진의 글꼴 변경을 먼저 반영한다.
    const { layoutEpoch, fontGeneration } = this.state();
    const cached = this.pageMetadata;
    if (cached?.doc === doc && cached.layoutEpoch === layoutEpoch && cached.fontGeneration === fontGeneration) return cached.pages;
    const pages: HmPage[] = JSON.parse(doc.pages());
    this.pageMetadata = { doc, layoutEpoch, fontGeneration, pages };
    return pages;
  }
  getAllPageInfo(): PageInfo[] { return this.hmPages().map(p => this.pageInfo(p)); }
  private pageInfo(p: HmPage): PageInfo {
    return {
      pageIndex: p.index, pageNumber: p.number, sectionIndex: p.section,
      width: p.width * PX_PER_HU, height: p.height * PX_PER_HU,
      // hm-wasm/1은 여백을 제공하지 않는다. 0으로 꾸미지 않고, 소비자가 읽으면 거절한다.
      get marginLeft() { return unsupportedMargin(); },
      get marginRight() { return unsupportedMargin(); },
      get marginTop() { return unsupportedMargin(); },
      get marginBottom() { return unsupportedMargin(); },
      get marginHeader() { return unsupportedMargin(); },
      get marginFooter() { return unsupportedMargin(); },
    };
  }
  getPageInfo(index: number): PageInfo {
    const page = this.hmPages()[index];
    if (!page) throw new RangeError(`No page ${index}`);
    return this.pageInfo(page);
  }
  refreshLayout(): void { this.packets.clear(); this.pageMetadata = null; }

  private invalidate(receipt: Receipt): void {
    if (receipt.changedPages === null) { this.packets.clear(); return; }
    for (const index of receipt.changedPages) this.packets.delete(index);
    // 전역 epoch가 바뀌어도 엔진이 보장한 나머지 쪽의 packet은 재사용한다.
    for (const packet of this.packets.values()) {
      packet.contentEpoch = receipt.contentEpoch;
      packet.layoutEpoch = receipt.layoutEpoch;
    }
  }

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

  renderPageToCanvas(index: number, canvas: HTMLCanvasElement, scale: number, refill = true): void {
    const doc = this.document();
    const paint = { index, scale };
    for (const old of this.canvasPaints.keys()) if (!old.isConnected) this.canvasPaints.delete(old);
    this.canvasPaints.set(canvas, paint);
    const packet = this.page(index);
    // 쪽 그리기(page-renderer)와 같이 내림한다. 올림하면 A4 가 794×1123 이 되어 쪽 틀이 1px 커진다.
    canvas.width = Math.max(1, Math.floor(packet.width * PX_PER_HU * scale));
    canvas.height = Math.max(1, Math.floor(packet.height * PX_PER_HU * scale));
    canvas.dataset.heemangPage = String(index);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas2D를 사용할 수 없습니다');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    this.player.paint(ctx, packet, 96 * scale, (item, dpi) =>
      patchImage(doc.patch(index, item, dpi).slice(), (w, h) => new OffscreenCanvas(w, h)),
      item => this.pictures.get(doc, index, item));
    if (!refill) return;
    void this.refillOutlines().then(refilled => {
      if (!refilled || this.doc !== doc || this.canvasPaints.get(canvas) !== paint || !canvas.isConnected) return;
      this.renderPageToCanvas(index, canvas, scale, false);
    }).catch(error => console.warn('[Heemang] 글꼴 윤곽선 연결 실패:', error));
  }

  locate(request: LocateRequest): Located | Caret | null { return JSON.parse(this.document().locate(JSON.stringify(request))); }
  select(request: SelectRequest): Rect[] { return JSON.parse(this.document().select(JSON.stringify(request))); }
  selectRange(request: SelectRequest): Selected { return JSON.parse(this.document().selectRange(JSON.stringify(request))); }

  /** 다른 목록의 wire 경계와 셀 병합은 엔진에서만 계산한다. */
  private normalized(range: EditingSelection): Selected['range'] {
    if (!isCellSelection(range)) {
      if (range.from.section !== range.to.section) throw new EngineNotSupportedError('서로 다른 구역 사이의 선택');
      this.checkSelection(range);
    }
    return this.selectRange(range).range;
  }
  private spans(range: EditingSelection, includeTables = false): TextSelection[] {
    const selected = this.normalized(range);
    if (selected.kind === 'cells' && !selected.cells.length) throw Object.assign(new RangeError('잘못된 셀 선택입니다'), { code: 'BAD_ADDRESS' });
    const wholeList = (list: { section: number; steps?: Address['steps'] }): TextSelection => {
      const count = this.getParagraphCount(list.section, list.steps);
      const first = this.paragraphs(list.section, list.steps, 0, 1)[0];
      const last = this.paragraphs(list.section, list.steps, count - 1, 1)[0];
      return { from: { ...list, para: 0, offset: first.caret[0] }, to: { ...list, para: count - 1, offset: last.caret[1] } };
    };
    const spans = selected.kind === 'text' ? [{ from: selected.from, to: selected.to }]
      : selected.cells.map(({ list }) => wholeList(list));
    // 본문의 표 제어 문자에만 서식을 주면 셀 내용은 바뀌지 않는다.
    // 완전히 선택된 표의 목록을 query로 읽어 같은 native 이력에 포함한다.
    if (includeTables) for (const { from, to } of spans) {
      for (const para of this.paragraphs(from.section, from.steps, from.para, to.para - from.para + 1)) {
        const start = para.index === from.para ? from.offset : 0;
        const end = para.index === to.para ? to.offset : para.length;
        for (const control of para.controls) {
          if (control.kind !== 'table' || control.offset < start || control.offset + 8 > end) continue;
          for (let index = 0; index < control.lists; index++) spans.push(wholeList({
            section: from.section, steps: [...(from.steps ?? []), { para: para.index, control: control.index, index }],
          }));
        }
      }
    }
    return spans;
  }
  private textRange(range: EditingSelection): TextSelection {
    const selected = this.normalized(range);
    if (selected.kind !== 'text') throw new EngineNotSupportedError('셀 블록을 입력 텍스트로 바꾸기');
    return { from: selected.from, to: selected.to };
  }
  navigate(request: NavigateRequest): Located | null { return JSON.parse(this.document().navigate(JSON.stringify(request))); }

  replaceText(range: EditingSelection, text: string): EditResult | null {
    const normalized = editingText(text);
    if (normalized) return this.edit(replacementOps(this.textRange(range), normalized), range);
    const ops = this.spans(range).slice().reverse().flatMap(span => replacementOps(span, ''));
    return this.edit(ops, range);
  }

  formatCharacters(range: EditingSelection, patch: CharPatch): EditResult | null {
    this.requireEditable();
    const spans = this.spans(range, true);
    if (spans.length === 1 && sameAddress(spans[0].from, spans[0].to) && !isCellSelection(range)) throw new EngineNotSupportedError('캐럿 위치의 입력 서식');
    const validated = formattingPatch(patch, false) as CharPatch;
    if (!Object.keys(validated).length) return null;
    return this.edit(spans.map(({ from, to }) => ({ op: 'formatChars', from, to, patch: validated })), range, true);
  }

  formatParagraphs(range: EditingSelection, patch: ParaPatch): EditResult | null {
    this.requireEditable();
    const validated = formattingPatch(patch, true) as ParaPatch;
    if (!Object.keys(validated).length) return null;
    return this.edit(this.spans(range, true).map(({ from, to }) => ({ op: 'formatParas', from, to, patch: validated })), range, true);
  }

  copyText(range: EditingSelection): Copied {
    const selected = this.normalized(range);
    if (selected.kind === 'cells') {
      // native copy는 두 셀의 주소로 블록을 인식한다. 셀 목록은 엔진이 정규화했다.
      if (!selected.cells.length) throw Object.assign(new RangeError('잘못된 셀 선택입니다'), { code: 'BAD_ADDRESS' });
      const first = selected.cells[0], last = selected.cells.at(-1)!;
      const at = (list: typeof first.list): Address => ({ ...list, para: 0, offset: this.paragraphs(list.section, list.steps, 0, 1)[0].caret[0] });
      const from = at(first.list), to = at(last.list);
      if (selected.cells.length === 1) {
        to.para = this.getParagraphCount(to.section, to.steps) - 1;
        to.offset = this.paragraphs(to.section, to.steps, to.para, 1)[0].caret[1];
      }
      const copied: Copied = JSON.parse(this.document().copy(JSON.stringify({ from, to })));
      if (selected.cells.length === 1) copied.html = `<table><tr><td>${copied.html}</td></tr></table>`;
      internalClipboard = null; // 셀 블록은 TSV/HTML만 제공하며 rich fragment는 만들지 않는다.
      return copied;
    }
    const { from, to } = selected;
    this.checkSelection({ from, to });
    if (sameAddress(from, to)) return { text: '', html: '' };
    for (let para = from.para; para <= to.para; para++) {
      const p = this.paragraphs(from.section, from.steps, para, 1)[0];
      const start = para === from.para ? from.offset : 0;
      const end = para === to.para ? to.offset : p.length;
      const textUnits = [...p.text].reduce((n, c) => n + (c === '\t' ? 8 : c.length), 0);
      if (/[\n\u00a0\u2007]/.test(p.text) || textUnits + p.controls.length * 8 !== p.length - 1) {
        throw new EngineNotSupportedError('줄바꿈이나 특수 제어 문자를 포함한 클립보드 문단');
      }
      if (p.controls.some(control => control.offset < end && control.offset + 8 > start)) {
        throw new EngineNotSupportedError('개체를 포함한 클립보드 선택');
      }
    }
    const copied: Copied = JSON.parse(this.document().copy(JSON.stringify({ from, to })));
    internalClipboard = { engine: this.engine, text: copied.text };
    return copied;
  }

  cutText(range: EditingSelection): CutResult {
    this.requireEditable();
    const clipboard = this.copyText(range);
    return { clipboard, edit: this.replaceText(range, '') };
  }

  pasteText(range: EditingSelection, text: string, internal = false): EditResult | null {
    this.requireEditable();
    if (!internal) return this.replaceText(range, text);
    const { from, to } = this.textRange(range);
    if (!sameAddress(from, to)) throw new EngineNotSupportedError('내부 클립보드로 선택 영역 바꾸기');
    const normalized = editingText(text);
    if (!this.hasInternalClipboard() || internalClipboard!.text !== normalized) throw new EngineNotSupportedError('일치하는 내부 클립보드 조각');
    if (!normalized) return null;
    return this.applyEdit(range, (doc, epoch) => JSON.parse(doc.paste(JSON.stringify({ at: from, expectedEpoch: epoch, text: normalized }))));
  }

  search(text: string, caseSensitive = false, from?: Address, backward = false): SearchResult {
    // 기본 1000건 제한으로 replaceAll 일부만 바뀌는 일을 막는다.
    return JSON.parse(this.document().search(JSON.stringify({ text: editingText(text), caseSensitive, limit: 0xffffffff, from, backward })));
  }

  replaceMatch(match: Match, text: string, expectedEpoch: number): EditResult | null {
    this.requireEditable();
    this.checkEpoch(expectedEpoch);
    return this.replaceText(match, text);
  }

  replaceAll(text: string, replacement: string, caseSensitive = false, before?: EditingSelection): ReplaceAllResult {
    this.requireEditable();
    if (before) this.normalized(before);
    const normalized = editingText(replacement);
    const found = this.search(text, caseSensitive);
    if (!found.matches.length) return { count: 0, edit: null };
    const ops = found.matches.slice().reverse().flatMap(match => replacementOps(match, normalized));
    this.checkEpoch(found.contentEpoch);
    return { count: found.matches.length, edit: this.edit(ops, before ?? found.matches[0]) };
  }

  split(range: EditingSelection): EditResult | null {
    const ordered = this.textRange(range);
    return this.edit([...replacementOps(ordered, ''), { op: 'split', at: ordered.from }], range);
  }

  deleteBackward(range: EditingSelection): EditResult | null { return this.deleteDirection(range, 'left'); }
  deleteForward(range: EditingSelection): EditResult | null { return this.deleteDirection(range, 'right'); }

  private deleteDirection(range: EditingSelection, motion: 'left' | 'right'): EditResult | null {
    if (isCellSelection(range)) return this.replaceText(range, '');
    const ordered = this.textRange(range);
    if (!sameAddress(ordered.from, ordered.to)) return this.edit(replacementOps(ordered, ''), range);
    this.requireEditable();
    // 엔진의 grapheme/control 경계를 따른다. 문단 끝에서는 인접 문단과 join한다.
    const next = this.navigate({ position: ordered.from, motion });
    if (!next || sameAddress(next.position, ordered.from)) return null;
    return this.edit(replacementOps({ from: ordered.from, to: next.position }, ''), range);
  }

  private requireEditable(): void {
    this.document();
    if (this.readOnly) throw new EngineNotSupportedError('이 형식의 편집 및 저장');
  }

  private checkEpoch(expected: number): void {
    if (!Number.isInteger(expected) || expected !== this.state().contentEpoch) {
      throw Object.assign(new Error('검색 후 문서가 변경되었습니다'), { code: 'STALE_EPOCH' });
    }
  }

  private checkSelection(range: TextSelection): void {
    for (const at of [range.from, range.to]) {
      const values = [at.section, at.para, at.offset, ...(at.steps ?? []).flatMap(s => [s.para, s.control, s.index])];
      if (values.some(n => !Number.isInteger(n) || n < 0 || n > 0xffffffff)) throw Object.assign(new RangeError('잘못된 문서 위치입니다'), { code: 'BAD_ADDRESS' });
      const p = this.paragraphs(at.section, at.steps, at.para, 1)[0];
      if (!p || at.offset < p.caret[0] || at.offset > p.caret[1]) {
        throw Object.assign(new RangeError('잘못된 문서 위치입니다'), { code: 'BAD_ADDRESS' });
      }
    }
  }

  /** 서식/붙여넣기의 사전 shape 생성과 편집 후 caret 조회 실패까지 되돌린다. */
  private checkpointed<T>(run: (doc: Doc, epoch: number) => T): T {
    const doc = this.document();
    const epoch = this.state().contentEpoch;
    const checkpoint = doc.checkpoint();
    try {
      return run(doc, epoch);
    } catch (error) {
      const restored: Receipt = JSON.parse(doc.restore(checkpoint));
      // 내용은 같아도 restore는 native epoch를 올린다. 유효한 저장 후보는 유지한다.
      if (this.serialized?.epoch === epoch) this.serialized = { ...this.serialized, epoch: restored.contentEpoch };
      this.refreshLayout();
      throw error;
    } finally {
      doc.releaseCheckpoint(checkpoint);
    }
  }

  private nativeSelection(range: EditingSelection): Selection | CellSelection {
    return isCellSelection(range) ? copySelection(range) : {
      anchor: copyAddress(range.from), focus: copyAddress(range.to),
      anchorAffinity: range.fromAffinity ?? 'downstream', focusAffinity: range.toAffinity ?? 'downstream',
    };
  }

  private edit(ops: EditOp[], before: EditingSelection, preserveSelection = false): EditResult | null {
    this.requireEditable();
    if (!ops.length) return null;
    return this.applyEdit(before, (doc, epoch) => JSON.parse(doc.transact(JSON.stringify({ expectedEpoch: epoch, ops, selection: this.nativeSelection(before) }))), preserveSelection);
  }

  private applyEdit(before: EditingSelection, mutate: (doc: Doc, epoch: number) => Receipt, preserveSelection = false): EditResult | null {
    const changed = this.checkpointed((doc, epoch) => {
      const receipt = mutate(doc, epoch);
      if (receipt.contentEpoch === epoch) return null;
      const result = this.editResult(receipt, preserveSelection ? before : undefined);
      return { receipt, result };
    });
    if (!changed) return null;
    const { receipt, result } = changed;
    // transact의 text selection은 native 이력에 있다. 아직 누락된 응답만 보관한다.
    if (preserveSelection || !receipt.selection) {
      this.selectionFallbacks.set(receipt.historyId, {
        before: copySelection(before), after: preserveSelection ? copySelection(before) : {
          from: copyAddress(result.anchor?.position ?? result.caret.position), to: copyAddress(result.caret.position),
          fromAffinity: result.anchor?.affinity ?? result.caret.affinity, toAffinity: result.caret.affinity,
        },
      });
    }
    this.historyId = receipt.historyId;
    this.invalidate(receipt);
    return result;
  }

  undoEdit(): EditResult | null { return this.historyEdit(false); }
  redoEdit(): EditResult | null { return this.historyEdit(true); }
  canUndo(): boolean { return this.doc !== null && this.state().undo > 0; }
  canRedo(): boolean { return this.doc !== null && this.state().redo > 0; }

  private historyEdit(redo: boolean): EditResult | null {
    this.requireEditable();
    const changed = this.checkpointed(doc => {
      const receipt: Receipt | null = JSON.parse(redo ? doc.redo() : doc.undo());
      return receipt ? { receipt, result: this.editResult(receipt, !receipt.selection
        ? (redo ? this.selectionFallbacks.get(receipt.historyId)?.after : this.selectionFallbacks.get(this.historyId)?.before) : undefined) } : null;
    });
    if (!changed) return null;
    this.historyId = changed.receipt.historyId;
    this.invalidate(changed.receipt);
    return changed.result;
  }

  private editResult(receipt: Receipt, fallback?: EditingSelection): EditResult {
    const native = receipt.selection as Selection | CellSelection | undefined;
    const selection: EditingSelection | undefined = fallback ?? (native && ('kind' in native ? native : {
      from: native.anchor, to: native.focus, fromAffinity: native.anchorAffinity, toAffinity: native.focusAffinity,
    })) ?? (receipt.caret ? { from: receipt.caret, to: receipt.caret } : undefined);
    if (!selection) throw new EngineNotSupportedError('편집 결과의 선택');
    const locate = (position: Address, affinity: Affinity = 'downstream'): Located => {
      const caret = this.locate({ kind: 'caret', position, affinity }) as Caret | null;
      if (!caret) throw new EngineNotSupportedError('편집 위치의 caret 조회');
      return { position: copyAddress(position), affinity, caret };
    };
    if (isCellSelection(selection)) {
      const range = this.normalized(selection);
      if (range.kind !== 'cells' || !range.cells.length) throw new EngineNotSupportedError('셀 선택의 caret 조회');
      const at = (list: typeof range.cells[number]['list']): Address => ({ ...list, para: 0, offset: this.paragraphs(list.section, list.steps, 0, 1)[0].caret[0] });
      return { receipt, selection: copySelection(selection), caret: locate(at(range.cells.at(-1)!.list)), anchor: locate(at(range.cells[0].list)) };
    }
    return { receipt, caret: locate(selection.to, selection.toAffinity), anchor: sameAddress(selection.from, selection.to) && (selection.fromAffinity ?? 'downstream') === (selection.toAffinity ?? 'downstream') ? null : locate(selection.from, selection.fromAffinity) };
  }

  /** 같은 형식만 직렬화한다. 실제 파일 쓰기 성공 후 markSaved를 호출한다. */
  serialize(markSaved = false): Uint8Array {
    this.requireEditable();
    const epoch = this.state().contentEpoch;
    const bytes = this.document().serialize(false).slice();
    this.serialized = { instance: this.documentInstance, epoch, digest: `blake3:${blake3Hex(bytes)}` };
    if (markSaved) this.markSaved();
    return bytes;
  }

  /** 비동기 파일 쓰기 중 새 편집이 생겼으면 saved로 바꾸지 않는다. */
  markSaved(): boolean {
    const saved = this.serialized;
    if (!saved || !this.doc || saved.instance !== this.documentInstance || saved.epoch !== this.state().contentEpoch) return false;
    this.document().markSaved(saved.epoch);
    this._digest = saved.digest;
    this.serialized = null;
    return true;
  }

  paragraphs(section: number, steps: Address['steps'] = [], from = 0, count = 1024): ParagraphInfo[] {
    return JSON.parse(this.document().query(JSON.stringify({ kind: 'paragraphs', list: { section, steps }, from, count })));
  }
  getParagraphText(section: number, para: number, steps: Address['steps'] = []): string { return this.paragraphs(section, steps, para, 1)[0]?.text ?? ''; }
  getParagraphCount(section: number, steps: Address['steps'] = []): number {
    let count = 0;
    while (true) {
      const page = this.paragraphs(section, steps, count);
      count += page.length;
      if (page.length < 1024) return count;
    }
  }
  isSubsecondHotpatchEnabled(): boolean { return false; }
  hasTableTransposeClipboard(): boolean { return false; }
  hasInternalClipboard(): boolean { return internalClipboard !== null && internalClipboard.engine === this.engine; }
  hasHmlExportCapability(): boolean { return false; }
  getShowControlCodes(): boolean { return false; }
  getShowParagraphMarks(): boolean { return false; }
  getClipEnabled(): boolean { return true; }

  // ─── WasmBridge 위임부가 쓰는 저수준 접근 (src/core/hm/) ───────────────

  /** 열린 엔진 문서. 없으면 던진다. */
  hmDoc(): Doc { return this.document(); }
  /** 문서들이 글꼴과 클립보드를 나눠 쓰는 엔진. */
  hmEngine(): Engine { return this.engine; }
  /** 브리지가 직접 낸 편집 영수증으로 바뀐 쪽의 packet만 버린다. */
  applyReceipt(receipt: Receipt): void { this.invalidate(receipt); this.pageMetadata = null; }
  /** 글꼴 준비 전에도 문서를 연 상태로 본다. 두 번째 브리지(버전·비교)는 공유 엔진의 글꼴로 조판한다. */
  markFontsPrepared(): void { this.fontsPrepared = true; }
  get fontsReady(): boolean { return this.fontsPrepared; }

  /**
   * 위젯에서 고른 글꼴 파일을 서식 변경 전에 연결한다. 문서 내용은 바꾸지 않는다. 엔진이 알려 주는 후보
   * (같은 이름, 한컴이 대신 쓰는 글꼴, 글꼴 표의 대체 글꼴) 가운데 있는 것을 연결하므로, 파일이 없는 바탕·돋움도
   * 함초롬바탕·함초롬돋움이 있으면 고를 수 있다.
   */
  async hmPrepareFontFamilies(names: string[], options: WebFontLoadOptions): Promise<void> {
    const doc = this.document();
    const wanted = [...new Set(names)].filter(Boolean);
    const missing = () => (JSON.parse(doc.query(JSON.stringify({ kind: 'fontCandidates', names: wanted }))) as FaceCandidates[])
      .filter(face => !face.resolves);
    if (!missing().length) return;
    await this.loadFonts({ faces: missing().map(({ name, candidates, standIns }) => ({ name, candidates, standIns })), classDefaults: [], fallbacks: [] });
    if (this.doc !== doc) return;
    const unresolved = missing();
    if (unresolved.length) {
      const plan = resolveCanvasKitFontPlan([...new Set(unresolved.flatMap(face => [...face.candidates, ...face.standIns]))], options);
      await Promise.all(plan.sources.map(source => {
        let pending = this.webFonts.get(source.url);
        if (!pending) {
          const read = async () => {
            const response = await fetch(source.url, { signal: AbortSignal.timeout(6000) });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const bytes = await readResponseBytesWithLimit(response, 32 * 1024 * 1024, '글꼴');
            return decodeWebFont(bytes, { decompress: this.webFontDecoders(), maxBytes: 32 * 1024 * 1024 });
          };
          this.sources.set(source.url, read);
          pending = read().then(bytes => this.register(source.url, bytes));
          this.webFonts.set(source.url, pending);
        }
        return pending;
      }));
      if (this.doc !== doc) return;
    }
    const left = missing();
    if (left.length) throw new EngineNotSupportedError(`글꼴 파일: ${left.map(face => face.name).join(', ')}`);
    this.refreshLayout();
  }
}
