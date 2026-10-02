// Remaining architecture and asset guards; behavioral replay runs independently.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { PNG } from 'pngjs';
import { blake3 } from '@noble/hashes/blake3.js';
import { bytesToHex } from '@noble/hashes/utils.js';

import { comparePngBuffers } from '../helpers.mjs';

const studioRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const repoRoot = path.resolve(studioRoot, '..');
const canvaskitPath = path.join(studioRoot, 'src/view/canvaskit-renderer.ts');
const canvaskitDirectory = path.join(studioRoot, 'src/view/canvaskit');
const canvaskitDiagnosticsPath = path.join(canvaskitDirectory, 'diagnostics.ts');
const layerTypesPath = path.join(studioRoot, 'src/core/types.ts');
const rendererBaselinePath = path.join(studioRoot, 'e2e/renderer-baseline.mjs');
const rendererBaselineNativeDiffPath = path.join(
  studioRoot,
  'e2e/renderer-baseline-native-diff.mjs',
);
const rendererBaselineDriverPath = path.join(repoRoot, 'scripts/renderer_baseline.py');
const rendererBaselineManifestPath = path.join(repoRoot, 'scripts/renderer_baseline_manifest.json');
const helpersPath = path.join(studioRoot, 'e2e/helpers.mjs');
const mainPath = path.join(studioRoot, 'src/main.ts');
const embedRpcRouterPath = path.join(studioRoot, 'src/embed/rpc-router.ts');
const renderBackendPath = path.join(studioRoot, 'src/view/render-backend.ts');
const rendererSessionPath = path.join(studioRoot, 'src/view/renderer-session.ts');
const pageRendererPath = path.join(studioRoot, 'src/view/page-renderer.ts');
const canvasViewPath = path.join(studioRoot, 'src/view/canvas-view.ts');
const vscodeViewerPath = path.join(repoRoot, 'rhwp-vscode/src/webview/viewer.ts');
const vscodeWebpackPath = path.join(repoRoot, 'rhwp-vscode/webpack.config.js');
const renderDiffWorkflowPath = path.join(repoRoot, '../.github/workflows/render-diff.yml');
const fullRendererSweepWorkflowPath = path.join(
  repoRoot,
  '../.github/workflows/full-renderer-sweep.yml',
);

const canvaskitSource = fs.readFileSync(canvaskitPath, 'utf8');
const canvaskitDiagnosticsSource = fs.readFileSync(canvaskitDiagnosticsPath, 'utf8');
const layerTypesSource = fs.readFileSync(layerTypesPath, 'utf8');
const rendererBaselineSource = fs.readFileSync(rendererBaselinePath, 'utf8');
const rendererBaselineNativeDiffSource = fs.readFileSync(rendererBaselineNativeDiffPath, 'utf8');
const rendererBaselineDriverSource = fs.readFileSync(rendererBaselineDriverPath, 'utf8');
const rendererBaselineManifest = JSON.parse(fs.readFileSync(rendererBaselineManifestPath, 'utf8'));
const helpersSource = fs.readFileSync(helpersPath, 'utf8');
const mainSource = fs.readFileSync(mainPath, 'utf8');
const embedRpcRouterSource = fs.readFileSync(embedRpcRouterPath, 'utf8');
const renderBackendSource = fs.readFileSync(renderBackendPath, 'utf8');
const rendererSessionSource = fs.readFileSync(rendererSessionPath, 'utf8');
const pageRendererSource = fs.readFileSync(pageRendererPath, 'utf8');
const canvasViewSource = fs.readFileSync(canvasViewPath, 'utf8');
const vscodeViewerSource = fs.readFileSync(vscodeViewerPath, 'utf8');
const vscodeWebpackSource = fs.readFileSync(vscodeWebpackPath, 'utf8');



function extractBlockBody(source, signatureIndex, blockName) {
  let bodyStart = -1;
  for (let index = signatureIndex; index < source.length; index += 1) {
    if (source[index] === '{') {
      bodyStart = index;
      break;
    }
  }
  assert.notEqual(bodyStart, -1, `missing body for ${blockName}`);

  let depth = 0;
  for (let index = bodyStart; index < source.length; index += 1) {
    const char = source[index];
    if (char === '{') {
      depth += 1;
    } else if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        return source.slice(bodyStart + 1, index);
      }
    }
  }

  throw new Error(`unterminated body for ${blockName}`);
}

function extractMethodBody(source, methodName) {
  let signatureIndex = source.indexOf(`private ${methodName}(`);
  if (signatureIndex === -1) {
    signatureIndex = source.indexOf(`${methodName}(`);
  }
  assert.notEqual(signatureIndex, -1, `missing method ${methodName}`);

  return extractBlockBody(source, signatureIndex, methodName);
}

function extractSwitchCaseClusterBody(methodBody, caseLabel) {
  const casePattern = new RegExp(`^\\s*case '${caseLabel}':`, 'm');
  const caseMatch = methodBody.match(casePattern);
  assert.notEqual(caseMatch, null, `missing switch case ${caseLabel}`);

  const startIndex = caseMatch.index;
  let cursor = startIndex + caseMatch[0].length;
  const labelPattern = /^\s*(case\s+'[^']+':|default:)/gm;
  labelPattern.lastIndex = cursor;
  for (
    let match = labelPattern.exec(methodBody);
    match !== null;
    match = labelPattern.exec(methodBody)
  ) {
    const betweenLabels = methodBody.slice(cursor, match.index).trim();
    if (betweenLabels !== '') {
      return methodBody.slice(startIndex, match.index);
    }
    cursor = match.index + match[0].length;
  }

  return methodBody.slice(startIndex);
}

function caseLabels(methodBody) {
  return [...methodBody.matchAll(/case\s+'([^']+)':/g)].map((match) => match[1]);
}

function tsFilesUnder(directory) {
  return fs.readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        return tsFilesUnder(entryPath);
      }
      return entry.name.endsWith('.ts') ? [entryPath] : [];
    })
    .sort();
}

function layerPaintOpTypes() {
  const unionMatch = layerTypesSource.match(/export type LayerPaintOp =([\s\S]*?);/);
  assert.notEqual(unionMatch, null, 'missing LayerPaintOp union');
  const interfaceNames = [...unionMatch[1].matchAll(/\|\s*(Layer[A-Za-z0-9]+Op)\b/g)]
    .map((match) => match[1]);
  assert.ok(interfaceNames.length > 0, 'LayerPaintOp union has no variants');

  return interfaceNames.map((interfaceName) => {
    const interfacePattern = new RegExp(`export interface ${interfaceName} \\{[\\s\\S]*?type:\\s*'([^']+)'`);
    const interfaceMatch = layerTypesSource.match(interfacePattern);
    assert.notEqual(interfaceMatch, null, `missing literal type for ${interfaceName}`);
    return interfaceMatch[1];
  }).sort();
}

function layerNodeKinds() {
  const unionMatch = layerTypesSource.match(/export type LayerNode =([\s\S]*?);/);
  assert.notEqual(unionMatch, null, 'missing LayerNode union');
  const interfaceNames = unionMatch[1].split('|')
    .map((item) => item.trim().replace(/;$/, ''))
    .filter(Boolean);
  assert.ok(interfaceNames.length > 0, 'LayerNode union has no variants');

  return interfaceNames.map((interfaceName) => {
    const interfacePattern = new RegExp(`export interface ${interfaceName} \\{[\\s\\S]*?kind:\\s*'([^']+)'`);
    const interfaceMatch = layerTypesSource.match(interfacePattern);
    assert.notEqual(interfaceMatch, null, `missing kind literal for ${interfaceName}`);
    return interfaceMatch[1];
  }).sort();
}

function requireSnippet(source, pattern, message) {
  assert.match(source, pattern, message);
}

const renderOpBody = extractMethodBody(canvaskitSource, 'renderOp');
const renderNodeBody = extractMethodBody(canvaskitSource, 'renderNode');
const diagnosticsBody = extractMethodBody(canvaskitSource, 'diagnostics');
const makeSurfaceBody = extractMethodBody(canvaskitSource, 'makeSurface');
const renderPageCanvasKitBody = extractMethodBody(pageRendererSource, 'renderPageCanvasKit');
const renderOpCases = caseLabels(renderOpBody).sort();
const layerOpTypes = layerPaintOpTypes();
const layerNodeKindSet = layerNodeKinds();
const canvaskitSourceFiles = [
  { label: path.relative(studioRoot, canvaskitPath), source: canvaskitSource },
  ...tsFilesUnder(canvaskitDirectory).map((filePath) => ({
    label: path.relative(studioRoot, filePath),
    source: fs.readFileSync(filePath, 'utf8'),
  })),
];
const forbiddenCanvas2dApiPatterns = [
  [/document\s*\.\s*createElement\b/, 'document.createElement'],
  [/\.getContext\s*\(/, 'HTMLCanvasElement.getContext'],
  [/\bCanvasRenderingContext2D\b/, 'CanvasRenderingContext2D'],
  [/\bPath2D\b/, 'Path2D'],
  [/\.measureText\s*\(/, 'CanvasRenderingContext2D.measureText'],
  [/\bOffscreenCanvas\b/, 'OffscreenCanvas'],
  [/\bImageData\b/, 'ImageData'],
  [/\bcreateImageBitmap\s*\(/, 'createImageBitmap'],
  [/\bImageBitmap\b/, 'ImageBitmap'],
  [/\bHTMLImageElement\b/, 'HTMLImageElement'],
  [/\bnew\s+Image\s*\(/, 'new Image'],
  [/\bDOMParser\b/, 'DOMParser'],
  [/\bXMLSerializer\b/, 'XMLSerializer'],
  [/\bURL\s*\.\s*createObjectURL\s*\(/, 'URL.createObjectURL'],
  [/\bFileReader\b/, 'FileReader'],
  [/\bCanvas2DLayerRenderer\b/, 'Canvas2DLayerRenderer'],
  [/canvas2d-layer-renderer/, 'canvas2d-layer-renderer import'],
];
const expectedUnsupportedSetMatch = canvaskitDiagnosticsSource.match(
  /const EXPECTED_CANVASKIT_UNSUPPORTED_OPS = new Set\(\[([\s\S]*?)\]\);/,
);
assert.notEqual(expectedUnsupportedSetMatch, null, 'missing CanvasKit expected unsupported op set');
const expectedUnsupportedSetBody = expectedUnsupportedSetMatch[1];
const expectedUnsupportedFunctionMatch = canvaskitDiagnosticsSource.match(
  /export function isExpectedCanvasKitUnsupportedOp\(op: string\): boolean \{([\s\S]*?)\n\}/,
);
assert.notEqual(expectedUnsupportedFunctionMatch, null, 'missing CanvasKit expected unsupported helper');
const expectedUnsupportedBody = expectedUnsupportedFunctionMatch[1];

assert.deepEqual(
  renderOpCases,
  layerOpTypes,
  'CanvasKit renderOp must explicitly mention every LayerPaintOp variant',
);
for (const sample of rendererBaselineManifest.samples.filter(
  (entry) => entry.canvaskitReadinessGate === true,
)) {
  assert.deepEqual(
    Object.keys(sample.canvaskitPerformanceBudget ?? {}).sort(),
    [
      'maxColdDocumentLoadAndInitialRenderMs',
      'maxImageCachePixels',
      'maxWarmRendererDurationMs',
      'maxWarmReplayMs',
    ],
    `readiness sample ${sample.id} should define the complete cold/warm performance budget`,
  );
}
assert.deepEqual(
  layerNodeKindSet,
  ['clipRect', 'group', 'leaf'],
  'renderer contract guard should know every LayerNode kind',
);

requireSnippet(
  renderNodeBody,
  /node\.kind === 'group'[\s\S]*?for \(const child of node\.children\)[\s\S]*?this\.renderNode\(canvas, child,[\s\S]*?\}\s*return;/,
  'group nodes should recurse through children',
);
requireSnippet(
  renderNodeBody,
  /node\.kind === 'clipRect'[\s\S]*?this\.renderClipNode\(canvas, node,[\s\S]*?\);\s*return;/,
  'clipRect nodes should go through renderClipNode',
);
requireSnippet(
  renderNodeBody,
  /this\.renderLeaf\(canvas, node, profile, replayPlane, activeLayer\);/,
  'leaf nodes should go through renderLeaf',
);
requireSnippet(
  diagnosticsBody,
  /const lastUnsupportedOps = \[\.\.\.this\.unsupportedOps\]\.sort\(\);[\s\S]*?const lastExpectedUnsupportedOps = lastUnsupportedOps\.filter\(isExpectedCanvasKitUnsupportedOp\);[\s\S]*?const lastUnexpectedUnsupportedOps = lastUnsupportedOps\.filter\([\s\S]*?!isExpectedCanvasKitUnsupportedOp\(op\)/,
  'CanvasKit diagnostics should split expected and unexpected unsupported operations',
);
requireSnippet(
  expectedUnsupportedBody,
  /return EXPECTED_CANVASKIT_UNSUPPORTED_OPS\.has\(op\);/,
  'CanvasKit expected unsupported helper should use exact diagnostics only',
);
assert.doesNotMatch(
  canvaskitDiagnosticsSource,
  /startsWith\(/,
  'CanvasKit readiness classification must not hide future diagnostic suffixes behind prefixes',
);
requireSnippet(
  diagnosticsBody,
  /if \(!this\.lastRenderCompleted\) readinessBlockers\.push\('renderNotCompleted'\);[\s\S]*?if \(this\.lastRenderError !== null\) readinessBlockers\.push\('renderError'\);[\s\S]*?if \(lastUnexpectedUnsupportedOps\.length > 0\) readinessBlockers\.push\('unexpectedUnsupportedOps'\);[\s\S]*?passesRuntimeReadinessGate: readinessBlockers\.length === 0/,
  'CanvasKit diagnostics should expose deterministic runtime readiness blockers',
);
requireSnippet(
  canvaskitSource,
  /this\.lastRenderCompleted = false;[\s\S]*?surface\.flush\(\);[\s\S]*?this\.lastRenderCompleted = true;/,
  'CanvasKit readiness should require a completed surface flush',
);
requireSnippet(
  makeSurfaceBody,
  /try \{[\s\S]*?MakeCanvasSurface\(targetCanvas\)[\s\S]*?this\.surfaceBackend = 'default'[\s\S]*?\} catch \{[\s\S]*?defaultSurfaceCreationFailed[\s\S]*?MakeSWCanvasSurface\(softwareCanvas\)[\s\S]*?this\.surfaceBackend = 'software'/,
  'CanvasKit auto surface creation should fall back to software after default surface exceptions',
);
requireSnippet(
  makeSurfaceBody,
  /targetCanvas\.parentElement !== originalParent[\s\S]*?this\.surfaceBackend = 'software';[\s\S]*?canvas: replacement/,
  'CanvasKit internal software fallback should expose its replacement canvas',
);
requireSnippet(
  makeSurfaceBody,
  /surfaceRequest\.preference === 'webgpu'[\s\S]*?surfaceFallbackReason = 'webgpuSurfaceUnsupported'[\s\S]*?reuseSoftwareFallbackCanvas/,
  'CanvasKit repeated software fallback should preserve the original WebGPU rejection reason',
);
requireSnippet(
  renderPageCanvasKitBody,
  /canvaskitDiagnosticsByPage\.delete\(pageIdx\);[\s\S]*?try \{[\s\S]*?getPageInfo\(pageIdx\)[\s\S]*?getPageLayerTreeObject\(pageIdx[\s\S]*?renderStarted = true;[\s\S]*?recordRenderFailure\(error, !renderStarted\)[\s\S]*?if \(!renderStarted\) throw error/,
  'CanvasKit page diagnostics should be cleared before page info or layer lowering can fail',
);
requireSnippet(
  pageRendererSource,
  /canvaskitDiagnosticsByPage = new Map<number, CanvasKitRenderDiagnostics>\(\)[\s\S]*?getCanvasKitRenderDiagnostics\(pageIdx: number\)[\s\S]*?this\.canvaskitDiagnosticsByPage\.get\(pageIdx\)[\s\S]*?this\.canvaskitDiagnosticsByPage\.set\(pageIdx, this\.canvaskitRenderer\.diagnostics\(\)\)/,
  'PageRenderer should retain CanvasKit diagnostics by page instead of global last-render state',
);
requireSnippet(
  canvasViewSource,
  /getCanvasKitRenderDiagnostics\(pageIndex: number\)[\s\S]*?this\.pageRenderer\.getCanvasKitRenderDiagnostics\(pageIndex\)/,
  'CanvasView should expose page-scoped CanvasKit diagnostics',
);
requireSnippet(
  vscodeViewerSource,
  /new RendererSession\([\s\S]*?backend: "canvas2d"[\s\S]*?import\("@\/view\/canvaskit-renderer"\)/,
  'VS Code should keep the compatibility default while retaining lazy CanvasKit infrastructure',
);
requireSnippet(
  vscodeViewerSource,
  /async function loadDocument\([\s\S]*?rendererSession\.beginDocument\(digest\)[\s\S]*?await rendererSession\.resolve\([\s\S]*?applyRendererSelection\(selection\)[\s\S]*?buildPageLayout\(\)/,
  'VS Code should resolve one backend before laying out and rendering the document',
);
requireSnippet(
  vscodeViewerSource,
  /resolveCanvasKitFontPlan[\s\S]*?transformCanvasKitPreflight[\s\S]*?withCanvasKitSurfaceBlockers[\s\S]*?prepareCanvasKitDocument[\s\S]*?prepareBundledFonts/,
  'VS Code auto selection should validate and prepare document fonts before first replay',
);
requireSnippet(
  vscodeViewerSource,
  /updateVisiblePages\(\);[\s\S]*?await Promise\.resolve\(\);[\s\S]*?const activeSelection = rendererSelection \?\? selection;[\s\S]*?renderer: activeSelection\.diagnostics/,
  'VS Code loaded diagnostics should report a first-render fallback instead of stale CanvasKit selection',
);
requireSnippet(
  vscodeViewerSource,
  /function scheduleRendererFallback\([\s\S]*?fallbackFromResourceFailure[\s\S]*?fallbackFromRuntimeFailure[\s\S]*?queueMicrotask[\s\S]*?releasePage\(pageNum\)[\s\S]*?updateVisiblePages\(\)/,
  'VS Code CanvasKit failures should trigger one whole-document Canvas2D replay',
);
requireSnippet(
  vscodeWebpackSource,
  /resourceQuery: \/url\/[\s\S]*?type: "asset\/resource"/,
  'VS Code should emit the lazily loaded CanvasKit WASM asset',
);
requireSnippet(
  vscodeWebpackSource,
  /path: path\.resolve\(__dirname, "dist", "webview"\)[\s\S]*?clean: true/,
  'VS Code webview builds should remove obsolete lazy chunks and assets',
);
requireSnippet(
  mainSource,
  /async getRendererDiagnostics\(pageIndex\)[\s\S]*?getRendererSessionDiagnostics\(\)[\s\S]*?request: rendererRuntimeRequest[\s\S]*?initialized: rendererInitialized[\s\S]*?initializationError:[\s\S]*?effectiveBackend: selection\?\.effectiveBackend[\s\S]*?backendFallbackReason:[\s\S]*?selection,[\s\S]*?getCanvasKitRenderDiagnostics\(pageIndex\)/,
  'Studio iframe API should expose backend selection and page-scoped renderer diagnostics',
);
requireSnippet(
  mainSource,
  /renderBackendRequest\.backend === 'auto'[\s\S]*?backend: 'canvas2d'[\s\S]*?backend: diagnosticsBackendRequest/,
  'Studio renderer diagnostics v1 should preserve its legacy request backend enum',
);
requireSnippet(
  rendererSessionSource,
  /beginDocument\(documentDigest: string \| null\)[\s\S]*?documentRevision \+= 1;[\s\S]*?resourceGeneration \+= 1;[\s\S]*?invalidateDocument\(\)[\s\S]*?decisionKey\(\)/,
  'RendererSession should invalidate document-scoped decisions by revision and resource generation',
);
requireSnippet(
  rendererSessionSource,
  /pinAutoMutationRevision\(\)[\s\S]*?invalidateDocument\(\)[\s\S]*?'autoRevisionPending'[\s\S]*?'canvaskitRevisionInvalidated'/,
  'Auto edits should pin an invalidated revision to Canvas2D without a synchronous document rescan',
);
requireSnippet(
  canvasViewSource,
  /scheduleAutoRendererReselection\(\)[\s\S]*?setTimeout\([\s\S]*?selectNextDocumentRevision\(\)\.then[\s\S]*?AUTO_RENDERER_RESELECTION_DELAY_MS/,
  'Auto edit revisions should coalesce one bounded capability re-evaluation after input settles',
);
requireSnippet(
  canvasViewSource,
  /prepareDocumentLoad\(\)[\s\S]*?rendererSelectionEpoch \+= 1;[\s\S]*?rendererSession\.beginDocument[\s\S]*?this\.reset\(\)/,
  'Document replacement should synchronously detach the previous renderer decision and canvases',
);
requireSnippet(
  helpersSource,
  /await window\.__canvasView\?\.loadDocument\?\.\(\)/,
  'Cold renderer timing should include preflight, lazy CanvasKit initialization, and initial replay',
);
requireSnippet(
  rendererSessionSource,
  /dispose\(\): void[\s\S]*?this\.canvaskitRenderer = null;[\s\S]*?renderer\?\.dispose\(\)/,
  'RendererSession should own and dispose the shared CanvasKit renderer',
);
assert.doesNotMatch(
  extractMethodBody(pageRendererSource, 'dispose'),
  /canvaskitRenderer\?\.dispose/,
  'PageRenderer must not dispose the RendererSession-owned CanvasKit instance',
);
requireSnippet(
  rendererSessionSource,
  /this\.request\.backend === 'auto'[\s\S]*?this\.readPreflight\(source\)[\s\S]*?!preflight\.complete \|\| preflight\.status === 'incomplete'[\s\S]*?!preflight\.eligible \|\| preflight\.status !== 'eligible'[\s\S]*?ensureCanvasKitRenderer\(\)/,
  'Auto backend selection should fail closed before lazily initializing CanvasKit',
);
requireSnippet(
  rendererSessionSource,
  /readPreflight\(source: RendererPreflightSource\)[\s\S]*?source\.getCanvasKitDocumentPreflight\([\s\S]*?preflight\.schemaVersion !== 1[\s\S]*?preflight\.mode !== this\.canvaskitMode\.mode[\s\S]*?preflight\.profile !== this\.renderProfile/,
  'RendererSession should validate the bounded document preflight contract',
);
requireSnippet(
  rendererSessionSource,
  /transformCanvasKitPreflight[\s\S]*?prepareCanvasKitDocument[\s\S]*?await this\.options\.prepareCanvasKitDocument\(renderer, preflight\)[\s\S]*?'canvaskitResourcePreparationFailed'/,
  'RendererSession should apply surface capability blockers before initialization and prepare resources before selection',
);
requireSnippet(
  rendererSessionSource,
  /invalidateDocument\(options:[\s\S]*?resetResources[\s\S]*?this\.canvaskitRenderer\?\.resetDocumentResources\(\)[\s\S]*?this\.decisionKey\(\) !== key[\s\S]*?'superseded'/,
  'RendererSession should cancel stale resource preparation and reset native resources on document mutations',
);
requireSnippet(
  canvaskitSource,
  /catch \(error\) \{[\s\S]*?!this\.disposed && generation === this\.documentGeneration[\s\S]*?this\.bundledTypefaceLoadFailures\.add\(source\.url\)/,
  'Document replacement cancellation must not poison the next CanvasKit font preparation attempt',
);
requireSnippet(
  rendererSessionSource,
  /fallbackFromResourceFailure\([\s\S]*?expectedDecisionKey: string[\s\S]*?'canvaskitResourcePreparationFailed'[\s\S]*?fallbackForCurrentDecision\([\s\S]*?'canvas2d'/,
  'CanvasKit resource preparation failures should pin the document to Canvas2D',
);
requireSnippet(
  rendererSessionSource,
  /fallbackFromRuntimeFailure\([\s\S]*?if \(!this\.isAutoRequest\(\)\) return null;[\s\S]*?'canvaskitRuntimeFailed'/,
  'Auto CanvasKit runtime failures should pin the document to Canvas2D without changing explicit requests',
);
requireSnippet(
  canvasViewSource,
  /activeRendererDecisionKey[\s\S]*?getCanvasKitRenderDiagnostics\(pageIdx\)[\s\S]*?!canvaskitDiagnostics\.passesRuntimeReadinessGate[\s\S]*?rendererSession\.isAutoRequest\(\)[\s\S]*?readinessBlockers\.join[\s\S]*?scheduleCanvasKitFallback\([\s\S]*?'runtime'[\s\S]*?fallbackFromRuntimeFailure\(error, expectedDecisionKey\)/,
  'CanvasView should promote failed auto CanvasKit readiness through the current document decision only',
);
requireSnippet(
  pageRendererSource,
  /invalidateDocumentRevision\(\)[\s\S]*?releaseAllPageDiagnostics\(\);[\s\S]*?layerSummaryCache\.clear\(\)/,
  'PageRenderer should drop revision-scoped diagnostics and layer summaries before replaying a new decision',
);
requireSnippet(
  renderBackendSource,
  /if \(!normalized\) return \{ backend: 'canvas2d', source: 'default' \}/,
  'Browser rendering should preserve Canvas2D unless auto is explicitly requested',
);
requireSnippet(
  rendererBaselineSource,
  /if \(options\.readinessOnly\) \{[\s\S]*?\?renderer=auto&canvaskitMode=default&renderProfile=[\s\S]*?runtime\.request\?\.backend\?\.backend !== 'canvas2d'[\s\S]*?runtime\.selection\?\.request\?\.backend !== 'auto'[\s\S]*?runtime\.selection\?\.request\?\.source !== 'url'[\s\S]*?runtime\.selection\?\.selectionReason !== 'autoEligible'[\s\S]*?autoPreflightNotEligible/,
  'Selected readiness should measure an explicit auto candidate and its preflight decision',
);
assert.doesNotMatch(
  mainSource,
  /viewOption:showParagraphMarks/,
  'Automatic selection should permit directly replayable text marks',
);
assert.match(
  mainSource,
  /viewOption:showControlCodes/,
  'Automatic selection should reject structural control markers until they have explicit ops',
);
requireSnippet(
  embedRpcRouterSource,
  /case 'getRendererDiagnostics':[\s\S]*?params\.page \?\? 0[\s\S]*?Number\.isSafeInteger\(page\)[\s\S]*?page must be a non-negative safe integer[\s\S]*?handlers\.getRendererDiagnostics\(page as number\)/,
  'Embed router should preserve renderer diagnostics and reject invalid page indexes',
);
assert.doesNotMatch(
  mainSource,
  /effectiveBackend: canvasView\?\.getRenderBackend\(\) \?\? 'canvas2d'/,
  'Studio diagnostics must not report Canvas2D when no renderer initialized',
);
requireSnippet(
  mainSource,
  /new RendererSession\([\s\S]*?async \(mode, surface\) => \{[\s\S]*?import\('\@\/view\/canvaskit-renderer'\)[\s\S]*?CanvasKitLayerRenderer\.create\(mode, surface,[\s\S]*?requirePreparedFontFamilies:[\s\S]*?transformCanvasKitPreflight[\s\S]*?prepareBundledFonts/,
  'Studio should load CanvasKit only after the renderer session selects it',
);
requireSnippet(
  canvaskitSource,
  /prepareBundledFonts\([\s\S]*?MAX_BUNDLED_FONT_BYTES[\s\S]*?bundledTypefaceAliases\.set[\s\S]*?CanvasKit font family가 준비되지 않았습니다/,
  'CanvasKit should bound bundled font parsing and reject unprepared explicit families',
);
requireSnippet(
  canvaskitSource,
  /requiresShapingManager[\s\S]*?OLD_HANGUL_FONT_FAMILY[\s\S]*?!prepared\.fontManager[\s\S]*?shaping font source 준비 실패/,
  'Old-Hangul font preparation should require a shaping-capable font manager',
);
assert.doesNotMatch(
  renderBackendSource,
  /rhwp\.renderBackend|persistRenderBackend/,
  'CanvasKit backend opt-in should stay URL-only',
);

const directReplayOps = [
  ['charOverlap', 'renderCharOverlap'],
  ['ellipse', 'renderEllipse'],
  ['equation', 'renderEquation'],
  ['footnoteMarker', 'renderTextRun'],
  ['formObject', 'renderFormObject'],
  ['image', 'renderImage'],
  ['line', 'renderLine'],
  ['pageBackground', 'renderPageBackground'],
  ['path', 'renderPath'],
  ['placeholder', 'renderPlaceholder'],
  ['rectangle', 'renderRectangle'],
  ['tabLeader', 'renderTabLeader'],
  ['textControlMark', 'renderTextControlMark'],
  ['textDecoration', 'renderTextDecoration'],
  ['textRun', 'renderTextRun'],
];
const textRunFallbackOps = [
  'glyphRun',
];
const objectFragmentFallbackOps = [
  ['rawSvg', 'rawSvg:unsupportedDirectReplay'],
];

for (const [op, renderMethod] of directReplayOps) {
  const caseBody = extractSwitchCaseClusterBody(renderOpBody, op);
  requireSnippet(
    caseBody,
    new RegExp(`this\\.${renderMethod}\\(canvas,`),
    `${op} should dispatch to a CanvasKit replay method`,
  );
  requireSnippet(caseBody, /\breturn;/, `${op} should terminate inside its own switch case`);
  assert.doesNotMatch(
    caseBody,
    /unsupportedOps\.add/,
    `${op} direct replay case should not mark the op unsupported`,
  );
}

for (const op of textRunFallbackOps) {
  const caseBody = extractSwitchCaseClusterBody(renderOpBody, op);
  requireSnippet(caseBody, new RegExp(`case '${op}':`), `${op} should remain in the fallback case group`);
  requireSnippet(
    caseBody,
    /this\.unsupportedOps\.add\(op\.type\);\s*return;/,
    `${op} should stay on the declared unsupported/TextRun fallback path`,
  );
  assert.doesNotMatch(
    caseBody,
    /this\.render[A-Za-z0-9]+\(/,
    `${op} fallback case should not direct-render before the fallback policy changes`,
  );
}

for (const [op, unsupportedReason] of objectFragmentFallbackOps) {
  const caseBody = extractSwitchCaseClusterBody(renderOpBody, op);
  requireSnippet(caseBody, new RegExp(`case '${op}':`), `${op} should have an explicit CanvasKit fallback case`);
  requireSnippet(
    caseBody,
    new RegExp(`this\\.unsupportedOps\\.add\\('${unsupportedReason}'\\);\\s*return;`),
    `${op} should report the declared direct replay gap`,
  );
  assert.doesNotMatch(
    caseBody,
    /this\.render[A-Za-z0-9]+\(/,
    `${op} fallback case should not direct-render before the fallback policy changes`,
  );
}
for (const expectedUnsupportedToken of [
  'equation:unsupportedDirectReplay',
  'rawSvg:unsupportedDirectReplay',
  'glyphRun',
  'textRunFont',
  'image:dataMissing',
  'image:invalidBounds',
  'image:dimensionUnavailable',
  'image:tileLimit',
  'glyphOutline:unsupportedColorGlyph',
  'imageEffect:grayScale',
  'textRun:verticalText',
  'textRun:scriptTextRequiresShaping',
]) {
  assert.ok(
    expectedUnsupportedSetBody.includes(`'${expectedUnsupportedToken}'`),
    `CanvasKit expected unsupported set should include ${expectedUnsupportedToken}`,
  );
}
for (const directTextVisualToken of [
  'charOverlap',
  'tabLeader',
  'textControlMark',
  'textDecoration',
  'textRun:glyphMapping',
  'textRun:textDecoration',
]) {
  assert.equal(
    expectedUnsupportedSetBody.includes(`'${directTextVisualToken}'`),
    false,
    `CanvasKit direct text visual should not stay on the expected-unsupported allowlist: ${directTextVisualToken}`,
  );
}
assert.ok(
  !expectedUnsupportedSetBody.includes("'equation:invalidLayout'"),
  'malformed semantic equation layouts should block CanvasKit readiness',
);
assert.ok(
  !expectedUnsupportedSetBody.includes("'renderPage'"),
  'CanvasKit render failures should stay unexpected readiness diagnostics',
);
assert.ok(
  !expectedUnsupportedSetBody.includes("'unknown'"),
  'CanvasKit unknown op diagnostics should stay unexpected readiness diagnostics',
);
assert.ok(
  !expectedUnsupportedSetBody.includes("'glyphOutline:replayInvariant'"),
  'CanvasKit replay invariants should stay unexpected readiness diagnostics',
);

const glyphOutlineCaseBody = extractSwitchCaseClusterBody(renderOpBody, 'glyphOutline');
requireSnippet(
  glyphOutlineCaseBody,
  /const status = glyphOutlinePayloadStatus\(op,[\s\S]*?allowBitmapGlyph: true[\s\S]*?allowSvgGlyph: true[\s\S]*?if \(status\.supported && this\.glyphOutlineVariantReplayable\(op\)\) \{[\s\S]*?this\.renderGlyphOutline\(canvas, op\);\s*return;\s*\}[\s\S]*?this\.unsupportedOps\.add\(status\.reason \? `glyphOutline:\$\{status\.reason\}` : 'glyphOutline'\);\s*return;/,
  'glyphOutline should stay guarded by payload status before direct replay',
);

const renderRectangleBody = extractMethodBody(canvaskitSource, 'renderRectangle');
const renderEllipseBody = extractMethodBody(canvaskitSource, 'renderEllipse');
const renderEquationBody = extractMethodBody(canvaskitSource, 'renderEquation');
const renderEquationBoxBody = extractMethodBody(canvaskitSource, 'renderEquationBox');
const renderPathBody = extractMethodBody(canvaskitSource, 'renderPath');
const renderLineBody = extractMethodBody(canvaskitSource, 'renderLine');
const renderFormObjectBody = extractMethodBody(canvaskitSource, 'renderFormObject');
const renderPlaceholderBody = extractMethodBody(canvaskitSource, 'renderPlaceholder');
const renderTextRunBody = extractMethodBody(canvaskitSource, 'renderTextRun');
const renderShapedScriptTextBody = extractMethodBody(canvaskitSource, 'renderShapedScriptText');
const renderGlyphOutlineBody = extractMethodBody(canvaskitSource, 'renderGlyphOutline');
const renderColorPaintGraphNodeBody = extractMethodBody(canvaskitSource, 'renderColorPaintGraphNode');
const recordTextRunCoverageGapsBody = extractMethodBody(canvaskitSource, 'recordTextRunCoverageGaps');

for (const expectedTextRunGap of [
  'textRun:verticalText',
  'textRun:outlineTextEffect',
  'textRun:shadowTextEffect',
  'textRun:embossTextEffect',
  'textRun:engraveTextEffect',
  'textRun:shadeTextEffect',
  'textRun:ratioTextEffect',
]) {
  assert.ok(
    recordTextRunCoverageGapsBody.includes(`'${expectedTextRunGap}'`),
    `textRun runtime diagnostics should include ${expectedTextRunGap}`,
  );
}
requireSnippet(
  renderGlyphOutlineBody,
  /op\.colorLayers\?\.paintGraph[\s\S]*?graph\.rootNodeId[\s\S]*?this\.renderColorPaintGraphNode/,
  'glyphOutline replay should require a colorLayers paint graph root',
);
requireSnippet(
  renderColorPaintGraphNodeBody,
  /visited\.has\(nodeId\)[\s\S]*?replayInvariant[\s\S]*?return;[\s\S]*?visited\.add\(nodeId\);/,
  'glyphOutline color graph replay should record visited nodes before recursion',
);
requireSnippet(
  renderColorPaintGraphNodeBody,
  /node\.kind === 'transform'[\s\S]*?transformNode\?\.childNodeId[\s\S]*?this\.renderColorPaintGraphNode\(canvas, nodesById, transformNode\.childNodeId, visited\)/,
  'glyphOutline color graph replay should keep transform recursion explicit',
);
requireSnippet(
  renderColorPaintGraphNodeBody,
  /node\.solidPath \?\? node\.linearGradientPath \?\? node\.radialGradientPath \?\? node\.sweepGradientPath[\s\S]*?node\.kind === 'solidPath' && node\.solidPath\?\.fill[\s\S]*?node\.kind === 'linearGradientPath' && node\.linearGradientPath\?\.gradient[\s\S]*?node\.kind === 'radialGradientPath' && node\.radialGradientPath\?\.gradient[\s\S]*?node\.kind === 'sweepGradientPath' && node\.sweepGradientPath\?\.gradient/,
  'glyphOutline color graph replay should keep cycle guard and supported path families explicit',
);

for (const { label, source } of canvaskitSourceFiles) {
  for (const [pattern, name] of forbiddenCanvas2dApiPatterns) {
    assert.doesNotMatch(
      source,
      pattern,
      `CanvasKit direct replay source ${label} must not depend on ${name}`,
    );
  }
}

assert.match(
  comparePngBuffers.toString(),
  /MAX_INK_MASK_MATCH_EDGES/,
  'ink-mask maximum matching should stop before allocating an unbounded edge graph',
);

assert.deepEqual(
  rendererBaselineManifest.samples
    .filter((sample) => sample.canvaskitReadinessGate === true)
    .map((sample) => sample.id)
    .sort(),
  [
    'font-batang-hancom',
    'font-native-bitmap',
    'image-crop',
    'paragraph-line-basic',
    'paragraph-text-marks',
    'pua-special-glyphs',
    'table-core',
  ],
  'CanvasKit readiness gate should cover text visuals, positioned fallbacks, and core resources',
);
const textMarkReadinessSample = rendererBaselineManifest.samples
  .find((sample) => sample.id === 'paragraph-text-marks');
assert.deepEqual(
  textMarkReadinessSample?.viewOptions,
  { showParagraphMarks: true, showControlCodes: false },
  'text-mark readiness must exercise the directly replayable paragraph-mark mode only',
);
assert.ok(
  rendererBaselineSource.includes('applySampleViewOptions(page, sample.viewOptions)'),
  'browser baseline capture must apply manifest view options before the selected-page replay',
);
assert.match(
  rendererBaselineSource,
  /viewOptions:\s*\{\s*showParagraphMarks:\s*false,\s*showControlCodes:\s*false,\s*\}/,
  'every baseline sample must reset view options so one marked sample cannot contaminate the next',
);
const fontNativeReadinessSample = rendererBaselineManifest.samples
  .find((sample) => sample.id === 'font-native-bitmap');
assert.equal(
  fontNativeReadinessSample?.browserParityThresholds?.minimumInkPixels,
  40,
  'font-native readiness must retain a positive anti-blank budget calibrated to intrinsic capture',
);
const tableReadinessSample = rendererBaselineManifest.samples
  .find((sample) => sample.id === 'table-core');
assert.equal(
  tableReadinessSample?.browserParityThresholds?.maxDiffRatio,
  0.047,
  'table readiness must keep the calibrated tolerant pixel budget bounded',
);
assert.equal(
  tableReadinessSample?.browserParityThresholds?.inkMaskMaxDiffRatio,
  0.0185,
  'table readiness must keep the calibrated ink-mask budget bounded',
);
assert.equal(rendererBaselineManifest.schemaVersion, 1, 'renderer baseline manifest schema must be explicit');
assert.ok(
  rendererBaselineManifest.samples.length >= 120,
  'renderer baseline manifest must keep the refreshed cross-backend corpus',
);
for (const sample of rendererBaselineManifest.samples) {
  assert.ok(
    Array.isArray(sample.diagnosticAxes)
      && sample.diagnosticAxes.length > 0
      && new Set(sample.diagnosticAxes).size === sample.diagnosticAxes.length,
    `renderer baseline sample ${sample.id} must declare unique diagnostic axes`,
  );
  assert.ok(
    sample.baselineTier === 'representative' || sample.baselineTier === 'extended',
    `renderer baseline sample ${sample.id} must declare its corpus tier`,
  );
  assert.ok(
    Number.isInteger(sample.page ?? 0) && (sample.page ?? 0) >= 0,
    `renderer baseline sample ${sample.id} must declare a valid page`,
  );
}
assert.equal(
  rendererBaselineManifest.samples.filter((sample) => sample.baselineTier === 'representative').length,
  23,
  'the default renderer baseline tier must remain bounded',
);
for (const sampleId of [
  'chart-line-markers-hwp',
  'chart-line-markers-hwpx',
  'chart-stock-hwp',
  'chart-stock-hwpx',
  'table-cell-image-clip-page-1',
  'missing-picture-profile',
  'local-font-nanumsquare-bold',
  'malformed-lineseg-reflow',
]) {
  assert.ok(
    rendererBaselineManifest.samples.some((sample) => sample.id === sampleId),
    `renderer baseline manifest must keep recent regression sample ${sampleId}`,
  );
}
assert.equal(
  rendererBaselineManifest.samples.some((sample) => Number(sample.page) > 0),
  true,
  'renderer baseline manifest must keep non-zero page coverage',
);
assert.deepEqual(
  rendererBaselineManifest.samples
    .filter((sample) => sample.id.startsWith('table-diagonal-cell-'))
    .map((sample) => sample.file)
    .sort(),
  ['대각선샘플.hwp', '대각선샘플.hwpx'],
  'renderer baseline manifest must keep the paired HWP/HWPX diagonal-cell corpus',
);
assert(
  rendererBaselineSource.includes('pageRenderer.renderPage(capturePageIndex, canvas, 1.0, 1.0, 1.0)')
    && rendererBaselineSource.includes('pageRenderer?.cancelAll?.()')
    && rendererBaselineSource.includes('BASELINE_CAPTURE_CONTAINER_SELECTOR')
    && rendererBaselineSource.includes('canvas2dRenderer?.domImageCache')
    && rendererBaselineSource.includes("container.querySelectorAll('img')")
    && rendererBaselineSource.includes("typeof image.decode === 'function'")
    && rendererBaselineSource.includes('localTypefacePendingCount')
    && rendererBaselineSource.includes('selectedPageRenderMs')
    && rendererBaselineDriverSource.includes('averageSelectedPageRenderMs')
    && helpersSource.includes('selector = CANVAS_SELECTOR')
    && !rendererBaselineSource.includes('browser baseline currently supports only page=0 samples'),
  'browser baseline must settle resources and capture the requested page at intrinsic scale',
);
assert(
  rendererBaselineSource.includes('getCanvasKitReplayPlan?.(')
    && rendererBaselineSource.includes('targetProfile,')
    && rendererBaselineSource.includes("code: 'replayPlanUnavailable'")
    && rendererBaselineSource.includes("code: 'replayPlanEmpty'")
    && rendererBaselineSource.includes("code: 'replayPlanContractMismatch'")
    && rendererBaselineSource.includes("code: 'runtimeDiagnosticsUnavailable'")
    && rendererBaselineSource.includes("code: 'runtimeRenderIncomplete'")
    && rendererBaselineSource.includes("code: 'runtimeRenderError'")
    && rendererBaselineSource.includes("code: 'runtimeUnexpectedUnsupportedOps'")
    && rendererBaselineSource.includes("code: 'runtimeBackendMismatch'")
    && rendererBaselineSource.includes("code: 'runtimeProfileMismatch'")
    && rendererBaselineSource.includes('contractGateAndReportInventory')
    && rendererBaselineSource.includes('planReasonCounts')
    && rendererBaselineSource.includes('planFeatureCounts'),
  'browser baseline must gate replay-plan/runtime contract failures and inventory known gaps',
);
assert(
  rendererBaselineDriverSource.includes('CanvasKit Replay Diagnostics')
    && rendererBaselineDriverSource.includes('Replay Diagnostic Inventory')
    && rendererBaselineDriverSource.includes('expectedUnsupportedOpCounts')
    && rendererBaselineDriverSource.includes('unexpectedUnsupportedOpCounts'),
  'renderer baseline report must preserve replay-plan and runtime diagnostic inventories',
);
assert(
  rendererBaselineSource.includes("createHash('sha256')")
    && rendererBaselineSource.includes('comparisonIdentity')
    && rendererBaselineSource.includes("status: 'identityMismatch'")
    && rendererBaselineSource.includes('summaryByDiagnosticAxis')
    && rendererBaselineDriverSource.includes('documentDigest')
    && rendererBaselineDriverSource.includes('comparisonIdentity')
    && rendererBaselineDriverSource.includes('Diagnostic Axis Summary')
    && rendererBaselineSource.includes('fs.realpathSync(samplePath)')
    && rendererBaselineSource.includes('baseline sample page must be a non-negative integer')
    && rendererBaselineNativeDiffSource.includes("status: 'identityMismatch'")
    && rendererBaselineNativeDiffSource.includes("createHash('sha256')")
    && rendererBaselineNativeDiffSource.includes('nativeArtifactSha256')
    && rendererBaselineNativeDiffSource.includes('nativeArtifactSizeBytes')
    && rendererBaselineDriverSource.includes('native Skia ({profile}) baseline export did not create a non-empty artifact')
    && rendererBaselineNativeDiffSource.includes('summaryByDiagnosticAxis'),
  'cross-backend comparisons must bind document/page/profile/artifact provenance and diagnostic axes',
);





requireSnippet(
  rendererBaselineSource,
  /getCanvasKitRenderDiagnostics\?\.\(targetPageIndex\)[\s\S]*?canvasPool\?\.getCanvas\?\.\(targetPageIndex\)[\s\S]*?activeBackend: window\.__renderBackend[\s\S]*?request: window\.__rendererRuntimeRequest[\s\S]*?canvasOwnershipTracked/,
  'CanvasKit baseline should read page-scoped diagnostics and effective backend selection',
);
requireSnippet(
  rendererBaselineSource,
  /readinessGateRequired: options\.readinessOnly[\s\S]*?backend\.key === 'canvaskit-default'[\s\S]*?profile === 'screen'[\s\S]*?options\.canvaskitSurface === 'auto'/,
  'CanvasKit readiness gate should be explicit and limited to default screen/auto captures',
);
for (const readinessGuard of [
  'backendNotActive',
  'legacyRequestProjectionMismatch',
  'autoSelectionMismatch',
  'autoPreflightNotEligible',
  'autoDocumentDigestMissing',
  'autoDecisionGenerationMissing',
  'canvaskitModeRequestMismatch',
  'canvaskitSurfaceRequestMismatch',
  'canvaskitModeMismatch',
  'canvaskitSurfacePreferenceMismatch',
  'canvasOwnershipMismatch',
  'diagnosticsUnavailable',
  'runtime:readinessGateFailed',
  'visualThresholdMissing',
  'visualParityFailed',
  'performanceBudgetMissing',
  'performanceColdExceeded',
  'performanceWarmExceeded',
  'performanceRendererWarmExceeded',
  'imageCachePixelBudgetExceeded',
  'warmReplayMissing',
  'glyphOutlinePayloadMissing:',
  'warmImageCacheHitMissing',
]) {
  assert.ok(
    rendererBaselineSource.includes(readinessGuard),
    `CanvasKit readiness baseline should keep guard ${readinessGuard}`,
  );
}
requireSnippet(
  rendererBaselineSource,
  /canvaskitReadinessGate\.summary\.failed > 0[\s\S]*?process\.exitCode = 1/,
  'CanvasKit readiness baseline should fail after writing its JSON report',
);
requireSnippet(
  rendererBaselineSource,
  /catch \(error\) \{[\s\S]*?captureError =[\s\S]*?writeFileSync\([\s\S]*?captureError/,
  'CanvasKit readiness baseline should preserve a JSON report after browser capture failures',
);
assert.ok(
  rendererBaselineSource.includes("--readiness-only cannot be combined with --filter"),
  'CanvasKit readiness should reject partial filtered corpus runs',
);
assert.ok(
  rendererBaselineSource.includes('BROWSER_PARITY_ALLOWED_THRESHOLDS'),
  'CanvasKit readiness should validate visual threshold keys and ranges',
);
assert.ok(
  rendererBaselineSource.includes('requires a positive minimumInkPixels threshold'),
  'CanvasKit readiness samples should require an explicit positive ink floor',
);
assert.ok(
  rendererBaselineSource.includes('measureWarmCanvasKitReplay')
    && rendererBaselineSource.includes('requireColdAndWarmPerformanceBudget')
    && rendererBaselineSource.includes('readLayerFeatureProbe'),
  'CanvasKit readiness should gate cold/warm replay and declared layer features',
);
requireSnippet(
  rendererBaselineSource,
  /getCurrentCanvasKitRenderDiagnostics\?\.\(\)[\s\S]*?rerenderPageForDiagnostics\?\.\(targetPageIndex\)[\s\S]*?getCurrentCanvasKitRenderDiagnostics\?\.\(\)[\s\S]*?renderCountDelta/,
  'CanvasKit warm replay should report whether the existing page canvas was rerendered',
);
requireSnippet(
  canvasViewSource,
  /rerenderPageForDiagnostics\(pageIdx: number\)[\s\S]*?canvasPool\.getCanvas\(pageIdx\)[\s\S]*?this\.renderCanvas\(pageIdx, canvas\)/,
  'diagnostic warm replay should reuse the canvas already owned by the pool',
);
assert.doesNotMatch(
  rendererBaselineSource,
  /view\?\.renderPage\?\.\(targetPageIndex\)/,
  'warm replay must not acquire a second canvas for an already rendered page',
);



assert.ok(
  rendererBaselineSource.includes('chromiumBuildId'),
  'CanvasKit readiness artifacts should identify the pinned Chromium snapshot',
);

console.log('Renderer architecture and asset contracts passed');
