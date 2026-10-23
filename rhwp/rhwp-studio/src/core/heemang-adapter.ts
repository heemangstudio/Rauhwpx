import type { Address, Affinity, Caret, CharPatch, Copied, Doc, DocState as HmDocState, EditOp, Engine, FontFileSource, FontRequests, Located, LocateRequest, Match, NavigateRequest, PageInfo as HmPage, ParagraphInfo, ParaPatch, Receipt, Rect, SearchResult, SelectRequest } from '../../vendor/hm-wasm/hm_wasm';
import { copyAddress, copySelection, editingText, formattingPatch, orderedSelection, replacementOps, sameAddress, type TextSelection } from './heemang-editing';
import type { DocumentInfo, PageInfo } from './types';
import type { FileSystemFileHandleLike } from '../command/file-system-access';
import { getSystemFontHost, loadDesktopFontIndex, type RuntimeFontMetricsApi } from './desktop-fonts';
import { blake3Hex, setBlake3WasmApi } from './content-hash';
import { EngineNotSupportedError, nextDocumentGeneration, nextDocumentInstance, receiveEngineFonts, type EngineFontReader } from './engine-support';
import { resolveCanvasKitFontPlan, type WebFontLoadOptions } from './font-loader';
import { decodeWebFont, streamWebFontDecoders } from '../../../rhwp-shared/fonts/font-index-core.mjs';
import { readResponseBytesWithLimit } from './document-input-limits';
import { Pictures, Player, decodePacket, patchImage, type PagePacket } from '../view/heemang-player';

export type { Address, Affinity, Caret, CharPatch, Copied, Located, LocateRequest, Match, Motion, NavigateRequest, ParagraphInfo, ParaPatch, Receipt, Rect, SearchResult, SelectRequest, Step } from '../../vendor/hm-wasm/hm_wasm';
export type { TextSelection } from './heemang-editing';
export type DocState = Omit<HmDocState, 'format'> & { format: 'hwp5' | 'hwpx' | 'hwp3' };
export interface EditResult { caret: Located; anchor?: Located | null; receipt: Receipt }
export interface CutResult { clipboard: Copied; edit: EditResult | null }
export interface ReplaceAllResult { count: number; edit: EditResult | null }
type SelectionHistory = { before: TextSelection; after: TextSelection; beforeId: number; afterId: number };

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
  const { default: init, Blake3Hasher, Engine, fileFamilyNames, capabilities } = await import('../../vendor/hm-wasm/hm_wasm');
  const { memory } = await init();
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
  return { engine, player: new Player(engine), memory, fontCount: () => faces, register, hasFamily, hasAvailableFamily, loadFonts, refillOutlines, sources };
}

/** 문서와 엔진 undo를 소유한다. UI history에는 선택 정보만 둔다. */
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
  private _fileName = '';
  private sourceFormat = 'hwpx';
  private _digest: string | null = null;
  private editable = false;
  private savedBytes: Uint8Array | null = null;
  private contentId = 0;
  private savedContentId = 0;
  private nextContentId = 0;
  private readonly edits: SelectionHistory[] = [];
  private readonly redos: SelectionHistory[] = [];
  private serialized: { instance: number; epoch: number; bytes: Uint8Array; digest: string } | null = null;
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
      const decoder = streamWebFontDecoders();
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
  state(): DocState {
    const state: DocState = JSON.parse(this.document().state());
    // 엔진 epoch는 undo에서도 증가한다. 저장한 history 위치로 돌아오면 clean이다.
    return { ...state, dirty: this.contentId !== this.savedContentId };
  }
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
    this.currentFileHandle = null;
    this._digest = null;
    this.editable = false;
    this.savedBytes = null;
    this.serialized = null;
    this.contentId = this.savedContentId = this.nextContentId = 0;
    this.edits.length = this.redos.length = 0;
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
    this.savedBytes = bytes.slice();
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

  renderPageToCanvas(index: number, canvas: HTMLCanvasElement, scale: number, refill = true): void {
    const doc = this.document();
    const paint = { index, scale };
    for (const old of this.canvasPaints.keys()) if (!old.isConnected) this.canvasPaints.delete(old);
    this.canvasPaints.set(canvas, paint);
    const packet = this.page(index);
    canvas.width = Math.ceil(packet.width * PX_PER_HU * scale);
    canvas.height = Math.ceil(packet.height * PX_PER_HU * scale);
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
  select(request: SelectRequest): Rect[] {
    if (JSON.stringify([request.from.section, request.from.steps ?? []]) !== JSON.stringify([request.to.section, request.to.steps ?? []])) {
      throw new EngineNotSupportedError('서로 다른 문단 목록 사이의 선택');
    }
    return JSON.parse(this.document().select(JSON.stringify(request)));
  }
  navigate(request: NavigateRequest): Located | null { return JSON.parse(this.document().navigate(JSON.stringify(request))); }

  replaceText(range: TextSelection, text: string): EditResult | null {
    const normalized = editingText(text);
    if (normalized.includes('\n')) this.requireNonemptySplit(range, normalized);
    return this.edit(replacementOps(range, normalized), range);
  }

  formatCharacters(range: TextSelection, patch: CharPatch): EditResult | null {
    this.requireEditable();
    const { from, to } = orderedSelection(range);
    if (sameAddress(from, to)) throw new EngineNotSupportedError('캐럿 위치의 입력 서식');
    const validated = formattingPatch(patch, false) as CharPatch;
    if (!Object.keys(validated).length) return null;
    this.checkSelection(range);
    return this.edit([{ op: 'formatChars', from, to, patch: validated }], range, true);
  }

  formatParagraphs(range: TextSelection, patch: ParaPatch): EditResult | null {
    this.requireEditable();
    const { from, to } = orderedSelection(range);
    const validated = formattingPatch(patch, true) as ParaPatch;
    if (!Object.keys(validated).length) return null;
    this.checkSelection(range);
    return this.edit([{ op: 'formatParas', from, to, patch: validated }], range, true);
  }

  copyText(range: TextSelection): Copied {
    const { from, to } = orderedSelection(range);
    this.checkSelection(range);
    if (sameAddress(from, to)) return { text: '', html: '' };
    // native 조각은 개체/표를 버린다. cut에서 원본만 지워지는 선택은 받지 않는다.
    for (let para = from.para; para <= to.para; para++) {
      const p = this.paragraphs(from.section, from.steps, para, 1)[0];
      const start = para === from.para ? from.offset : 0;
      const end = para === to.para ? to.offset : p.length;
      // plain_text가 생략한 단위와 soft break는 native clipboard가 복원하지 못한다.
      // wire 지도 query가 없으므로 이런 문단의 부분 선택도 보수적으로 거절한다.
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

  cutText(range: TextSelection): CutResult {
    this.requireEditable();
    const clipboard = this.copyText(range);
    return { clipboard, edit: this.edit(replacementOps(range, ''), range) };
  }

  pasteText(range: TextSelection, text: string, internal = false): EditResult | null {
    this.requireEditable();
    const { from, to } = orderedSelection(range);
    if (!internal) return this.replaceText(range, text);
    if (!sameAddress(from, to)) throw new EngineNotSupportedError('내부 클립보드로 선택 영역 바꾸기');
    const normalized = editingText(text);
    if (!this.hasInternalClipboard() || internalClipboard!.text !== normalized) {
      throw new EngineNotSupportedError('일치하는 내부 클립보드 조각');
    }
    if (!normalized) return null;
    if (normalized.includes('\n')) this.requireNonemptySplit(range, normalized);
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

  replaceAll(text: string, replacement: string, caseSensitive = false, before?: TextSelection): ReplaceAllResult {
    this.requireEditable();
    if (before) { orderedSelection(before); this.checkSelection(before); }
    const normalized = editingText(replacement);
    const found = this.search(text, caseSensitive);
    if (!found.matches.length) return { count: 0, edit: null };
    if (normalized.startsWith('\n') && normalized.endsWith('\n')
      && found.matches.some((match, i) => i > 0 && sameAddress(found.matches[i - 1].to, match.from))) {
      throw new EngineNotSupportedError('빈 문단을 만드는 Enter 조판');
    }
    const ops = found.matches.slice().reverse().flatMap(match => {
      if (normalized.includes('\n')) this.requireNonemptySplit(match, normalized);
      return replacementOps(match, normalized);
    });
    this.checkEpoch(found.contentEpoch);
    return { count: found.matches.length, edit: this.edit(ops, before ?? found.matches[0]) };
  }

  split(range: TextSelection): EditResult | null {
    this.requireNonemptySplit(range, '\n');
    const ordered = orderedSelection(range);
    return this.edit([...replacementOps(ordered, ''), { op: 'split', at: ordered.from }], range);
  }

  private requireNonemptySplit(range: TextSelection, text: string): void {
    this.requireEditable();
    const { from, to } = orderedSelection(range);
    const first = this.paragraphs(from.section, from.steps, from.para, 1)[0];
    const last = this.paragraphs(to.section, to.steps, to.para, 1)[0];
    // hm-wasm은 추가된 빈 문단의 페이지 넘김을 보장하지 못한다. 숨은 편집을 만들지 않는다.
    if (text.includes('\n\n') || (text.startsWith('\n') && first?.caret[0] === from.offset)
      || (text.endsWith('\n') && last?.caret[1] === to.offset)) {
      throw new EngineNotSupportedError('빈 문단을 만드는 Enter 조판');
    }
  }

  deleteBackward(range: TextSelection): EditResult | null { return this.deleteDirection(range, 'left'); }
  deleteForward(range: TextSelection): EditResult | null { return this.deleteDirection(range, 'right'); }

  private deleteDirection(range: TextSelection, motion: 'left' | 'right'): EditResult | null {
    const ordered = orderedSelection(range);
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

  private edit(ops: EditOp[], before: TextSelection, preserveSelection = false): EditResult | null {
    this.requireEditable();
    if (!ops.length) return null;
    return this.applyEdit(before, (doc, epoch) => JSON.parse(doc.transact(JSON.stringify({ expectedEpoch: epoch, ops }))), preserveSelection);
  }

  private applyEdit(before: TextSelection, mutate: (doc: Doc, epoch: number) => Receipt, preserveSelection = false): EditResult | null {
    const selection = copySelection(before);
    const changed = this.checkpointed((doc, epoch) => {
      const receipt = mutate(doc, epoch);
      if (receipt.contentEpoch === epoch) return null;
      if (!preserveSelection && !receipt.caret) throw new EngineNotSupportedError('편집 결과의 caret');
      const after = preserveSelection ? copySelection(selection)
        : { from: copyAddress(receipt.caret!), to: copyAddress(receipt.caret!) };
      return { after, result: this.editResult(receipt, after) };
    });
    if (!changed) return null;
    const { after, result } = changed;
    this.edits.push({ before: selection, after, beforeId: this.contentId, afterId: ++this.nextContentId });
    this.contentId = this.nextContentId;
    this.redos.length = 0;
    this.refreshLayout();
    return result;
  }

  undoEdit(): EditResult | null { return this.historyEdit(false); }
  redoEdit(): EditResult | null { return this.historyEdit(true); }
  canUndo(): boolean { return this.doc !== null && this.edits.length > 0; }
  canRedo(): boolean { return this.doc !== null && this.redos.length > 0; }

  private historyEdit(redo: boolean): EditResult | null {
    this.requireEditable();
    const source = redo ? this.redos : this.edits;
    const entry = source.at(-1);
    if (!entry) return null;
    const result = this.checkpointed(doc => {
      const receipt: Receipt | null = JSON.parse(redo ? doc.redo() : doc.undo());
      return receipt ? this.editResult(receipt, redo ? entry.after : entry.before) : null;
    });
    if (!result) return null;
    source.pop();
    (redo ? this.edits : this.redos).push(entry);
    this.contentId = redo ? entry.afterId : entry.beforeId;
    this.refreshLayout();
    return result;
  }

  private editResult(receipt: Receipt, selection: TextSelection): EditResult {
    const locate = (position: Address, affinity: Affinity = 'downstream'): Located => {
      const caret = this.locate({ kind: 'caret', position, affinity }) as Caret | null;
      if (!caret) throw new EngineNotSupportedError('편집 위치의 caret 조회');
      return { position: copyAddress(position), affinity, caret };
    };
    return { receipt, caret: locate(selection.to, selection.toAffinity), anchor: sameAddress(selection.from, selection.to) ? null : locate(selection.from, selection.fromAffinity) };
  }

  /** 같은 형식만 직렬화한다. 실제 파일 쓰기 성공 후 markSaved를 호출한다. */
  serialize(markSaved = false): Uint8Array {
    this.requireEditable();
    const epoch = this.state().contentEpoch;
    const native = this.document().serialize(false).slice();
    // undo로 저장한 내용에 돌아와도 엔진은 새 line segment를 쓸 수 있다.
    const saved = epoch > 0 && this.contentId === this.savedContentId ? this.savedBytes : null;
    const bytes = saved && (saved.length !== native.length || saved.some((b, i) => b !== native[i]))
      ? saved.slice() : native;
    this.serialized = { instance: this.documentInstance, epoch, bytes: bytes.slice(), digest: `blake3:${blake3Hex(bytes)}` };
    if (markSaved) this.markSaved();
    return bytes;
  }

  /** 비동기 파일 쓰기 중 새 편집이 생겼으면 saved로 바꾸지 않는다. */
  markSaved(): boolean {
    const saved = this.serialized;
    if (!saved || !this.doc || saved.instance !== this.documentInstance || saved.epoch !== this.state().contentEpoch) return false;
    // hm-wasm에는 독립된 markSaved가 없다. 성공했을 때만 저장 위치를 옮긴다.
    this.document().serialize(true);
    this.savedBytes = saved.bytes;
    this.savedContentId = this.contentId;
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
}
