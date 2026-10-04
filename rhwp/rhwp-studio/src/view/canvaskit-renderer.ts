import CanvasKitInit from 'canvaskit-wasm';
import type {
  Canvas,
  CanvasKit,
  Color,
  Font,
  FontMgr,
  Image as SkImage,
  Paint,
  Path,
  PathBuilder,
  Rect,
  Surface,
  Typeface,
} from 'canvaskit-wasm';
import canvaskitWasmUrl from '@/view/canvaskit-wasm-url';
import { rendererFontFallbackFamilies } from '@/core/desktop-fonts';
import { downsampleImage, affineSampleImage, imageDownsampleAvailable, imageAffineSampleAvailable, imageDownsampleApiGeneration } from '@/core/image-sampling';

import type {
  LayerBounds,
  LayerCharOverlapOp,
  LayerClipNode,
  LayerEllipseOp,
  LayerEquationLayoutBox,
  LayerEquationOp,
  LayerFormObjectOp,
  LayerGradientFill,
  LayerAffineTransform,
  LayerGlyphOutlineOp,
  LayerImageOp,
  LayerInfo,
  LayerLeafNode,
  LayerLineOp,
  LayerNode,
  LayerPageBackgroundOp,
  LayerPaintOp,
  LayerPathCommand,
  LayerPathOp,
  LayerPathTransform,
  LayerPlaceholderOp,
  LayerRectangleOp,
  LayerRenderProfile,
  LayerResources,
  LayerShapeStyle,
  LayerTabLeaderOp,
  LayerTextControlMarkOp,
  LayerTextDecorationOp,
  LayerTextRunOp,
  PageInfo,
  PageLayerTree,
} from '@/core/types';
import {
  DEFAULT_CANVASKIT_SURFACE_REQUEST,
  type CanvasKitRenderMode,
  type CanvasKitSurfacePreference,
  type CanvasKitSurfaceRequest,
} from './render-backend';
import {
  canvasKitImageCacheKey,
  canvasKitImageContainRect,
  canvasKitImageFillModeContains,
  canvasKitImageFillModeTiles,
  canvasKitImageFillModeStretches,
  canvasKitImagePlacement,
  canvasKitImageSourceRect,
} from './canvaskit/image-replay';
import { encodedImageDimensions } from './canvaskit/image-header';
import { canvaskitClipRightPad } from './canvaskit/policy';
import {
  selectLayerTextVariantsForLeaf,
  staticSvgPathLayersAreReplayable,
} from './canvaskit/text-variant-selection';
import {
  CANVASKIT_REPLAY_PLANES,
  type CanvasKitReplayPlane,
  layerPaintOpReplayPlane,
} from './canvaskit/replay-plane';
import { isExpectedCanvasKitUnsupportedOp } from './canvaskit/diagnostics';
import { layerResourceKeyMatches } from './canvaskit/resource-key';
import {
  glyphOutlinePayloadResourceKey,
  glyphOutlinePayloadStatus,
} from './glyph-outline-payload-status';
import { parseStaticSvgPathLayers, type StaticSvgPathLayer } from './static-svg-path-layers';
import { getImportedLocalFontBytes, getLocalFontRecords, loadLocalFontBytesFor, localFontFaceKey, resolveLocalFont, type LocalFontRecord } from '@/core/local-fonts';
import type { CanvasKitBundledFontSource } from '@/core/font-loader';
import { createOutlineSkiaFont } from '@/core/skia-font';
import { hftGlyphPath } from '@/core/hft-glyphs';
import { preferredFamilyStyleFaces, selectPreparedFontFace } from './canvaskit-font-style';
import { createEquationLiteralFontResolver, equationHftBanks, equationFontFamilies, equationLocalFontFace, isLegacyEquationFont, legacyEquationRuns, modernShortSquarePaintMetrics } from '@/core/equation-font';
import { cancelResponseBody } from '@/core/document-input-limits';
import { readBoundedResponseArrayBuffer } from './canvaskit/bounded-response';

type CanvasKitApi = CanvasKit;
type SkCanvas = Canvas;
type SkPaint = Paint;
type SkSurface = Surface;

export interface CanvasKitLayerRendererOptions {
  defaultFontUrl?: string;
  symbolFallbackFontUrl?: string;
  oldHangulFontUrl?: string;
  equationFontUrl?: string;
  requirePreparedFontFamilies?: boolean;
}

const OLD_HANGUL_FONT_FAMILY = 'Source Han Serif K Old Hangul';
const DISCRETIONARY_HYPHEN = '\u00ad';
const HANCOM_PUA_FALLBACK_FAMILIES = [
  'Haansoft Batang', '한컴바탕', 'HCR Batang Ext-B', 'HCR Batang ExtB',
  '함초롬바탕 확장B', 'HCR Batang Ext', '함초롬바탕 확장', 'HCR Batang', '함초롬바탕',
] as const;
/** \ud55c\ucef4 \uae00\uaf34\uc5d0\ub9cc \uc788\ub294 PUA \uae00\ub9ac\ud504\uc758 \ud45c\uc900 \ub300\uccb4 \ubb38\uc790 (\uc5d4\uc9c4 `pua_missing_glyph_substitute`). */
const PUA_MISSING_GLYPH_SUBSTITUTES = new Map<number, string>([
  [0xF02FC, '\u25ba'], // \u25ba BLACK RIGHT-POINTING POINTER
  // Wingdings PUA(U+F020..U+F0FF): 엔진은 원문을 유지하고 Haansoft Batang 폭으로 조판한다
  // (composer::is_wingdings_pua). 글리프가 없으면 map_pua_bullet_char 와 같은 표준 문자로 대체.
  [0xF09E, '\u00b7'], // · MIDDLE DOT
  [0xF0FC, '\u2713'], // ✓ CHECK MARK
  [0xF06C, '\u25cf'], // ● Black circle
  [0xF06D, '\u25cf'], // ● (Lower right shadowed white circle → 근사값)
  [0xF06E, '\u25a0'], // ■ Black square
  [0xF06F, '\u25a1'], // □ White square
  [0xF070, '\u25a1'], // □ (Bold white square → 근사값)
  [0xF071, '\u25a1'], // □ (Lower right shadowed → 근사값)
  [0xF072, '\u25a1'], // □ (Upper right shadowed → 근사값)
  [0xF073, '\u2b27'], // ⬧ Black medium lozenge
  [0xF074, '\u29eb'], // ⧫ Black lozenge
  [0xF075, '\u25c6'], // ◆ Black diamond
  [0xF076, '\u2756'], // ❖ Black diamond minus white X
  [0xF077, '\u2b25'], // ⬥ Black medium diamond
  [0xF09F, '\u2022'], // • Bullet
  [0xF0A0, '\u00b7'], // · Middle dot
  [0xF0A1, '\u26aa'], // ⚪ Medium white circle
  [0xF0A2, '\u25cb'], // ○ (Heavy large circle → 근사값)
  [0xF0A3, '\u25cb'], // ○ (Very heavy white circle → 근사값)
  [0xF0A4, '\u25c9'], // ◉ Fisheye
  [0xF0A5, '\u25ce'], // ◎ Bullseye
  [0xF0A7, '\u25aa'], // ▪ Black small square
  [0xF0A8, '\u25fb'], // ◻ White medium square
  [0xF0AA, '\u2726'], // ✦ Black four pointed star
  [0xF0AB, '\u2605'], // ★ Black star
  [0xF0AC, '\u2736'], // ✶ Six pointed black star
  [0xF0AD, '\u2734'], // ✴ Eight pointed black star
  [0xF0AE, '\u2739'], // ✹ Twelve pointed black star
  [0xF045, '\u261c'], // ☜ White left pointing index
  [0xF046, '\u261e'], // ☞ White right pointing index
  [0xF047, '\u261d'], // ☝ White up pointing index
  [0xF048, '\u261f'], // ☟ White down pointing index
  [0xF0FB, '\u2717'], // ✗ Ballot X (근사값)
  [0xF0FD, '\u2612'], // ☒ Ballot box with X (근사값)
  [0xF0FE, '\u2611'], // ☑ Ballot box with check (근사값)
  [0xF0E8, '\u2794'], // ➔ Heavy wide-headed rightwards arrow
  [0xF0EF, '\u21e6'], // ⇦ Leftwards white arrow
  [0xF0F0, '\u21e8'], // ⇨ Rightwards white arrow
  [0xF0F1, '\u21e7'], // ⇧ Upwards white arrow
  [0xF0F2, '\u21e9'], // ⇩ Downwards white arrow
  [0xF022, '\u2702'], // ✂ Black scissors
  [0xF036, '\u231b'], // ⌛ Hourglass
  [0xF04A, '\u263a'], // ☺ White smiling face
  [0xF04E, '\u2620'], // ☠ Skull and crossbones
  [0xF052, '\u263c'], // ☼ White sun with rays
  [0xF054, '\u2744'], // ❄ Snowflake
  [0xF058, '\u2720'], // ✠ Maltese cross
  [0xF059, '\u2721'], // ✡ Star of David
]);
type LayerColorGraph = NonNullable<NonNullable<LayerGlyphOutlineOp['colorLayers']>['paintGraph']>;
type LayerColorGraphNode = NonNullable<LayerColorGraph['nodes']>[number];
interface CanvasKitSurfaceTarget {
  surface: SkSurface;
  canvas: HTMLCanvasElement;
}

interface CanvasKitLocalTypeface {
  typeface: Typeface | null;
  fontManager: FontMgr | null;
  fontFamily: string | null;
}

interface CanvasKitStyledTypeface {
  prepared: CanvasKitLocalTypeface | null;
  syntheticBold: boolean;
  syntheticItalic: boolean;
}

function primaryFontFamily(value: string | null | undefined): string {
  return (value ?? '')
    .split(',')[0]
    .trim()
    .replace(/^(["'])|(["'])$/g, '');
}

function normalizedFontFamily(value: string | null | undefined): string {
  return primaryFontFamily(value)
    .replace(/\u0000/g, '')
    .normalize('NFC')
    .replace(/\s+/g, ' ')
    .trim()
    .toLocaleLowerCase('en-US');
}

interface EquationTypeface {
  typeface: Typeface;
  legacy?: boolean;
  syntheticItalic: boolean;
  syntheticBold: boolean;
}

interface EquationRenderBudget {
  remainingNodes: number;
  hft: boolean;
  modernHy: boolean;
}

export interface CanvasKitRenderDiagnostics {
  mode: CanvasKitRenderMode;
  surfacePreference: CanvasKitSurfacePreference;
  surfaceBackend: 'default' | 'software' | null;
  surfaceFallbackReason: string | null;
  lastRenderCompleted: boolean;
  lastUnsupportedOps: string[];
  lastExpectedUnsupportedOps: string[];
  lastUnexpectedUnsupportedOps: string[];
  lastRenderError: string | null;
  passesRuntimeReadinessGate: boolean;
  readinessBlockers: CanvasKitReadinessBlocker[];
  hiddenCanvas2dOverlayUsed: false;
  lastRenderDurationMs: number | null;
  renderCount: number;
  imageCacheEntries: number;
  imageCacheLimit: number;
  imageCachePixels: number;
  imageCachePixelLimit: number;
  imageCacheHits: number;
  imageCacheMisses: number;
  imageCacheEvictions: number;
  localTypefaceCount: number;
  localTypefaceLoadFailureCount: number;
  localTypefacePendingCount: number;
  bundledTypefaceCount: number;
  bundledTypefaceLoadFailureCount: number;
}

export type CanvasKitReadinessBlocker =
  | 'renderNotCompleted'
  | 'renderError'
  | 'unexpectedUnsupportedOps'
  | 'localFontsPending';

export class CanvasKitLayerRenderer {
  private readonly equationLiteralFont = createEquationLiteralFontResolver(resolveLocalFont, getImportedLocalFontBytes);
  // Prevent pathological tiled fills from monopolizing the render loop.
  private static readonly MAX_IMAGE_TILE_DRAWS = 4096;
  private static readonly MAX_IMAGE_CACHE_ENTRIES = 128;
  private static readonly MAX_IMAGE_FAILURE_CACHE_ENTRIES = 128;
  private static readonly MAX_SVG_GLYPH_CACHE_ENTRIES = 128;
  private static readonly MAX_ENCODED_IMAGE_BASE64_LENGTH = 24 * 1024 * 1024;
  private static readonly MAX_DECODED_IMAGE_PIXELS = 32 * 1024 * 1024;
  private static readonly MAX_IMAGE_CACHE_PIXELS = 16 * 1024 * 1024;
  private static readonly MAX_BITMAP_GLYPH_BASE64_LENGTH = Math.ceil(4 * 1024 * 1024 / 3) * 4;
  private static readonly MAX_STATIC_SVG_GLYPH_BYTES = 1024 * 1024;
  private static readonly MAX_PLACEHOLDER_DASH_SEGMENTS_PER_AXIS = 2048;
  private static readonly MAX_EQUATION_LAYOUT_DEPTH = 64;
  private static readonly MAX_EQUATION_LAYOUT_NODES = 4096;
  private static readonly MAX_EQUATION_TEXT_LENGTH = 4096;
  private static readonly MAX_TEXT_VISUAL_WAVE_SEGMENTS = 4096;
  private static readonly MAX_TEXT_SPECIAL_VISUAL_ITEMS = 4096;
  private static readonly MAX_TEXT_RUN_FALLBACK_SPANS = 4096;
  // 단일 text run은 줄바꿈 없이 문서가 지정한 위치에 재생한다.
  private static readonly MAX_SHAPED_TEXT_WIDTH = 1_000_000;
  private static readonly MAX_BUNDLED_FONT_BYTES = 32 * 1024 * 1024;

  private readonly imageCache = new Map<string, { image: SkImage; pixels: number }>();
  private readonly imageDecodeFailures = new Set<string>();
  private readonly svgGlyphPathCache = new Map<string, StaticSvgPathLayer[]>();
  private readonly svgGlyphParseFailures = new Set<string>();
  private readonly localTypefaces = new Map<string, CanvasKitLocalTypeface>();
  private readonly localTypefaceRecords = new Map<string, LocalFontRecord>();
  private readonly equationTypefaces = new Map<string, EquationTypeface[]>();
  private readonly localTypefaceLoadFailures = new Set<string>();
  private readonly localTypefacePending = new Map<string, number>();
  private readonly bundledTypefaces = new Map<string, CanvasKitLocalTypeface>();
  private readonly bundledTypefaceAliases = new Map<string, CanvasKitLocalTypeface>();
  private readonly bundledTypefaceLoadFailures = new Set<string>();
  private readonly bundledFontRequests = new Set<AbortController>();
  private readonly unsupportedOps = new Set<string>();
  private surfaceBackend: 'default' | 'software' | null = null;
  private surfaceFallbackReason: string | null = null;
  private lastRenderError: string | null = null;
  private lastRenderCompleted = false;
  private lastRenderDurationMs: number | null = null;
  private renderCount = 0;
  private imageCacheHits = 0;
  private imageCacheMisses = 0;
  private imageCacheEvictions = 0;
  private imageCachePixels = 0;
  private currentResources: LayerResources | undefined;
  private currentShowParagraphMarks = false;
  private currentShowControlCodes = false;
  private currentRenderScale = 1;
  private currentRenderProfile: LayerRenderProfile = 'screen';
  private selectedTextVariantOps = new WeakSet<LayerPaintOp>();
  private documentGeneration = 0;
  private disposed = false;

  private constructor(
    private readonly canvasKit: CanvasKitApi,
    private readonly renderMode: CanvasKitRenderMode,
    private readonly surfaceRequest: CanvasKitSurfaceRequest,
    private readonly defaultTypeface: Typeface | null,
    private readonly symbolFallbackTypeface: Typeface | null,
    private readonly defaultFontManager: FontMgr | null = null,
    private readonly defaultFontFamily: string | null = null,
    private readonly defaultFontUrl: string = 'fonts/NotoSansKR-Regular.woff2',
    private readonly requirePreparedFontFamilies: boolean = false,
    private readonly oldHangulTypeface: CanvasKitLocalTypeface | null = null,
    private readonly oldHangulFontUrl: string = 'fonts/SourceHanSerifK-OldHangul-subset.woff2',
    private readonly equationTypeface: Typeface | null = null,
  ) {}

  static async create(
    renderMode: CanvasKitRenderMode = 'default',
    surfaceRequest: CanvasKitSurfaceRequest | CanvasKitSurfacePreference = DEFAULT_CANVASKIT_SURFACE_REQUEST,
    options: CanvasKitLayerRendererOptions = {},
  ): Promise<CanvasKitLayerRenderer> {
    const canvasKit = await CanvasKitInit({
      locateFile: (file) => file === 'canvaskit.wasm' ? canvaskitWasmUrl : file,
    });
    const resolvedSurfaceRequest = typeof surfaceRequest === 'string'
      ? { ...DEFAULT_CANVASKIT_SURFACE_REQUEST, preference: surfaceRequest, requested: surfaceRequest }
      : surfaceRequest;
    // 기본 Noto는 local face가 없거나 등록에 실패한 text run의 안정적인 CJK fallback이다.
    let defaultTypeface: Typeface | null = null;
    let defaultFontManager: FontMgr | null = null;
    let defaultFontFamily: string | null = null;
    const defaultFontUrl = options.defaultFontUrl ?? 'fonts/NotoSansKR-Regular.woff2';
    try {
      const response = await fetch(defaultFontUrl);
      if (response.ok) {
        const bytes = await readBoundedResponseArrayBuffer(response, {
          maxBytes: CanvasKitLayerRenderer.MAX_BUNDLED_FONT_BYTES,
        });
        defaultTypeface = canvasKit.Typeface.MakeFreeTypeFaceFromData(bytes)
          ?? canvasKit.Typeface.MakeTypefaceFromData(bytes);
        defaultFontManager = canvasKit.FontMgr.FromData(bytes);
        if (defaultFontManager && defaultFontManager.countFamilies() > 0) {
          defaultFontFamily = defaultFontManager.getFamilyName(0);
        }
      } else {
        await cancelResponseBody(response, `HTTP ${response.status}`);
      }
    } catch (error) {
      console.warn('[CanvasKitLayerRenderer] 기본 CJK 폰트 로딩 실패:', error);
    }
    let symbolFallbackTypeface: Typeface | null = null;
    const symbolFallbackFontUrl = options.symbolFallbackFontUrl
      ?? 'fonts/D2Coding-Regular.woff2';
    try {
      const response = await fetch(symbolFallbackFontUrl);
      if (response.ok) {
        const bytes = await readBoundedResponseArrayBuffer(response, {
          maxBytes: CanvasKitLayerRenderer.MAX_BUNDLED_FONT_BYTES,
        });
        symbolFallbackTypeface = canvasKit.Typeface.MakeFreeTypeFaceFromData(bytes)
          ?? canvasKit.Typeface.MakeTypefaceFromData(bytes);
      } else {
        await cancelResponseBody(response, `HTTP ${response.status}`);
      }
    } catch (error) {
      console.warn('[CanvasKitLayerRenderer] 기호 폴백 폰트 로딩 실패:', error);
    }
    let oldHangulTypeface: CanvasKitLocalTypeface | null = null;
    const oldHangulFontUrl = options.oldHangulFontUrl
      ?? 'fonts/SourceHanSerifK-OldHangul-subset.woff2';
    let oldHangulNativeTypeface: Typeface | null = null;
    let oldHangulFontManager: FontMgr | null = null;
    try {
      const response = await fetch(oldHangulFontUrl);
      if (response.ok) {
        const bytes = await readBoundedResponseArrayBuffer(response, {
          maxBytes: CanvasKitLayerRenderer.MAX_BUNDLED_FONT_BYTES,
        });
        oldHangulNativeTypeface = canvasKit.Typeface.MakeFreeTypeFaceFromData(bytes)
          ?? canvasKit.Typeface.MakeTypefaceFromData(bytes);
        oldHangulFontManager = canvasKit.FontMgr.FromData(bytes.slice(0));
        const fontFamily = oldHangulFontManager && oldHangulFontManager.countFamilies() > 0
          ? oldHangulFontManager.getFamilyName(0)
          : OLD_HANGUL_FONT_FAMILY;
        if (oldHangulNativeTypeface || oldHangulFontManager) {
          oldHangulTypeface = {
            typeface: oldHangulNativeTypeface,
            fontManager: oldHangulFontManager,
            fontFamily,
          };
          oldHangulNativeTypeface = null;
          oldHangulFontManager = null;
        }
      } else {
        await cancelResponseBody(response, `HTTP ${response.status}`);
      }
    } catch (error) {
      oldHangulNativeTypeface?.delete?.();
      oldHangulFontManager?.delete?.();
      console.warn('[CanvasKitLayerRenderer] 옛한글 shaping 폰트 로딩 실패:', error);
    }
    let equationTypeface: Typeface | null = null;
    try {
      const response = await fetch(options.equationFontUrl ?? 'fonts/LatinModernMath-Regular.woff2');
      if (response.ok) {
        const bytes = await readBoundedResponseArrayBuffer(response, {
          maxBytes: CanvasKitLayerRenderer.MAX_BUNDLED_FONT_BYTES,
        });
        equationTypeface = canvasKit.Typeface.MakeFreeTypeFaceFromData(bytes)
          ?? canvasKit.Typeface.MakeTypefaceFromData(bytes);
      } else {
        await cancelResponseBody(response, `HTTP ${response.status}`);
      }
    } catch (error) {
      console.warn('[CanvasKitLayerRenderer] 수식 폰트 로딩 실패:', error);
    }
    return new CanvasKitLayerRenderer(
      canvasKit,
      renderMode,
      resolvedSurfaceRequest,
      defaultTypeface,
      symbolFallbackTypeface,
      defaultFontManager,
      defaultFontFamily,
      defaultFontUrl,
      options.requirePreparedFontFamilies ?? false,
      oldHangulTypeface,
      oldHangulFontUrl,
      equationTypeface,
    );
  }

  /** Auto selection에서 승인된 문서 폰트를 첫 replay 전에 native Typeface로 등록한다. */
  async prepareBundledFonts(sources: readonly CanvasKitBundledFontSource[]): Promise<number> {
    if (this.disposed || sources.length === 0) return 0;
    const generation = this.documentGeneration;
    let registered = 0;
    for (const source of sources) {
      if (!source.url || source.aliases.length === 0) continue;
      const requiresShapingManager = source.aliases.some(alias => (
        normalizedFontFamily(alias) === normalizedFontFamily(OLD_HANGUL_FONT_FAMILY)
      ));
      let prepared = source.url === this.oldHangulFontUrl && this.oldHangulTypeface
        ? this.oldHangulTypeface
        : source.url === this.defaultFontUrl && (this.defaultTypeface || this.defaultFontManager)
          ? {
            typeface: this.defaultTypeface,
            fontManager: this.defaultFontManager,
            fontFamily: this.defaultFontFamily,
          }
          : this.bundledTypefaces.get(source.url) ?? null;
      if (prepared && requiresShapingManager && !prepared.fontManager) {
        throw new Error(`CanvasKit shaping font source 준비 실패: ${source.url}`);
      }
      if (!prepared) {
        if (this.bundledTypefaceLoadFailures.has(source.url)) {
          throw new Error(`CanvasKit font source 준비 실패: ${source.url}`);
        }
        let typeface: Typeface | null = null;
        let fontManager: FontMgr | null = null;
        const request = new AbortController();
        this.bundledFontRequests.add(request);
        try {
          if (this.disposed || generation !== this.documentGeneration) {
            throw new Error('문서 교체로 CanvasKit font 준비가 취소되었습니다');
          }
          const response = await fetch(source.url, { signal: request.signal });
          if (!response.ok) {
            await cancelResponseBody(response, `HTTP ${response.status}`);
            throw new Error(`HTTP ${response.status}`);
          }
          const bytes = await readBoundedResponseArrayBuffer(response, {
            maxBytes: CanvasKitLayerRenderer.MAX_BUNDLED_FONT_BYTES,
            signal: request.signal,
            isCancelled: () => this.disposed || generation !== this.documentGeneration,
            cancelledMessage: '문서 교체로 CanvasKit font 준비가 취소되었습니다',
          });
          if (this.disposed || generation !== this.documentGeneration) {
            throw new Error('문서 교체로 CanvasKit font 준비가 취소되었습니다');
          }
          typeface = this.canvasKit.Typeface.MakeFreeTypeFaceFromData(bytes)
            ?? this.canvasKit.Typeface.MakeTypefaceFromData(bytes);
          fontManager = this.canvasKit.FontMgr.FromData(bytes.slice(0));
          if ((!typeface && !fontManager) || (requiresShapingManager && !fontManager)) {
            throw new Error('CanvasKit이 font payload를 해석하지 못했습니다');
          }
          const fontFamily = fontManager && fontManager.countFamilies() > 0
            ? fontManager.getFamilyName(0)
            : source.aliases[0];
          prepared = { typeface, fontManager, fontFamily };
          this.bundledTypefaces.set(source.url, prepared);
          registered += 1;
          typeface = null;
          fontManager = null;
        } catch (error) {
          typeface?.delete?.();
          fontManager?.delete?.();
          if (!request.signal.aborted
            && !this.disposed && generation === this.documentGeneration) {
            this.bundledTypefaceLoadFailures.add(source.url);
          }
          throw new Error(`CanvasKit font source 준비 실패 (${source.url}): ${error}`);
        } finally {
          this.bundledFontRequests.delete(request);
        }
      }
      for (const alias of source.aliases) {
        const key = normalizedFontFamily(alias);
        if (key) this.bundledTypefaceAliases.set(key, prepared);
      }
      await Promise.resolve();
    }
    this.equationTypefaces.clear();
    return registered;
  }

  /** 현재 문서가 실제로 사용하는 설치 글꼴만 CanvasKit native 객체로 등록한다. */
  async prepareLocalFonts(fontNames: readonly string[] | undefined): Promise<number> {
    if (this.disposed || !fontNames?.length) return 0;
    const generation = this.documentGeneration;
    const pendingRecords = new Map<string, LocalFontRecord>();
    const auxiliaryFamilies = new Set([...equationFontFamilies('HYhwpEQ'), 'STIXGeneral', 'Cambria Math', 'HSUSR', 'HSUSRI', 'HSUSFL', 'HSUSSP', 'Batang', ...HANCOM_PUA_FALLBACK_FAMILIES]
      .map(name => name.toLowerCase()));
    const knownFaces = getLocalFontRecords({ includeRegistered: true });
    const auxiliaryFaces = knownFaces
      .filter(record => auxiliaryFamilies.has(record.family.toLowerCase()));
    const requestedFaces = new Map<string, LocalFontRecord>();
    const fallbacks = fontNames.flatMap(name => resolveLocalFont(name) ? [] : [...rendererFontFallbackFamilies(name)]);
    for (const fontName of [...fontNames, ...fallbacks, ...auxiliaryFaces.map(record => record.fullName)]) {
      const resolved = resolveLocalFont(fontName);
      if (!resolved) continue;
      const resolvedKey = localFontFaceKey(resolved);
      const prior = requestedFaces.get(resolvedKey);
      if (!prior || (!prior.runtimeFamily && resolved.runtimeFamily)) {
        requestedFaces.set(resolvedKey, resolved);
      }
      // Skia Typeface does not choose sibling bold/italic faces by CSS weight.
      // Prepare the closest 400/700 face in each slant; an explicitly named
      // Black or Semibold face above is kept in addition to these defaults.
      const siblings = preferredFamilyStyleFaces(knownFaces.filter(sibling =>
        normalizedFontFamily(sibling.family) === normalizedFontFamily(resolved.family)));
      for (const sibling of siblings) {
        const siblingKey = localFontFaceKey(sibling);
        const priorSibling = requestedFaces.get(siblingKey);
        if (!priorSibling || (!priorSibling.runtimeFamily && sibling.runtimeFamily)) {
          requestedFaces.set(siblingKey, sibling);
        }
      }
    }
    for (const record of requestedFaces.values()) {
      const faceKey = record ? localFontFaceKey(record) : '';
      if (!faceKey) continue;
      // 같은 이름의 파일을 다시 가져오면 이전 face/실패 캐시를 재사용하지 않는다.
      // record identity는 비동기 파싱 중 교체된 결과가 새 face를 덮는 것도 막는다.
      if (this.localTypefaceRecords.get(faceKey) !== record) {
        const previous = this.localTypefaces.get(faceKey);
        previous?.typeface?.delete?.();
        previous?.fontManager?.delete?.();
        this.localTypefaces.delete(faceKey);
        this.localTypefaceLoadFailures.delete(faceKey);
        this.localTypefacePending.delete(faceKey);
        this.localTypefaceRecords.set(faceKey, record);
        this.equationTypefaces.clear();
      }
      if (this.localTypefaces.has(faceKey)
        || this.localTypefaceLoadFailures.has(faceKey) || this.localTypefacePending.has(faceKey)) continue;
      pendingRecords.set(faceKey, record);
      this.localTypefacePending.set(faceKey, generation);
    }

    let registered = 0;
    try {
      const bytesByFace = await loadLocalFontBytesFor([...pendingRecords.values()].map(record => record.fullName));
      for (const [faceKey, record] of pendingRecords) {
        const bytes = bytesByFace.get(faceKey);
        if (this.disposed || generation !== this.documentGeneration) return registered;
        if (this.localTypefaceRecords.get(faceKey) !== record) continue;
        if (this.localTypefaces.has(faceKey) || this.localTypefaceLoadFailures.has(faceKey)) continue;
        if (!bytes) {
          this.localTypefaceLoadFailures.add(faceKey);
          continue;
        }
        let typeface: Typeface | null = null;
        let fontManager: FontMgr | null = null;
        try {
          typeface = this.canvasKit.Typeface.MakeFreeTypeFaceFromData(bytes)
            ?? this.canvasKit.Typeface.MakeTypefaceFromData(bytes);
          fontManager = this.canvasKit.FontMgr.FromData(bytes.slice(0));
          if (!typeface && !fontManager) {
            this.localTypefaceLoadFailures.add(faceKey);
            continue;
          }
          const fontFamily = fontManager && fontManager.countFamilies() > 0
            ? fontManager.getFamilyName(0)
            : record.family;
          this.localTypefaces.set(faceKey, { typeface, fontManager, fontFamily });
          registered += 1;
        } catch (error) {
          typeface?.delete?.();
          fontManager?.delete?.();
          this.localTypefaceLoadFailures.add(faceKey);
          console.warn(`[CanvasKitLayerRenderer] ${record.displayName} local Typeface 등록 실패:`, error);
        }
        // native font parsing은 동기 작업이므로 face 사이에서 paint/event loop에 양보한다.
        await new Promise<void>(resolve => window.setTimeout(resolve, 0));
      }
    } finally {
      for (const [faceKey, record] of pendingRecords) {
        if (this.localTypefacePending.get(faceKey) === generation
          && this.localTypefaceRecords.get(faceKey) === record) {
          this.localTypefacePending.delete(faceKey);
        }
      }
    }
    this.equationTypefaces.clear();
    return registered;
  }

  renderPage(
    tree: PageLayerTree,
    targetCanvas: HTMLCanvasElement,
    scale: number,
    pageInfo?: PageInfo,
  ): HTMLCanvasElement {
    if (this.disposed) {
      throw new Error('CanvasKit renderer가 이미 dispose되었습니다');
    }
    this.unsupportedOps.clear();
    this.lastRenderError = null;
    this.lastRenderCompleted = false;
    let surface: SkSurface | null = null;
    let renderedCanvas = targetCanvas;
    const renderStartedAt = performance.now();
    try {
      const surfaceTarget = this.makeSurface(targetCanvas);
      surface = surfaceTarget.surface;
      renderedCanvas = surfaceTarget.canvas;
      const canvas = surface.getCanvas();
      this.currentResources = tree.resources;
      this.currentShowParagraphMarks = tree.outputOptions?.showParagraphMarks === true;
      this.currentShowControlCodes = tree.outputOptions?.showControlCodes === true;
      this.currentRenderScale = scale;
      this.currentRenderProfile = tree.profile ?? 'screen';
      if (this.currentShowControlCodes) {
        this.unsupportedOps.add('viewOption:showControlCodes');
      }
      this.selectedTextVariantOps = new WeakSet<LayerPaintOp>();
      this.selectTextVariants(tree.root);
      let hasPageBackground = false;
      const stack: LayerNode[] = [tree.root];
      while (stack.length > 0 && !hasPageBackground) {
        const node = stack.pop()!;
        if (node.kind === 'group') {
          stack.push(...node.children);
        } else if (node.kind === 'clipRect') {
          stack.push(node.child);
        } else {
          hasPageBackground = node.ops.some((op) => op.type === 'pageBackground');
        }
      }
      canvas.save();
      canvas.clear(this.color(hasPageBackground ? 'rgba(0,0,0,0)' : '#ffffff'));
      canvas.scale(scale, scale);
      const rightOverflowSlop =
        tree.outputOptions?.showParagraphMarks || tree.outputOptions?.showControlCodes ? 48 : undefined;
      for (const replayPlane of CANVASKIT_REPLAY_PLANES) {
        this.renderNode(canvas, tree.root, tree.profile ?? 'screen', replayPlane, null, rightOverflowSlop);
      }
      if (pageInfo) {
        const paint = this.makeStrokePaint('#c0c0c0', 0.3);
        const left = pageInfo.marginLeft;
        const top = pageInfo.marginHeader + pageInfo.marginTop;
        const right = pageInfo.width - pageInfo.marginRight;
        const bottom = pageInfo.height - pageInfo.marginFooter - pageInfo.marginBottom;
        const length = 15;
        canvas.drawLine(left, top - length, left, top, paint);
        canvas.drawLine(left, top, left - length, top, paint);
        canvas.drawLine(right + length, top, right, top, paint);
        canvas.drawLine(right, top, right, top - length, paint);
        canvas.drawLine(left - length, bottom, left, bottom, paint);
        canvas.drawLine(left, bottom, left, bottom + length, paint);
        canvas.drawLine(right, bottom + length, right, bottom, paint);
        canvas.drawLine(right, bottom, right + length, bottom, paint);
        paint.delete();
      }
      canvas.restore();
      surface.flush();
      this.lastRenderCompleted = true;
    } catch (error) {
      this.recordRenderFailure(error);
      throw error;
    } finally {
      surface?.delete();
      this.currentResources = undefined;
      this.currentShowParagraphMarks = false;
      this.currentShowControlCodes = false;
      this.currentRenderScale = 1;
      this.currentRenderProfile = 'screen';
      this.lastRenderDurationMs = performance.now() - renderStartedAt;
      this.renderCount += 1;
    }
    return renderedCanvas;
  }

  releaseLayerTree(_tree: PageLayerTree): void {
    /* Per-tree native picture interning is not implemented yet. */
  }

  resetDocumentResources(): void {
    this.documentGeneration += 1;
    this.cancelDocumentPreparation();
    for (const entry of this.imageCache.values()) entry.image?.delete?.();
    this.imageCache.clear();
    this.imageCachePixels = 0;
    this.imageDecodeFailures.clear();
    this.svgGlyphPathCache.clear();
    this.svgGlyphParseFailures.clear();
    this.currentResources = undefined;
    this.selectedTextVariantOps = new WeakSet<LayerPaintOp>();
    for (const { typeface, fontManager } of this.localTypefaces.values()) {
      typeface?.delete?.();
      fontManager?.delete?.();
    }
    this.localTypefaces.clear();
    this.localTypefaceRecords.clear();
    this.equationTypefaces.clear();
    this.localTypefaceLoadFailures.clear();
    this.localTypefacePending.clear();
    for (const { typeface, fontManager } of this.bundledTypefaces.values()) {
      typeface?.delete?.();
      fontManager?.delete?.();
    }
    this.bundledTypefaces.clear();
    this.bundledTypefaceAliases.clear();
    this.bundledTypefaceLoadFailures.clear();
    this.imageCacheHits = 0;
    this.imageCacheMisses = 0;
    this.imageCacheEvictions = 0;
    this.renderCount = 0;
    this.lastRenderDurationMs = null;
  }

  cancelDocumentPreparation(): void {
    for (const request of this.bundledFontRequests) {
      request.abort(new Error('문서 교체로 CanvasKit font 준비가 취소되었습니다'));
    }
    this.bundledFontRequests.clear();
  }

  diagnostics(): CanvasKitRenderDiagnostics {
    const lastUnsupportedOps = [...this.unsupportedOps].sort();
    const lastExpectedUnsupportedOps = lastUnsupportedOps.filter(isExpectedCanvasKitUnsupportedOp);
    const lastUnexpectedUnsupportedOps = lastUnsupportedOps.filter(
      (op) => !isExpectedCanvasKitUnsupportedOp(op),
    );
    const surfaceFallbackReason = this.surfaceFallbackReason ?? this.surfaceRequest.unsupportedReason ?? null;
    const readinessBlockers: CanvasKitReadinessBlocker[] = [];
    if (!this.lastRenderCompleted) readinessBlockers.push('renderNotCompleted');
    if (this.lastRenderError !== null) readinessBlockers.push('renderError');
    if (lastUnexpectedUnsupportedOps.length > 0) readinessBlockers.push('unexpectedUnsupportedOps');
    if (this.localTypefacePending.size > 0) readinessBlockers.push('localFontsPending');
    return {
      mode: this.renderMode,
      surfacePreference: this.surfaceRequest.preference,
      surfaceBackend: this.surfaceBackend,
      surfaceFallbackReason,
      lastRenderCompleted: this.lastRenderCompleted,
      lastUnsupportedOps,
      lastExpectedUnsupportedOps,
      lastUnexpectedUnsupportedOps,
      lastRenderError: this.lastRenderError,
      passesRuntimeReadinessGate: readinessBlockers.length === 0,
      readinessBlockers,
      hiddenCanvas2dOverlayUsed: false,
      lastRenderDurationMs: this.lastRenderDurationMs,
      renderCount: this.renderCount,
      imageCacheEntries: this.imageCache.size,
      imageCacheLimit: CanvasKitLayerRenderer.MAX_IMAGE_CACHE_ENTRIES,
      imageCachePixels: this.imageCachePixels,
      imageCachePixelLimit: CanvasKitLayerRenderer.MAX_IMAGE_CACHE_PIXELS,
      imageCacheHits: this.imageCacheHits,
      imageCacheMisses: this.imageCacheMisses,
      imageCacheEvictions: this.imageCacheEvictions,
      localTypefaceCount: this.localTypefaces.size,
      localTypefaceLoadFailureCount: this.localTypefaceLoadFailures.size,
      localTypefacePendingCount: this.localTypefacePending.size,
      bundledTypefaceCount: this.bundledTypefaces.size,
      bundledTypefaceLoadFailureCount: this.bundledTypefaceLoadFailures.size,
    };
  }

  recordRenderFailure(error: unknown, resetReplayState = false): void {
    if (resetReplayState) {
      this.unsupportedOps.clear();
      this.surfaceBackend = null;
      this.surfaceFallbackReason = null;
    }
    this.lastRenderCompleted = false;
    this.lastRenderError = error instanceof Error ? error.message : String(error);
    this.unsupportedOps.add('renderPage');
  }

  dispose(): void {
    this.disposed = true;
    this.resetDocumentResources();
    this.defaultTypeface?.delete();
    this.equationTypeface?.delete();
    this.symbolFallbackTypeface?.delete();
    this.defaultFontManager?.delete();
    this.oldHangulTypeface?.typeface?.delete?.();
    this.oldHangulTypeface?.fontManager?.delete?.();
  }

  private makeSurface(
    targetCanvas: HTMLCanvasElement,
  ): CanvasKitSurfaceTarget {
    this.surfaceBackend = null;
    this.surfaceFallbackReason = this.surfaceRequest.unsupportedReason ?? null;
    if (this.surfaceRequest.preference === 'webgpu' && this.surfaceFallbackReason === null) {
      this.surfaceFallbackReason = 'webgpuSurfaceUnsupported';
    }
    const reuseSoftwareFallbackCanvas = targetCanvas.classList.contains('ck-replaced');
    if (this.surfaceRequest.preference === 'software' || reuseSoftwareFallbackCanvas) {
      const swSurface = this.canvasKit.MakeSWCanvasSurface(targetCanvas);
      if (swSurface) {
        this.surfaceBackend = 'software';
        if (reuseSoftwareFallbackCanvas && this.surfaceFallbackReason === null) {
          this.surfaceFallbackReason = 'defaultSurfaceUnavailableUsingSoftware';
        }
        return { surface: swSurface, canvas: targetCanvas };
      }
      this.surfaceFallbackReason = 'softwareSurfaceUnavailable';
    }
    const originalParent = targetCanvas.parentElement;
    const originalChildIndex = originalParent
      ? Array.prototype.indexOf.call(originalParent.children, targetCanvas)
      : -1;
    try {
      const surface = this.canvasKit.MakeCanvasSurface(targetCanvas);
      if (surface) {
        const replacement = originalParent && originalChildIndex >= 0
          ? originalParent.children.item(originalChildIndex)
          : null;
        if (targetCanvas.parentElement !== originalParent && replacement instanceof HTMLCanvasElement) {
          this.surfaceBackend = 'software';
          if (this.surfaceFallbackReason === null) {
            this.surfaceFallbackReason = 'defaultSurfaceUnavailableUsingSoftware';
          }
          return { surface, canvas: replacement };
        }
        this.surfaceBackend = 'default';
        return { surface, canvas: targetCanvas };
      }
    } catch {
      if (this.surfaceFallbackReason === null) {
        this.surfaceFallbackReason = 'defaultSurfaceCreationFailed';
      }
    }
    const internalReplacement = originalParent && originalChildIndex >= 0
      ? originalParent.children.item(originalChildIndex)
      : null;
    let softwareCanvas = targetCanvas.parentElement !== originalParent
      && internalReplacement instanceof HTMLCanvasElement
      ? internalReplacement
      : targetCanvas;
    if (softwareCanvas === targetCanvas && targetCanvas.parentElement) {
      const parent = targetCanvas.parentElement;
      const replacement = targetCanvas.cloneNode(true) as HTMLCanvasElement;
      replacement.classList.add('ck-replaced');
      parent.replaceChild(replacement, targetCanvas);
      softwareCanvas = replacement;
    }
    const softwareSurface = this.canvasKit.MakeSWCanvasSurface(softwareCanvas);
    if (softwareSurface) {
      this.surfaceBackend = 'software';
      if (this.surfaceFallbackReason === null) {
        this.surfaceFallbackReason = 'defaultSurfaceUnavailableUsingSoftware';
      }
      return { surface: softwareSurface, canvas: softwareCanvas };
    }
    throw new Error('CanvasKit surface를 만들 수 없습니다');
  }

  private selectTextVariants(node: LayerNode): void {
    if (node.kind === 'group') {
      for (const child of node.children) this.selectTextVariants(child);
      return;
    }
    if (node.kind === 'clipRect') {
      this.selectTextVariants(node.child);
      return;
    }

    const selected = selectLayerTextVariantsForLeaf(
      node.ops,
      op => this.glyphOutlineVariantReplayable(op),
    );
    for (const op of selected) {
      this.selectedTextVariantOps.add(op);
    }
  }

  private glyphOutlineVariantReplayable(op: LayerGlyphOutlineOp): boolean {
    if (op.diagnostics?.strictVisualEligible !== true) return false;
    const status = glyphOutlinePayloadStatus(op, {
      allowMonochromeFillStroke: true,
      allowColrv1Stage1ColorGraph: true,
      allowBitmapGlyph: true,
      allowSvgGlyph: true,
    });
    if (!status.supported) return false;
    if (op.payloadKind === 'bitmapGlyph') {
      const imageOp = this.bitmapGlyphImageOp(op);
      return imageOp !== null && this.imageForOp(imageOp) !== null;
    }
    if (op.payloadKind === 'svgGlyph') {
      return this.staticSvgGlyphPathLayers(op) !== null;
    }
    return op.payloadKind === 'colorLayers'
      || op.payloadKind === 'monochromeFill'
      || op.payloadKind === 'monochromeFillStroke';
  }

  private layerResourceIndex(
    id: number | string | undefined,
    keys: string[] | undefined,
    length: number,
  ): number | null {
    if (typeof id === 'number' && Number.isInteger(id) && id >= 0 && id < length) return id;
    if (typeof id !== 'string') return null;
    const index = keys?.indexOf(id) ?? -1;
    return index >= 0 && index < length ? index : null;
  }

  private bitmapGlyphImageOp(op: LayerGlyphOutlineOp): LayerImageOp | null {
    const payload = op.bitmapGlyph;
    const resources = this.currentResources;
    const index = this.layerResourceIndex(
      payload?.imageResourceId ?? payload?.imageRef,
      resources?.imageKeys,
      resources?.images?.length ?? 0,
    );
    if (!payload || index === null || !payload.placement) return null;
    const base64 = resources?.images?.[index];
    const resourceKey = resources?.imageKeys?.[index];
    const payloadResourceKey = glyphOutlinePayloadResourceKey(op);
    let bytes: Uint8Array;
    try {
      if (typeof base64 !== 'string'
        || base64.length > CanvasKitLayerRenderer.MAX_BITMAP_GLYPH_BASE64_LENGTH) {
        return null;
      }
      bytes = base64ToBytes(base64);
    } catch {
      return null;
    }
    if (
      typeof resourceKey !== 'string'
      || payloadResourceKey === null
      || op.payloadResourceKey !== `${payloadResourceKey}:resource:${resourceKey}`
      || !layerResourceKeyMatches('img', resourceKey, bytes)
    ) {
      return null;
    }
    return {
      type: 'image',
      bbox: payload.placement,
      base64,
      imageRef: `glyph:${resourceKey}`,
      fillMode: 'fitToSize',
    };
  }

  private staticSvgGlyphPathLayers(op: LayerGlyphOutlineOp): StaticSvgPathLayer[] | null {
    const payload = op.svgGlyph;
    const resources = this.currentResources;
    const index = this.layerResourceIndex(
      payload?.vectorResourceId ?? payload?.svgRef,
      resources?.svgKeys,
      resources?.svgFragments?.length ?? 0,
    );
    if (!payload || index === null) return null;
    const fragment = resources?.svgFragments?.[index];
    const resourceKey = resources?.svgKeys?.[index];
    const payloadResourceKey = glyphOutlinePayloadResourceKey(op);
    if (typeof fragment !== 'string'
      || fragment.length > CanvasKitLayerRenderer.MAX_STATIC_SVG_GLYPH_BYTES) {
      return null;
    }
    const fragmentBytes = new TextEncoder().encode(fragment);
    if (
      fragmentBytes.byteLength > CanvasKitLayerRenderer.MAX_STATIC_SVG_GLYPH_BYTES
      || typeof resourceKey !== 'string'
      || payloadResourceKey === null
      || op.payloadResourceKey !== `${payloadResourceKey}:resource:${resourceKey}`
      || !layerResourceKeyMatches('svg', resourceKey, fragmentBytes)
    ) {
      return null;
    }
    const cached = this.svgGlyphPathCache.get(resourceKey);
    if (cached) {
      this.svgGlyphPathCache.delete(resourceKey);
      this.svgGlyphPathCache.set(resourceKey, cached);
      return cached;
    }
    if (this.svgGlyphParseFailures.has(resourceKey)) return null;

    const layers = parseStaticSvgPathLayers(fragment, op.paintStyle?.color ?? '#000000');
    if (layers.length === 0) {
      this.rememberSvgGlyphParseFailure(resourceKey);
      return null;
    }
    if (!staticSvgPathLayersAreReplayable(
      layers,
      pathData => this.canvasKit.Path.MakeFromSVGString(pathData),
    )) {
      this.rememberSvgGlyphParseFailure(resourceKey);
      return null;
    }
    if (this.svgGlyphPathCache.size >= CanvasKitLayerRenderer.MAX_SVG_GLYPH_CACHE_ENTRIES) {
      const oldestKey = this.svgGlyphPathCache.keys().next().value as string | undefined;
      if (oldestKey !== undefined) this.svgGlyphPathCache.delete(oldestKey);
    }
    this.svgGlyphPathCache.set(resourceKey, layers);
    return layers;
  }

  private rememberSvgGlyphParseFailure(resourceKey: string): void {
    if (this.svgGlyphParseFailures.size >= CanvasKitLayerRenderer.MAX_SVG_GLYPH_CACHE_ENTRIES) {
      const oldestKey = this.svgGlyphParseFailures.values().next().value as string | undefined;
      if (oldestKey !== undefined) this.svgGlyphParseFailures.delete(oldestKey);
    }
    this.svgGlyphParseFailures.add(resourceKey);
  }

  private renderNode(
    canvas: SkCanvas,
    node: LayerNode,
    profile: LayerRenderProfile,
    replayPlane: CanvasKitReplayPlane,
    inheritedLayer: LayerInfo | null = null,
    rightOverflowSlop?: number,
  ): void {
    const activeLayer = node.layer ?? inheritedLayer;
    if (node.kind === 'group') {
      for (const child of node.children) {
        this.renderNode(canvas, child, profile, replayPlane, activeLayer, rightOverflowSlop);
      }
      return;
    }
    if (node.kind === 'clipRect') {
      this.renderClipNode(canvas, node, profile, replayPlane, activeLayer, rightOverflowSlop);
      return;
    }
    this.renderLeaf(canvas, node, profile, replayPlane, activeLayer);
  }

  private renderClipNode(
    canvas: SkCanvas,
    node: LayerClipNode,
    profile: LayerRenderProfile,
    replayPlane: CanvasKitReplayPlane,
    inheritedLayer: LayerInfo | null,
    rightOverflowSlop?: number,
  ): void {
    const pad = canvaskitClipRightPad(this.renderMode, profile, node.clipKind, rightOverflowSlop);
    const clip = {
      ...node.clip,
      width: node.clip.width + pad,
    };
    canvas.save();
    canvas.clipRect(this.rect(clip), this.canvasKit.ClipOp?.Intersect ?? 0, true);
    this.renderNode(canvas, node.child, profile, replayPlane, inheritedLayer, rightOverflowSlop);
    canvas.restore();
  }

  private renderLeaf(
    canvas: SkCanvas,
    node: LayerLeafNode,
    profile: LayerRenderProfile,
    replayPlane: CanvasKitReplayPlane,
    inheritedLayer: LayerInfo | null,
  ): void {
    const activeLayer = node.layer ?? inheritedLayer;
    for (const op of node.ops) {
      if (layerPaintOpReplayPlane(op, activeLayer) !== replayPlane) {
        continue;
      }
      const equivalenceGroup = 'variant' in op ? op.variant?.equivalenceGroup : undefined;
      if (equivalenceGroup && !this.selectedTextVariantOps.has(op)) {
        continue;
      }
      this.renderOp(canvas, op, profile);
    }
  }

  private renderOp(canvas: SkCanvas, op: LayerPaintOp, profile: LayerRenderProfile): void {
    switch (op.type) {
      case 'pageBackground':
        this.renderPageBackground(canvas, op);
        return;
      case 'rectangle':
        this.renderRectangle(canvas, op);
        return;
      case 'ellipse':
        this.renderEllipse(canvas, op);
        return;
      case 'line':
        this.renderLine(canvas, op);
        return;
      case 'path':
        this.renderPath(canvas, op);
        return;
      case 'image':
        this.renderImage(canvas, op);
        return;
      case 'textRun':
        this.renderTextRun(canvas, op);
        return;
      case 'footnoteMarker':
        this.renderTextRun(canvas, {
          type: 'textRun',
          bbox: op.bbox,
          text: op.text,
          baseline: op.baseline ?? op.fontSize ?? 7,
          style: { fontFamily: op.fontFamily, fontSize: op.fontSize, bold: op.bold, color: op.color },
        });
        return;
      case 'formObject':
        this.renderFormObject(canvas, op);
        return;
      case 'placeholder':
        this.renderPlaceholder(canvas, op, profile);
        return;
      case 'equation':
        this.renderEquation(canvas, op);
        return;
      case 'rawSvg':
        this.unsupportedOps.add('rawSvg:unsupportedDirectReplay');
        return;
      case 'charOverlap':
        this.renderCharOverlap(canvas, op);
        return;
      case 'tabLeader':
        this.renderTabLeader(canvas, op);
        return;
      case 'textControlMark':
        this.renderTextControlMark(canvas, op);
        return;
      case 'textDecoration':
        this.renderTextDecoration(canvas, op);
        return;
      case 'glyphRun':
        this.unsupportedOps.add(op.type);
        return;
      case 'glyphOutline': {
        const status = glyphOutlinePayloadStatus(op, {
          allowMonochromeFillStroke: true,
          allowColrv1Stage1ColorGraph: true,
          allowBitmapGlyph: true,
          allowSvgGlyph: true,
        });
        if (status.supported && this.glyphOutlineVariantReplayable(op)) {
          this.renderGlyphOutline(canvas, op);
          return;
        }
        this.unsupportedOps.add(status.reason ? `glyphOutline:${status.reason}` : 'glyphOutline');
        return;
      }
      default:
        this.unsupportedOps.add((op as { type?: string }).type ?? 'unknown');
    }
  }

  private renderPageBackground(canvas: SkCanvas, op: LayerPageBackgroundOp): void {
    if (op.backgroundColor) {
      const paint = this.makeFillPaint(op.backgroundColor);
      canvas.drawRect(this.rect(op.bbox), paint);
      paint.delete?.();
    }
    if (op.gradient) {
      this.drawShapeGradient(canvas, op.bbox, op.gradient, 1, (paint) => {
        canvas.drawRect(this.rect(op.bbox), paint);
      });
    }
    if (op.image) {
      this.renderImage(canvas, {
        type: 'image', bbox: op.bbox, base64: op.image.base64, fillMode: op.image.fillMode,
      });
    }
    if (op.borderColor && (op.borderWidth ?? 0) > 0) {
      const aligned = this.pixelAlignedHairlineRect(op.bbox, op.borderWidth ?? 1);
      const paint = this.makeStrokePaint(op.borderColor, aligned?.strokeWidth ?? op.borderWidth ?? 1);
      canvas.drawRect(this.rect(aligned?.bounds ?? op.bbox), paint);
      paint.delete?.();
    }
  }

  private renderRectangle(canvas: SkCanvas, op: LayerRectangleOp): void {
    const hasTransform = op.transform?.rotation || op.transform?.horzFlip || op.transform?.vertFlip;
    const aligned = !hasTransform && (op.cornerRadius ?? 0) === 0 && op.style?.strokeColor
      ? this.pixelAlignedHairlineRect(op.bbox, op.style.strokeWidth ?? 1)
      : null;
    this.withShapeTransform(canvas, op.bbox, op.transform, () => {
      this.drawStyledShape(canvas, op.bbox, op.style, (paint) => {
        const cornerRadius = op.cornerRadius ?? 0;
        if (cornerRadius > 0) {
          canvas.drawRRect(this.canvasKit.RRectXY(this.rect(op.bbox), cornerRadius, cornerRadius), paint);
        } else {
          canvas.drawRect(this.rect(op.bbox), paint);
        }
      }, op.gradient, aligned ? {
        strokeWidth: aligned.strokeWidth,
        draw: (paint) => canvas.drawRect(this.rect(aligned.bounds), paint),
      } : undefined);
    });
  }

  private renderEllipse(canvas: SkCanvas, op: LayerEllipseOp): void {
    this.withShapeTransform(canvas, op.bbox, op.transform, () => {
      this.drawStyledShape(canvas, op.bbox, op.style, (paint) => {
        canvas.drawOval(this.rect(op.bbox), paint);
      }, op.gradient);
    });
  }

  private renderLine(canvas: SkCanvas, op: LayerLineOp): void {
    const strokeWidth = op.style?.width ?? 1;
    let x1 = op.x1;
    let y1 = op.y1;
    let x2 = op.x2;
    let y2 = op.y2;
    let width = strokeWidth;
    const hasTransform = op.transform?.rotation || op.transform?.horzFlip || op.transform?.vertFlip;
    const canSnap = !hasTransform
      && (op.style?.lineType === undefined || op.style.lineType === 'single')
      && (op.style?.startArrow === undefined || op.style.startArrow === 'none')
      && (op.style?.endArrow === undefined || op.style.endArrow === 'none');
    if (canSnap && x1 === x2) {
      const aligned = this.pixelAlignedHairline(x1, strokeWidth);
      if (aligned) { x1 = x2 = aligned.center; width = aligned.strokeWidth; }
    } else if (canSnap && y1 === y2) {
      const aligned = this.pixelAlignedHairline(y1, strokeWidth);
      if (aligned) { y1 = y2 = aligned.center; width = aligned.strokeWidth; }
    }
    const paint = this.makeStrokePaint(op.style?.color ?? '#000000', width, 1, op.style?.dash);
    this.withShapeTransform(canvas, op.bbox, op.transform, () => canvas.drawLine(x1, y1, x2, y2, paint));
    paint.delete?.();
  }

  private renderPath(canvas: SkCanvas, op: LayerPathOp): void {
    const path = this.makeCommandPath(op.commands ?? [], op.bbox.x, op.bbox.y);
    const style = op.style ?? (op.gradient ? {} : {
      strokeColor: op.lineStyle?.color ?? '#000000',
      strokeWidth: op.lineStyle?.width ?? 1,
      strokeDash: op.lineStyle?.dash,
      fillColor: null,
    });

    // [Task #1067] HWPX/HWP 도형의 회전 + flip 변환 적용 (src/paint/json.rs::write_transform).
    this.withShapeTransform(canvas, op.bbox, op.transform, () => {
      this.drawStyledPath(canvas, path, style, op.gradient, op.bbox);
    });
    path.delete?.();
  }

  private makeCommandPath(commands: readonly LayerPathCommand[], x = 0, y = 0): Path {
    const builder = new this.canvasKit.PathBuilder();
    try {
      for (const command of commands) [x, y] = this.applyPathCommand(builder, command, x, y);
      return builder.detach();
    } finally {
      builder.delete?.();
    }
  }

  private applyPathCommand(path: PathBuilder, command: LayerPathCommand, currentX: number, currentY: number): [number, number] {
    switch (command.type) {
      case 'moveTo':
        path.moveTo(command.x, command.y);
        return [command.x, command.y];
      case 'lineTo':
        path.lineTo(command.x, command.y);
        return [command.x, command.y];
      case 'curveTo':
        path.cubicTo(command.x1, command.y1, command.x2, command.y2, command.x3, command.y3);
        return [command.x3, command.y3];
      case 'arcTo':
        if (typeof path.arcToRotated === 'function') {
          path.arcToRotated(command.rx, command.ry, command.rotation, command.largeArc, command.sweep, command.x, command.y);
        } else {
          path.lineTo(command.x, command.y);
        }
        return [command.x, command.y];
      case 'closePath':
        path.close();
        return [currentX, currentY];
    }
  }

  private renderImage(canvas: SkCanvas, op: LayerImageOp): void {
    const image = this.imageForOp(op);
    if (!image) {
      this.unsupportedOps.add(op.base64 ? 'image:decodeFailed' : 'image:dataMissing');
      return;
    }
    this.recordImageCoverageGaps(op);
    const nominalHeightPt = op.shadow?.nominalHeightPt;
    const matrix = this.imageScaleTranslateMatrix(canvas);
    const transformed = op.transform?.rotation || op.transform?.horzFlip || op.transform?.vertFlip;
    const cssPerPt = 96 / 72;
    const widthPt = op.bbox.width / cssPerPt;
    const heightPt = op.bbox.height / cssPerPt;
    if (op.shadow && Number.isFinite(nominalHeightPt) && nominalHeightPt! > 0
      && !transformed && matrix && matrix[0] > 0 && matrix[4] > 0
      && Number.isFinite(widthPt) && Number.isFinite(heightPt) && widthPt >= 1 && heightPt >= 1) {
      // 그림자 전경의 정수 pt 래스터 경계는 변환 전 hp:sz 높이를 기준으로 삼는다.
      op = { ...op, bbox: {
        x: op.bbox.x,
        y: op.bbox.y + (Math.floor(heightPt) - Math.ceil(nominalHeightPt!)) * cssPerPt,
        width: Math.floor(widthPt) * cssPerPt,
        height: Math.floor(heightPt) * cssPerPt,
      } };
    }
    this.withShapeTransform(canvas, op.bbox, op.transform, () => this.drawImageOp(canvas, image, op));
  }

  private renderGlyphOutline(canvas: SkCanvas, op: LayerGlyphOutlineOp): void {
    if (op.payloadKind === 'bitmapGlyph') {
      this.renderBitmapGlyphOutline(canvas, op);
      return;
    }
    if (op.payloadKind === 'svgGlyph') {
      this.renderSvgGlyphOutline(canvas, op);
      return;
    }
    if (op.payloadKind === 'monochromeFill' || op.payloadKind === 'monochromeFillStroke') {
      this.renderMonochromeGlyphOutline(canvas, op);
      return;
    }
    const graph = op.colorLayers?.paintGraph;
    const nodes = graph?.nodes ?? [];
    if (!graph || nodes.length === 0 || graph.rootNodeId === undefined) {
      this.unsupportedOps.add('glyphOutline:replayInvariant');
      return;
    }
    const nodesById = new Map<number, LayerColorGraphNode>();
    for (const node of nodes) {
      if (node.nodeId !== undefined) {
        nodesById.set(node.nodeId, node);
      }
    }
    canvas.save();
    const matrix = this.affineToCanvasKitMatrix(op.placement?.runToPage);
    if (matrix) {
      (canvas as unknown as { concat?: (matrix: number[]) => void }).concat?.(matrix);
    }
    try {
      this.renderColorPaintGraphNode(canvas, nodesById, graph.rootNodeId, new Set());
    } finally {
      canvas.restore();
    }
  }

  private renderBitmapGlyphOutline(canvas: SkCanvas, op: LayerGlyphOutlineOp): void {
    const imageOp = this.bitmapGlyphImageOp(op);
    const image = imageOp ? this.imageForOp(imageOp) : null;
    if (!imageOp || !image) {
      this.unsupportedOps.add('glyphOutline:bitmapReplayInvariant');
      return;
    }
    canvas.save();
    try {
      const transform = op.bitmapGlyph?.transformToRun;
      const matrix = this.affineToCanvasKitMatrix(transform);
      if (matrix) (canvas as unknown as { concat: (matrix: number[]) => void }).concat(matrix);
      this.drawImageOp(canvas, image, imageOp, false);
    } finally {
      canvas.restore();
    }
  }

  private renderSvgGlyphOutline(canvas: SkCanvas, op: LayerGlyphOutlineOp): void {
    const payload = op.svgGlyph;
    const viewBox = payload?.viewBox;
    const layers = this.staticSvgGlyphPathLayers(op);
    if (!payload || !viewBox || !layers || !this.boundsAreDrawable(op.bbox) || !this.boundsAreDrawable(viewBox)) {
      this.unsupportedOps.add('glyphOutline:svgReplayInvariant');
      return;
    }
    canvas.save();
    try {
      const payloadMatrix = this.affineToCanvasKitMatrix(payload.transformToRun);
      if (payloadMatrix) {
        (canvas as unknown as { concat: (matrix: number[]) => void }).concat(payloadMatrix);
      }
      canvas.translate(op.bbox.x, op.bbox.y);
      canvas.scale(op.bbox.width / viewBox.width, op.bbox.height / viewBox.height);
      canvas.translate(-viewBox.x, -viewBox.y);
      for (const layer of layers) {
        canvas.save();
        let path: Path | null = null;
        try {
          const layerMatrix = this.affineToCanvasKitMatrix(layer.transform);
          if (layerMatrix) {
            (canvas as unknown as { concat: (matrix: number[]) => void }).concat(layerMatrix);
          }
          path = this.canvasKit.Path.MakeFromSVGString(layer.pathData);
          if (!path) continue;
          this.applyGlyphPathFillRule(path, layer.fillRule);
          if (layer.fill !== null) {
            let paint: SkPaint | null = null;
            try {
              paint = this.makeFillPaint(layer.fill, layer.opacity);
              canvas.drawPath(path, paint);
            } finally {
              paint?.delete?.();
            }
          }
          if (layer.stroke) {
            const stroke = layer.stroke;
            let paint: SkPaint | null = null;
            let effect: ReturnType<typeof this.canvasKit.PathEffect.MakeDash> | null = null;
            try {
              paint = this.makeStrokePaint(stroke.color, stroke.width, stroke.opacity);
              paint.setStrokeJoin(this.canvasKit.StrokeJoin[
                stroke.lineJoin === 'round' ? 'Round' : stroke.lineJoin === 'bevel' ? 'Bevel' : 'Miter'
              ]);
              paint.setStrokeCap(this.canvasKit.StrokeCap[
                stroke.lineCap === 'round' ? 'Round' : stroke.lineCap === 'square' ? 'Square' : 'Butt'
              ]);
              paint.setStrokeMiter(stroke.miterLimit);
              effect = stroke.dashArray
                ? this.canvasKit.PathEffect.MakeDash(stroke.dashArray, stroke.dashOffset)
                : null;
              if (effect) paint.setPathEffect(effect);
              canvas.drawPath(path, paint);
            } finally {
              effect?.delete?.();
              paint?.delete?.();
            }
          }
        } finally {
          path?.delete?.();
          canvas.restore();
        }
      }
    } finally {
      canvas.restore();
    }
  }

  private renderMonochromeGlyphOutline(canvas: SkCanvas, op: LayerGlyphOutlineOp): void {
    const matrix = this.affineToCanvasKitMatrix(op.placement?.runToPage);
    if (!matrix || !op.paths?.length) {
      this.unsupportedOps.add('glyphOutline:replayInvariant');
      return;
    }
    const fill = this.makeFillPaint(op.paintStyle?.color ?? '#000000');
    const stroke = op.payloadKind === 'monochromeFillStroke' && op.stroke
      ? this.makeStrokePaint(op.stroke.color ?? op.paintStyle?.color ?? '#000000', op.stroke.width ?? 1)
      : null;
    canvas.save();
    try {
      (canvas as unknown as { concat: (matrix: number[]) => void }).concat(matrix);
      for (const outline of op.paths) {
        const path = this.makeCommandPath(outline.commands ?? []);
        try {
          this.applyGlyphPathFillRule(path, outline.fillRule);
          canvas.drawPath(path, fill);
          if (stroke) canvas.drawPath(path, stroke);
        } finally {
          path.delete?.();
        }
      }
    } finally {
      canvas.restore();
      stroke?.delete?.();
      fill.delete?.();
    }
  }

  private applyGlyphPathFillRule(path: Path, fillRule: string | undefined): void {
    path.setFillType(fillRule === 'evenodd' ? this.canvasKit.FillType.EvenOdd : this.canvasKit.FillType.Winding);
  }

  private renderColorPaintGraphNode(
    canvas: SkCanvas,
    nodesById: Map<number, LayerColorGraphNode>,
    nodeId: number,
    visited: Set<number>,
  ): void {
    if (visited.has(nodeId)) {
      this.unsupportedOps.add('glyphOutline:replayInvariant');
      return;
    }
    visited.add(nodeId);
    const node = nodesById.get(nodeId);
    if (!node) {
      this.unsupportedOps.add('glyphOutline:replayInvariant');
      return;
    }
    if (node.kind === 'transform') {
      const transformNode = node.transform;
      const matrix = this.affineToCanvasKitMatrix(transformNode?.transform);
      if (!matrix || transformNode?.childNodeId === undefined) {
        this.unsupportedOps.add('glyphOutline:replayInvariant');
        return;
      }
      canvas.save();
      (canvas as unknown as { concat?: (matrix: number[]) => void }).concat?.(matrix);
      try {
        this.renderColorPaintGraphNode(canvas, nodesById, transformNode.childNodeId, visited);
      } finally {
        canvas.restore();
      }
      return;
    }
    const pathNode = node.solidPath ?? node.linearGradientPath ?? node.radialGradientPath ?? node.sweepGradientPath;
    if (!pathNode?.commands) {
      this.unsupportedOps.add('glyphOutline:replayInvariant');
      return;
    }
    const path = this.makeCommandPath(pathNode.commands);
    this.applyFillRule(path, pathNode.fillRule);
    const paint = new this.canvasKit.Paint();
    let shader: unknown | undefined;
    try {
      paint.setAntiAlias?.(true);
      paint.setStyle(this.canvasKit.PaintStyle.Fill);
      if (node.kind === 'solidPath' && node.solidPath?.fill) {
        paint.setColor(this.resolvedColor(node.solidPath.fill));
      } else if (node.kind === 'linearGradientPath' && node.linearGradientPath?.gradient) {
        shader = this.makeLinearGradientShader(node.linearGradientPath.gradient);
        if (!shader) {
          return;
        }
        (paint as unknown as { setShader: (shader: unknown) => void }).setShader(shader);
      } else if (node.kind === 'radialGradientPath' && node.radialGradientPath?.gradient) {
        shader = this.makeRadialGradientShader(node.radialGradientPath.gradient);
        if (!shader) {
          return;
        }
        (paint as unknown as { setShader: (shader: unknown) => void }).setShader(shader);
      } else if (node.kind === 'sweepGradientPath' && node.sweepGradientPath?.gradient) {
        shader = this.makeSweepGradientShader(node.sweepGradientPath.gradient);
        if (!shader) {
          return;
        }
        (paint as unknown as { setShader: (shader: unknown) => void }).setShader(shader);
      } else {
        return;
      }
      canvas.drawPath(path, paint);
    } finally {
      (shader as { delete?: () => void } | undefined)?.delete?.();
      paint.delete?.();
      path.delete?.();
    }
  }

  private affineToCanvasKitMatrix(transform: LayerAffineTransform | undefined): number[] | null {
    if (!transform) return null;
    return [
      transform.a,
      transform.c,
      transform.e,
      transform.b,
      transform.d,
      transform.f,
      0,
      0,
      1,
    ];
  }

  private applyFillRule(path: Path, fillRule: string | undefined): void {
    if (fillRule === 'evenodd') {
      (path as unknown as { setFillType?: (fillType: unknown) => void }).setFillType?.(this.canvasKit.FillType.EvenOdd);
    }
  }

  private resolvedColor(color: { rgba?: number[] }): Color {
    const rgba = color.rgba ?? [0, 0, 0, 1];
    return this.canvasKit.Color(
      clampUnit(rgba[0]),
      clampUnit(rgba[1]),
      clampUnit(rgba[2]),
      clampUnit(rgba[3]),
    );
  }

  private makeLinearGradientShader(gradient: NonNullable<LayerColorGraphNode['linearGradientPath']>['gradient']): unknown {
    const shaderApi = this.canvasKit.Shader as unknown as { MakeLinearGradient?: (...args: unknown[]) => unknown };
    return shaderApi.MakeLinearGradient?.(
      [gradient?.x0 ?? 0, gradient?.y0 ?? 0],
      [gradient?.x1 ?? 0, gradient?.y1 ?? 0],
      gradientColors(gradient?.stops),
      gradientPositions(gradient?.stops),
      this.canvasKit.TileMode.Clamp,
    );
  }

  private makeRadialGradientShader(gradient: NonNullable<LayerColorGraphNode['radialGradientPath']>['gradient']): unknown {
    const shaderApi = this.canvasKit.Shader as unknown as { MakeRadialGradient?: (...args: unknown[]) => unknown };
    return shaderApi.MakeRadialGradient?.(
      [gradient?.cx ?? 0, gradient?.cy ?? 0],
      gradient?.radius ?? 1,
      gradientColors(gradient?.stops),
      gradientPositions(gradient?.stops),
      this.canvasKit.TileMode.Clamp,
    );
  }

  private makeSweepGradientShader(gradient: NonNullable<LayerColorGraphNode['sweepGradientPath']>['gradient']): unknown {
    const shaderApi = this.canvasKit.Shader as unknown as { MakeSweepGradient?: (...args: unknown[]) => unknown };
    return shaderApi.MakeSweepGradient?.(
      gradient?.cx ?? 0,
      gradient?.cy ?? 0,
      gradientColors(gradient?.stops),
      gradientPositions(gradient?.stops),
      this.canvasKit.TileMode.Clamp,
      null,
      0,
      gradient?.startAngleDegrees ?? 0,
      gradient?.endAngleDegrees ?? 360,
    );
  }

  private drawImageOp(canvas: SkCanvas, image: SkImage, op: LayerImageOp, isPicture = true): void {
    const imageWithDimensions = image as SkImage & { width?: unknown; height?: unknown };
    const widthMember = imageWithDimensions.width;
    const heightMember = imageWithDimensions.height;
    const imageWidth = typeof widthMember === 'function'
      ? (widthMember as () => number).call(image)
      : typeof widthMember === 'number'
        ? widthMember
        : null;
    const imageHeight = typeof heightMember === 'function'
      ? (heightMember as () => number).call(image)
      : typeof heightMember === 'number'
        ? heightMember
        : null;
    if (!this.boundsAreDrawable(op.bbox)) {
      this.unsupportedOps.add('image:invalidBounds');
      return;
    }
    if (
      imageWidth === null
      || imageHeight === null
      || !Number.isFinite(imageWidth)
      || !Number.isFinite(imageHeight)
      || imageWidth <= 0
      || imageHeight <= 0
    ) {
      const paint = new this.canvasKit.Paint();
      paint.setAntiAlias?.(true);
      try {
        canvas.drawImage(image, op.bbox.x, op.bbox.y, paint);
        this.unsupportedOps.add('image:dimensionUnavailable');
      } finally {
        paint.delete?.();
      }
      return;
    }

    const crop = canvasKitImageSourceRect(
      imageWidth,
      imageHeight,
      op.crop,
      op.originalSizeHu,
    );
    const opacity = Number.isFinite(op.opacity) ? Math.max(0, Math.min(1, op.opacity ?? 1)) : 1;
    const drawImage = (dstX: number, dstY: number, dstW: number, dstH: number) => {
      const src = crop
        ? this.canvasKit.XYWHRect(Math.fround(crop.x), Math.fround(crop.y), Math.fround(crop.width), Math.fround(crop.height))
        : this.canvasKit.XYWHRect(0, 0, imageWidth, imageHeight);
      // Native Rect는 f32 입력을 더한다. 반올림 순서도 맞춰 600dpi 경계를 보존한다.
      let localDest = this.canvasKit.XYWHRect(
        Math.fround(dstX), Math.fround(dstY), Math.fround(dstW), Math.fround(dstH),
      );
      const matrix = this.imageScaleTranslateMatrix(canvas);
      if (isPicture && !op.shadow && matrix) {
        // 한컴 PDF의 600dpi 배치와 16.16 pt 변환을 그림 페인트에만 적용한다.
        const quantize = (value: number) => Math.fround(
          Math.sign(value) * Math.round(Math.abs(value) * 600 / 96) * 7864 / 65536 * 96 / 72,
        );
        localDest = this.canvasKit.XYWHRect(
          quantize(localDest[0]), quantize(localDest[1]),
          quantize(Math.fround(localDest[2] - localDest[0])),
          quantize(Math.fround(localDest[3] - localDest[1])),
        );
      }
      if (isPicture && matrix && canvasKitImageFillModeStretches(fillMode)
        && this.drawResampledImage(canvas, image, op, src, localDest, matrix, imageWidth, imageHeight, opacity)) return;
      const dest = canvasKitImageFillModeStretches(fillMode)
        ? this.upscaledImageDeviceRect(canvas, src, localDest)
        : localDest;
      if (op.shadow) this.drawImageShadowRect(canvas, image, src, dest, op.shadow, opacity);
      this.drawImageRect(canvas, image, src, dest, opacity, op.bakedWatermark ? undefined : op.effect);
    };

    const fillMode = op.fillMode ?? 'fitToSize';
    if (canvasKitImageFillModeStretches(fillMode)) {
      drawImage(op.bbox.x, op.bbox.y, op.bbox.width, op.bbox.height);
      return;
    }
    if (canvasKitImageFillModeContains(fillMode)) {
      const fit = canvasKitImageContainRect(op.bbox, imageWidth, imageHeight);
      canvas.save();
      try {
        canvas.clipRect(this.rect(op.bbox), this.canvasKit.ClipOp?.Intersect ?? 0, true);
        drawImage(fit.x, fit.y, fit.width, fit.height);
      } finally {
        canvas.restore();
      }
      return;
    }

    let tileWidth = op.originalSize?.width ?? imageWidth;
    let tileHeight = op.originalSize?.height ?? imageHeight;
    if (!Number.isFinite(tileWidth) || tileWidth <= 0) tileWidth = imageWidth;
    if (!Number.isFinite(tileHeight) || tileHeight <= 0) tileHeight = imageHeight;

    canvas.save();
    try {
      canvas.clipRect(this.rect(op.bbox), this.canvasKit.ClipOp?.Intersect ?? 0, true);
      if (canvasKitImageFillModeTiles(fillMode)) {
        this.drawTiledImage(canvas, op.bbox, fillMode, tileWidth, tileHeight, drawImage);
      } else {
        const placed = canvasKitImagePlacement(fillMode, op.bbox, tileWidth, tileHeight);
        drawImage(placed.x, placed.y, tileWidth, tileHeight);
      }
    } finally {
      canvas.restore();
    }
  }

  private imageScaleTranslateMatrix(canvas: SkCanvas): number[] | null {
    const m = canvas.getTotalMatrix?.();
    return m && m.length === 9 && m.every(Number.isFinite)
      && m[1] === 0 && m[3] === 0 && m[6] === 0 && m[7] === 0 && m[8] === 1
      && m[0] !== 0 && m[4] !== 0 ? Array.from(m) : null;
  }

  private drawResampledImage(
    canvas: SkCanvas, image: SkImage, op: LayerImageOp, source: Rect, dest: Rect,
    m: number[], sourceWidth: number, sourceHeight: number, opacity: number,
  ): boolean {
    const xs = [Math.fround(m[0] * dest[0] + m[2]), Math.fround(m[0] * dest[2] + m[2])];
    const ys = [Math.fround(m[4] * dest[1] + m[5]), Math.fround(m[4] * dest[3] + m[5])];
    const left = Math.min(...xs), right = Math.max(...xs);
    const top = Math.min(...ys), bottom = Math.max(...ys);
    if (right <= left || bottom <= top) return false;
    const minified = right - left < source[2] - source[0] && bottom - top < source[3] - source[1];
    const enlarged = right - left > source[2] - source[0] || bottom - top > source[3] - source[1];
    const useDownsample = minified && imageDownsampleAvailable();
    if (op.shadow && !useDownsample) return false;
    if (!useDownsample && !(enlarged && imageAffineSampleAvailable())) return false;
    const nearest = right - left > (source[2] - source[0]) * 2
      || bottom - top > (source[3] - source[1]) * 2;
    const width = Math.ceil(right) - Math.floor(left), height = Math.ceil(bottom) - Math.floor(top);
    if (width * height > CanvasKitLayerRenderer.MAX_IMAGE_CACHE_PIXELS) return false;
    const baseKey = canvasKitImageCacheKey(op);
    const mode = useDownsample ? 'down' : nearest ? 'nearest' : 'bilinear';
    const key = baseKey ? `sample:${mode}:${imageDownsampleApiGeneration()}:${baseKey}:${Array.from(source)}:${width}:${height}` : null;
    let sampled = key ? this.imageCache.get(key)?.image : null;
    if (!sampled) {
      const pixels = image.readPixels(0, 0, {
        width: sourceWidth, height: sourceHeight, colorType: this.canvasKit.ColorType.RGBA_8888,
        alphaType: this.canvasKit.AlphaType.Unpremul, colorSpace: this.canvasKit.ColorSpace.SRGB,
      });
      if (!(pixels instanceof Uint8Array)) return false;
      const args: Parameters<typeof downsampleImage> = [pixels, sourceWidth, sourceHeight,
        source[0], source[1], source[2], source[3], width, height];
      const result = useDownsample ? downsampleImage(...args) : affineSampleImage(...args, nearest);
      if (!result) return false;
      sampled = this.canvasKit.MakeImage({
        width, height, colorType: this.canvasKit.ColorType.RGBA_8888,
        alphaType: this.canvasKit.AlphaType.Unpremul, colorSpace: this.canvasKit.ColorSpace.SRGB,
      }, result, width * 4);
      if (!sampled) return false;
      if (key) this.cacheImage(key, sampled, width * height);
    } else if (key) {
      const entry = this.imageCache.get(key)!;
      this.imageCache.delete(key);
      this.imageCache.set(key, entry);
    }
    const sx = Math.fround(1 / m[0]), sy = Math.fround(1 / m[4]);
    const tx = Math.fround(-m[2] / m[0]), ty = Math.fround(-m[5] / m[4]);
    const x = [Math.fround(Math.floor(left) * sx + tx), Math.fround(Math.ceil(right) * sx + tx)];
    const y = [Math.fround(Math.floor(top) * sy + ty), Math.fround(Math.ceil(bottom) * sy + ty)];
    try {
      const sourceRect = this.canvasKit.XYWHRect(0, 0, width, height);
      const destRect = new Float32Array([Math.min(...x), Math.min(...y), Math.max(...x), Math.max(...y)]);
      if (op.shadow) this.drawImageShadowRect(canvas, sampled, sourceRect, destRect, op.shadow, opacity);
      this.drawImageRect(canvas, sampled, sourceRect, destRect,
        opacity, op.bakedWatermark ? undefined : op.effect, this.canvasKit.FilterMode.Nearest);
    } finally {
      if (!key) sampled.delete();
    }
    return true;
  }

  private upscaledImageDeviceRect(canvas: SkCanvas, source: Rect, dest: Rect): Rect {
    const m = canvas.getTotalMatrix?.();
    if (!m || m.length !== 9 || !m.every(Number.isFinite)
      || m[1] !== 0 || m[3] !== 0 || m[6] !== 0 || m[7] !== 0 || m[8] !== 1
      || m[0] === 0 || m[4] === 0) return dest;
    const x0 = Math.fround(m[0] * dest[0] + m[2]);
    const x1 = Math.fround(m[0] * dest[2] + m[2]);
    const y0 = Math.fround(m[4] * dest[1] + m[5]);
    const y1 = Math.fround(m[4] * dest[3] + m[5]);
    const left = Math.min(x0, x1), right = Math.max(x0, x1);
    const top = Math.min(y0, y1), bottom = Math.max(y0, y1);
    if (right - left <= source[2] - source[0] || bottom - top <= source[3] - source[1]) return dest;
    // 확대된 그림은 PDF와 같은 정수 장치 픽셀 범위에서 보간하고 레이아웃 bbox는 유지한다.
    const sx = Math.fround(1 / m[0]), sy = Math.fround(1 / m[4]);
    const tx = Math.fround(-m[2] / m[0]), ty = Math.fround(-m[5] / m[4]);
    const xs = [Math.fround(Math.floor(left) * sx + tx), Math.fround(Math.ceil(right) * sx + tx)];
    const ys = [Math.fround(Math.floor(top) * sy + ty), Math.fround(Math.ceil(bottom) * sy + ty)];
    return new Float32Array([Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]);
  }

  private drawImageRect(canvas: SkCanvas, image: SkImage, source: Rect, dest: Rect, opacity = 1, effect?: LayerImageOp['effect'], filter = this.canvasKit.FilterMode.Linear): void {
    const paint = new this.canvasKit.Paint();
    // 네이티브 Skia와 같은 휘도 행렬로 원본 그림의 회색조를 재생한다.
    const colorFilter = effect === 'grayScale'
      ? this.canvasKit.ColorFilter.MakeMatrix([
        0.299, 0.587, 0.114, 0, 0,
        0.299, 0.587, 0.114, 0, 0,
        0.299, 0.587, 0.114, 0, 0,
        0, 0, 0, 1, 0,
      ])
      : null;
    if (colorFilter) paint.setColorFilter(colorFilter);
    paint.setAntiAlias?.(true);
    if (opacity < 1) {
      paint.setAlphaf(opacity);
    }
    try {
      canvas.drawImageRectOptions(image, source, dest,
        filter, this.canvasKit.MipmapMode.None, paint);
    } finally {
      paint.delete?.();
      colorFilter?.delete?.();
    }
  }

  private drawImageShadowRect(
    canvas: SkCanvas,
    image: SkImage,
    source: Rect,
    dest: Rect,
    shadow: NonNullable<LayerImageOp['shadow']>,
    imageOpacity: number,
  ): void {
    const { alpha, blurSigma, offsetX, offsetY } = shadow;
    if (![alpha, blurSigma, offsetX, offsetY].every(Number.isFinite) || alpha <= 0) return;
    const paint = new this.canvasKit.Paint();
    const colorFilter = this.canvasKit.ColorFilter.MakeBlend(
      this.color(shadow.color, Math.min(1, alpha) * imageOpacity),
      this.canvasKit.BlendMode.SrcIn,
    );
    const blur = blurSigma > 0
      ? this.canvasKit.ImageFilter.MakeBlur(blurSigma, blurSigma, this.canvasKit.TileMode.Decal, null)
      : null;
    paint.setAntiAlias?.(true);
    paint.setColorFilter(colorFilter);
    if (blur) paint.setImageFilter(blur);
    try {
      canvas.drawImageRectOptions(
        image,
        source,
        this.canvasKit.XYWHRect(dest[0] + offsetX, dest[1] + offsetY, dest[2] - dest[0], dest[3] - dest[1]),
        this.canvasKit.FilterMode.Linear,
        this.canvasKit.MipmapMode.None,
        paint,
      );
    } finally {
      paint.delete?.();
      blur?.delete?.();
      colorFilter.delete?.();
    }
  }

  private drawTiledImage(
    canvas: SkCanvas,
    bbox: LayerBounds,
    fillMode: string,
    tileWidth: number,
    tileHeight: number,
    drawImage: (dstX: number, dstY: number, dstW: number, dstH: number) => void,
  ): void {
    const maxTileDraws = CanvasKitLayerRenderer.MAX_IMAGE_TILE_DRAWS;
    let tileDraws = 0;
    const drawTile = (x: number, y: number) => {
      if (tileDraws >= maxTileDraws) return;
      drawImage(x, y, tileWidth, tileHeight);
      tileDraws += 1;
    };

    if (fillMode === 'tileAll') {
      for (let y = bbox.y; y < bbox.y + bbox.height && tileDraws < maxTileDraws; y += tileHeight) {
        for (let x = bbox.x; x < bbox.x + bbox.width && tileDraws < maxTileDraws; x += tileWidth) {
          drawTile(x, y);
        }
      }
    } else if (fillMode === 'tileHorzTop' || fillMode === 'tileHorzBottom') {
      const y = fillMode === 'tileHorzTop' ? bbox.y : bbox.y + bbox.height - tileHeight;
      for (let x = bbox.x; x < bbox.x + bbox.width && tileDraws < maxTileDraws; x += tileWidth) {
        drawTile(x, y);
      }
    } else {
      const x = fillMode === 'tileVertLeft' ? bbox.x : bbox.x + bbox.width - tileWidth;
      for (let y = bbox.y; y < bbox.y + bbox.height && tileDraws < maxTileDraws; y += tileHeight) {
        drawTile(x, y);
      }
    }

    if (tileDraws >= maxTileDraws) {
      this.unsupportedOps.add('image:tileLimit');
    }
  }

  /**
   * 중심 기준으로 대칭 후 회전한다. 한컴은 도형을 먼저 대칭한 뒤 회전한 모습으로 그리므로,
   * 한쪽만 대칭이면 회전 부호를 반전한다 (Rust ShapeTransform::rotation_after_flip 과 동일).
   */
  private withShapeTransform(
    canvas: SkCanvas,
    bounds: LayerBounds,
    transform: LayerPathTransform | undefined,
    draw: () => void,
  ): void {
    const rotation = transform?.rotation ?? 0;
    const horzFlip = transform?.horzFlip ?? false;
    const vertFlip = transform?.vertFlip ?? false;
    if (rotation === 0 && !horzFlip && !vertFlip) {
      draw();
      return;
    }

    const cx = bounds.x + bounds.width / 2;
    const cy = bounds.y + bounds.height / 2;
    canvas.save();
    try {
      if (horzFlip || vertFlip) {
        canvas.translate(cx, cy);
        canvas.scale(horzFlip ? -1 : 1, vertFlip ? -1 : 1);
        canvas.translate(-cx, -cy);
      }
      if (rotation !== 0) {
        canvas.rotate(horzFlip !== vertFlip ? -rotation : rotation, cx, cy);
      }
      draw();
    } finally {
      canvas.restore();
    }
  }

  private recordImageCoverageGaps(op: LayerImageOp): void {
    if (op.bakedWatermark) return;
    if (op.effect && op.effect !== 'realPic' && op.effect !== 'grayScale') {
      this.unsupportedOps.add(`imageEffect:${op.effect}`);
    }
    if ((op.brightness ?? 0) !== 0 || (op.contrast ?? 0) !== 0) {
      this.unsupportedOps.add('imageEffect:brightnessContrast');
    }
  }

  private recordTextRunCoverageGaps(op: LayerTextRunOp): void {
    const style = op.style ?? {};
    const decorationsAreExternal = op.legacyVisuals?.decorations === 'mirror';
    if (op.isVertical) {
      this.unsupportedOps.add('textRun:verticalText');
    }
    if (!decorationsAreExternal && style.underline && style.underline !== 'none') {
      this.unsupportedOps.add('textRun:textDecoration');
    }
    if (!decorationsAreExternal && style.strikethrough) {
      this.unsupportedOps.add('textRun:textDecoration');
    }
    if (!decorationsAreExternal && style.emphasisDot && style.emphasisDot !== 0) {
      this.unsupportedOps.add('textRun:emphasisDot');
    }
    if (style.outlineType && style.outlineType !== 0) {
      this.unsupportedOps.add('textRun:outlineTextEffect');
    }
    if (style.emboss) {
      this.unsupportedOps.add('textRun:embossTextEffect');
    }
    if (style.engrave) {
      this.unsupportedOps.add('textRun:engraveTextEffect');
    }
    if (style.ratio !== undefined && (!Number.isFinite(style.ratio) || style.ratio <= 0)) {
      this.unsupportedOps.add('textRun:ratioTextEffect');
    }
  }

  private boundsAreDrawable(bounds: LayerBounds): boolean {
    return Number.isFinite(bounds.x)
      && Number.isFinite(bounds.y)
      && Number.isFinite(bounds.width)
      && Number.isFinite(bounds.height)
      && bounds.width > 0
      && bounds.height > 0;
  }

  private renderTextRun(canvas: SkCanvas, op: LayerTextRunOp): void {
    if (op.charOverlap && op.legacyVisuals?.charOverlap === 'mirror') {
      return;
    }
    if (op.charOverlap) {
      this.renderCharOverlap(canvas, {
        type: 'charOverlap',
        bbox: op.bbox,
        text: op.text,
        baseline: op.baseline ?? op.style?.fontSize ?? 12,
        rotation: op.rotation ?? 0,
        isVertical: op.isVertical === true,
        style: op.style ?? {},
        positions: op.positions ?? [],
        positionsComplete: op.positions !== undefined,
        charOverlap: op.charOverlap,
      });
      return;
    }
    if ((op.style?.shadowType ?? 0) > 0) {
      const style = { ...op.style, shadowType: 0 };
      const dx = style.shadowOffsetX ?? 0;
      const dy = style.shadowOffsetY ?? 0;
      const transform = op.placement?.runToPage;
      const angle = (op.rotation ?? 0) * Math.PI / 180;
      const a = transform?.a ?? Math.cos(angle);
      const b = transform?.b ?? Math.sin(angle);
      const c = transform?.c ?? -Math.sin(angle);
      const d = transform?.d ?? Math.cos(angle);
      canvas.save();
      try {
        canvas.translate(a * dx + c * dy, b * dx + d * dy);
        this.renderTextRun(canvas, {
          ...op, style: { ...style, color: style.shadowColor ?? '#000000', shadeColor: undefined },
        });
      } finally {
        canvas.restore();
      }
      this.renderTextRun(canvas, { ...op, style });
      return;
    }
    const replayText = op.displayText ?? op.text;
    const replayPositions = op.displayText !== undefined ? op.displayPositions : op.positions;
    if (!replayText) return;
    // U+00AD is a zero-advance HWP hyphen control unless a line breaker has
    // explicitly replaced it with a visible hyphen in displayText.
    const paintText = replayText.replaceAll(DISCRETIONARY_HYPHEN, '');
    if (!paintText) return;
    const sourceStyle = op.style ?? {};
    const fauxBoldWidth = Number.isFinite(sourceStyle.fauxBoldStrokeWidth)
      && sourceStyle.fauxBoldStrokeWidth! > 0 ? sourceStyle.fauxBoldStrokeWidth! : 0;
    const style = fauxBoldWidth ? { ...sourceStyle, bold: false } : sourceStyle;
    const ratio = Number.isFinite(style.ratio) && style.ratio! > 0 ? style.ratio! : 1;
    this.recordTextRunCoverageGaps(op);
    const paint = this.makeFillPaint(style.color ?? '#000000');
    const baseFontSize = style.fontSize ?? Math.max(1, op.bbox.height || 12);
    let fontSize = baseFontSize;
    let baselineShift = 0;
    // 한컴 PDF 실측 비율 (Rust renderer::script_glyph_size_and_shift 와 동일).
    if (style.superscript) {
      fontSize = baseFontSize * 0.64;
      baselineShift -= baseFontSize * 0.44;
    } else if (style.subscript) {
      fontSize = baseFontSize * 0.64;
      baselineShift += baseFontSize * 0.12;
    }
    // 글자 위치(%) — 엔진 renderer::char_offset_dy 와 같은 규칙 (장식선은 옮기지 않는다).
    if (Number.isFinite(style.charOffset)) baselineShift += baseFontSize * style.charOffset!;
    const placementMatrix = this.affineToCanvasKitMatrix(op.placement?.runToPage);
    const originX = placementMatrix ? 0 : op.bbox.x;
    const originY = placementMatrix
      ? (op.placement?.baselineY ?? 0)
      : op.bbox.y + (op.baseline ?? baseFontSize)
        - (Number.isFinite(style.charOffset) ? baseFontSize * style.charOffset! : 0);
    const rotation = op.rotation ?? 0;
    const codePoints = Array.from(replayText);
    const needsPreservedAdvances = style.superscript || style.subscript;
    const hasSimpleScriptText = codePoints.every((codePoint) => {
      const code = codePoint.charCodeAt(0);
      return codePoint.length === 1 && code >= 0x20 && code <= 0x7e;
    });
    const hasLayoutPositions = replayPositions?.length === codePoints.length + 1
      && replayPositions.every(Number.isFinite);
    const hftPaths = style.hftFamily && style.italic !== true
      ? codePoints.map(codePoint => hftGlyphPath(style.hftFamily!, codePoint.codePointAt(0) ?? 0))
      : null;
    const hasHftPaths = hftPaths?.some(Boolean) === true;
    const fauxBoldPaint = fauxBoldWidth ? paint.copy() : null;
    if (fauxBoldPaint) {
      // CanvasKit은 Fill/Stroke만 노출하므로 동일한 Regular 윤곽선에 획을 더한다.
      fauxBoldPaint.setStyle(this.canvasKit.PaintStyle.Stroke);
      fauxBoldPaint.setStrokeWidth(fauxBoldWidth * fontSize / baseFontSize);
    }
    const drawTtf = (draw: (p: SkPaint) => void) => {
      draw(paint);
      if (fauxBoldPaint) draw(fauxBoldPaint);
    };
    const hftBoldCopy = op.hftVerticalBoldCopy;
    const hasHftBoldCopy = hftBoldCopy !== undefined
      && Number.isFinite(hftBoldCopy.offsetY) && hftBoldCopy.offsetY >= 0
      && Number.isFinite(hftBoldCopy.emboldenX) && hftBoldCopy.emboldenX >= 0
      && Number.isFinite(hftBoldCopy.offsetX ?? 0)
      && Number.isFinite(hftBoldCopy.rotation ?? 0);
    const drawHftBoldCopy = (
      draw: (dx: number, dy: number) => void,
      anchorX = originX,
      anchorY = originY + baselineShift,
    ) => {
      if (!hasHftBoldCopy) return;
      if ((hftBoldCopy.rotation ?? 0) === 0) {
        for (let step = 0; step <= 5; step += 1) {
          draw((hftBoldCopy.offsetX ?? 0) + hftBoldCopy.emboldenX * step / 5, hftBoldCopy.offsetY);
        }
        return;
      }
      canvas.save();
      try {
        canvas.translate(anchorX + (hftBoldCopy.offsetX ?? 0), anchorY + hftBoldCopy.offsetY);
        canvas.rotate(hftBoldCopy.rotation!, 0, 0);
        for (let step = 0; step <= 5; step += 1) {
          draw(hftBoldCopy.emboldenX * step / 5 - anchorX, -anchorY);
        }
      } finally {
        canvas.restore();
      }
    };
    // 반각 칸의 전각 여는 괄호·따옴표는 glyph 를 칸 오른쪽 끝에 맞춘다 (엔진이 계산한 halt 오프셋).
    const glyphOffsets = hasLayoutPositions && Array.isArray(op.glyphOffsets) && op.glyphOffsets.length > 0
      ? new Map(op.glyphOffsets.filter(([index, dx]) => Number.isInteger(index) && Number.isFinite(dx)))
      : null;
    const requestedFontFamily = primaryFontFamily(style.fontFamily);
    const styledTypeface = this.findStyledPreparedTypeface(
      requestedFontFamily, style.bold === true, style.italic === true, style.fontSubst,
    );
    const preparedTypeface = styledTypeface.prepared;
    if (requestedFontFamily && !preparedTypeface && this.requirePreparedFontFamilies
      && !codePoints.every((codePoint, index) => codePoint === DISCRETIONARY_HYPHEN || !!hftPaths?.[index])) {
      throw new Error(`CanvasKit font family가 준비되지 않았습니다: ${requestedFontFamily}`);
    }
    const typeface = preparedTypeface?.typeface ?? this.defaultTypeface;
    const fontManager = preparedTypeface?.fontManager ?? this.defaultFontManager;
    const fontFamily = preparedTypeface?.fontFamily ?? this.defaultFontFamily;
    let font: Font | null = null;
    const fallbackFonts: Font[] = [];
    let boxedPuaFont: Font | null = null;
    let boxedPuaStrokePaint: SkPaint | null = null;
    let canvasSaved = false;
    try {
      paint.setAntiAlias?.(true);
      if (!typeface && !fontManager && !this.symbolFallbackTypeface
        && /[^\u0000-\u00ff]/.test(replayText) && !hasHftPaths) {
        this.unsupportedOps.add('textRunFont');
        return;
      }
      canvas.save();
      canvasSaved = true;
      if (placementMatrix) {
        canvas.concat(placementMatrix);
      } else if (rotation !== 0) {
        canvas.rotate(rotation, originX, originY);
      }

      if (style.shadeColor) {
        const shade = parseCssColor(style.shadeColor);
        const isUnshaded = (shade.r === 255 && shade.g === 255 && shade.b === 255)
          || (shade.r === 0 && shade.g === 0 && shade.b === 0);
        if (!isUnshaded && shade.a > 0) {
          let width = hasLayoutPositions ? replayPositions![codePoints.length] : 0;
          if (!hasLayoutPositions) {
            const measureFont = createOutlineSkiaFont(this.canvasKit, typeface, fontSize);
            try {
              measureFont.setScaleX?.(ratio);
              width = (measureFont.getGlyphWidths(measureFont.getGlyphIDs(paintText)) ?? [])
                .reduce((total, advance) => total + advance, 0);
            } finally {
              measureFont.delete?.();
            }
          }
          if (Number.isFinite(width) && width > 0) {
            const shadePaint = this.makeFillPaint(style.shadeColor);
            try {
              canvas.drawRect(this.canvasKit.XYWHRect(
                originX, originY + baselineShift - fontSize * 0.85, width, fontSize,
              ), shadePaint);
            } finally {
              shadePaint.delete?.();
            }
          }
        }
      }

      if (needsPreservedAdvances && !hasSimpleScriptText && !hasHftPaths) {
        if (!this.renderShapedScriptText(
          canvas,
          paintText,
          style.color ?? '#000000',
          fontSize,
          originX,
          originY,
          baselineShift,
          fontManager,
          fontFamily,
          style.bold === true,
          style.italic === true,
          ratio,
        )) {
          this.unsupportedOps.add('textRun:scriptTextRequiresShaping');
        }
      } else {
        font = createOutlineSkiaFont(this.canvasKit, typeface, fontSize);
        font.setScaleX?.(ratio);
        const adjustableFont = font as Font & {
          setEmbolden?: (enabled: boolean) => void;
          setSkewX?: (skew: number) => void;
        };
        adjustableFont.setEmbolden?.(styledTypeface.syntheticBold);
        adjustableFont.setSkewX?.(styledTypeface.syntheticItalic ? -0.2 : 0);
        if (hasLayoutPositions || hasHftPaths) {
          const primaryGlyphIds = font.getGlyphIDs(replayText, codePoints.length);
          const glyphPositions = hasLayoutPositions ? replayPositions! : (() => {
            const widths = font!.getGlyphWidths(primaryGlyphIds) ?? [];
            const positions = [0];
            for (let index = 0; index < codePoints.length; index += 1) {
              positions.push(positions[index] + (widths[index] || fontSize * 0.5 * ratio));
            }
            return positions;
          })();
          const candidateFonts = [font];
          const candidateGlyphIds = [primaryGlyphIds];
          // 요청 face에 없는 반각 괄호·기호는 문서 대체 서체와 한컴 설치
          // 서체에서 먼저 찾는다. 웹 번들 부분집합에는 이 글리프가 없을 수 있다.
          if (primaryGlyphIds.some((glyphId, index) => glyphId === 0
            && codePoints[index] !== DISCRETIONARY_HYPHEN && !hftPaths?.[index])) {
            const faces = new Set([typeface]);
            // Native와 같은 순서: 설치된 run face의 누락 글리프는 함초롬돋움이
            // 먼저 받는다. FontMap은 face 자체가 없을 때의 치환 순서다.
            const missingGlyphFamilies = style.hftFamily ? [] : ['HCR Dotum', '함초롬돋움'];
            for (const family of [...missingGlyphFamilies, ...rendererFontFallbackFamilies(requestedFontFamily, style.fontSubst), 'HCR Dotum', 'HCR Batang', ...HANCOM_PUA_FALLBACK_FAMILIES]) {
              const fallback = this.findStyledPreparedTypeface(family, style.bold === true, style.italic === true);
              const face = fallback.prepared?.typeface;
              if (!face || faces.has(face)) continue;
              faces.add(face);
              const fallbackFont = createOutlineSkiaFont(this.canvasKit, face, fontSize);
              fallbackFont.setScaleX?.(ratio);
              fallbackFont.setEmbolden?.(fallback.syntheticBold);
              fallbackFont.setSkewX?.(fallback.syntheticItalic ? -0.2 : 0);
              fallbackFonts.push(fallbackFont);
              candidateFonts.push(fallbackFont);
              candidateGlyphIds.push(fallbackFont.getGlyphIDs(replayText, codePoints.length));
            }
          }
          const oldHangulTypeface = codePoints.some((codePoint) => {
            const code = codePoint.codePointAt(0) ?? 0;
            return (code >= 0x1100 && code <= 0x11FF)
              || (code >= 0xA960 && code <= 0xA97F)
              || (code >= 0xD7B0 && code <= 0xD7FF);
          })
            ? this.findPreparedTypeface(OLD_HANGUL_FONT_FAMILY)
            : null;
          if (primaryGlyphIds.some((glyphId, index) => glyphId === 0 && codePoints[index] !== DISCRETIONARY_HYPHEN)
            && this.defaultTypeface !== null
            && typeface !== this.defaultTypeface) {
            const defaultFont = createOutlineSkiaFont(this.canvasKit, this.defaultTypeface, fontSize);
            defaultFont.setScaleX?.(ratio);
            const adjustableDefault = defaultFont as Font & {
              setEmbolden?: (enabled: boolean) => void;
              setSkewX?: (skew: number) => void;
            };
            adjustableDefault.setEmbolden?.(style.bold === true);
            adjustableDefault.setSkewX?.(style.italic === true ? -0.2 : 0);
            fallbackFonts.push(defaultFont);
            candidateFonts.push(defaultFont);
            candidateGlyphIds.push(defaultFont.getGlyphIDs(replayText, codePoints.length));
          }
          if (codePoints.some((codePoint, index) => codePoint !== DISCRETIONARY_HYPHEN
            && candidateGlyphIds.every(ids => (ids[index] ?? 0) === 0))
            && this.symbolFallbackTypeface !== null
            && typeface !== this.symbolFallbackTypeface
            && this.defaultTypeface !== this.symbolFallbackTypeface) {
            const symbolFont = createOutlineSkiaFont(this.canvasKit, this.symbolFallbackTypeface, fontSize);
            symbolFont.setScaleX?.(ratio);
            const adjustableSymbol = symbolFont as Font & {
              setEmbolden?: (enabled: boolean) => void;
              setSkewX?: (skew: number) => void;
            };
            adjustableSymbol.setEmbolden?.(style.bold === true);
            adjustableSymbol.setSkewX?.(style.italic === true ? -0.2 : 0);
            fallbackFonts.push(symbolFont);
            candidateFonts.push(symbolFont);
            candidateGlyphIds.push(symbolFont.getGlyphIDs(replayText, codePoints.length));
          }
          const selectedFontIndices = codePoints.map((codePoint, index) => {
            const code = codePoint.codePointAt(0) ?? 0;
            // 탭은 저장된 advance만 이동한다. HFT 은행의 제어문자 슬롯을 그리지 않는다.
            if (codePoint === DISCRETIONARY_HYPHEN || code < 0x20 || code === 0x7f) return -3;
            if (hftPaths?.[index]) return -5;
            if ((code >= 0x1100 && code <= 0x11FF)
              || (code >= 0xA960 && code <= 0xA97F)
              || (code >= 0xD7B0 && code <= 0xD7FF)) {
              return -2;
            }
            const candidateIndex = candidateGlyphIds.findIndex(ids => (ids[index] ?? 0) !== 0);
            if (candidateIndex >= 0) return candidateIndex;
            if (PUA_MISSING_GLYPH_SUBSTITUTES.has(code)) return -4;
            return code >= 0xF02B1 && code <= 0xF02C4 ? -1 : 0;
          });
          const fallbackSpans: Array<{ start: number; end: number; fontIndex: number }> = [];
          let spanStart = 0;
          while (spanStart < codePoints.length) {
            const fontIndex = selectedFontIndices[spanStart];
            let spanEnd = spanStart + 1;
            if (fontIndex !== -1 && fontIndex !== -4) {
              while (spanEnd < codePoints.length && selectedFontIndices[spanEnd] === fontIndex) {
                spanEnd += 1;
              }
            }
            fallbackSpans.push({ start: spanStart, end: spanEnd, fontIndex });
            if (fallbackSpans.length > CanvasKitLayerRenderer.MAX_TEXT_RUN_FALLBACK_SPANS) {
              this.unsupportedOps.add('textRun:fallbackSpanLimitExceeded');
              return;
            }
            spanStart = spanEnd;
          }
          let hasMissingGlyph = false;
          for (const { start: runStart, end: runEnd, fontIndex } of fallbackSpans) {
            if (fontIndex === -3) continue;
            if (fontIndex === -5) {
              for (let index = runStart; index < runEnd; index += 1) {
                const path = this.canvasKit.Path.MakeFromSVGString(hftPaths![index]!);
                if (!path) {
                  hasMissingGlyph = true;
                  continue;
                }
                try {
                  const drawGlyph = (dx: number, dy: number) => {
                    canvas.save();
                    try {
                      canvas.translate(originX + glyphPositions[index] + dx, originY + baselineShift + dy);
                      canvas.scale((fontSize / 1000) * ratio, fontSize / 1000);
                      canvas.drawPath(path, paint);
                    } finally {
                      canvas.restore();
                    }
                  };
                  drawGlyph(0, 0);
                  drawHftBoldCopy(drawGlyph, originX + glyphPositions[index], originY + baselineShift);
                } finally {
                  path.delete?.();
                }
              }
              continue;
            }
            if (fontIndex === -2) {
              if (!this.renderShapedScriptText(
                canvas,
                codePoints.slice(runStart, runEnd).join(''),
                style.color ?? '#000000',
                fontSize,
                originX + glyphPositions[runStart],
                originY,
                baselineShift,
                oldHangulTypeface?.fontManager ?? null,
                oldHangulTypeface?.fontFamily ?? OLD_HANGUL_FONT_FAMILY,
                style.bold === true,
                style.italic === true,
                ratio,
              )) {
                hasMissingGlyph = true;
              }
              continue;
            }
            if (fontIndex === -4) {
              // 한컴 PUA 글리프가 어느 후보 글꼴에도 없으면 표준 대체 글리프를 원문
              // advance 에 맞춰 그린다 (엔진 skia/web_canvas 와 같은 규칙).
              const codePoint = codePoints[runStart].codePointAt(0) ?? 0;
              const substitute = PUA_MISSING_GLYPH_SUBSTITUTES.get(codePoint)!;
              const fontWithGlyph = candidateFonts.find(
                candidate => (candidate.getGlyphIDs(substitute, 1)[0] ?? 0) !== 0,
              );
              if (!fontWithGlyph) {
                hasMissingGlyph = true;
                continue;
              }
              const glyphIds = fontWithGlyph.getGlyphIDs(substitute, 1);
              const glyphWidth = (fontWithGlyph.getGlyphWidths(glyphIds) ?? [])[0] ?? 0;
              const advance = glyphPositions[runStart + 1] - glyphPositions[runStart];
              canvas.save();
              canvas.translate(originX + glyphPositions[runStart], originY + baselineShift);
              if (glyphWidth > advance && glyphWidth > 0) {
                canvas.scale(advance / glyphWidth, 1);
              }
              canvas.drawGlyphs(glyphIds, new Float32Array([0, 0]), 0, 0, fontWithGlyph, paint);
              canvas.restore();
              continue;
            }
            if (fontIndex === -1) {
              const codePoint = codePoints[runStart].codePointAt(0) ?? 0;
              const displayNumber = String(codePoint - 0xF02B0);
              const boxSize = Math.max(1, fontSize * 0.72);
              const boxWidth = boxSize * ratio;
              const boxX = originX + glyphPositions[runStart];
              const boxY = originY + baselineShift - fontSize * 0.76;
              boxedPuaStrokePaint ??= this.makeStrokePaint(
                style.color ?? '#000000',
                Math.max(0.6, fontSize * 0.04),
              );
              boxedPuaFont ??= createOutlineSkiaFont(
                this.canvasKit,
                this.symbolFallbackTypeface ?? this.defaultTypeface ?? typeface,
                Math.max(1, fontSize * 0.5),
              );
              const boxedAdjustable = boxedPuaFont as Font & {
                setEmbolden?: (enabled: boolean) => void;
                setSkewX?: (skew: number) => void;
              };
              const boxedUsesPrimary = !this.symbolFallbackTypeface && !this.defaultTypeface;
              boxedPuaFont.setScaleX?.(ratio);
              boxedAdjustable.setEmbolden?.(boxedUsesPrimary ? styledTypeface.syntheticBold : style.bold === true);
              boxedAdjustable.setSkewX?.((boxedUsesPrimary ? styledTypeface.syntheticItalic : style.italic === true) ? -0.2 : 0);
              const numberGlyphIds = boxedPuaFont.getGlyphIDs(
                displayNumber,
                displayNumber.length,
              );
              const numberWidth = (boxedPuaFont.getGlyphWidths(numberGlyphIds) ?? [])
                .reduce((sum, width) => sum + width, 0);
              canvas.drawRect(
                this.canvasKit.XYWHRect(boxX, boxY, boxWidth, boxSize),
                boxedPuaStrokePaint,
              );
              canvas.drawText(
                displayNumber,
                boxX + (boxWidth - numberWidth) / 2,
                boxY + boxSize * 0.72,
                paint,
                boxedPuaFont,
              );
              continue;
            }
            const runGlyphIds = new Uint16Array(runEnd - runStart);
            const runPositions = new Float32Array((runEnd - runStart) * 2);
            for (let index = runStart; index < runEnd; index += 1) {
              const glyphId = candidateGlyphIds[fontIndex][index] ?? 0;
              runGlyphIds[index - runStart] = glyphId;
              runPositions[(index - runStart) * 2] = glyphPositions[index] + (glyphOffsets?.get(index) ?? 0);
              runPositions[(index - runStart) * 2 + 1] = baselineShift;
              hasMissingGlyph ||= glyphId === 0;
            }
            drawTtf(p => canvas.drawGlyphs(
              runGlyphIds,
              runPositions,
              originX,
              originY,
              candidateFonts[fontIndex],
              p,
            ));
            drawHftBoldCopy((dx, dy) => drawTtf(p => canvas.drawGlyphs(
              runGlyphIds, runPositions, originX + dx, originY + dy,
              candidateFonts[fontIndex], p,
            )));
          }
          if (hasMissingGlyph) this.unsupportedOps.add('textRun:glyphMapping');
        } else {
          if (needsPreservedAdvances) this.unsupportedOps.add('textRun:layoutPositions');
          drawTtf(p => canvas.drawText(paintText, originX, originY + baselineShift, p, font!));
          drawHftBoldCopy((dx, dy) => drawTtf(p => canvas.drawText(
            paintText, originX + dx, originY + baselineShift + dy, p, font!,
          )));
        }
      }
    } finally {
      try {
        if (canvasSaved) canvas.restore();
      } finally {
        font?.delete?.();
        for (const fallbackFont of fallbackFonts) fallbackFont.delete?.();
        boxedPuaFont?.delete?.();
        boxedPuaStrokePaint?.delete?.();
        fauxBoldPaint?.delete?.();
        paint.delete?.();
      }
    }
  }

  private renderCharOverlap(canvas: SkCanvas, op: LayerCharOverlapOp): void {
    if (op.style?.shadowType) this.unsupportedOps.add('textRun:shadowTextEffect');
    if (op.style?.ratio !== undefined && op.style.ratio !== 1) {
      this.unsupportedOps.add('textRun:ratioTextEffect');
    }
    if (typeof op.text !== 'string' || !op.charOverlap || !Array.isArray(op.positions)) {
      this.unsupportedOps.add('charOverlap:invalidGeometry');
      return;
    }
    if (op.positionsComplete !== true
      || op.positions.length > CanvasKitLayerRenderer.MAX_TEXT_SPECIAL_VISUAL_ITEMS + 1) {
      this.unsupportedOps.add('charOverlap:visualItemLimitExceeded');
      return;
    }
    const chars: string[] = [];
    for (const ch of op.text) {
      if (chars.length >= CanvasKitLayerRenderer.MAX_TEXT_SPECIAL_VISUAL_ITEMS) {
        this.unsupportedOps.add('charOverlap:visualItemLimitExceeded');
        return;
      }
      chars.push(ch);
    }
    if (op.positions.length !== chars.length + 1) {
      this.unsupportedOps.add('charOverlap:invalidGeometry');
      return;
    }
    if (chars.length === 0) return;
    const paintChars = chars.filter(ch => ch !== DISCRETIONARY_HYPHEN);
    if (paintChars.length === 0) return;
    if (op.isVertical) {
      this.unsupportedOps.add('textRun:verticalText');
      return;
    }
    const style = op.style ?? {};
    const rawFontSize = style.fontSize ?? (op.bbox.height || 12);
    if (![op.baseline, op.rotation, rawFontSize, op.charOverlap.innerCharSize]
      .every(Number.isFinite)
      || op.positions.some(position => !Number.isFinite(position))
      || rawFontSize <= 0
      || !Number.isInteger(op.charOverlap.borderType)
      || op.charOverlap.borderType < 0
      || op.charOverlap.borderType > 4
      || !Number.isInteger(op.charOverlap.innerCharSize)
      || op.charOverlap.innerCharSize < -128
      || op.charOverlap.innerCharSize > 127) {
      this.unsupportedOps.add('charOverlap:invalidGeometry');
      return;
    }
    const fontSize = Math.max(1, rawFontSize);
    const rawRatio = op.charOverlap.innerCharSize > 0
      ? op.charOverlap.innerCharSize / 100
      : op.charOverlap.innerCharSize < 0
        ? 1 + op.charOverlap.innerCharSize * 0.1
        : 1;
    const innerFontSize = Math.max(1, fontSize * Math.min(4, Math.max(0.1, rawRatio)));
    const requestedFontFamily = primaryFontFamily(style.fontFamily);
    const styledTypeface = this.findStyledPreparedTypeface(
      requestedFontFamily, style.bold === true, style.italic === true, style.fontSubst,
    );
    const preparedTypeface = styledTypeface.prepared;
    if (requestedFontFamily && !preparedTypeface && this.requirePreparedFontFamilies) {
      throw new Error(`CanvasKit font family가 준비되지 않았습니다: ${requestedFontFamily}`);
    }
    const primaryTypeface = preparedTypeface?.typeface ?? this.defaultTypeface;

    // 한컴 사각 숫자의 십·일의 자리 PUA는 글꼴에 없으면 한 상자로 합친다.
    const codes = paintChars.map(ch => ch.codePointAt(0) ?? 0);
    const boxedNumber = codes.length === 1 && codes[0] >= 0xF02B1 && codes[0] <= 0xF02B9
      ? String(codes[0] - 0xF02B0)
      : codes.length === 2 && codes[0] >= 0xF02BA && codes[0] <= 0xF02C2
        && codes[1] >= 0xF02C3 && codes[1] <= 0xF02CC
        ? `${codes[0] - 0xF02B9}${codes[1] - 0xF02C3}`
        : null;
    if (op.charOverlap.borderType === 0 && boxedNumber !== null) {
      // 사각 숫자 PUA는 완성된 글리프 부품이다. charSz로 줄이지 않고
      // 원래 글자 크기와 기준선에서 같은 원점에 겹친다.
      const faces = new Set<Typeface>();
      if (primaryTypeface) faces.add(primaryTypeface);
      for (const family of ['HCR Dotum', '함초롬돋움', 'HCR Batang', '함초롬바탕', ...HANCOM_PUA_FALLBACK_FAMILIES]) {
        const face = this.findStyledPreparedTypeface(family, style.bold === true, style.italic === true).prepared?.typeface;
        if (face) faces.add(face);
      }
      for (const face of codes.length === 2 ? faces : []) {
        const font = createOutlineSkiaFont(this.canvasKit, face, fontSize);
        let paint: SkPaint | null = null;
        try {
          const ids = font.getGlyphIDs(paintChars.join(''), paintChars.length);
          if (ids.length !== paintChars.length || ids.some(id => id === 0)) continue;
          font.setScaleX?.(style.ratio ?? 1);
          paint = this.makeFillPaint(style.color ?? '#000000');
          this.withHorizontalTextVisualOrigin(canvas, op.bbox, op.rotation ?? 0, 'charOverlap', (x, y) => {
            canvas.drawGlyphs(ids, new Float32Array(ids.length * 2), x, y + op.baseline, font, paint!);
          });
          return;
        } finally {
          paint?.delete?.();
          font.delete();
        }
      }
      const probe = createOutlineSkiaFont(this.canvasKit, primaryTypeface, fontSize);
      const missing = probe.getGlyphIDs(paintChars.join(''), paintChars.length).some(id => id === 0);
      probe.delete?.();
      if (missing) {
        const font = createOutlineSkiaFont(this.canvasKit, primaryTypeface ?? this.defaultTypeface, fontSize * 0.5);
        const paint = this.makeFillPaint(style.color ?? '#000000');
        const stroke = this.makeStrokePaint(style.color ?? '#000000', Math.max(0.6, fontSize * 0.04));
        try {
          const ids = font.getGlyphIDs(boxedNumber, boxedNumber.length);
          const width = (font.getGlyphWidths(ids) ?? []).reduce((sum, value) => sum + value, 0);
          const bounds = font.getGlyphBounds(ids);
          const top = Math.min(...Array.from(ids, (_, i) => bounds[i * 4 + 1]));
          const bottom = Math.max(...Array.from(ids, (_, i) => bounds[i * 4 + 3]));
          this.withHorizontalTextVisualOrigin(canvas, op.bbox, op.rotation ?? 0, 'charOverlap', (x, y) => {
            const size = fontSize * 0.72;
            const boxY = y + op.baseline - fontSize * 0.76;
            canvas.drawRect(this.canvasKit.XYWHRect(x, boxY, size, size), stroke);
            canvas.drawText(boxedNumber, x + (size - width) / 2, boxY + size / 2 - (top + bottom) / 2, paint, font);
          });
          if (ids.some(id => id === 0)) this.unsupportedOps.add('textRun:glyphMapping');
        } finally {
          stroke.delete?.(); paint.delete?.(); font.delete?.();
        }
        return;
      }
    }

    const overlapDigits: Array<[number, number]> = [];
    for (const ch of paintChars) {
      const codePoint = ch.codePointAt(0) ?? 0;
      const digit = codePoint >= 0xF0289 && codePoint <= 0xF0291
        ? [0, codePoint - 0xF0288] as [number, number]
        : codePoint >= 0xF0292 && codePoint <= 0xF029B
          ? [1, codePoint - 0xF0292] as [number, number]
          : codePoint >= 0xF0491 && codePoint <= 0xF0499
            ? [0, codePoint - 0xF0490] as [number, number]
            : codePoint >= 0xF049A && codePoint <= 0xF04A3
              ? [1, codePoint - 0xF049A] as [number, number]
              : codePoint >= 0xF04A4 && codePoint <= 0xF04AD
                ? [2, codePoint - 0xF04A4] as [number, number]
                : null;
      if (!digit) {
        overlapDigits.length = 0;
        break;
      }
      overlapDigits.push(digit);
    }
    const decodedNumber = overlapDigits.length === paintChars.length
      ? overlapDigits
          .sort(([left], [right]) => left - right)
          .map(([, digit]) => String.fromCharCode(0x30 + digit))
          .join('')
      : null;

    const draw = (originX: number, originY: number) => {
      const boxSize = fontSize;
      // 테두리는 같은 런 서체의 도형 글자를 기준선에 찍는다. 안쪽 문자는 em 중심에 맞춘다.
      const shapeGlyph = decodedNumber === null
        ? [null, '○', '●', '□', '■'][op.charOverlap.borderType]
        : null;
      const centerY = shapeGlyph
        ? originY + op.baseline - boxSize * 0.35
        : originY + op.bbox.height - boxSize / 2;
      const drawShapeGlyph = (centerX: number): boolean => {
        if (!shapeGlyph) return false;
        for (const typeface of [primaryTypeface, this.defaultTypeface, this.symbolFallbackTypeface]) {
          if (!typeface) continue;
          const font = createOutlineSkiaFont(this.canvasKit, typeface, fontSize);
          let paint: SkPaint | null = null;
          try {
            const ids = font.getGlyphIDs(shapeGlyph, 1);
            if (ids[0] === 0) continue;
            const width = font.getGlyphWidths(ids)[0] ?? 0;
            paint = this.makeFillPaint(style.color ?? '#000000');
            canvas.drawText(shapeGlyph, centerX - width / 2, originY + op.baseline, paint, font);
            return true;
          } finally {
            paint?.delete?.();
            font.delete?.();
          }
        }
        return false;
      };
      const drawCell = (
        displayText: string,
        centerX: number,
        drawShape: boolean,
        horizontalScale?: number,
      ) => {
        const borderType = horizontalScale !== undefined && op.charOverlap.borderType === 0
          ? 1
          : op.charOverlap.borderType;
        const reversed = borderType === 2 || borderType === 4;
        const circle = borderType === 1 || borderType === 2;
        const rectangle = borderType === 3 || borderType === 4;
        const textColor = reversed ? '#ffffff' : style.color ?? '#000000';
        if (drawShape && (circle || rectangle) && !drawShapeGlyph(centerX)) {
          let fill: SkPaint | null = null;
          let stroke: SkPaint | null = null;
          try {
            fill = reversed ? this.makeFillPaint('#000000') : null;
            stroke = this.makeStrokePaint(
              reversed ? '#000000' : style.color ?? '#000000',
              0.8,
            );
            if (circle) {
              const radiusY = boxSize / 2;
              const radiusX = radiusY * 0.85;
              const oval = this.canvasKit.XYWHRect(
                centerX - radiusX,
                centerY - radiusY,
                radiusX * 2,
                radiusY * 2,
              );
              if (fill) canvas.drawOval(oval, fill);
              canvas.drawOval(oval, stroke);
            } else {
              const rect = this.canvasKit.XYWHRect(
                centerX - boxSize / 2,
                centerY - boxSize / 2,
                boxSize,
                boxSize,
              );
              if (fill) canvas.drawRect(rect, fill);
              canvas.drawRect(rect, stroke);
            }
          } finally {
            fill?.delete?.();
            stroke?.delete?.();
          }
        }

        let textFont = createOutlineSkiaFont(this.canvasKit, primaryTypeface, innerFontSize);
        let fallbackCandidate: Font | null = null;
        let paint: SkPaint | null = null;
        const adjustFont = (target: Font, usesPrimary: boolean) => {
          const adjustable = target as Font & {
            setEmbolden?: (enabled: boolean) => void;
            setSkewX?: (skew: number) => void;
          };
          adjustable.setEmbolden?.(usesPrimary ? styledTypeface.syntheticBold : style.bold === true);
          adjustable.setSkewX?.((usesPrimary ? styledTypeface.syntheticItalic : style.italic === true) ? -0.2 : 0);
        };
        try {
          adjustFont(textFont, true);
          let glyphIds = textFont.getGlyphIDs(displayText, Array.from(displayText).length);
          if (glyphIds.some(glyphId => glyphId === 0)) {
            for (const fallbackTypeface of [this.defaultTypeface, this.symbolFallbackTypeface]) {
              if (!fallbackTypeface || fallbackTypeface === primaryTypeface) continue;
              fallbackCandidate = createOutlineSkiaFont(this.canvasKit, fallbackTypeface, innerFontSize);
              adjustFont(fallbackCandidate, false);
              const fallbackGlyphIds = fallbackCandidate.getGlyphIDs(
                displayText,
                Array.from(displayText).length,
              );
              if (fallbackGlyphIds.every(glyphId => glyphId !== 0)) {
                textFont.delete?.();
                textFont = fallbackCandidate;
                fallbackCandidate = null;
                glyphIds = fallbackGlyphIds;
                break;
              }
              fallbackCandidate.delete?.();
              fallbackCandidate = null;
            }
          }
          if (glyphIds.some(glyphId => glyphId === 0)) {
            this.unsupportedOps.add('textRun:glyphMapping');
          }
          const widths = textFont.getGlyphWidths(glyphIds) ?? [];
          const measuredWidth = widths.reduce((sum, width) => sum + width, 0);
          const scaleX = horizontalScale ?? 1;
          if (scaleX < 1) {
            textFont.setScaleX(scaleX);
          }
          const drawWidth = measuredWidth * scaleX;
          paint = this.makeFillPaint(textColor);
          const textY = (horizontalScale !== undefined ? centerY - fontSize * 0.08 : centerY)
            + innerFontSize * 0.35;
          canvas.drawText(displayText, centerX - Math.max(drawWidth, 1) / 2, textY, paint, textFont);
        } finally {
          paint?.delete?.();
          fallbackCandidate?.delete?.();
          textFont.delete?.();
        }
      };

      if (decodedNumber !== null) {
        const horizontalScale = decodedNumber.length > 1
          ? 0.7 / decodedNumber.length * 2
          : 1;
        drawCell(decodedNumber, originX + boxSize / 2, true, horizontalScale);
        return;
      }
      const centerX = paintChars.length > 1 ? originX + op.bbox.width / 2 : originX + boxSize / 2;
      paintChars.forEach((ch, index) => {
        const codePoint = ch.codePointAt(0) ?? 0;
        const displayText = codePoint >= 0x2460 && codePoint <= 0x2473
          ? String(codePoint - 0x2460 + 1)
          : codePoint >= 0xF02CE && codePoint <= 0xF02E1
            ? String(codePoint - 0xF02CD)
          : codePoint === 0xF012B
            ? '(인)'
            : codePoint === 0xF031C
              ? '■'
              : codePoint === 0xF02FC
                ? '►'
                : codePoint === 0xF03C5
                  ? '□'
              : ch;
        drawCell(displayText, centerX, index === 0);
      });
    };

    this.withHorizontalTextVisualOrigin(canvas, op.bbox, op.rotation ?? 0, 'charOverlap', draw);
  }

  private renderTextControlMark(canvas: SkCanvas, op: LayerTextControlMarkOp): void {
    if (op.isVertical) {
      this.unsupportedOps.add('textRun:verticalText');
      return;
    }
    if (!Array.isArray(op.marks)) {
      this.unsupportedOps.add('textControlMark:invalidGeometry');
      return;
    }
    if (op.marksComplete !== true
      || op.marks.length > CanvasKitLayerRenderer.MAX_TEXT_SPECIAL_VISUAL_ITEMS) {
      this.unsupportedOps.add('textControlMark:visualItemLimitExceeded');
      return;
    }
    if (![op.baseline, op.rotation].every(Number.isFinite)
      || op.marks.some(mark => !['space', 'tab', 'paragraphEnd', 'lineBreakEnd'].includes(mark.kind)
        || ![mark.x, mark.y, mark.fontSize].every(Number.isFinite)
        || mark.fontSize <= 0)) {
      this.unsupportedOps.add('textControlMark:invalidGeometry');
      return;
    }
    if (!this.currentShowParagraphMarks && !this.currentShowControlCodes) return;
    const draw = (originX: number, originY: number) => {
      const baselineY = originY + op.baseline;
      let paint: SkPaint | null = null;
      try {
        paint = this.makeStrokePaint('#0066ff', 0.75);
        for (const mark of op.marks) {
          const x = originX + mark.x;
          const y = baselineY + mark.y;
          const size = mark.fontSize;
          if (mark.kind === 'space') {
            canvas.drawLine(x, y - size * 0.45, x + size * 0.25, y - size * 0.15, paint);
            canvas.drawLine(x + size * 0.25, y - size * 0.15, x + size * 0.5, y - size * 0.45, paint);
          } else if (mark.kind === 'tab') {
            const lineY = y - size * 0.3;
            const tipX = x + size * 0.85;
            canvas.drawLine(x, lineY, tipX, lineY, paint);
            canvas.drawLine(tipX, lineY, tipX - size * 0.25, lineY - size * 0.2, paint);
            canvas.drawLine(tipX, lineY, tipX - size * 0.25, lineY + size * 0.2, paint);
          } else if (mark.kind === 'paragraphEnd') {
            const topY = y - size * 0.8;
            const turnX = x + size * 0.4;
            const arrowY = y - size * 0.25;
            canvas.drawLine(turnX, topY, turnX, arrowY, paint);
            canvas.drawLine(turnX, arrowY, x, arrowY, paint);
            canvas.drawLine(x, arrowY, x + size * 0.2, arrowY - size * 0.18, paint);
            canvas.drawLine(x, arrowY, x + size * 0.2, arrowY + size * 0.18, paint);
          } else {
            const lineX = x + size * 0.25;
            const tipY = y - size * 0.1;
            canvas.drawLine(lineX, y - size * 0.85, lineX, tipY, paint);
            canvas.drawLine(lineX, tipY, lineX - size * 0.18, tipY - size * 0.22, paint);
            canvas.drawLine(lineX, tipY, lineX + size * 0.18, tipY - size * 0.22, paint);
          }
        }
      } finally {
        paint?.delete?.();
      }
    };

    this.withHorizontalTextVisualOrigin(canvas, op.bbox, op.rotation, 'textControlMark', draw);
  }

  private renderTabLeader(canvas: SkCanvas, op: LayerTabLeaderOp): void {
    if (op.isVertical) {
      this.unsupportedOps.add('textRun:verticalText');
      return;
    }
    if (!Array.isArray(op.leaders)) {
      this.unsupportedOps.add('tabLeader:invalidGeometry');
      return;
    }
    if (op.leadersComplete !== true
      || op.leaders.length > CanvasKitLayerRenderer.MAX_TEXT_SPECIAL_VISUAL_ITEMS) {
      this.unsupportedOps.add('tabLeader:visualItemLimitExceeded');
      return;
    }
    if (![op.baseline, op.fontSize, op.rotation].every(Number.isFinite)
      || op.fontSize <= 0
      || op.leaders.some(leader => ![leader.startX, leader.endX].every(Number.isFinite)
        || leader.endX < leader.startX
        || !Number.isInteger(leader.fillType)
        || leader.fillType < 0
        || leader.fillType > 11)) {
      this.unsupportedOps.add('tabLeader:invalidGeometry');
      return;
    }
    const draw = (originX: number, originY: number) => {
      const baselineY = originY + op.baseline;
      for (const leader of op.leaders) {
        if (leader.fillType === 0 || leader.endX <= leader.startX) continue;
        const x1 = originX + leader.startX;
        const x2 = originX + leader.endX;
        const y = baselineY - op.fontSize * 0.35;
        switch (leader.fillType) {
          case 1:
            this.drawTextVisualStroke(canvas, x1, y, x2, y, op.color, 0.5);
            break;
          case 2:
            this.drawTextVisualStroke(canvas, x1, y, x2, y, op.color, 0.5, [3, 3]);
            break;
          case 3: {
            // Native dot_tab_leader_layout keeps the trailing phase and reserves
            // the middle-dot glyph's half-em leading bearing.
            const pitch = op.fontSize / 4;
            const diameter = op.fontSize * 0.12;
            const last = x2 + pitch - diameter / 2;
            const inkStart = x1 + op.fontSize * 0.5;
            const count = Math.floor((last - inkStart - diameter / 2) / pitch);
            if (count >= 0) {
              this.drawTextVisualStroke(canvas, last - count * pitch, y, last + 0.01, y,
                op.color, diameter, [0.01, pitch - 0.01], true);
            }
            break;
          }
          case 4:
            this.drawTextVisualStroke(canvas, x1, y, x2, y, op.color, 0.5, [6, 2, 1, 2]);
            break;
          case 5:
            this.drawTextVisualStroke(canvas, x1, y, x2, y, op.color, 0.5, [6, 2, 1, 2, 1, 2]);
            break;
          case 6:
            this.drawTextVisualStroke(canvas, x1, y, x2, y, op.color, 0.5, [8, 4]);
            break;
          case 7:
            this.drawTextVisualStroke(canvas, x1, y, x2, y, op.color, 0.7, [0.1, 2.5], true);
            break;
          case 8:
            this.drawTextVisualStroke(canvas, x1, y - 1, x2, y - 1, op.color, 0.3);
            this.drawTextVisualStroke(canvas, x1, y + 1, x2, y + 1, op.color, 0.3);
            break;
          case 9:
            this.drawTextVisualStroke(canvas, x1, y - 1.2, x2, y - 1.2, op.color, 0.3);
            this.drawTextVisualStroke(canvas, x1, y + 0.8, x2, y + 0.8, op.color, 0.8);
            break;
          case 10:
            this.drawTextVisualStroke(canvas, x1, y - 0.8, x2, y - 0.8, op.color, 0.8);
            this.drawTextVisualStroke(canvas, x1, y + 1.2, x2, y + 1.2, op.color, 0.3);
            break;
          case 11:
            this.drawTextVisualStroke(canvas, x1, y - 2, x2, y - 2, op.color, 0.3);
            this.drawTextVisualStroke(canvas, x1, y, x2, y, op.color, 0.8);
            this.drawTextVisualStroke(canvas, x1, y + 2, x2, y + 2, op.color, 0.3);
            break;
        }
      }
    };

    this.withHorizontalTextVisualOrigin(canvas, op.bbox, op.rotation, 'tabLeader', draw);
  }

  private renderTextDecoration(canvas: SkCanvas, op: LayerTextDecorationOp): void {
    const decoration = op.decoration;
    if (!decoration
      || !Array.isArray(decoration.positions)
      || !['underline', 'strikethrough', 'emphasisDot'].includes(decoration.kind)) {
      this.unsupportedOps.add('textDecoration:invalidGeometry');
      return;
    }
    if (decoration.isVertical) {
      this.unsupportedOps.add('textRun:verticalText');
      return;
    }
    if (decoration.positionsComplete !== true
      || decoration.positions.length > CanvasKitLayerRenderer.MAX_TEXT_SPECIAL_VISUAL_ITEMS + 1) {
      this.unsupportedOps.add('textDecoration:visualItemLimitExceeded');
      return;
    }
    if (![decoration.baseline, decoration.rotation, decoration.fontSize, decoration.ratio]
      .every(Number.isFinite)
      || decoration.fontSize <= 0
      || decoration.ratio <= 0
      || decoration.positions.some(position => !Number.isFinite(position))
      || !Number.isInteger(decoration.shape)
      || decoration.shape < 0
      || decoration.shape > 12
      || !Number.isInteger(decoration.emphasisDot)
      || decoration.emphasisDot < 0
      || decoration.emphasisDot > 6
      || !['none', 'bottom', 'top'].includes(decoration.underline)) {
      this.unsupportedOps.add('textDecoration:invalidGeometry');
      return;
    }
    const textWidth = decoration.positions.at(-1) ?? 0;
    if (!Number.isFinite(textWidth) || textWidth < 0) {
      this.unsupportedOps.add('textDecoration:invalidGeometry');
      return;
    }
    const drawLineShape = (originX: number, y: number) => {
      const x2 = originX + textWidth;
      switch (decoration.shape) {
        case 7:
          this.drawTextVisualStroke(canvas, originX, y - 1, x2, y - 1, decoration.color, 0.7);
          this.drawTextVisualStroke(canvas, originX, y + 1, x2, y + 1, decoration.color, 0.7);
          break;
        case 8:
          this.drawTextVisualStroke(canvas, originX, y - 1.2, x2, y - 1.2, decoration.color, 0.5);
          this.drawTextVisualStroke(canvas, originX, y + 0.8, x2, y + 0.8, decoration.color, 1.2);
          break;
        case 9:
          this.drawTextVisualStroke(canvas, originX, y - 0.8, x2, y - 0.8, decoration.color, 1.2);
          this.drawTextVisualStroke(canvas, originX, y + 1.2, x2, y + 1.2, decoration.color, 0.5);
          break;
        case 10:
          this.drawTextVisualStroke(canvas, originX, y - 1.5, x2, y - 1.5, decoration.color, 0.5);
          this.drawTextVisualStroke(canvas, originX, y, x2, y, decoration.color, 0.5);
          this.drawTextVisualStroke(canvas, originX, y + 1.5, x2, y + 1.5, decoration.color, 0.5);
          break;
        case 11:
          this.drawTextVisualStroke(canvas, originX, y, x2, y, decoration.color, 0.7, [], false, 1.5, 6);
          break;
        case 12:
          this.drawTextVisualStroke(canvas, originX, y - 1, x2, y - 1, decoration.color, 0.5, [], false, 1.2, 6);
          this.drawTextVisualStroke(canvas, originX, y + 1, x2, y + 1, decoration.color, 0.5, [], false, 1.2, 6);
          break;
        default: {
          const dash = decoration.shape === 1 ? [3, 3]
            : decoration.shape === 2 ? [1, 2]
              : decoration.shape === 3 ? [6, 2, 1, 2]
                : decoration.shape === 4 ? [6, 2, 1, 2, 1, 2]
                  : decoration.shape === 5 ? [8, 4]
                    : decoration.shape === 6 ? [0.1, 2.5]
                      : [];
          this.drawTextVisualStroke(
            canvas,
            originX,
            y,
            x2,
            y,
            decoration.color,
            1,
            dash,
            decoration.shape === 6,
          );
        }
      }
    };
    const draw = (originX: number, originY: number) => {
      const baselineY = originY + decoration.baseline;
      if (decoration.kind === 'underline') {
        const y = decoration.underline === 'top'
          ? baselineY - decoration.fontSize + 1
          : baselineY + 2;
        drawLineShape(originX, y);
        return;
      }
      if (decoration.kind === 'strikethrough') {
        drawLineShape(originX, baselineY - decoration.fontSize * 0.3);
        return;
      }
      if (decoration.emphasisDot === 0) return;
      const dotSize = Math.max(1, decoration.fontSize * 0.3);
      let fillPaint: SkPaint | null = null;
      let strokePaint: SkPaint | null = null;
      try {
        fillPaint = this.makeFillPaint(decoration.color);
        strokePaint = this.makeStrokePaint(
          decoration.color,
          Math.max(dotSize * 0.12, 0.75),
        );
        for (const position of decoration.positions.slice(0, -1)) {
          const x = originX + position + decoration.fontSize * decoration.ratio * 0.5;
          const y = baselineY - decoration.fontSize * 1.05;
          const centerY = y - dotSize * 0.45;
          if (decoration.emphasisDot === 1) {
            canvas.drawCircle(x, centerY, Math.max(dotSize * 0.48, 1), fillPaint);
          } else if (decoration.emphasisDot === 2) {
            canvas.drawCircle(x, centerY, Math.max(dotSize * 0.48, 1), strokePaint);
          } else if (decoration.emphasisDot === 3) {
            canvas.drawLine(x - dotSize * 0.45, centerY - dotSize * 0.2, x, centerY + dotSize * 0.25, strokePaint);
            canvas.drawLine(x, centerY + dotSize * 0.25, x + dotSize * 0.45, centerY - dotSize * 0.2, strokePaint);
          } else if (decoration.emphasisDot === 4) {
            canvas.drawLine(x - dotSize * 0.5, centerY, x - dotSize * 0.15, centerY - dotSize * 0.22, strokePaint);
            canvas.drawLine(x - dotSize * 0.15, centerY - dotSize * 0.22, x + dotSize * 0.15, centerY + dotSize * 0.22, strokePaint);
            canvas.drawLine(x + dotSize * 0.15, centerY + dotSize * 0.22, x + dotSize * 0.5, centerY, strokePaint);
          } else if (decoration.emphasisDot === 5) {
            canvas.drawCircle(x, centerY, Math.max(dotSize * 0.22, 0.75), fillPaint);
          } else {
            const radius = Math.max(dotSize * 0.18, 0.7);
            canvas.drawCircle(x, centerY - radius * 1.5, radius, fillPaint);
            canvas.drawCircle(x, centerY + radius * 1.5, radius, fillPaint);
          }
        }
      } finally {
        strokePaint?.delete?.();
        fillPaint?.delete?.();
      }
    };

    this.withHorizontalTextVisualOrigin(
      canvas,
      op.bbox,
      decoration.rotation,
      'textDecoration',
      draw,
    );
  }

  private withHorizontalTextVisualOrigin(
    canvas: SkCanvas,
    bbox: LayerBounds,
    rotation: number,
    opType: 'charOverlap' | 'textControlMark' | 'tabLeader' | 'textDecoration',
    draw: (originX: number, originY: number) => void,
  ): void {
    if (![bbox.x, bbox.y, bbox.width, bbox.height, rotation].every(Number.isFinite)
      || bbox.width < 0
      || bbox.height < 0) {
      this.unsupportedOps.add(`${opType}:invalidGeometry`);
      return;
    }
    if (rotation !== 0) {
      this.unsupportedOps.add(`${opType}:rotatedText`);
      return;
    }
    draw(bbox.x, bbox.y);
  }

  private drawTextVisualStroke(
    canvas: SkCanvas,
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    color: string,
    width: number,
    dash: number[] = [],
    roundCap = false,
    waveHeight = 0,
    waveWidth = 0,
  ): void {
    const paint = this.makeStrokePaint(color, width);
    let effect: ReturnType<typeof this.canvasKit.PathEffect.MakeDash> | null = null;
    let path: Path | null = null;
    try {
      if (roundCap) paint.setStrokeCap(this.canvasKit.StrokeCap.Round);
      if (dash.length > 0) {
        effect = this.canvasKit.PathEffect.MakeDash(dash, 0);
        if (effect) paint.setPathEffect(effect);
      }
      if (waveHeight > 0 && waveWidth > 0) {
        const builder = new this.canvasKit.PathBuilder();
        try {
          builder.moveTo(x1, y1);
          let cursor = x1;
          let up = true;
          const step = Math.max(
            waveWidth,
            (x2 - x1) / CanvasKitLayerRenderer.MAX_TEXT_VISUAL_WAVE_SEGMENTS,
          );
          while (cursor < x2) {
            const next = Math.min(cursor + step, x2);
            builder.quadTo((cursor + next) / 2, up ? y1 - waveHeight : y1 + waveHeight, next, y1);
            cursor = next;
            up = !up;
          }
          path = builder.detach();
        } finally {
          builder.delete?.();
        }
        canvas.drawPath(path, paint);
      } else {
        canvas.drawLine(x1, y1, x2, y2, paint);
      }
    } finally {
      path?.delete?.();
      effect?.delete?.();
      paint.delete?.();
    }
  }

  private renderShapedScriptText(
    canvas: SkCanvas,
    text: string,
    color: string,
    fontSize: number,
    originX: number,
    originY: number,
    baselineShift: number,
    fontManager: FontMgr | null,
    fontFamily: string | null,
    bold: boolean,
    italic: boolean,
    ratio = 1,
  ): boolean {
    if (!fontManager) return false;
    const textStyle = {
      color: this.color(color),
      fontSize,
      ...(fontFamily ? { fontFamilies: [fontFamily] } : {}),
      ...(this.canvasKit.FontWeight && this.canvasKit.FontSlant ? {
        fontStyle: {
          weight: bold ? this.canvasKit.FontWeight.Bold : this.canvasKit.FontWeight.Normal,
          slant: italic ? this.canvasKit.FontSlant.Italic : this.canvasKit.FontSlant.Upright,
        },
      } : {}),
    };
    const paragraphStyle = new this.canvasKit.ParagraphStyle({
      disableHinting: true,
      maxLines: 1,
      textStyle,
    });
    const builder = this.canvasKit.ParagraphBuilder.Make(paragraphStyle, fontManager);
    try {
      builder.addText(text);
      const paragraph = builder.build();
      try {
        paragraph.layout(CanvasKitLayerRenderer.MAX_SHAPED_TEXT_WIDTH);
        canvas.save();
        try {
          canvas.translate(originX, originY - fontSize + baselineShift);
          canvas.scale(ratio, 1);
          canvas.drawParagraph(paragraph, 0, 0);
        } finally {
          canvas.restore();
        }
        return true;
      } finally {
        paragraph.delete?.();
      }
    } finally {
      builder.delete?.();
    }
  }

  private findPreparedTypeface(fontFamily: string | undefined): CanvasKitLocalTypeface | null {
    const key = normalizedFontFamily(fontFamily);
    if (!key) return null;
    const record = resolveLocalFont(primaryFontFamily(fontFamily));
    const local = record ? this.localTypefaces.get(localFontFaceKey(record)) ?? null : null;
    const bundled = this.bundledTypefaceAliases.get(key);
    if (key === normalizedFontFamily(OLD_HANGUL_FONT_FAMILY)) {
      return [this.oldHangulTypeface, local, bundled]
        .find(candidate => candidate?.fontManager) ?? null;
    }
    if (local) return local;
    if (bundled) return bundled;
    if (key === normalizedFontFamily(this.defaultFontFamily) || key === 'noto sans kr') {
      return this.defaultTypeface || this.defaultFontManager
        ? {
            typeface: this.defaultTypeface,
            fontManager: this.defaultFontManager,
            fontFamily: this.defaultFontFamily,
          }
        : null;
    }
    return null;
  }

  private findStyledPreparedTypeface(
    fontFamily: string | undefined,
    bold: boolean,
    italic: boolean,
    fontSubst?: string,
  ): CanvasKitStyledTypeface {
    const requested = primaryFontFamily(fontFamily);
    const families = [requested, ...rendererFontFallbackFamilies(requested, fontSubst)];
    for (const family of families) {
      const resolved = resolveLocalFont(family);
      if (resolved) {
        const loadedFaces = Array.from(this.localTypefaceRecords.entries())
          .filter(([key]) => this.localTypefaces.has(key))
          .map(([, record]) => record);
        const selected = selectPreparedFontFace(family, resolved, loadedFaces, bold, italic);
        const prepared = this.localTypefaces.get(localFontFaceKey(selected.record));
        if (prepared) {
          return {
            prepared,
            syntheticBold: prepared.typeface ? selected.syntheticBold : bold,
            syntheticItalic: prepared.typeface ? selected.syntheticItalic : italic,
          };
        }
      }
      const prepared = this.findPreparedTypeface(family);
      if (prepared) return { prepared, syntheticBold: bold, syntheticItalic: italic };
    }
    return { prepared: null, syntheticBold: bold, syntheticItalic: italic };
  }

  private findEquationTypefaces(fontName: string | undefined, italic: boolean, bold: boolean, modernCjk = false): EquationTypeface[] {
    const key = `${fontName ?? ''}:${italic}:${bold}:${modernCjk}`;
    const cached = this.equationTypefaces.get(key);
    if (cached) return cached;
    const records = getLocalFontRecords({ includeRegistered: true });
    const faces: EquationTypeface[] = [];
    // 수식 서체가 지원하지 않는 한글·동그라미 숫자는 native와 같이
    // 준비된 본문 서체에서 찾는다. 수식 서체의 우선순위는 유지한다.
    const families = [...equationFontFamilies(fontName), ...(modernCjk ? ['Haansoft Batang'] : []), 'Noto Serif KR', 'Batang',
      'AppleMyungjo', 'Haansoft Batang', 'HCR Batang', 'Noto Sans KR', 'HCR Dotum'];
    for (const family of families) {
      if (/^HSUS(R|RI|FL|SP)$/.test(family)) {
        const native = this.findPreparedTypeface(family)?.typeface;
        if (native) faces.push({ typeface: native, syntheticItalic: false, syntheticBold: bold });
        continue;
      }
      if (isLegacyEquationFont(family)) {
        const legacy = this.findPreparedTypeface(family)?.typeface;
        if (legacy) faces.push({ typeface: legacy, syntheticItalic: italic, syntheticBold: bold, legacy: true });
        continue;
      }
      const styled = equationLocalFontFace(records, family, italic, bold);
      const exact = styled ? this.localTypefaces.get(localFontFaceKey(styled))?.typeface : null;
      if (exact) {
        faces.push({ typeface: exact, syntheticItalic: false, syntheticBold: false });
        continue;
      }
      const prepared = this.findPreparedTypeface(family)?.typeface;
      const typeface = prepared ?? (family === 'Latin Modern Math' ? this.equationTypeface : null);
      if (typeface) faces.push({ typeface, syntheticItalic: italic, syntheticBold: bold });
    }
    if (this.defaultTypeface && !faces.some(face => face.typeface === this.defaultTypeface)) {
      faces.push({ typeface: this.defaultTypeface, syntheticItalic: italic, syntheticBold: bold });
    }
    this.equationTypefaces.set(key, faces);
    return faces;
  }

  private renderEquation(canvas: SkCanvas, op: LayerEquationOp): void {
    if (!op.layoutBox || !this.boundsAreDrawable(op.bbox)) {
      this.unsupportedOps.add('equation:unsupportedDirectReplay');
      return;
    }
    const budget: EquationRenderBudget = {
      remainingNodes: CanvasKitLayerRenderer.MAX_EQUATION_LAYOUT_NODES,
      hft: op.versionInfo === '' && isLegacyEquationFont(op.fontName),
      modernHy: !!op.versionInfo && isLegacyEquationFont(op.fontName),
    };
    const recorder = new this.canvasKit.PictureRecorder();
    let picture: ReturnType<typeof recorder.finishRecordingAsPicture> | null = null;
    let recordingFinished = false;
    let replayed = false;
    try {
      const recordingCanvas = recorder.beginRecording(this.rect(op.bbox));
      recordingCanvas.save();
      recordingCanvas.translate(op.bbox.x, op.bbox.y);
      try {
        replayed = this.renderEquationBox(
          recordingCanvas,
          op.layoutBox,
          0,
          0,
          op.color ?? '#000000',
          Math.max(1, op.fontSize ?? op.bbox.height),
          op.fontName,
          true,
          false,
          0,
          budget,
        );
      } finally {
        recordingCanvas.restore();
      }
      picture = recorder.finishRecordingAsPicture();
      recordingFinished = true;
      if (replayed) canvas.drawPicture(picture);
    } catch {
      replayed = false;
    } finally {
      if (!recordingFinished) {
        try {
          picture = recorder.finishRecordingAsPicture();
        } catch {
          picture = null;
        }
      }
      picture?.delete?.();
      recorder.delete?.();
    }
    if (!replayed) {
      this.unsupportedOps.add('equation:invalidLayout');
    }
  }

  private renderEquationBox(
    canvas: SkCanvas,
    layout: LayerEquationLayoutBox,
    parentX: number,
    parentY: number,
    color: string,
    fontSize: number,
    fontName: string | undefined,
    italic: boolean,
    bold: boolean,
    depth: number,
    budget: EquationRenderBudget,
  ): boolean {
    if (
      depth > CanvasKitLayerRenderer.MAX_EQUATION_LAYOUT_DEPTH
      || budget.remainingNodes <= 0
      || !this.equationBoxIsFinite(layout)
    ) {
      return false;
    }
    budget.remainingNodes -= 1;
    const x = parentX + layout.x;
    const y = parentY + layout.y;
    const child = (box: LayerEquationLayoutBox, size = fontSize, childItalic = italic, childBold = bold) => (
      this.renderEquationBox(canvas, box, x, y, color, size, fontName, childItalic, childBold, depth + 1, budget)
    );

    if (layout.glyphAdvances) {
      const kind = layout.kind;
      const text = kind.type === 'function' ? kind.name
        : ['text', 'number', 'symbol', 'mathSymbol'].includes(kind.type) && 'text' in kind ? kind.text : null;
      if (text === null || [...text].length !== layout.glyphAdvances.length
        || layout.glyphAdvances.length > budget.remainingNodes
        || depth === CanvasKitLayerRenderer.MAX_EQUATION_LAYOUT_DEPTH
        || !layout.glyphAdvances.every(value => Number.isFinite(value) && value >= 0)) return false;
      let pen = 0;
      return [...text].every((character, index) => {
        const advance = layout.glyphAdvances![index];
        const glyphKind: LayerEquationLayoutBox['kind'] = kind.type === 'function'
          ? { type: 'function', name: character }
          : { type: kind.type === 'symbol' ? 'mathSymbol' : kind.type as 'text' | 'number' | 'mathSymbol', text: character };
        const glyph = { ...layout, glyphAdvances: undefined, x: pen, y: 0, width: advance, kind: glyphKind };
        pen += advance;
        return child(glyph, layout.height);
      });
    }
    switch (layout.kind.type) {
      case 'row':
        return layout.kind.children.every((box) => child(box));
      case 'text':
      case 'number':
      case 'symbol':
      case 'mathSymbol': {
        if (budget.modernHy && layout.kind.text === '∫') {
          const integralDrawn = this.drawModernHyIntegral(canvas, x, y, fontSize, color);
          if (integralDrawn !== null) return integralDrawn;
        }
        return this.drawEquationText(
          canvas,
          layout.kind.text,
          x,
          y + layout.baseline,
          // 잎의 높이는 측정된 em이며 첨자·행별 크기도 이미 반영되어 있다.
          layout.height > 0 ? layout.height : fontSize,
          color,
          (layout.kind.type === 'text' || (layout.kind.type === 'mathSymbol' && /[\u0391-\u03c9]/u.test(layout.kind.text))) && italic && !/[\u3000-\u9fff\uf900-\ufaff\uac00-\ud7af]/u.test(layout.kind.text),
          (layout.kind.type === 'text' || layout.kind.type === 'number') && bold,
          layout.width,
          layout.kind.type === 'symbol',
          fontName,
          budget.hft,
          layout.kind.type === 'text',
          budget.modernHy,
        );
      }
      case 'function':
        return this.drawEquationText(
          canvas,
          layout.kind.name,
          x,
          y + layout.baseline,
          layout.height > 0 ? layout.height : fontSize,
          color,
          false,
          false,
          layout.width,
          false,
          fontName,
          budget.hft,
        );
      case 'fraction':
        return child(layout.kind.numer)
          && this.drawEquationLine(
            canvas,
            x + (layout.kind.barInset ?? fontSize * 0.05),
            // canonical fraction_line_y: 분자 높이 + padding + 선 두께/2.
            y + layout.kind.numer.height + fontSize * (0.2 + 0.04 / 2),
            x + layout.width - (layout.kind.barInset ?? fontSize * 0.05),
            y + layout.kind.numer.height + fontSize * (0.2 + 0.04 / 2),
            color,
            fontSize * 0.04,
          )
          && child(layout.kind.denom);
      case 'atop':
        return child(layout.kind.top) && child(layout.kind.bottom);
      case 'sqrt': {
        const puaDrawn = this.drawEquationSqrt(canvas, layout, x, y, fontSize, color, fontName, budget.hft, budget.modernHy);
        if (puaDrawn) {
          return (!layout.kind.index || child(layout.kind.index, fontSize * 0.7, false, false))
            && child(layout.kind.body);
        }
        const bodyLeft = x + layout.kind.body.x - fontSize * 0.1;
        const midX = bodyLeft - fontSize * 0.15;
        const midY = y + layout.height;
        const startX = midX - fontSize * 0.3;
        const startY = y + layout.height * 0.6;
        const tickX = startX - fontSize * 0.1;
        const tickY = startY - fontSize * 0.05;
        const linesDrawn = this.drawEquationLine(canvas, tickX, tickY, startX, startY, color, fontSize * 0.04)
          && this.drawEquationLine(canvas, startX, startY, midX, midY, color, fontSize * 0.04)
          && this.drawEquationLine(canvas, midX, midY, bodyLeft, y, color, fontSize * 0.04)
          && this.drawEquationLine(canvas, bodyLeft, y, x + layout.width, y, color, fontSize * 0.04);
        const indexDrawn = layout.kind.index
          ? child(layout.kind.index, fontSize * 0.7, false, false)
          : true;
        return linesDrawn && indexDrawn && child(layout.kind.body);
      }
      case 'superscript':
        return child(layout.kind.base)
          && child(layout.kind.sup, fontSize * 0.7);
      case 'subscript':
        return child(layout.kind.base)
          && child(layout.kind.sub, fontSize * 0.7);
      case 'subSup':
        return child(layout.kind.base)
          && child(layout.kind.sub, fontSize * 0.7)
          && child(layout.kind.sup, fontSize * 0.7);
      case 'bigOp': {
        const modernHySum = budget.modernHy && layout.kind.symbol === '∑';
        const opSize = fontSize * (modernHySum ? 1.8 : 1.5);
        const supHeight = layout.kind.sup ? layout.kind.sup.height + fontSize * 0.05 : 0;
        const integralDrawn = budget.modernHy && layout.kind.symbol === '∫'
          ? this.drawModernHyIntegral(canvas, x, y, fontSize, color) : null;
        const symbolDrawn = integralDrawn ?? this.drawEquationText(
          canvas,
          layout.kind.symbol,
          x,
          y + supHeight + opSize * (modernHySum ? 0.74 : 0.8),
          opSize,
          color,
          false,
          false,
          layout.width - (modernHySum ? fontSize * 0.03 : 0),
          true,
          fontName,
          budget.hft,
        );
        const supDrawn = layout.kind.sup
          ? child(layout.kind.sup, fontSize * 0.7, modernHySum && italic, false)
          : true;
        const subDrawn = layout.kind.sub
          ? child(layout.kind.sub, fontSize * 0.7, modernHySum && italic, false)
          : true;
        return symbolDrawn && supDrawn && subDrawn;
      }
      case 'limit': {
        // 전체 높이는 첨자를 포함한다. 이름의 em은 엔진 기준선에서 얻는다.
        const size = layout.baseline / 0.8;
        const limitDrawn = this.drawEquationText(
          canvas,
          layout.kind.isUpper ? 'Lim' : 'lim',
          x + (layout.kind.nameX ?? 0),
          y + layout.baseline + (layout.kind.nameY ?? 0),
          size,
          color,
          false,
          false,
          layout.width,
          false,
          fontName,
          budget.hft,
        );
        return limitDrawn && (layout.kind.sub
          ? child(layout.kind.sub, fontSize * 0.7, italic, false)
          : true);
      }
      case 'matrix': {
        let rendered = true;
        if (layout.kind.style !== 'plain') {
          const brackets = layout.kind.style === 'paren'
            ? ['(', ')']
            : layout.kind.style === 'bracket'
              ? ['[', ']']
              : ['|', '|'];
          rendered = this.drawEquationBracket(canvas, brackets[0], x, y, layout.height, color, fontSize, fontName, fontSize * 0.3)
            && this.drawEquationBracket(canvas, brackets[1], x + layout.width - fontSize * 0.3, y, layout.height, color, fontSize, fontName, fontSize * 0.3);
        }
        for (const row of layout.kind.cells) {
          for (const cell of row) rendered = child(cell) && rendered;
        }
        return rendered;
      }
      case 'rel':
        return child(layout.kind.over)
          && child(layout.kind.arrow)
          && (layout.kind.under ? child(layout.kind.under) : true);
      case 'eqAlign':
        return layout.kind.rows.every((row) => child(row.left) && child(row.right));
      case 'paren': {
        const { left, right, body } = layout.kind;
        const barSlot = fontSize * 0.5;
        const leftBar = left === '|', rightBar = right === '|';
        const after = layout.width - body.x - body.width;
        // Source-metric HY LEFT/RIGHT bars reserve a half-em slot. Keep their
        // strokes centered in that slot; ordinary glyph bars retain their width.
        if (budget.modernHy && (leftBar || rightBar)
          && (leftBar || left === '') && (rightBar || right === '')
          && Math.abs(body.x - (leftBar ? barSlot : 0)) < 1e-6
          && Math.abs(after - (rightBar ? barSlot : 0)) < 1e-6) {
          return (!leftBar || this.drawEquationBracket(canvas, left, x, y,
            layout.height, color, fontSize, fontName, barSlot))
            && child(body)
            && (!rightBar || this.drawEquationBracket(canvas, right,
              x + layout.width - barSlot, y, layout.height, color, fontSize, fontName, barSlot));
        }
        const square = modernShortSquarePaintMetrics(
          getImportedLocalFontBytes(fontName ?? ''), fontSize,
          { ...layout.kind, width: layout.width, height: layout.height }, budget.modernHy,
        );
        if (square) {
          return this.drawEquationText(canvas, '[', x + square.openInkLeft, y + layout.baseline,
            fontSize, color, false, false, 0, false, fontName, budget.hft)
            && child(body)
            && this.drawEquationText(canvas, ']', x + layout.width - square.rightSlot,
              y + layout.baseline, fontSize, color, false, false, 0, false, fontName, budget.hft);
        }
        if (!budget.hft && isLegacyEquationFont(fontName ?? '') && !layout.kind.modernExtent
          && (layout.kind.left === '{' || layout.kind.right === '}')) {
          const size = Math.max(layout.height, fontSize);
          const baseline = y + layout.height / 2 + size * 0.309;
          const contentBottom = budget.modernHy
            ? this.equationContentBottom(layout.kind.body, depth + 1, budget.remainingNodes) : null;
          const inkHeight = contentBottom === null ? null : Math.min(Math.max(contentBottom, fontSize), size);
          const bracket = (text: string, bx: number): boolean => {
            if (!text) return true;
            if (inkHeight !== null && (text === '{' || text === '}')
              && this.drawModernHyBrace(canvas, text === '{', bx,
                baseline - size * 821 / 1024, inkHeight, fontSize, color, fontName)) return true;
            return this.drawEquationText(canvas, text, bx, baseline, size, color,
              false, false, 0, false, fontName);
          };
          const after = layout.width - layout.kind.body.x - layout.kind.body.width;
          const rightSlot = layout.kind.right === '}' && Math.abs(after - fontSize * 0.48) < 0.001
            ? after : fontSize * 0.333;
          return bracket(layout.kind.left, x) && child(layout.kind.body)
            && bracket(layout.kind.right, x + layout.width - rightSlot);
        }
        if (layout.height <= fontSize * 1.2) {
          const bracket = (text: string, bx: number): boolean => !text || (
            /^[()[\]]$/.test(text)
              ? this.drawEquationText(canvas, text, bx, y + layout.baseline, fontSize,
                color, false, false, 0, false, fontName, budget.hft)
              : this.drawEquationBracket(canvas, text, bx, y, layout.height, color, fontSize, fontName)
          );
          return bracket(layout.kind.left, x) && child(layout.kind.body)
            && bracket(layout.kind.right, x + layout.width - fontSize * 0.333);
        }
        if (!budget.hft && isLegacyEquationFont(fontName)
          && (layout.kind.left === '[' || layout.kind.right === ']')) {
          const bracket = (text: string, bx: number): boolean => !text
            || ((text === '[' || text === ']')
              && this.drawLegacySquareBracket(canvas, text === '[', bx,
                y + layout.height * 0.03, layout.height * 0.94, fontSize, color, fontName, budget))
            || this.drawEquationBracket(canvas, text, bx, y, layout.height, color, fontSize, fontName);
          return bracket(layout.kind.left, x) && child(layout.kind.body)
            && bracket(layout.kind.right, x + layout.width
              - (layout.kind.right === ']' ? fontSize * 0.494 : fontSize * 0.333));
        }
        if (layout.kind.modernExtent) {
          const [top, height] = layout.kind.modernExtent;
          const bracket = (text: string, bx: number): boolean => {
            if (!text) return true;
            const bottom = text === '{' ? -203 / 1024 : text === '(' ? -207 / 1024 : -208 / 1024;
            const glyphTop = (text === '{' ? 821 : 826) / 1024;
            const scaleY = height / ((glyphTop - bottom) * fontSize);
            canvas.save();
            try {
              canvas.translate(bx, y + top + glyphTop * fontSize * scaleY);
              canvas.scale(1, scaleY);
              return this.drawEquationText(canvas, text, 0, 0, fontSize, color,
                false, false, 0, false, fontName);
            } finally { canvas.restore(); }
          };
          return bracket(layout.kind.left, x) && child(layout.kind.body)
            && bracket(layout.kind.right, x + layout.width - fontSize * 0.39);
        }
        return (layout.kind.left
          ? this.drawEquationBracket(canvas, layout.kind.left, x, y, layout.height, color, fontSize, fontName)
          : true)
          && child(layout.kind.body)
          && (layout.kind.right
            ? this.drawEquationBracket(canvas, layout.kind.right, x + layout.width - fontSize * 0.333, y, layout.height, color, fontSize, fontName)
            : true);
      }
      case 'decoration':
        return child(layout.kind.body)
          && this.drawEquationDecoration(
            canvas,
            layout.kind.decoration,
            x + layout.kind.body.x + layout.kind.body.width / 2,
            y + fontSize * 0.05,
            layout.kind.body.width,
            color,
            fontSize,
          );
      case 'fontStyle': {
        if (!['roman', 'italic', 'bold'].includes(layout.kind.fontStyle)) return false;
        const nextItalic = layout.kind.fontStyle === 'roman'
          ? false
          : layout.kind.fontStyle === 'italic'
            || layout.kind.fontStyle === 'calligraphy'
            || layout.kind.fontStyle === 'fraktur'
            || italic;
        const nextBold = layout.kind.fontStyle === 'roman'
          ? false
          : layout.kind.fontStyle === 'bold'
            || layout.kind.fontStyle === 'blackboard'
            || bold;
        return child(layout.kind.body, fontSize, nextItalic, nextBold);
      }
      case 'space':
      case 'newline':
      case 'empty':
        return true;
    }
  }

  private equationBoxIsFinite(layout: LayerEquationLayoutBox): boolean {
    return Number.isFinite(layout.x)
      && Number.isFinite(layout.y)
      && Number.isFinite(layout.width)
      && Number.isFinite(layout.height)
      && Number.isFinite(layout.baseline)
      && layout.width >= 0
      && layout.height >= 0;
  }

  /** 원본 HYhwpEQ의 근호 부품만 가로로 늘리고 윗줄의 em 두께는 유지한다. */
  private drawEquationSqrt(
    canvas: SkCanvas,
    layout: LayerEquationLayoutBox,
    x: number,
    y: number,
    fontSize: number,
    color: string,
    fontName: string | undefined,
    hft: boolean,
    modernHy = false,
  ): boolean {
    if (layout.kind.type !== 'sqrt' || !isLegacyEquationFont(fontName)) return false;
    const face = this.findPreparedTypeface(fontName)?.typeface;
    if (!face) return false;
    const body = layout.kind.body;
    const top = body.y - fontSize * (modernHy && !hft ? 0.1 : 0.15);
    const signSize = hft ? fontSize * 0.682 + body.height * 0.37 : body.height + fontSize * 0.1;
    const signBaseline = hft ? layout.baseline : top + signSize * 821 / 1024;
    const barSize = hft ? body.height * 1.11 : fontSize;
    const barBaseline = hft ? body.y + body.height * 0.694 : top + fontSize * 639 / 1024;
    const barAdvance = hft
      ? body.width + fontSize * 0.17
      : layout.width - body.x + fontSize * 0.05;
    const signFont = createOutlineSkiaFont(this.canvasKit, face, signSize);
    const barFont = createOutlineSkiaFont(this.canvasKit, face, barSize);
    let paint: SkPaint | null = null;
    try {
      const signIds = signFont.getGlyphIDs('\ue05c', 1);
      const barIds = barFont.getGlyphIDs('\ue06d', 1);
      if (!signIds?.[0] || !barIds?.[0]) return false;
      const signWidth = signFont.getGlyphWidths(signIds)?.[0] ?? 0;
      const barWidth = barFont.getGlyphWidths(barIds)?.[0] ?? 0;
      if (!(signWidth > 0 && barWidth > 0)) return false;
      paint = this.makeFillPaint(color);
      const draw = (glyph: string, font: Font, left: number, baseline: number, width: number, natural: number) => {
        canvas.save();
        try {
          canvas.translate(left, baseline);
          canvas.scale(width / natural, 1);
          canvas.drawText(glyph, 0, 0, paint!, font);
        } finally { canvas.restore(); }
      };
      draw('\ue05c', signFont, x + body.x - fontSize, y + signBaseline, fontSize, signWidth);
      draw('\ue06d', barFont, x + body.x - fontSize * 0.03, y + barBaseline, barAdvance, barWidth);
      return true;
    } finally {
      paint?.delete?.();
      signFont.delete();
      barFont.delete();
    }
  }

  private drawEquationText(
    canvas: SkCanvas,
    text: string,
    x: number,
    baselineY: number,
    fontSize: number,
    color: string,
    italic: boolean,
    bold: boolean,
    targetWidth: number,
    centered: boolean,
    fontName: string | undefined,
    hft = false,
    literal = false,
    modernHy = false,
  ): boolean {
    if (
      !text
      || text.length > CanvasKitLayerRenderer.MAX_EQUATION_TEXT_LENGTH
      || ![x, baselineY, fontSize, targetWidth].every(Number.isFinite)
    ) {
      return false;
    }
    if (hft && literal && /[^\x00-\x7f]/u.test(text)) {
      let pen = x;
      for (const character of text) {
        const unicode = /[^\x00-\x7f]/u.test(character);
        const resolved = unicode ? this.equationLiteralFont(character) : null;
        const latin = italic ? 'HSUSRI' : 'HSUSR';
        const family = unicode ? resolved?.family ?? 'Times New Roman'
          : this.findPreparedTypeface(latin)?.typeface ? latin : 'Times New Roman';
        const size = fontSize * (resolved?.emScale ?? 1);
        if (!this.drawEquationText(canvas, character, pen, baselineY, size, color,
          unicode ? false : italic, bold, 0, false, family)) return false;
        const face = this.findPreparedTypeface(family)?.typeface;
        if (face) {
          const measured = createOutlineSkiaFont(this.canvasKit, face, size);
          try {
            const ids = measured.getGlyphIDs(character, 1);
            pen += ids ? measured.getGlyphWidths(ids)?.[0] ?? 0 : 0;
          } finally { measured.delete(); }
        }
      }
      return true;
    }
    if (hft) {
      const banks = equationHftBanks(italic);
      const runs: Array<{ text: string; family: string; width: number }> = [];
      for (const character of text) {
        let run: { text: string; family: string; width: number } | undefined;
        for (const family of banks) {
          const face = this.findPreparedTypeface(family)?.typeface;
          if (!face) continue;
          const candidate = createOutlineSkiaFont(this.canvasKit, face, fontSize);
          try {
            const ids = candidate.getGlyphIDs(character, 1);
            if (ids?.[0]) {
              run = { text: character, family, width: candidate.getGlyphWidths(ids)?.[0] ?? 0 };
              break;
            }
          } finally { candidate.delete(); }
        }
        if (!run) { runs.length = 0; break; }
        runs.push(run);
      }
      if (runs.length) {
        const width = runs.reduce((sum, run) => sum + run.width, 0);
        let pen = centered ? x + (targetWidth - width) / 2 : x;
        for (const run of runs) {
          if (!this.drawEquationText(canvas, run.text, pen, baselineY, fontSize, color,
            false, bold, run.width, false, run.family)) return false;
          pen += run.width;
        }
        return true;
      }
    }
    let font: Font | null = null;
    let paint: SkPaint | null = null;
    try {
      let face: EquationTypeface | undefined;
      let glyphIds: Uint16Array | null = null;
      let runs: Array<{ text: string; italic: boolean; baselineEm?: number }> = [{ text, italic }];
      // 현대 HY 수식의 한글은 준비된 한컴 원본 서체를 우선한다.
      const modernCjk = modernHy && isLegacyEquationFont(fontName)
        && /[\u3000-\u9fff\uf900-\ufaff\uac00-\ud7af]/u.test(text);
      for (const candidate of this.findEquationTypefaces(fontName, italic, bold, modernCjk)) {
        font = createOutlineSkiaFont(this.canvasKit, candidate.typeface, fontSize);
        const candidateRuns = candidate.legacy ? legacyEquationRuns(text, italic, !hft) : [{ text, italic: candidate.syntheticItalic }];
        const candidateText = candidateRuns.map(run => run.text).join('');
        glyphIds = font.getGlyphIDs(candidateText, Array.from(candidateText).length);
        if (glyphIds && !glyphIds.some(glyphId => glyphId === 0)) {
          face = candidate;
          runs = candidateRuns;
          break;
        }
        font.delete();
        font = null;
      }
      if (!face || !font || !glyphIds) return false;
      paint = this.makeFillPaint(color);
      const glyphWidths = font.getGlyphWidths(glyphIds) ?? [];
      const measuredWidth = glyphWidths.reduce((sum, width) => sum + width, 0);
      // control 폭에 맞춘 비등방 배율 없이 원본 서체의 자연 비례를 유지한다.
      const drawWidth = measuredWidth;
      const adjustableFont = font as Font & {
        setEmbolden?: (enabled: boolean) => void;
        setSkewX?: (skew: number) => void;
      };
      adjustableFont.setEmbolden?.(face.syntheticBold);
      let pen = centered ? x + (targetWidth - drawWidth) / 2 : x;
      for (const run of runs) {
        adjustableFont.setSkewX?.(run.italic ? -0.2 : 0);
        canvas.drawText(run.text, pen, baselineY + (run.baselineEm ?? 0) * fontSize, paint, font);
        const ids = font.getGlyphIDs(run.text, Array.from(run.text).length);
        pen += (ids ? font.getGlyphWidths(ids) : null)?.reduce((sum, width) => sum + width, 0) ?? 0;
      }
      return true;
    } finally {
      font?.delete?.();
      paint?.delete?.();
    }
  }

  /** 현대 HY 적분은 기존 논리 박스 안에서 STIX 원본 윤곽으로 그린다. */
  private drawModernHyIntegral(
    canvas: SkCanvas,
    x: number,
    y: number,
    fontSize: number,
    color: string,
  ): boolean | null {
    const face = this.findPreparedTypeface('STIXGeneral')?.typeface;
    if (!face) return null;
    const font = createOutlineSkiaFont(this.canvasKit, face, fontSize * 1.748);
    let paint: SkPaint | null = null;
    try {
      if (!font.getGlyphIDs('∫', 1)?.[0]) return null;
      paint = this.makeFillPaint(color);
      canvas.drawText('∫', x + fontSize * 0.042, y + fontSize * 1.94, paint, font);
      return true;
    } finally {
      font.delete();
      paint?.delete?.();
    }
  }

  private drawEquationLine(
    canvas: SkCanvas,
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    color: string,
    width: number,
  ): boolean {
    if (![x1, y1, x2, y2, width].every(Number.isFinite)) return false;
    const paint = this.makeStrokePaint(color, Math.max(0.5, width));
    try {
      canvas.drawLine(x1, y1, x2, y2, paint);
      return true;
    } finally {
      paint.delete?.();
    }
  }

  /** 큰 HY 대괄호는 em을 늘리지 않고 원본 상단·연장·하단 파트를 쌓는다. */
  private drawLegacySquareBracket(
    canvas: SkCanvas,
    left: boolean,
    x: number,
    top: number,
    height: number,
    fontSize: number,
    color: string,
    fontName: string | undefined,
    budget: EquationRenderBudget,
  ): boolean {
    if (![x, top, height, fontSize].every(Number.isFinite) || height <= 0 || fontSize <= 0) return false;
    const upperBottom = top + 0.941 * fontSize;
    const lowerTop = top + height - 0.944 * fontSize;
    const span = Math.max(0, lowerTop - upperBottom);
    const count = Math.max(1, Math.ceil((span + fontSize * 0.2) / (fontSize * 0.7)));
    if (!Number.isFinite(count) || count + 2 > budget.remainingNodes) return false;
    const parts = left ? ['\ue100', '\ue101', '\ue103'] : ['\ue102', '\ue105', '\ue104'];
    const face = this.findEquationTypefaces(fontName, false, false).find(candidate => candidate.legacy);
    if (!face) return false;
    const font = createOutlineSkiaFont(this.canvasKit, face.typeface, fontSize);
    let paint: SkPaint | null = null;
    try {
      const ids = font.getGlyphIDs(parts.join(''), 3);
      if (!ids || ids.some(id => id === 0)) return false;
      paint = this.makeFillPaint(color);
      canvas.drawText(parts[0], x, top + 0.733 * fontSize, paint, font);
      canvas.drawText(parts[2], x, top + height - 0.152 * fontSize, paint, font);
      budget.remainingNodes -= count + 2;
      for (let index = 0; index < count; index++) {
        const center = upperBottom + span * (index + 0.5) / count;
        canvas.drawText(parts[1], x, center + 0.292 * fontSize, paint, font);
      }
      return true;
    } finally {
      font.delete();
      paint?.delete?.();
    }
  }

  private equationContentBottom(
    layout: LayerEquationLayoutBox,
    depth: number,
    remainingNodes: number,
  ): number | null {
    const bottom = (box: LayerEquationLayoutBox, level: number): number | null => {
      if (level > CanvasKitLayerRenderer.MAX_EQUATION_LAYOUT_DEPTH || --remainingNodes < 0
        || !this.equationBoxIsFinite(box)) return null;
      const kind = box.kind;
      const children = kind.type === 'row' ? kind.children
        : kind.type === 'fraction' ? [kind.numer, kind.denom]
          : kind.type === 'atop' ? [kind.top, kind.bottom] : null;
      if (!children) return box.height;
      let result = 0;
      for (const child of children) {
        const childBottom = bottom(child, level + 1);
        if (childBottom === null) return null;
        result = Math.max(result, child.y + childBottom);
      }
      return result;
    };
    return bottom(layout, depth);
  }

  private drawModernHyBrace(
    canvas: SkCanvas,
    left: boolean,
    x: number,
    top: number,
    height: number,
    fontSize: number,
    color: string,
    fontName: string | undefined,
  ): boolean {
    const face = this.findEquationTypefaces(fontName, false, false).find(candidate => candidate.legacy);
    if (!face) return false;
    const glyph = left ? '\ue04b' : '\ue04c';
    const font = createOutlineSkiaFont(this.canvasKit, face.typeface, fontSize);
    let paint: SkPaint | null = null;
    try {
      if (!font.getGlyphIDs(glyph, 1)?.[0]) return false;
      paint = this.makeFillPaint(color);
      // HY braces retain their nominal x scale while their one-em ink height
      // follows the child content, excluding structural bottom padding.
      const scaleY = height / fontSize;
      canvas.save();
      try {
        canvas.translate(x, top + height * 821 / 1024);
        canvas.scale(1, scaleY);
        canvas.drawText(glyph, 0, 0, paint, font);
      } finally { canvas.restore(); }
      return true;
    } finally {
      font.delete(); paint?.delete?.();
    }
  }

  private drawEquationBracket(
    canvas: SkCanvas,
    bracket: string,
    x: number,
    y: number,
    height: number,
    color: string,
    fontSize: number,
    fontName: string | undefined,
    slotWidth = fontSize * 0.333,
  ): boolean {
    const width = Math.max(fontSize * 0.3, 1);
    if (bracket === '|') {
      const center = x + slotWidth / 2;
      return this.drawEquationLine(canvas, center, y, center, y + height, color, fontSize * 0.04);
    }
    return this.drawEquationText(
      canvas,
      bracket,
      x - width / 2,
      y + height * 0.7,
      Math.max(height, fontSize),
      color,
      false,
      false,
      width,
      true,
      fontName,
    );
  }

  private drawEquationDecoration(
    canvas: SkCanvas,
    decoration: string,
    centerX: number,
    y: number,
    width: number,
    color: string,
    fontSize: number,
  ): boolean {
    const halfWidth = width / 2;
    const strokeWidth = Math.max(fontSize * 0.03, 0.5);
    switch (decoration) {
      case 'hat':
        return this.drawEquationLine(canvas, centerX - halfWidth * 0.6, y + fontSize * 0.15, centerX, y, color, strokeWidth)
          && this.drawEquationLine(canvas, centerX, y, centerX + halfWidth * 0.6, y + fontSize * 0.15, color, strokeWidth);
      case 'bar':
      case 'overline':
        return this.drawEquationLine(canvas, centerX - halfWidth, y + fontSize * 0.05, centerX + halfWidth, y + fontSize * 0.05, color, strokeWidth);
      case 'strikeThrough':
        return this.drawEquationLine(canvas, centerX - halfWidth, y + fontSize * 1.14,
          centerX + halfWidth, y + fontSize * 0.14, color, strokeWidth);
      case 'underline':
      case 'under':
        return this.drawEquationLine(canvas, centerX - halfWidth, y + fontSize * 1.1, centerX + halfWidth, y + fontSize * 1.1, color, strokeWidth);
      case 'vec':
      case 'dyad': {
        const lineY = y + fontSize * 0.05;
        const endX = centerX + halfWidth;
        return this.drawEquationLine(canvas, centerX - halfWidth, lineY, endX, lineY, color, strokeWidth)
          && this.drawEquationLine(canvas, endX - fontSize * 0.1, lineY - fontSize * 0.06, endX, lineY, color, strokeWidth)
          && this.drawEquationLine(canvas, endX, lineY, endX - fontSize * 0.1, lineY + fontSize * 0.06, color, strokeWidth);
      }
      case 'dot':
      case 'dDot': {
        const paint = this.makeFillPaint(color);
        const radius = Math.max(fontSize * 0.03, 1);
        try {
          if (decoration === 'dot') {
            canvas.drawCircle(centerX, y + fontSize * 0.06, radius, paint);
          } else {
            canvas.drawCircle(centerX - fontSize * 0.1, y + fontSize * 0.06, radius, paint);
            canvas.drawCircle(centerX + fontSize * 0.1, y + fontSize * 0.06, radius, paint);
          }
          return true;
        } finally {
          paint.delete?.();
        }
      }
      default:
        return false;
    }
  }

  private renderFormObject(canvas: SkCanvas, op: LayerFormObjectOp): void {
    if (op.formType?.toLowerCase() === 'checkbox') {
      const b = op.bbox;
      const size = Math.min(b.width, b.height, 14);
      if (size <= 0) return;
      const box = { x: b.x + 2, y: b.y + (b.height - size) / 2, width: size, height: size };
      this.drawStyledShape(canvas, box, {
        fillColor: op.backColor ?? '#f0f0f0', strokeColor: '#a0a0a0', strokeWidth: 1,
      }, paint => canvas.drawRect(this.rect(box), paint));
      if (op.value) {
        const paint = this.makeStrokePaint(op.foreColor ?? '#000000', 2);
        paint.setStrokeCap(this.canvasKit.StrokeCap.Round);
        try {
          canvas.drawLine(box.x + size * 0.2, box.y + size * 0.55,
            box.x + size * 0.4, box.y + size * 0.75, paint);
          canvas.drawLine(box.x + size * 0.4, box.y + size * 0.75,
            box.x + size * 0.8, box.y + size * 0.25, paint);
        } finally { paint.delete(); }
      }
      if (op.caption) {
        const fontSize = Math.max(8, Math.min(13, b.height * 0.6));
        this.renderTextRun(canvas, {
          type: 'textRun', bbox: { ...b, x: box.x + size + 4 }, text: op.caption,
          baseline: b.height / 2 + fontSize * 0.35,
          style: { fontSize, color: op.foreColor ?? '#000000' },
        });
      }
      return;
    }
    const fill = op.backColor && op.backColor !== '#000000' ? op.backColor : '#f7f7f7';
    this.drawStyledShape(canvas, op.bbox, {
      fillColor: fill,
      strokeColor: op.foreColor ?? '#555555',
      strokeWidth: 1,
      opacity: op.enabled === false ? 0.55 : 1,
    }, (paint) => canvas.drawRect(this.rect(op.bbox), paint));
    if (op.value && (
      op.formType === 'checkBox'
      || op.formType === 'radioButton'
      || op.formType === 'checkbox'
      || op.formType === 'radio'
    )) {
      const paint = this.makeStrokePaint(op.foreColor ?? '#111111', 1.5);
      const b = op.bbox;
      canvas.drawLine(b.x + b.width * 0.25, b.y + b.height * 0.55, b.x + b.width * 0.45, b.y + b.height * 0.75, paint);
      canvas.drawLine(b.x + b.width * 0.45, b.y + b.height * 0.75, b.x + b.width * 0.78, b.y + b.height * 0.28, paint);
      paint.delete?.();
    }
    const label = op.caption || op.text;
    if (label) {
      this.renderTextRun(canvas, {
        type: 'textRun',
        bbox: { ...op.bbox, x: op.bbox.x + 4, width: Math.max(0, op.bbox.width - 8) },
        text: label,
        baseline: Math.max(10, op.bbox.height * 0.68),
        style: { fontSize: Math.max(9, Math.min(14, op.bbox.height * 0.55)), color: op.foreColor ?? '#111111' },
      });
    }
  }

  private renderPlaceholder(canvas: SkCanvas, op: LayerPlaceholderOp, profile: LayerRenderProfile): void {
    if (op.kind === 'missingPicture') {
      if (profile === 'print' || profile === 'highQuality') return;
      if (![op.bbox.x, op.bbox.y, op.bbox.width, op.bbox.height].every(Number.isFinite)
        || op.bbox.width <= 0 || op.bbox.height <= 0) return;
      const paint = this.makeStrokePaint(op.strokeColor ?? '#999999', 1);
      const dash = 5;
      const gap = 3;
      const horizontalStep = Math.max(
        dash + gap,
        op.bbox.width / CanvasKitLayerRenderer.MAX_PLACEHOLDER_DASH_SEGMENTS_PER_AXIS,
      );
      const verticalStep = Math.max(
        dash + gap,
        op.bbox.height / CanvasKitLayerRenderer.MAX_PLACEHOLDER_DASH_SEGMENTS_PER_AXIS,
      );
      try {
        for (let x = op.bbox.x; x < op.bbox.x + op.bbox.width; x += horizontalStep) {
          const end = Math.min(x + horizontalStep * dash / (dash + gap), op.bbox.x + op.bbox.width);
          canvas.drawLine(x, op.bbox.y, end, op.bbox.y, paint);
          canvas.drawLine(x, op.bbox.y + op.bbox.height, end, op.bbox.y + op.bbox.height, paint);
        }
        for (let y = op.bbox.y; y < op.bbox.y + op.bbox.height; y += verticalStep) {
          const end = Math.min(y + verticalStep * dash / (dash + gap), op.bbox.y + op.bbox.height);
          canvas.drawLine(op.bbox.x, y, op.bbox.x, end, paint);
          canvas.drawLine(op.bbox.x + op.bbox.width, y, op.bbox.x + op.bbox.width, end, paint);
        }
      } finally {
        paint.delete?.();
      }
      const icon = Math.max(14, Math.min(36, Math.min(op.bbox.width, op.bbox.height) * 0.4));
      const ix = op.bbox.x + (op.bbox.width - icon) / 2;
      const iy = op.bbox.y + (op.bbox.height - icon * 0.75) / 2;
      const iconBounds = this.canvasKit.XYWHRect(ix, iy, icon, icon * 0.75);
      let iconFill: SkPaint | null = null;
      let iconStroke: SkPaint | null = null;
      let missingStroke: SkPaint | null = null;
      try {
        iconFill = this.makeFillPaint('#ffffff');
        iconStroke = this.makeStrokePaint('#888888', 1);
        missingStroke = this.makeStrokePaint('#cc4444', 1.5);
        canvas.drawRect(iconBounds, iconFill);
        canvas.drawRect(iconBounds, iconStroke);
        canvas.drawLine(ix + icon * 0.08, iy + icon * 0.62, ix + icon * 0.32, iy + icon * 0.30, iconStroke);
        canvas.drawLine(ix + icon * 0.32, iy + icon * 0.30, ix + icon * 0.52, iy + icon * 0.62, iconStroke);
        canvas.drawLine(ix + icon * 0.52, iy + icon * 0.62, ix + icon * 0.68, iy + icon * 0.42, iconStroke);
        canvas.drawLine(ix + icon * 0.68, iy + icon * 0.42, ix + icon * 0.92, iy + icon * 0.62, iconStroke);
        canvas.drawCircle(ix + icon * 0.72, iy + icon * 0.20, icon * 0.07, iconStroke);
        canvas.drawLine(ix, iy + icon * 0.75, ix + icon, iy, missingStroke);
      } finally {
        missingStroke?.delete?.();
        iconStroke?.delete?.();
        iconFill?.delete?.();
      }
      return;
    }
    this.drawStyledShape(canvas, op.bbox, {
      fillColor: op.fillColor ?? '#f2f2f2',
      strokeColor: op.strokeColor ?? '#999999',
      strokeWidth: 1,
    }, (paint) => canvas.drawRect(this.rect(op.bbox), paint));
    if (op.label) {
      this.renderTextRun(canvas, {
        type: 'textRun',
        bbox: { ...op.bbox, x: op.bbox.x + 4 },
        text: op.label,
        baseline: Math.max(10, op.bbox.height * 0.65),
        style: { fontSize: Math.max(9, Math.min(14, op.bbox.height * 0.45)), color: '#555555' },
      });
    }
  }

  private drawStyledShape(
    canvas: SkCanvas,
    bounds: LayerBounds,
    style: LayerShapeStyle | undefined,
    draw: (paint: SkPaint) => void,
    gradient?: LayerGradientFill,
    strokeOverride?: { strokeWidth: number; draw: (paint: SkPaint) => void },
  ): void {
    const gradientDrawn = gradient
      ? this.drawShapeGradient(canvas, bounds, gradient, style?.opacity ?? 1, draw)
      : false;
    if (!gradientDrawn && style?.fillColor) {
      const paint = this.makeFillPaint(style.fillColor, style.opacity);
      draw(paint);
      paint.delete?.();
    }
    if (style?.strokeColor && (style.strokeWidth ?? 0) > 0) {
      const paint = this.makeStrokePaint(style.strokeColor, strokeOverride?.strokeWidth ?? style.strokeWidth ?? 1, style.opacity, style.strokeDash);
      (strokeOverride?.draw ?? draw)(paint);
      paint.delete?.();
    }
    if (!style && !gradient) {
      const paint = this.makeStrokePaint('#000000', 1);
      draw(paint);
      paint.delete?.();
    }
  }

  private pixelAlignedHairline(position: number, strokeWidth: number): { center: number; strokeWidth: number } | null {
    const scale = this.currentRenderScale;
    // 정밀 화면에서는 원래 선폭과 좌표를 유지하고, 빠른 미리보기만 픽셀에 맞춘다.
    if (this.currentRenderProfile !== 'fastPreview') return null;
    if (![position, strokeWidth, scale].every(Number.isFinite)
      || strokeWidth <= 0 || scale <= 0 || strokeWidth * scale > 1 + 1e-9) return null;
    return { center: (Math.round(position * scale) + 0.5) / scale, strokeWidth: 1 / scale };
  }

  private pixelAlignedHairlineRect(
    bounds: LayerBounds,
    strokeWidth: number,
  ): { bounds: LayerBounds; strokeWidth: number } | null {
    const scale = this.currentRenderScale;
    if (bounds.width * scale < 2 || bounds.height * scale < 2) return null;
    const left = this.pixelAlignedHairline(bounds.x, strokeWidth);
    const top = this.pixelAlignedHairline(bounds.y, strokeWidth);
    const right = this.pixelAlignedHairline(bounds.x + bounds.width, strokeWidth);
    const bottom = this.pixelAlignedHairline(bounds.y + bounds.height, strokeWidth);
    if (!left || !top || !right || !bottom) return null;
    return {
      bounds: { x: left.center, y: top.center, width: right.center - left.center, height: bottom.center - top.center },
      strokeWidth: left.strokeWidth,
    };
  }

  private drawStyledPath(
    canvas: SkCanvas,
    path: Path,
    style: LayerShapeStyle,
    gradient?: LayerGradientFill,
    bounds?: LayerBounds,
  ): void {
    const gradientDrawn = gradient && bounds
      ? this.drawShapeGradient(canvas, bounds, gradient, style.opacity ?? 1, (paint) => canvas.drawPath(path, paint))
      : false;
    if (!gradientDrawn && style.fillColor) {
      const paint = this.makeFillPaint(style.fillColor, style.opacity);
      canvas.drawPath(path, paint);
      paint.delete?.();
    }
    if (style.strokeColor && (style.strokeWidth ?? 0) > 0) {
      const paint = this.makeStrokePaint(style.strokeColor, style.strokeWidth ?? 1, style.opacity, style.strokeDash);
      canvas.drawPath(path, paint);
      paint.delete?.();
    }
  }

  private drawShapeGradient(
    canvas: SkCanvas,
    bounds: LayerBounds,
    gradient: LayerGradientFill,
    opacity: number,
    draw: (paint: SkPaint) => void,
  ): boolean {
    const shader = this.makeShapeGradientShader(gradient, bounds, opacity);
    if (!shader) {
      if (gradient.colors.length >= 2
        && [bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite)
        && bounds.width > 0 && bounds.height > 0) {
        this.unsupportedOps.add('shapeGradient:shaderUnavailable');
      }
      return false;
    }
    const paint = new this.canvasKit.Paint();
    try {
      paint.setAntiAlias?.(true);
      paint.setStyle(this.canvasKit.PaintStyle.Fill);
      (paint as unknown as { setShader: (shader: unknown) => void }).setShader(shader);
      draw(paint);
      return true;
    } finally {
      paint.delete?.();
      (shader as { delete?: () => void }).delete?.();
    }
  }

  private makeShapeGradientShader(
    gradient: LayerGradientFill,
    bounds: LayerBounds,
    opacity: number,
  ): unknown | null {
    if (gradient.colors.length < 2
      || ![bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite)
      || bounds.width <= 0 || bounds.height <= 0) return null;
    let colors = gradient.colors.map((color) => this.color(color, opacity));
    let positions = gradient.colors.map((_, index) =>
      gradient.positions[index] ?? index / (gradient.colors.length - 1));
    const shaderApi = this.canvasKit.Shader as unknown as {
      MakeLinearGradient?: (...args: unknown[]) => unknown;
      MakeRadialGradient?: (...args: unknown[]) => unknown;
      MakeSweepGradient?: (...args: unknown[]) => unknown;
    };
    try {
      if (gradient.gradientType === 3) {
        return shaderApi.MakeSweepGradient?.(
          bounds.x + bounds.width * gradient.centerX / 100,
          bounds.y + bounds.height * gradient.centerY / 100,
          colors, positions, this.canvasKit.TileMode.Clamp,
          null, 0, -gradient.angle, 180 - gradient.angle,
        ) ?? null;
      }
      if ([2, 4].includes(gradient.gradientType)) {
        const center = [
          bounds.x + bounds.width * gradient.centerX / 100,
          bounds.y + bounds.height * gradient.centerY / 100,
        ];
        return shaderApi.MakeRadialGradient?.(
          center, Math.max(bounds.width, bounds.height) / 2,
          colors, positions, this.canvasKit.TileMode.Clamp,
        ) ?? null;
      }
      const angle = ((gradient.angle % 360) + 360) % 360;
      const { x, y, width, height } = bounds;
      const cardinal: Record<number, [number[], number[]]> = {
        0: [[x, y], [x, y + height]],
        45: [[x, y], [x + width, y + height]],
        90: [[x, y], [x + width, y]],
        135: [[x, y + height], [x + width, y]],
        180: [[x, y + height], [x, y]],
        225: [[x + width, y + height], [x, y]],
        270: [[x + width, y], [x, y]],
        315: [[x + width, y], [x, y + height]],
      };
      const radians = angle * Math.PI / 180;
      if (gradient.gradientType === 1 && colors.length === 2
        && gradient.positions.length === 2 && gradient.positions[0] === 0 && gradient.positions[1] === 1) {
        const dx = Math.sin(radians) * width, dy = Math.cos(radians) * height;
        const distanceSquared = dx * dx + dy * dy;
        if (distanceSquared > 0) {
          const center = Math.fround(Math.max(0, Math.min(1, 0.5
            + ((gradient.centerX / 100 - 0.5) * width * dx
              + (gradient.centerY / 100 - 0.5) * height * dy) / distanceSquared)));
          if (center > 0 && center < 1) {
            colors = [colors[1], colors[0], colors[1]];
            positions = [0, center, 1];
          } else if (center >= 1) {
            colors.reverse();
          }
        }
      }
      const centerX = bounds.x + bounds.width / 2;
      const centerY = bounds.y + bounds.height / 2;
      const [start, end] = cardinal[angle] ?? [
        [centerX - Math.sin(radians) * bounds.width / 2, centerY - Math.cos(radians) * bounds.height / 2],
        [centerX + Math.sin(radians) * bounds.width / 2, centerY + Math.cos(radians) * bounds.height / 2],
      ];
      return shaderApi.MakeLinearGradient?.(
        start,
        end,
        colors, positions, this.canvasKit.TileMode.Clamp,
      ) ?? null;
    } catch {
      return null;
    }
  }

  private imageForOp(op: LayerImageOp): SkImage | null {
    const base64 = op.base64 ?? '';
    if (!base64 || base64.length > CanvasKitLayerRenderer.MAX_ENCODED_IMAGE_BASE64_LENGTH) {
      return null;
    }
    const key = canvasKitImageCacheKey(op);
    if (!key) return null;
    const cached = this.imageCache.get(key);
    if (cached) {
      this.imageCache.delete(key);
      this.imageCache.set(key, cached);
      this.imageCacheHits += 1;
      return cached.image;
    }
    if (this.imageDecodeFailures.has(key)) {
      this.imageCacheHits += 1;
      return null;
    }
    this.imageCacheMisses += 1;
    let bytes: Uint8Array;
    try {
      bytes = base64ToBytes(base64);
    } catch {
      this.rememberImageDecodeFailure(key);
      return null;
    }
    const encodedDimensions = encodedImageDimensions(bytes);
    if (!encodedDimensions) {
      this.rememberImageDecodeFailure(key);
      return null;
    }
    const encodedPixels = encodedDimensions.width * encodedDimensions.height;
    if (!Number.isSafeInteger(encodedPixels)
      || encodedPixels > CanvasKitLayerRenderer.MAX_DECODED_IMAGE_PIXELS) {
      this.rememberImageDecodeFailure(key);
      return null;
    }
    let image: SkImage | null = null;
    try {
      image = this.canvasKit.MakeImageFromEncoded(bytes);
    } catch {
      this.rememberImageDecodeFailure(key);
      return null;
    }
    if (!image) {
      this.rememberImageDecodeFailure(key);
      return null;
    }
    const imageWithDimensions = image as SkImage & { width?: (() => number) | number; height?: (() => number) | number };
    const width = typeof imageWithDimensions.width === 'function' ? imageWithDimensions.width() : imageWithDimensions.width;
    const height = typeof imageWithDimensions.height === 'function' ? imageWithDimensions.height() : imageWithDimensions.height;
    const decodedPixels = typeof width === 'number' && typeof height === 'number'
      ? width * height
      : Number.POSITIVE_INFINITY;
    if (!Number.isSafeInteger(decodedPixels)
      || width !== encodedDimensions.width
      || height !== encodedDimensions.height
      || decodedPixels > CanvasKitLayerRenderer.MAX_DECODED_IMAGE_PIXELS) {
      image.delete?.();
      this.rememberImageDecodeFailure(key);
      return null;
    }
    this.cacheImage(key, image, decodedPixels);
    return image;
  }

  private cacheImage(key: string, image: SkImage, decodedPixels: number): void {
    while (this.imageCache.size >= CanvasKitLayerRenderer.MAX_IMAGE_CACHE_ENTRIES
      || this.imageCachePixels + decodedPixels > CanvasKitLayerRenderer.MAX_IMAGE_CACHE_PIXELS) {
      const oldestKey = this.imageCache.keys().next().value as string | undefined;
      if (oldestKey === undefined) break;
      const oldest = this.imageCache.get(oldestKey);
      oldest?.image.delete?.();
      this.imageCache.delete(oldestKey);
      this.imageCachePixels = Math.max(0, this.imageCachePixels - (oldest?.pixels ?? 0));
      this.imageCacheEvictions += 1;
    }
    this.imageCache.set(key, { image, pixels: decodedPixels });
    this.imageCachePixels += decodedPixels;
  }

  private rememberImageDecodeFailure(key: string): void {
    if (this.imageDecodeFailures.size >= CanvasKitLayerRenderer.MAX_IMAGE_FAILURE_CACHE_ENTRIES) {
      const oldestKey = this.imageDecodeFailures.values().next().value as string | undefined;
      if (oldestKey !== undefined) this.imageDecodeFailures.delete(oldestKey);
    }
    this.imageDecodeFailures.add(key);
  }

  private makeFillPaint(color: string, opacity = 1): SkPaint {
    const paint = new this.canvasKit.Paint();
    paint.setAntiAlias?.(true);
    paint.setStyle(this.canvasKit.PaintStyle.Fill);
    paint.setColor(this.color(color, opacity));
    return paint;
  }

  private makeStrokePaint(color: string, width: number, opacity = 1, dash?: string): SkPaint {
    const paint = new this.canvasKit.Paint();
    paint.setAntiAlias?.(true);
    paint.setStyle(this.canvasKit.PaintStyle.Stroke);
    paint.setStrokeWidth(Math.max(0.1, width));
    paint.setColor(this.color(color, opacity));
    const scale = Math.max(width, 1);
    const dotWidth = Math.max(width, 0.2);
    const intervals = dash === 'dot' ? [dotWidth * 4 / 3, dotWidth * 2]
      : dash === 'dash' ? [6 * scale, 3 * scale]
      : dash === 'longDash' ? [10 * scale, 3 * scale]
      : dash === 'circle' ? [0.1 * scale, 3 * scale]
      : dash === 'dashDot' ? [6 * scale, 3 * scale, 2 * scale, 3 * scale]
      : dash === 'dashDotDot' ? [6 * scale, 3 * scale, 2 * scale, 3 * scale, 2 * scale, 3 * scale]
      : null;
    if (intervals) {
      if (dash === 'circle') paint.setStrokeCap(this.canvasKit.StrokeCap.Round);
      const effect = this.canvasKit.PathEffect.MakeDash(intervals, 0);
      if (effect) {
        paint.setPathEffect(effect);
        effect.delete?.();
      }
    }
    return paint;
  }

  private rect(bounds: LayerBounds): Rect {
    return this.canvasKit.XYWHRect(bounds.x, bounds.y, bounds.width, bounds.height);
  }

  private color(cssColor: string, opacity = 1): Color {
    const { r, g, b, a } = parseCssColor(cssColor);
    const alpha = Math.max(0, Math.min(1, a * opacity));
    return this.canvasKit.Color(r, g, b, alpha);
  }
}

function parseCssColor(value: string): { r: number; g: number; b: number; a: number } {
  const trimmed = value.trim();
  if (trimmed === 'transparent') {
    return { r: 0, g: 0, b: 0, a: 0 };
  }
  if (trimmed === 'black') {
    return { r: 0, g: 0, b: 0, a: 1 };
  }
  if (trimmed === 'white') {
    return { r: 255, g: 255, b: 255, a: 1 };
  }
  const shortHex = /^#?([0-9a-f]{3,4})$/i.exec(trimmed);
  if (shortHex) {
    const value = shortHex[1];
    return {
      r: Number.parseInt(value[0] + value[0], 16),
      g: Number.parseInt(value[1] + value[1], 16),
      b: Number.parseInt(value[2] + value[2], 16),
      a: value.length === 4 ? Number.parseInt(value[3] + value[3], 16) / 255 : 1,
    };
  }
  const hexWithAlpha = /^#?([0-9a-f]{8})$/i.exec(trimmed);
  if (hexWithAlpha) {
    const n = Number.parseInt(hexWithAlpha[1], 16);
    return {
      r: (n >> 24) & 0xff,
      g: (n >> 16) & 0xff,
      b: (n >> 8) & 0xff,
      a: (n & 0xff) / 255,
    };
  }
  const hex = /^#?([0-9a-f]{6})$/i.exec(trimmed);
  if (hex) {
    const n = Number.parseInt(hex[1], 16);
    return {
      r: (n >> 16) & 0xff,
      g: (n >> 8) & 0xff,
      b: n & 0xff,
      a: 1,
    };
  }
  const rgb = /^rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([0-9.]+))?\)$/i.exec(trimmed);
  if (rgb) {
    return {
      r: Number(rgb[1]),
      g: Number(rgb[2]),
      b: Number(rgb[3]),
      a: rgb[4] === undefined ? 1 : Number(rgb[4]),
    };
  }
  return { r: 0, g: 0, b: 0, a: 1 };
}

function clampUnit(value: number | undefined): number {
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value ?? 0 : 0));
}

function gradientColors(stops: Array<{ color?: { rgba?: number[] } }> | undefined): number[][] {
  return (stops ?? []).map((stop) => {
    const rgba = stop.color?.rgba ?? [0, 0, 0, 1];
    return [
      clampUnit(rgba[0]),
      clampUnit(rgba[1]),
      clampUnit(rgba[2]),
      clampUnit(rgba[3]),
    ];
  });
}

function gradientPositions(stops: Array<{ offset?: number }> | undefined): number[] {
  return (stops ?? []).map((stop) => Math.max(0, Math.min(1, stop.offset ?? 0)));
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}
