import type { Address, Affinity, Caret, CharPatch, Copied, Doc, DocState as HmDocState, EditOp, Engine, FaceCandidates, FontFileSource, FontRequests, Located, LocateRequest, Match, NavigateRequest, PageInfo as HmPage, ParagraphInfo, ParaPatch, Receipt, Rect, SearchResult, Selected, SelectRequest, Selection } from '../../vendor/hm-wasm/hm_wasm';
import { copyAddress, copySelection, editingText, formattingPatch, replacementOps, sameAddress, isCellSelection, type EditingSelection, type CellSelection, type TextSelection } from './heemang-editing';
import type { DocumentInfo, PageInfo } from './types';
import type { FileSystemFileHandleLike } from '../command/file-system-access';
import { getSystemFontHost, loadDesktopFontIndex, getDesktopFontLookup, matchDesktopFont, isDesktopFontMatch, readDesktopFace, type RuntimeFontMetricsApi } from './desktop-fonts';
import { blake3Hex, setBlake3WasmApi } from './content-hash';
import { EngineNotSupportedError, nextDocumentGeneration, nextDocumentInstance, receiveEngineFonts, type EngineFontReader } from './engine-support';
import { resolveCanvasKitFontPlan, type WebFontLoadOptions } from './font-loader';
import { HANCOM_ENGINE_TABLE_ORDER, decodeWebFont, hancomEngineTableKind, streamWebFontDecoders, type HancomEngineTableKind } from '../../../rhwp-shared/fonts/font-index-core.mjs';
import { readResponseBytesWithLimit } from './document-input-limits';
import { Pictures, Player, decodePacket, patchImage, type Box, type PagePacket, type PaintRecord, type PatchState, type Picture } from '../view/heemang-player';
import { guardHeemangEngineCalls } from './engine-trap';
import { detectDocumentByteKind } from './document-signature';
import { readHmlSourceMetadata } from './hm/hml-source';
import type { HmlOpenMetadata } from './hm/bridge-types';
import { fontGlyphCoverage } from './heemang-font-coverage';
import { isHftBytes } from './hft-glyphs';

export type { Address, Affinity, Caret, CharPatch, Copied, Located, LocateRequest, Match, Motion, NavigateRequest, ParagraphInfo, ParaPatch, Receipt, Rect, SearchResult, Selected, SelectRequest, Step } from '../../vendor/hm-wasm/hm_wasm';
export type { TextSelection, CellSelection, EditingSelection } from './heemang-editing';
export type DocState = Omit<HmDocState, 'format'> & { format: 'hwp5' | 'hwpx' | 'hwp3' | 'hml' };
/** layoutFirst·layoutMore 가 조판한 결과: 지금까지의 쪽 수, 다 조판했는지, 조판 순번, 다시 그릴 쪽(새 쪽 포함). */
export interface LayoutProgress { pageCount: number; complete: boolean; layoutEpoch: number; changedPages: number[] }
/** 앞쪽부터 나눠 조판하는 hm-wasm 문서. 예전 vendor 패키지에는 없으므로 있는지 보고 쓴다. */
type ProgressiveDoc = Doc & { layoutFirst(pages: number): string; layoutMore(pages: number): string };
const progressiveDoc = (doc: Doc | null): ProgressiveDoc | null => {
  const d = doc as Partial<ProgressiveDoc> | null;
  return typeof d?.layoutFirst === 'function' && typeof d.layoutMore === 'function' ? d as ProgressiveDoc : null;
};
export interface EditResult { caret: Located; anchor?: Located | null; receipt: Receipt; selection?: EditingSelection }
export interface CutResult { clipboard: Copied; edit: EditResult | null }
export interface ReplaceAllResult { count: number; edit: EditResult | null }

const PX_PER_HU = 96 / 7200;
// 떼어 둔 쪽 캔버스는 쪽 하나만큼 메모리를 더 쓰므로 최근에 그린 몇 쪽만 남긴다.
const KEPT_PAGE_BUFFERS = 6;
function unsupportedMargin(): never { throw new EngineNotSupportedError('쪽 여백 정보'); }
let runtime: Promise<Awaited<ReturnType<typeof initializeRuntime>>> | undefined;
// 편집 경로의 WASM 함수는 처음 불릴 때 컴파일되므로, 문서를 연 뒤 첫 입력이 그 컴파일만큼 늦다.
// 엔진(모듈)마다 한 번, 첫 쪽을 그린 뒤 쉬는 시간에 빈 문서 사본을 편집해 미리 컴파일해 둔다.
let editWarmup: 'pending' | 'scheduled' | 'done' = 'pending';
let openWarmup: 'pending' | 'scheduled' | 'done' = 'pending';
let cancelOpenWarmupRun: (() => void) | null = null;
// native clipboard는 같은 Engine의 문서들이 공유한다.
let internalClipboard: { engine: Engine; text: string } | null = null;

type FontSubsetReader = (characters: string, glyphs?: readonly number[]) => Promise<ArrayBuffer | Uint8Array>;
type FontAsset = { name: string; url: string; size: number; families: string[]; host?: boolean; subset?: FontSubsetReader };
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
  const coverage = new Map<string, Uint8Array>();
  // 한컴 엔진 표(FontMap·hftinfo·코드 표)는 엔진마다 한 번, 첫 HFT 등록 전에만 넣는다.
  // 표 없이 HFT 가 먼저 들어가면 그 뒤에는 넣지 않는다.
  let tablesClosed = false;
  let tablesLoad: Promise<void> | null = null;
  const isHft = (name: string, bytes: Uint8Array) => /\.hft$/i.test(name) || isHftBytes(bytes);
  const addTables = (tables: { kind: HancomEngineTableKind; bytes: Uint8Array }[]) => {
    const order = (kind: HancomEngineTableKind) => HANCOM_ENGINE_TABLE_ORDER.indexOf(kind);
    let added = 0;
    for (const { kind, bytes } of [...tables].sort((a, b) => order(a.kind) - order(b.kind))) {
      const ok = kind === 'fontmap' ? engine.addFontMap(bytes) : kind === 'hftinfo' ? engine.addHftInfo(bytes) : engine.addCodeTable(bytes);
      if (ok) added++;
    }
    tablesClosed = true;
    return added;
  };
  // 호스트 색인(데스크톱·허브·글꼴 폴더)이 알려 준 한 설치본의 표를 읽어 등록한다.
  const prepareTables = (): Promise<void> => {
    if (tablesClosed) return Promise.resolve();
    const host = getSystemFontHost();
    if (!host) return Promise.resolve();
    return tablesLoad ??= (async () => {
      const list = (await loadDesktopFontIndex()).engineTables ?? [];
      if (!list.length || tablesClosed) return;
      const tables = await Promise.all(list.map(async table => ({ kind: table.kind, bytes: new Uint8Array(await readDesktopFace(host, table.id)) })));
      if (tablesClosed) return;
      // 엔진은 쓰는 코드 표만 받고 나머지에는 false 를 돌려준다.
      const added = addTables(tables);
      console.info(`[Heemang] 한컴 엔진 표 ${tables.length}개 중 ${added}개 사용`);
    })().catch(error => { console.warn('[Heemang] 한컴 엔진 표를 읽지 못했습니다:', error); })
      .finally(() => { tablesLoad = null; });
  };
  const register = (label: string, bytes: Uint8Array, names?: string[], name = label, refill = false) => {
    const key = copyKey(name, bytes.length);
    if (!refill && registered.has(key)) return;
    if (!tablesClosed && isHft(name, bytes)) tablesClosed = true;
    const included = fontGlyphCoverage(bytes);
    if (included) coverage.set(label, included); else coverage.delete(label);
    const file = fontFile(bytes);
    const added = engine.addFontFile(label, file);
    if (!added && !refill) return;
    for (const family of names ?? JSON.parse(fileFamilyNames(file)) as string[]) families.add(normalize(family));
    faces += added;
    registered.add(key);
  };
  const assets: FontAsset[] = [];
  const assetsByFamily = new Map<string, Set<FontAsset>>();
  const addAsset = (asset: FontAsset) => {
    assets.push(asset);
    for (const name of asset.families) {
      const key = normalize(name);
      let matches = assetsByFamily.get(key);
      if (!matches) assetsByFamily.set(key, matches = new Set());
      matches.add(asset);
    }
  };
  const loadedAssets = new Set<string>();
  const pending = new Map<string, Promise<void>>();
  const readAsset = async (asset: FontAsset) => {
    const res = await fetch(asset.url);
    if (!res.ok) throw new Error(`Heemang 글꼴 읽기 실패: ${asset.name}`);
    return new Uint8Array(await res.arrayBuffer());
  };
  receiveEngineFonts((label, bytes, read, sourceUrl) => {
    // 브라우저 미리보기와 엔진이 같은 호스트 face를 중복 등록하지 않는다.
    const identity = sourceUrl ?? label;
    if (read) sources.set(identity, read);
    if (sourceUrl && loadedAssets.has(sourceUrl)) return;
    const deliver = () => {
      if (sourceUrl && loadedAssets.has(sourceUrl)) return;
      register(identity, bytes, undefined, label);
      if (sourceUrl) loadedAssets.add(sourceUrl);
    };
    // HFT 는 엔진 표를 먼저 넣은 뒤 등록한다.
    if (!tablesClosed && isHft(label, bytes) && getSystemFontHost()) void prepareTables().then(deliver);
    else deliver();
  });
  // 배포에 한컴 자산을 넣지 않는다. 명시적으로 설정한 개발용 파일만 받는다.
  if (import.meta.env.DEV && import.meta.env.VITE_HEEMANG_FONT_ASSETS === '1') {
    const response = await fetch('/__heemang-fonts/manifest.json');
    if (!response.ok) throw new Error(`Heemang 글꼴 목록 오류: ${response.status}`);
    for (const asset of await response.json() as FontAsset[]) addAsset(asset);
    for (const asset of assets) sources.set(asset.url, () => readAsset(asset));
    const tables = assets.filter(a => /\.dat$/i.test(a.name));
    if (tables.length) {
      addTables(await Promise.all(tables.map(async asset => ({
        kind: hancomEngineTableKind(asset.name) ?? 'code', bytes: await readAsset(asset),
      }))));
    }
  }
  const hasFamily = (name: string) => families.has(normalize(name));
  const hasAvailableFamily = (name: string) => hasFamily(name) || assetsByFamily.has(normalize(name));
  const loadFonts = async (requests: FontRequests) => {
    const before = loadedAssets.size;
    await prepareTables();
    // 일반 실행에서도 호스트 색인에서 엔진이 고른 대체 서체를 직접 연결한다.
    const host = getSystemFontHost();
    if (host) {
      const index = await loadDesktopFontIndex();
      for (const face of index.faces) {
        const url = `heemang-host:${face.id}`;
        const subset: FontSubsetReader | undefined = host.readSubset ? (characters,glyphs) => host.readSubset!(face.id,characters,glyphs) : undefined;
        if (sources.has(url)) continue;
        addAsset({ name: face.path, url, size: face.size, families: face.families, host: true,
          ...(subset ? { subset } : {}) });
        sources.set(url, () => readDesktopFace(host, face.id));
      }
    }
    const wanted = new Set<string>();
    const outlined = new Set<string>();
    const first = (names: string[] = []) => names.find(hasAvailableFamily);
    const want = (name: string | undefined, text = true) => {
      if (!name) return;
      wanted.add(normalize(name));
      if (text) outlined.add(normalize(name));
    };
    for (const request of requests.faces) want(first(request.candidates), request.text !== false);
    const defaults = first(requests.classDefaults[0]);
    for (const name of defaults ? [defaults] : requests.classDefaults.slice(1).map(first)) want(name, false);
    // 한 대체 서체가 여러 후보의 빈 글자를 채울 수 있으므로 연결 뒤 다시 조회한다.
    want(first(requests.fallbacks ?? []));
    const matching = new Set([...wanted].flatMap(name => [...(assetsByFamily.get(name) ?? [])]));
    const lookup = getDesktopFontLookup();
    const preferred = new Set<string>();
    if (lookup) {
      for (const name of wanted) {
        const match = matchDesktopFont(name, lookup);
        if (isDesktopFontMatch(match)) {
          for (const { face } of match.slots) preferred.add(`heemang-host:${face.id}`);
        }
      }
    }
    const copies = new Set(registered);
    // 기존 색인 순서를 유지해 같은 face와 HFT 은행의 선택 순서도 바뀌지 않는다.
    await Promise.all(assets.filter(asset => matching.has(asset)).map(asset => {
      // SFNT는 PC 글꼴과 같은 선호 face만 읽는다. HFT는 모든 문자 은행이 필요하다.
      if (lookup && asset.host && !/\.hft$/i.test(asset.name) && !preferred.has(asset.url)) return;
      const key = copyKey(asset.name, asset.size);
      if (loadedAssets.has(asset.url) || copies.has(key)) return;
      copies.add(key);
      let load = pending.get(asset.url);
      if (!load) {
        load = (async () => {
          // 실제 글자를 그리는 face의 원본은 이후 입력에도 쓴다. 메트릭만 필요한 face는 작게 읽는다.
          const text = asset.families.some(name => outlined.has(normalize(name)));
          const bytes = asset.subset && !text ? await asset.subset('\0') : await sources.get(asset.url)!();
          if (!bytes) throw new Error(`Heemang 글꼴 읽기 실패: ${asset.name}`);
          const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
          register(asset.url, view, asset.host ? undefined : asset.families, asset.name);
          loadedAssets.add(asset.url);
        })().finally(() => pending.delete(asset.url));
        pending.set(asset.url, load);
      }
      return load;
    }));
    return loadedAssets.size > before;
  };
  const refillOutlines = async (extra: string[] = []) => {
    const paths = [...new Set([...(JSON.parse(engine.outlineRequests()) as string[]), ...extra])];
    if (!paths.length) return false;
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
  const prepareOutlines = async (doc: Doc) => {
    if (!coverage.size) return false;
    const requests = JSON.parse(doc.glyphRequests()) as { label: string; index: number; glyphs: number[] }[];
    const missing = requests.filter(request => {
      const included = coverage.get(request.label);
      return included && request.glyphs.some(glyph => !(included[glyph >> 3] & (1 << (glyph & 7))));
    }).map(request => request.label);
    return refillOutlines(missing);
  };
  // Brotli DecompressionStream 이 없는 브라우저(Chrome 포함)는 엔진의 해제기로 WOFF2 를 읽는다.
  const webFontDecoders = () => ({
    brotli: (data: Uint8Array, outLength: number) => brotliDecompress(data, outLength),
    ...streamWebFontDecoders(),
  });
  return { engine, player: new Player(engine), memory, fontCount: () => faces, register, hasFamily, hasAvailableFamily, loadFonts, refillOutlines, prepareOutlines, sources, webFontDecoders };
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
  private loadFonts!: (requests: FontRequests) => Promise<boolean>;
  private refillOutlines!: () => Promise<boolean>;
  private prepareOutlines!: (doc: Doc) => Promise<boolean>;
  private sources!: Map<string, EngineFontReader>;
  private webFontDecoders!: () => { brotli?: (data: Uint8Array, outLength: number) => Uint8Array | Promise<Uint8Array>; zlib?: (data: Uint8Array, outLength: number) => Promise<Uint8Array> };
  private fontsPrepared = false;
  private readonly canvasPaints = new Map<HTMLCanvasElement, { index: number; scale: number }>();
  // 쪽 캔버스마다 마지막으로 그린 쪽을 떼어 둔 캔버스에 남겨, 다음에는 바뀐 영역만 다시 그린다.
  private readonly pageBuffers = new Map<HTMLCanvasElement, { canvas: HTMLCanvasElement; doc: Doc; index: number; record: PaintRecord }>();
  private pictureFrame = 0;
  private readonly pictures = new Pictures(() => {
    if (this.pictureFrame) return;
    this.pictureFrame = requestAnimationFrame(() => {
      this.pictureFrame = 0;
      for (const [canvas, paint] of this.canvasPaints) {
        if (!canvas.isConnected) { this.canvasPaints.delete(canvas); continue; }
        this.redrawPage(canvas, paint);
      }
    });
  });
  private readonly webFonts = new Map<string, Promise<void>>();
  private doc: Doc | null = null;
  /** 앞쪽만 조판해 여는 동안 상태·쪽 읽기가 조판할 쪽 수(layoutFirst). 0이면 엔진대로 문서 전체를 조판한다. */
  private firstPages = 0;
  /** 나머지 쪽을 조판하는 중에 쪽 packet 과 쪽 목록이 따르는 조판 순번. 다 조판했으면 null. */
  private partialLayoutEpoch: number | null = null;
  private packets = new Map<number, PagePacket>();
  private furniturePreview: { key: string; doc: Doc; list: { section: number; steps: { para: number; control: number; index: number }[] } } | null = null;
  private pageMetadata: { doc: Doc; layoutEpoch: number; fontGeneration: number; pages: HmPage[] } | null = null;
  /** 마지막으로 읽은 쪽 목록 JSON 과 그 해석. 엔진이 같은 문자열을 주면 다시 해석하지 않는다. */
  private pageList: { doc: Doc; raw: string; pages: HmPage[] } | null = null;
  private _fileName = '';
  private sourceFormat = 'hwpx';
  private hmlSourceMetadata: HmlOpenMetadata | null = null;
  private _digest: string | null = null;
  /** 파일 바이트로 연 문서인가. 새 문서·서식 문서는 false 다(digest 가 문서의 정체성이 아니다). */
  openedFromFile = false;
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
  /** 비동기 글꼴·그림 준비 뒤 쪽과 화면 장식을 함께 다시 그릴 호스트. */
  onPageRenderReady?: (pageIndex: number) => void;
  /** 편집 경로를 미리 컴파일할 때 여는 빈 문서. 없으면 미리 컴파일하지 않는다. */
  editWarmupTemplate: Uint8Array | null = null;

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
    while (await this.loadFonts(requests())) {
      if (!current()) return;
    }
    if (!current()) return;
    const req = requests();
    const defaults = req.classDefaults;
    const satisfied = req.faces.every(face => face.candidates.some(this.hasFamily))
      && (!defaults.some(list => list.length) || defaults.some(list => list.some(this.hasFamily)))
      && (req.fallbacks ?? []).every(name => !this.hasAvailableFamily(name) || this.hasFamily(name));
    if (!satisfied) {
      const plan = resolveCanvasKitFontPlan([...new Set([...names, ...req.faces.map(face => face.name)])].filter(name => !this.hasFamily(name)), options);
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
      while (await this.loadFonts(requests())) {
        if (!current()) return;
      }
      if (!current()) return;
    }
    if (!this.fontCount()) throw new EngineNotSupportedError('글꼴 파일이 필요합니다. 로컬 TTF·OTF·TTC·HFT 글꼴을 연결해 주세요.');
    // 첫 조판이 찾은 대체 글꼴도 연결한다. 앞쪽만 조판하는 문서는 그 쪽들의 글꼴만 찾고, 나머지는 completeFonts 가 맡는다.
    const pageCount = this.state().pageCount;
    while (await this.loadFonts(requests())) {
      if (!current()) return;
    }
    if (!current()) return;
    // 윤곽선 요청은 문서 전체를 조판해 모든 쪽을 만든다. 앞쪽만 조판하는 동안에는 completeFonts 로 미룬다.
    if (!this.firstPages) await this.prepareOutlines(doc);
    if (!current()) return;
    this.refreshLayout();
    if (pageCount > 0) {
      // 그사이 글꼴이 바뀌었으면 쪽을 읽기 전에 앞쪽만 다시 조판한다.
      if (this.firstPages) progressiveDoc(doc)?.layoutFirst(this.firstPages);
      const packet = decodePacket(doc.page(0).slice());
      // 첫 쪽의 그림도 준비한 뒤 문서를 화면에 공개한다.
      await this.pictures.prepare(doc, 0, packet.ops.flatMap(op => op.op === 'patch' ? [op.item] : []));
      if (!current()) return;
      this.packets.set(0, packet);
    }
    this.fontsPrepared = true;
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
  state(): DocState { return JSON.parse(this.hmStateJson()); }
  get wasmMemoryBytes(): number { return this.memory.buffer.byteLength; }

  releaseDocument(): void {
    this.furniturePreview?.doc.free(); this.furniturePreview = null;
    if (this.pictureFrame) cancelAnimationFrame(this.pictureFrame);
    this.pictureFrame = 0;
    this.pictures.clear();
    this.canvasPaints.clear();
    this.pageBuffers.clear();
    this.doc?.close();
    this.doc?.free();
    this.doc = null;
    this.fontsPrepared = false;
    this.firstPages = 0;
    this.partialLayoutEpoch = null;
    this.packets.clear();
    this.pageMetadata = null;
    this.pageList = null;
    this.currentFileHandle = null;
    this._digest = null;
    this.openedFromFile = false;
    this.editable = false;
    this.hmlSourceMetadata = null;
    this.serialized = null;
    this.historyId = 0;
    this.selectionFallbacks.clear();
    this.documentGeneration = nextDocumentGeneration();
    this.documentInstance = nextDocumentInstance();
  }

  loadDocument(bytes: Uint8Array, name = ''): DocumentInfo {
    // 잘못된 입력은 현재 문서를 닫지 않는다.
    this.cancelOpenWarmup();
    const next = this.engine.open(bytes);
    this.releaseDocument();
    this.doc = next;
    this.hmReadSourceFormat(bytes);
    this._digest = `blake3:${blake3Hex(bytes)}`;
    this.openedFromFile = true;
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
      fontsUsed: [...new Set(requests.faces.filter(face => face.text !== false).map(face => face.name))],
    };
  }
  getSectionCount(): number { return Math.max(-1, ...this.hmPages().map(p => p.section)) + 1; }
  /** 지금 조판의 쪽 목록. 읽기 전용으로 나눠 쓴다. */
  hmPages(): HmPage[] {
    const doc = this.document();
    // state는 대기 중인 조판과 공유 엔진의 글꼴 변경을 먼저 반영한다.
    const { layoutEpoch, fontGeneration } = this.state();
    const cached = this.pageMetadata;
    if (cached?.doc === doc && cached.layoutEpoch === layoutEpoch && cached.fontGeneration === fontGeneration) return cached.pages;
    // 글자를 쳐도 쪽 배치가 그대로면 엔진은 같은 JSON 을 준다. 그때는 앞서 해석한 목록을 쓴다.
    const raw = doc.pages();
    const pages: HmPage[] = this.pageList?.doc === doc && this.pageList.raw === raw ? this.pageList.pages : JSON.parse(raw);
    this.pageList = { doc, raw, pages };
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

  // ─── 점진 조판: 큰 문서의 앞쪽을 먼저 보여 준다 ───────────────

  /** 엔진 상태 JSON. 앞쪽만 조판해 여는 동안에는 글꼴이 바뀌어도 앞쪽만 다시 조판한다. */
  hmStateJson(): string {
    const doc = this.document();
    if (this.firstPages) progressiveDoc(doc)?.layoutFirst(this.firstPages);
    return doc.state();
  }

  /**
   * 편집기가 문서를 열 때 부른다. 엔진이 지원하면 finishFirstPages 까지 상태·쪽 읽기가 문서 전체가 아니라
   * 앞쪽 pages 쪽만 조판한다. 앞쪽 조판으로 다 조판되는 문서이거나 엔진이 지원하지 않으면 false.
   */
  beginFirstPages(pages: number): boolean {
    const doc = progressiveDoc(this.doc);
    if (!doc) return false;
    const progress = JSON.parse(doc.layoutFirst(Math.max(1, pages))) as LayoutProgress;
    this.firstPages = progress.complete ? 0 : Math.max(1, pages);
    return !progress.complete;
  }

  /** 앞쪽만 조판해 연 문서의 나머지 쪽이 아직 남았는지. 쪽 읽기 밖의 엔진 호출은 남은 조판을 한 번에 끝낸다. */
  get layoutPending(): boolean { return this.firstPages > 0 || this.partialLayoutEpoch !== null; }

  /** 앞쪽만 조판하던 여는 단계를 끝낸다. 남은 쪽이 있으면 true — 호출자가 layoutMore 로 마저 조판한다. */
  finishFirstPages(): boolean {
    this.firstPages = 0;
    const doc = progressiveDoc(this.doc);
    if (!doc) return false;
    const state = JSON.parse(doc.state()) as DocState & { layoutComplete?: boolean };
    this.partialLayoutEpoch = state.layoutComplete === false ? state.layoutEpoch : null;
    return this.partialLayoutEpoch !== null;
  }

  /**
   * 남은 쪽을 pages 쪽쯤 더 조판한다(0이면 끝까지). 다시 그릴 쪽의 packet 만 버린다.
   * 그사이 다른 호출이 조판했으면(엔진은 다른 요청 전에 남은 조판을 끝낸다) 모든 쪽을 다시 그릴 쪽으로 돌려준다.
   */
  layoutMore(pages: number): LayoutProgress | null {
    const doc = progressiveDoc(this.doc);
    if (!doc) return null;
    const seen = this.partialLayoutEpoch;
    const before = (JSON.parse(doc.state()) as DocState).layoutEpoch;
    const progress = JSON.parse(doc.layoutMore(Math.max(0, pages))) as LayoutProgress;
    this.pageMetadata = null;
    if (seen === null || before !== seen) {
      this.packets.clear();
      progress.changedPages = Array.from({ length: progress.pageCount }, (_, index) => index);
    } else if (progress.layoutEpoch !== seen) {
      for (const index of progress.changedPages) this.packets.delete(index);
      for (const packet of this.packets.values()) packet.layoutEpoch = progress.layoutEpoch;
    }
    this.partialLayoutEpoch = progress.complete ? null : progress.layoutEpoch;
    return progress;
  }

  /**
   * 앞쪽만 조판해 연 문서의 조판이 끝난 뒤 부른다. 나머지 쪽이 찾은 대체 글꼴과 글꼴 윤곽선을 마저 연결한다.
   * 연결한 것이 있으면 true — 조판이나 글자 모양이 바뀌었을 수 있으므로 호출자가 쪽을 다시 그린다.
   */
  async completeFonts(): Promise<boolean> {
    const doc = this.doc;
    if (!doc) return false;
    let changed = false;
    while (await this.loadFonts(JSON.parse(doc.fontRequests()) as FontRequests)) {
      if (this.doc !== doc) return false;
      changed = true;
    }
    if (this.doc !== doc) return false;
    if (await this.prepareOutlines(doc)) changed = true;
    if (this.doc !== doc) return false;
    if (changed) this.refreshLayout();
    return changed;
  }

  private invalidate(receipt: Receipt): void {
    // 나머지 쪽을 조판하는 중에 편집하면 엔진이 조판을 먼저 끝낸다. 영수증은 그 뒤만 비교하므로 모두 버린다.
    if (receipt.changedPages === null || this.partialLayoutEpoch !== null) {
      this.partialLayoutEpoch = null;
      this.packets.clear();
      return;
    }
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

  /** 표시되지 않는 머리말·꼬리말의 조판은 내용·글꼴이 바뀔 때만 다시 만든다. */
  withFurniturePreview<T>(target: { section: number; para: number; control: number }, run: (doc: Doc, list: { section: number; steps: { para: number; control: number; index: number }[] }) => T): T {
    const source = this.document(), state = this.state();
    const key = `${state.instance}:${state.contentEpoch}:${state.fontGeneration}:${JSON.stringify(target)}`;
    if (this.furniturePreview?.key !== key) {
      this.furniturePreview?.doc.free(); this.furniturePreview = null;
      const sourceControls = JSON.parse(source.query('{"kind":"controls"}')) as { kind: string; target: { section: number; para: number; control: number; steps?: unknown[] } }[];
      const kind = sourceControls.find(c => c.target.section === target.section && c.target.para === target.para && c.target.control === target.control && !c.target.steps?.length)?.kind;
      const doc = (source as unknown as { furniturePreview(target: string): Doc }).furniturePreview(JSON.stringify(target));
      const controls = JSON.parse(doc.query('{"kind":"controls"}')) as typeof sourceControls;
      const active = controls.find(c => c.kind === kind && c.target.section === 0 && c.target.para === 0 && !c.target.steps?.length);
      if (!active) { doc.free(); throw new Error('머리말·꼬리말 미리보기 위치를 찾을 수 없습니다'); }
      this.furniturePreview = { key, doc, list: { section: 0, steps: [{ para: 0, control: active.target.control, index: 0 }] } };
    }
    return run(this.furniturePreview.doc, this.furniturePreview.list);
  }

  renderFurniturePreviewToCanvas(index: number, target: { section: number; para: number; control: number }, canvas: HTMLCanvasElement, scale: number): void {
    this.withFurniturePreview(target, preview => {
      const packet = decodePacket(preview.page(index).slice());
      canvas.width = Math.max(1, Math.floor(packet.width * PX_PER_HU * scale));
      canvas.height = Math.max(1, Math.floor(packet.height * PX_PER_HU * scale));
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('Canvas2D를 사용할 수 없습니다');
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
      this.player.paint(ctx, packet, 96 * scale, (item, dpi) => patchImage(preview.patch(index, item, dpi).slice(), (w, h) => new OffscreenCanvas(w, h)));
    });
  }

  renderPageToCanvas(index: number, canvas: HTMLCanvasElement, scale: number, refill = true): void {
    const doc = this.document();
    const paint = { index, scale };
    for (const old of this.canvasPaints.keys()) if (!old.isConnected) this.canvasPaints.delete(old);
    for (const old of this.pageBuffers.keys()) if (!old.isConnected) this.pageBuffers.delete(old);
    this.canvasPaints.set(canvas, paint);
    const packet = this.page(index);
    // 쪽 그리기(page-renderer)와 같이 내림한다. 올림하면 A4 가 794×1123 이 되어 쪽 틀이 1px 커진다.
    const width = Math.max(1, Math.floor(packet.width * PX_PER_HU * scale));
    const height = Math.max(1, Math.floor(packet.height * PX_PER_HU * scale));
    canvas.width = width;
    canvas.height = height;
    canvas.dataset.heemangPage = String(index);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas2D를 사용할 수 없습니다');
    // 영역 계산과 그리기가 같은 그림·조각을 보도록 이번 그리기 안에서는 항목마다 한 번만 묻는다.
    const pictures = new Map<number, Picture | null>(), bytes = new Map<number, Uint8Array>();
    const images = new Map<number, CanvasImageSource | null>();
    const picture = (item: number) => {
      if (!pictures.has(item)) pictures.set(item, this.pictures.get(doc, index, item));
      return pictures.get(item)!;
    };
    const patchBytes = (item: number) => {
      if (!bytes.has(item)) bytes.set(item, doc.patch(index, item, 96 * scale).slice());
      return bytes.get(item)!;
    };
    const patch = (item: number) => {
      if (!images.has(item)) images.set(item, patchImage(patchBytes(item), (w, h) => new OffscreenCanvas(w, h)));
      return images.get(item)!;
    };
    // 떼어 둔 캔버스는 화면에 붙은 쪽 캔버스와 같은 문서에서 만든다. 섬네일 같은 일회성 캔버스는 바로 그린다.
    const owner = canvas.isConnected ? canvas.ownerDocument : null;
    if (owner) {
      this.paintBuffered(owner, canvas, ctx, doc, index, packet, scale, patch, picture, patchBytes);
      this.scheduleEditWarmup();
    } else {
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, width, height);
      this.player.paint(ctx, packet, 96 * scale, patch, picture);
    }
    if (!refill) return;
    void this.refillOutlines().then(refilled => {
      if (!refilled || this.doc !== doc || this.canvasPaints.get(canvas) !== paint || !canvas.isConnected) return;
      this.redrawPage(canvas, paint, false);
    }).catch(error => console.warn('[Heemang] 글꼴 윤곽선 연결 실패:', error));
  }

  /**
   * 엔진을 읽은 뒤 쉬는 시간에 빈 문서 사본을 한 번 조판해 첫 쪽까지 만들고 닫는다. 엔진 모듈은 처음 부르는
   * 함수를 그때 컴파일하므로, 첫 문서를 열 때 조판·쪽 그리기 코드를 컴파일하는 시간이 들지 않는다.
   * 그 전에 문서를 열었으면 그 문서가 이미 컴파일했으므로 하지 않는다. 열린 문서·글꼴 상태는 건드리지 않는다.
   */
  scheduleOpenWarmup(): void {
    const template = this.editWarmupTemplate;
    if (openWarmup !== 'pending' || !template) return;
    openWarmup = 'scheduled';
    const run = () => {
      openWarmup = 'done';
      cancelOpenWarmupRun = null;
      // 비교 측정용: window.__rhwpOpenWarmup = false 이면 예열하지 않고, 예열하면 걸린 시간(ms)을 남긴다.
      const flags = globalThis as { __rhwpOpenWarmup?: boolean | number };
      if (this.doc || flags.__rhwpOpenWarmup === false) return;
      let scratch: Doc | null = null;
      const startedAt = performance.now();
      try {
        scratch = this.engine.open(template);
        scratch.state();
        scratch.page(0);
        flags.__rhwpOpenWarmup = performance.now() - startedAt;
      } catch (error) {
        console.warn('[Heemang] 첫 문서 조판 예열 실패:', error);
      } finally {
        scratch?.close();
        scratch?.free();
      }
    };
    if (typeof requestIdleCallback === 'function') {
      const id = requestIdleCallback(run, { timeout: 2000 });
      cancelOpenWarmupRun = () => cancelIdleCallback(id);
    } else {
      const id = setTimeout(run, 0);
      cancelOpenWarmupRun = () => clearTimeout(id);
    }
  }

  /** 문서를 열기 시작하면 아직 돌지 않은 첫 문서 예열을 거둔다. 여는 문서가 같은 코드를 컴파일한다. */
  cancelOpenWarmup(): void {
    if (openWarmup !== 'scheduled') return;
    openWarmup = 'done';
    cancelOpenWarmupRun?.();
    cancelOpenWarmupRun = null;
  }

  /**
   * 편집할 수 있는 문서를 처음 화면에 그린 뒤, 쉬는 시간에 빈 문서 사본에 글자 하나를 넣고 닫는다.
   * 열린 문서·기록·글꼴 상태는 건드리지 않고, 같은 엔진 모듈의 편집·조판 코드만 컴파일된다.
   */
  scheduleEditWarmup(): void {
    const template = this.editWarmupTemplate;
    if (editWarmup !== 'pending' || !this.editable || !template) return;
    editWarmup = 'scheduled';
    const run = () => {
      editWarmup = 'done';
      let scratch: Doc | null = null;
      try {
        scratch = this.engine.open(template);
        const list = { section: 0, steps: [] };
        const [para] = JSON.parse(scratch.query(JSON.stringify({ kind: 'paragraphs', list, from: 0, count: 1 }))) as ParagraphInfo[];
        const end = para.offsets[para.offsets.length - 1];
        const op: EditOp = { op: 'insertText', at: { section: 0, para: 0, offset: end }, text: '가' };
        scratch.transact(JSON.stringify({ ops: [op] }));
      } catch (error) {
        console.warn('[Heemang] 편집 경로 예열 실패:', error);
      } finally {
        scratch?.close();
        scratch?.free();
      }
    };
    if (typeof requestIdleCallback === 'function') requestIdleCallback(run, { timeout: 2000 });
    else setTimeout(run, 0);
  }

  /**
   * 떼어 둔 캔버스에서 지난 그리기와 달라진 영역만 흰 바탕부터 다시 그리고 쪽 캔버스로 옮긴다.
   * 영역 밖 픽셀은 지난 그리기와 같고 영역 안은 같은 순서로 다시 그리므로, 결과는 쪽 전체를 새로 그린 것과 같다.
   * 쪽 캔버스 위에 덧그리는 안내선 등은 떼어 둔 캔버스에 남지 않는다.
   */
  private paintBuffered(owner: Document, canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D, doc: Doc, index: number, packet: PagePacket, scale: number,
    patch: (item: number) => CanvasImageSource | null, picture: (item: number) => Picture | null, patchBytes: (item: number) => Uint8Array): void {
    const { width, height } = canvas, dpi = 96 * scale, s = dpi / 7200;
    // 그림은 원본·배치·디코드한 비트맵이, 엔진 조각은 픽셀이 같으면 다시 그리지 않는다.
    const patches = new Map<number, PatchState>();
    packet.ops.forEach((op, k) => {
      if (op.op !== 'patch') return;
      const pic = picture(op.item), boxes = this.player.patchBoxes(op, s, pic);
      patches.set(k, pic
        ? { boxes, key: [pic.source.key, JSON.stringify(pic.source.matrix), JSON.stringify(pic.source.clip), pic.bitmap] }
        : { boxes, key: [patchBytes(op.item)] });
    });
    const record: PaintRecord = { packet, s, patches };
    let buffer = this.pageBuffers.get(canvas);
    let region: Box[] | null = null;
    if (buffer && buffer.doc === doc && buffer.index === index && buffer.canvas.width === width && buffer.canvas.height === height) {
      region = this.player.repaintRegion(buffer.record, record, width, height);
    }
    if (buffer) this.pageBuffers.delete(canvas);
    buffer ??= { canvas: owner.createElement('canvas'), doc, index, record };
    this.pageBuffers.set(canvas, buffer);
    while (this.pageBuffers.size > KEPT_PAGE_BUFFERS) this.pageBuffers.delete(this.pageBuffers.keys().next().value!);
    const target = buffer.canvas.getContext('2d');
    if (!target) throw new Error('Canvas2D를 사용할 수 없습니다');
    if (region === null) {
      buffer.canvas.width = width;
      buffer.canvas.height = height;
      target.fillStyle = '#fff';
      target.fillRect(0, 0, width, height);
      this.player.paint(target, packet, dpi, patch, picture);
    } else {
      for (const box of region) {
        target.save();
        target.beginPath();
        target.rect(box.x, box.y, box.w, box.h);
        target.clip();
        target.fillStyle = '#fff';
        target.fillRect(box.x, box.y, box.w, box.h);
        this.player.paint(target, packet, dpi, patch, picture, { box, boxes: record.boxes! });
        target.restore();
      }
    }
    Object.assign(buffer, { doc, index, record });
    ctx.drawImage(buffer.canvas, 0, 0);
  }

  private redrawPage(canvas: HTMLCanvasElement, paint: { index: number; scale: number }, refill = true): void {
    if (this.onPageRenderReady) this.onPageRenderReady(paint.index);
    else this.renderPageToCanvas(paint.index, canvas, paint.scale, refill);
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
    if (sameAddress(from, to)) return { text: '', html: '', objects: 0 };
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

  /** HWP3는 HWP5로 직렬화한다. 실제 파일 쓰기 성공 후 markSaved를 호출한다. */
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
  hasHmlExportCapability(): boolean { return true; }
  getShowControlCodes(): boolean { return false; }
  getShowParagraphMarks(): boolean { return false; }
  getClipEnabled(): boolean { return true; }

  // ─── WasmBridge 위임부가 쓰는 저수준 접근 (src/core/hm/) ───────────────

  /** open/adopt가 검증한 바이트의 형식을 조판 없이 기억한다. */
  private hmReadSourceFormat(bytes: Uint8Array): void {
    const kind = bytes[0] === 0x50 && bytes[1] === 0x4b ? 'hwpx' : detectDocumentByteKind(bytes);
    this.sourceFormat = kind === 'hwpx' ? 'hwpx' : kind === 'hml' || kind === 'xml' ? 'hml' : 'hwp';
    this.hmlSourceMetadata = this.sourceFormat === 'hml' ? readHmlSourceMetadata(bytes) : null;
    this.editable = true; // open/adopt가 검증한 HWP3·HML도 편집한다.
  }
  hmHmlSourceMetadata(): HmlOpenMetadata | null {
    return this.hmlSourceMetadata ? structuredClone(this.hmlSourceMetadata) : null;
  }

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
   * 열린 엔진 문서의 내용만 bytes 로 바꾼다. 문서 객체와 checkpoint, 파일 이름·연결·출처 digest 는 그대로라
   * 바꾸기 전 스냅샷으로 되돌릴 수 있다. 잘못된 입력은 지금 문서를 건드리지 않는다.
   */
  hmAdopt(bytes: Uint8Array): void {
    const doc = this.document();
    // adopt 는 성공하든 실패하든 next 를 가져가 닫는다.
    doc.adopt(this.engine.open(bytes));
    this.firstPages = 0;
    this.partialLayoutEpoch = null;
    if (this.pictureFrame) cancelAnimationFrame(this.pictureFrame);
    this.pictureFrame = 0;
    this.pictures.clear();
    this.canvasPaints.clear();
    this.pageBuffers.clear();
    this.packets.clear();
    this.pageMetadata = null;
    this.serialized = null;
    this.historyId = 0;
    this.selectionFallbacks.clear();
    this.hmReadSourceFormat(bytes);
    this.documentGeneration = nextDocumentGeneration();
  }

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
