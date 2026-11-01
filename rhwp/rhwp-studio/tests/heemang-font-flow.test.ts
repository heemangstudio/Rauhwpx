import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks, stripTypeScriptTypes } from 'node:module';
import { readFileSync } from 'node:fs';
import { provideEngineFont } from '../src/core/engine-support.ts';

// 엔진·네트워크 경계만 대체해 실제 어댑터의 등록/조판/재그리기 순서를 검사한다.
let env: any;
(globalThis as any).heemangFontTest = () => env;
const stubs = new Map([
  ['/vendor/hm-wasm/hm_wasm.js', `const e = () => globalThis.heemangFontTest();
    export default async function init() { return { memory: new WebAssembly.Memory({initial:1}) }; }
    export class Blake3Hasher {}
    export class Doc {}
    export const capabilities = () => '{"contract":1,"packet":1}';
    export const fileFamilyNames = file => { e().probes++; return JSON.stringify(e().families.get(file.read(0,1)[0]) ?? []); };
    export class Engine {
      open() { return {...e().doc}; }
      addFontFile(path, file) {
        const id = file.read(0,1)[0];
        if (this.env !== e()) return 1;
        e().events.push('font:' + id); e().registered.push(path);
        e().outlines = e().outlines.filter(p => p !== path);
        assertFile(file);
        return 1;
      }
      // 앞선 테스트의 엔진도 같은 글꼴 수신자를 남기므로 표는 만든 테스트의 기록에만 남긴다.
      constructor() { this.env = e(); }
      addFontMap(b) { this.env.events.push('table:fontmap:' + b[0]); return true; }
      addHftInfo(b) { this.env.events.push('table:hftinfo:' + b[0]); return true; }
      addCodeTable(b) { this.env.events.push('table:code:' + b[0]); return true; }
      outlineRequests() { return JSON.stringify(e().outlines); }
      glyphCoverage() { return '[]'; }
      fontCharacters() { return 'A각'; }
    }
    function assertFile(file) { if (file.size < 1 || !(file.read(0,1) instanceof Uint8Array)) throw Error('invalid FontFile'); }`],
  ['/core/desktop-fonts.ts', `export const getSystemFontHost = () => globalThis.heemangFontTest().host;
    export const loadDesktopFontIndex = async () => globalThis.heemangFontTest().index;
    export const readDesktopFace = (host,id) => host.read(id);
    export const getDesktopFontLookup = () => globalThis.heemangFontTest().lookup ?? null;
    export const matchDesktopFont = (name,lookup) => lookup.get(name) ?? {requested:name,reason:'not-found'};
    export const isDesktopFontMatch = match => Array.isArray(match.slots);`],
  ['/core/content-hash.ts', `export const blake3Hex = () => 'digest'; export const setBlake3WasmApi = () => {};`],
  ['/core/font-loader.ts', `export const resolveCanvasKitFontPlan = () => { globalThis.heemangFontTest().plans++; return {sources: []}; };`],
  ['/fonts/font-index-core.mjs', `export const streamWebFontDecoders = () => null; export const decodeWebFont = b => b;
    export const HANCOM_ENGINE_TABLE_ORDER = ['fontmap','hftinfo','code'];
    export const hancomEngineTableKind = name => /^fontmap/i.test(name) ? 'fontmap' : /^hftinfo/i.test(name) ? 'hftinfo' : /^u300_/i.test(name) ? 'code' : null;`],
  ['/view/heemang-player.ts', `export class Pictures { constructor(ready) { globalThis.heemangFontTest().pictureReady = ready; } get() { return null; } clear() {}
      async prepare(doc,page,items) { const e = globalThis.heemangFontTest(); e.picturePreparations.push({page,items}); await e.pictureWait?.(); }
    }
    export class Player {
      paint(ctx) { const e = globalThis.heemangFontTest(); e.paints.push(ctx); e.onPaint?.(); }
    }
    export const decodePacket = () => ({width:7200,height:7200,fontGeneration:0,layoutEpoch:0,...globalThis.heemangFontTest().packetHeader?.(),ops:globalThis.heemangFontTest().packetOps ?? []});
    export const patchImage = () => null;`],
]);
registerHooks({
  resolve(specifier, context, next) {
    if (specifier.endsWith('/vendor/hm-wasm/hm_wasm')) return next(`${specifier}.js`, context);
    return next(specifier.startsWith('.') && !/\.[a-z]+$/i.test(specifier) ? `${specifier}.ts` : specifier, context);
  },
  load(url, context, next) {
    const path = new URL(url).pathname;
    for (const [suffix, source] of stubs) if (path.endsWith(suffix)) return {format:'module', source, shortCircuit:true};
    if (path.endsWith('/core/heemang-adapter.ts')) {
      const source = readFileSync(new URL(url), 'utf8').replaceAll('import.meta.env', '({DEV:true,VITE_HEEMANG_FONT_ASSETS:"1"})');
      return {format:'module', source:stripTypeScriptTypes(source), shortCircuit:true};
    }
    return next(url, context);
  },
});

let serial = 0;
function setup(assets: any[], requests: () => any) {
  env = { assets, events:[], registered:[], outlines:[], paints:[], probes:0, plans:0, host:null, families:new Map(), fetches:[], picturePreparations:[] };
  env.doc = {
    fontRequests: () => JSON.stringify(requests()),
    state: () => { env.events.push('layout'); return JSON.stringify({pageCount:3,fontGeneration:env.registered.length,layoutEpoch:1}); },
    pages: () => { env.events.push('pages'); return '[{"index":0,"section":1}]'; },
    page: () => new Uint8Array(), close() {}, free() {},
  };
  globalThis.fetch = (async (url: string) => {
    env.fetches.push(url);
    if (url.endsWith('/manifest.json')) return Response.json(assets);
    const a = assets.find(a => a.url === url);
    if (!a) throw Error('not allowlisted: ' + url);
    await env.fetchWait?.();
    return new Response(new Uint8Array(a.size).fill(a.id));
  }) as typeof fetch;
  return import(`../src/core/heemang-adapter.ts?font-flow=${++serial}`);
}
const asset = (id: number, name: string, family: string) => ({id,name,url:`/__heemang-fonts/${id}`,size:4,families:[family]});
const req = (candidates = ['Body'], defaults = [['Default']], fallbacks: string[] = []) => ({
  faces:[{name:'Requested',candidates,standIns:['Stand In']}],classDefaults:defaults,fallbacks,
});
const originalFetch = globalThis.fetch;
test.after(() => { globalThis.fetch = originalFetch; });

test('metadata stays lazy; first candidates/default and newly requested fallbacks precede layout, deduping physical copies', async () => {
  const assets = [asset(1,'Body.ttf','B o d y'),asset(2,'Later.ttf','Later'),asset(3,'Default.ttf','Default'),
    asset(4,'Serif.ttf','Serif'),asset(5,'Stand.ttf','Stand In'),asset(6,'Fallback.ttf','Fallback'),asset(7,'BODY.TTF','Body')];
  const { HeemangAdapter } = await setup(assets, () => req(['Missing','body','Later'], [['Default'],['Serif']], env.registered.length ? ['Fallback','Unavailable'] : []));
  const adapter = new HeemangAdapter(); await adapter.initialize();
  const info = adapter.loadDocument(new Uint8Array([0x50,0x4b]));
  assert.equal(info.pageCount,0); assert.equal(info.sectionCount,1);
  assert.deepEqual(info.fontsUsed,['Requested']);
  assert.equal(adapter.getSourceFormat(),'hwpx'); assert.equal(adapter.pageCount,0);
  assert.deepEqual(env.events,[]);
  // 일반 호스트 handoff의 파일 이름은 manifest 사본과 같아야 한다.
  env.families.set(1,['Body']);
  let rereads = 0;
  provideEngineFont('/host/BODY.TTF', new Uint8Array(4).fill(1), async () => { rereads++; return new Uint8Array(4).fill(1); });
  await adapter.prepareFonts(info.fontsUsed,{});
  assert.deepEqual(env.events.slice(0,4),['font:1','font:3','font:6','layout']);
  assert.equal(env.plans,0); assert.equal(env.probes,1);
  assert.equal(env.fetches.includes('/__heemang-fonts/1'),false);
  assert.equal(env.fetches.includes('/__heemang-fonts/7'),false);
  assert.equal(adapter.getDocumentInfo().pageCount,3);
  env.outlines = ['/host/BODY.TTF'];
  adapter.renderPageToCanvas(0,canvas(),1);
  await tick();
  assert.equal(rereads,1); assert.equal(env.paints.length,2);
});

test('missing primary default selects only first available families from remaining lists, including host-only fallbacks', async () => {
  const { HeemangAdapter } = await setup([asset(1,'Body.ttf','Body'),asset(2,'Serif.ttf','Serif'),asset(3,'Sans.ttf','Sans'),asset(4,'Later.ttf','Later')], () => req(['Body'],[['Missing'],['Serif','Later'],['Sans','Later']],['Host Fallback']));
  env.index = {faces:[{id:'host',path:'/fonts/host.ttf',size:4,families:['Host Fallback']}]};
  env.host = {read:async () => new Uint8Array(4).fill(9)};
  env.families.set(9,['Host Fallback']);
  const adapter = new HeemangAdapter(); await adapter.initialize(); adapter.loadDocument(new Uint8Array([0xd0,0xcf]));
  assert.equal(adapter.getSourceFormat(),'hwp');
  await adapter.prepareFonts(['Body'],{});
  assert.deepEqual(new Set(env.events.slice(0,4)),new Set(['font:1','font:2','font:3','font:9']));
  assert.equal(env.events[4],'layout'); assert.equal(env.plans,0);
});

test('text faces read their complete source while metrics faces stay sparse until an actual outline request', async () => {
  const { HeemangAdapter } = await setup([], () => ({
    faces:[{candidates:['Body']},{candidates:['Metrics'],text:false}],classDefaults:[['Metrics']],fallbacks:[],
  }));
  env.index = {faces:[
    {id:'body',path:'/fonts/body.ttf',size:4,families:['Body']},
    {id:'metrics',path:'/fonts/metrics.ttf',size:4,families:['Metrics']},
  ]};
  const reads: string[] = [];
  env.host = {
    read:async (id: string) => { reads.push(`full:${id}`); return new Uint8Array(4).fill(id === 'body' ? 1 : 2); },
    readSubset:async (id: string, characters: string) => {
      assert.equal(characters,'\0'); reads.push(`sparse:${id}`); return new Uint8Array(4).fill(2);
    },
  };
  env.families.set(1,['Body']); env.families.set(2,['Metrics']);
  const adapter = new HeemangAdapter(); await adapter.initialize(); adapter.loadDocument(new Uint8Array([0x50,0x4b]));
  await adapter.prepareFonts(['Body','Metrics'],{});
  assert.deepEqual(reads,['full:body','sparse:metrics']);
  env.outlines = ['heemang-host:metrics'];
  adapter.renderPageToCanvas(0,canvas(),1); await tick();
  assert.deepEqual(reads,['full:body','sparse:metrics','full:metrics']);
  assert.equal(env.registered.filter((label: string) => label === 'heemang-host:metrics').length,2);
});

function canvas() {
  const ctx = {fillRect() {}};
  return {width:0,height:0,dataset:{},isConnected:true,getContext:() => ctx} as any;
}
function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => {resolve=r;}); return {promise,resolve}; }
const tick = () => new Promise(resolve => setImmediate(resolve));

test('first page waits for pictures before becoming visible and ignores replaced or closed documents', async () => {
  for (const state of ['ready', 'replaced', 'closed']) {
    const { HeemangAdapter } = await setup([asset(1,'Body.ttf','Body')], () => req(['Body'],[]));
    const adapter = new HeemangAdapter(); await adapter.initialize(); adapter.loadDocument(new Uint8Array([0x50,0x4b]));
    const wait = deferred(); env.pictureWait = () => wait.promise;
    env.packetOps = [{op:'patch',item:7}];
    const preparing = adapter.prepareFonts(['Body'],{});
    await tick();
    assert.equal(adapter.pageCount,0);
    assert.deepEqual(env.picturePreparations,[{page:0,items:[7]}]);
    if (state === 'replaced') adapter.loadDocument(new Uint8Array([0x50,0x4b]));
    if (state === 'closed') adapter.releaseDocument();
    wait.resolve(); await preparing;
    assert.equal(adapter.pageCount,state === 'ready' ? 3 : 0);
  }
});

test('outline refetch uses approved readers, shares asynchronous reads, and repaints only current attached canvases', async () => {
  const { HeemangAdapter } = await setup([asset(1,'Body.ttf','Body')], () => req(['Body'],[]));
  const adapter = new HeemangAdapter(); await adapter.initialize(); adapter.loadDocument(new Uint8Array([0x50,0x4b]));
  await adapter.prepareFonts(['Body'],{});
  const wait = deferred(); env.fetchWait = () => wait.promise;
  env.outlines = ['/__heemang-fonts/1','/not-allowed.ttf'];
  const a = canvas(), b = canvas();
  adapter.renderPageToCanvas(0,a,1); adapter.renderPageToCanvas(0,b,1);
  b.isConnected = false;
  assert.equal(env.paints.length,2);
  wait.resolve(); await tick();
  assert.equal(env.paints.length,3);
  assert.equal(env.fetches.filter((p: string) => p === '/__heemang-fonts/1').length,2);
  assert.equal(env.fetches.includes('/not-allowed.ttf'),false);
  const next = deferred(); env.fetchWait = () => next.promise; env.outlines = ['/__heemang-fonts/1'];
  adapter.renderPageToCanvas(0,a,1);
  adapter.loadDocument(new Uint8Array([0x50,0x4b]));
  next.resolve(); await tick();
  assert.equal(env.paints.length,4);
});

test('font preparation does not lay out or mark a replacement document prepared after an async load', async () => {
  const { HeemangAdapter } = await setup([asset(1,'Body.ttf','Body')], () => req(['Body'],[]));
  const adapter = new HeemangAdapter(); await adapter.initialize(); adapter.loadDocument(new Uint8Array([0x50,0x4b]));
  const wait = deferred(); env.fetchWait = () => wait.promise;
  const preparing = adapter.prepareFonts(['Body'],{});
  adapter.loadDocument(new Uint8Array([0xd0,0xcf]));
  wait.resolve(); await preparing;
  assert.equal(env.events.includes('layout'),false);
  assert.equal(adapter.getDocumentInfo().pageCount,0);
});

test('async outlines notify the owning view and ignore replaced, closed or detached canvases', async () => {
  for (const state of ['ready','replaced','closed','detached']) {
    const { HeemangAdapter } = await setup([asset(1,'Body.ttf','Body')], () => req(['Body'],[]));
    const adapter = new HeemangAdapter(); await adapter.initialize(); adapter.loadDocument(new Uint8Array([0x50,0x4b]));
    await adapter.prepareFonts(['Body'],{});
    const pages: number[] = [];
    adapter.onPageRenderReady = page => pages.push(page);
    const wait = deferred(); env.fetchWait = () => wait.promise;
    env.outlines = ['/__heemang-fonts/1'];
    const target = canvas(); adapter.renderPageToCanvas(2,target,1);
    if (state === 'replaced') adapter.loadDocument(new Uint8Array([0x50,0x4b]));
    if (state === 'closed') adapter.releaseDocument();
    if (state === 'detached') target.isConnected = false;
    wait.resolve(); await tick();
    assert.deepEqual(pages,state === 'ready' ? [2] : [],state);
    assert.equal(env.paints.length,1,'the attached host owns the repaint and its decorations');
  }
});


test('picture arrivals coalesce repaint, drop detached canvases and cancel repaint on document replacement', async () => {
  const originalRequest = globalThis.requestAnimationFrame;
  const originalCancel = globalThis.cancelAnimationFrame;
  const frames = new Map<number, FrameRequestCallback>();
  let frame = 0;
  globalThis.requestAnimationFrame = callback => { frames.set(++frame, callback); return frame; };
  globalThis.cancelAnimationFrame = id => { frames.delete(id); };
  try {
    const { HeemangAdapter } = await setup([], () => req([], []));
    const adapter = new HeemangAdapter(); await adapter.initialize(); adapter.loadDocument(new Uint8Array([0x50,0x4b]));
    const a = canvas(), b = canvas();
    adapter.renderPageToCanvas(0,a,1); adapter.renderPageToCanvas(1,b,0.8);
    b.isConnected = false;
    env.pictureReady(); env.pictureReady();
    assert.equal(frames.size,1);
    const [id, callback] = [...frames][0]; frames.delete(id); callback(0);
    assert.equal(env.paints.length,3);
    assert.equal(a.width,96);
    const pages: number[] = [];
    adapter.onPageRenderReady = page => pages.push(page);
    env.pictureReady();
    const [readyId, readyCallback] = [...frames][0]; frames.delete(readyId); readyCallback(0);
    assert.deepEqual(pages,[0]);
    assert.equal(env.paints.length,3);
    env.pictureReady();
    assert.equal(frames.size,1);
    adapter.loadDocument(new Uint8Array([0x50,0x4b]));
    assert.equal(frames.size,0);
    assert.equal(env.paints.length,3);
    assert.deepEqual(pages,[0]);
  } finally {
    globalThis.requestAnimationFrame = originalRequest;
    globalThis.cancelAnimationFrame = originalCancel;
  }
});

test('catalog families keep every script bank in order and discover later host fallbacks', async () => {
  const assets = [asset(1,'Body-Korean.hft','B O D Y'),asset(2,'Body-Latin.hft','Body'),asset(3,'Unused.ttf','Unused')];
  const fallbacks: string[] = [];
  const { HeemangAdapter } = await setup(assets, () => req(['body'], [], fallbacks));
  env.index = {faces:[]};
  env.host = {read:async () => new Uint8Array(4).fill(9)};
  const adapter = new HeemangAdapter();
  await adapter.initialize(); adapter.loadDocument(new Uint8Array([0x50,0x4b]));
  await adapter.prepareFonts(['body'],{});
  assert.deepEqual(env.events,['font:1','font:2','layout']);
  assert.equal(env.fetches.includes('/__heemang-fonts/3'),false);
  env.index.faces.push({id:'new-fallback',path:'/fonts/new.ttf',size:4,families:['New Fallback']});
  env.families.set(9,['New Fallback']);
  fallbacks.push('new fallback');
  await adapter.prepareFonts(['body'],{});
  assert.deepEqual(env.events,['font:1','font:2','layout','font:9','layout']);
  assert.equal(env.plans,0);
});

test('host SFNT preparation reuses preferred slots while retaining every matching HFT bank', async () => {
  const reads: string[] = [];
  const { HeemangAdapter } = await setup([], () => req(['Body'],[]));
  env.index = {faces:[
    {id:'duplicate',path:'/old/Body.ttf',size:4,families:['Body']},
    {id:'preferred',path:'/new/Body.ttf',size:4,families:['Body']},
    {id:'korean',path:'/hft/Body-Korean.hft',size:4,families:['Body']},
    {id:'latin',path:'/hft/Body-Latin.hft',size:4,families:['Body']},
  ]};
  env.lookup = new Map([['body',{slots:[{face:{id:'preferred'}}]}]]);
  env.host = {read:async (id: string) => { reads.push(id); return new Uint8Array(4).fill(9); }};
  env.families.set(9,['Body']);
  const adapter = new HeemangAdapter(); await adapter.initialize();
  adapter.loadDocument(new Uint8Array([0x50,0x4b]));
  await adapter.prepareFonts(['Body'],{});
  assert.deepEqual(reads,['preferred','korean','latin']);
  assert.equal(env.plans,0);
});

test('a desktop TTC face already handed to the engine is not fetched again under its catalog identity', async () => {
  const { HeemangAdapter } = await setup([], () => req(['Body'],[]));
  env.index = {faces:[{id:'ttc-face',path:'/fonts/Body.ttc',size:1000,families:['Body']}]};
  let reads = 0;
  env.host = {read:async () => { reads++; throw Error('duplicate full-face read'); }};
  env.families.set(1,['Body']);
  const adapter = new HeemangAdapter(); await adapter.initialize();
  adapter.loadDocument(new Uint8Array([0x50,0x4b]));
  provideEngineFont('/fonts/Body.ttc#regular', new Uint8Array(4).fill(1), async () => new Uint8Array(4).fill(1), 'heemang-host:ttc-face');
  await adapter.prepareFonts(['Body'],{});
  assert.equal(adapter.getDocumentInfo().pageCount,3);
  assert.equal(env.plans,0);
  assert.equal(reads,0);
  const registered = [...env.registered];
  assert.ok(registered.every(label => label === 'heemang-host:ttc-face'));
  provideEngineFont('/fonts/Body.ttc#regular', new Uint8Array(4).fill(1), undefined, 'heemang-host:ttc-face');
  assert.deepEqual(env.registered, registered);
});

test('fallback coverage is queried again before reading another large candidate', async () => {
  const assets = [asset(1,'Body.ttf','Body'),asset(2,'Fallback.ttf','Fallback'),asset(3,'Other.ttf','Other')];
  const { HeemangAdapter } = await setup(assets, () => req(['Body'], [],
    env.registered.includes('/__heemang-fonts/2') ? [] : ['Fallback','Other']));
  const adapter = new HeemangAdapter(); await adapter.initialize();
  adapter.loadDocument(new Uint8Array([0x50,0x4b]));
  await adapter.prepareFonts(['Body'],{});
  assert.equal(env.fetches.includes('/__heemang-fonts/2'),true);
  assert.equal(env.fetches.includes('/__heemang-fonts/3'),false);
  assert.equal(env.events.at(-1),'layout');
});


test('metric-only faces defer outline transfer while retaining their native metrics', async () => {
  const { HeemangAdapter } = await setup([], () => ({
    ...req(['Metric'], []), faces: [{name:'Metric', candidates:['Metric'], standIns:[], text:false}],
  }));
  env.index = {faces:[{id:'metric',path:'/fonts/metric.ttf',size:1000,families:['Metric']}]};
  const plans: string[] = [];
  env.host = {read:async () => { throw Error('unexpected full read'); },
    readSubset:async (_id: string, characters: string) => { plans.push(characters); return new Uint8Array(4).fill(9); }};
  env.families.set(9,['Metric']);
  const adapter = new HeemangAdapter(); await adapter.initialize();
  adapter.loadDocument(new Uint8Array([0x50,0x4b]));
  await adapter.prepareFonts([],{});
  assert.deepEqual(plans,['\0']);
  assert.equal(adapter.getDocumentInfo().pageCount,3);
  assert.deepEqual(adapter.getDocumentInfo().fontsUsed,[]);
});

test('host Hancom engine tables reach the engine once, in order, before any HFT bank', async () => {
  const { HeemangAdapter } = await setup([], () => req(['Body'], []));
  env.index = {
    faces:[{id:'hft',path:'/hnc/Shared/Fonts/BODY.HFT',size:4,families:['Body']}],
    engineTables:[
      {id:'code',kind:'code',path:'/hnc/Bin/Code/u300_949.dat',size:4},
      {id:'info',kind:'hftinfo',path:'/hnc/Bin/FontDB/hftinfo.dat',size:4},
      {id:'map',kind:'fontmap',path:'/hnc/Shared/Fonts/FontMap.dat',size:4},
    ],
  };
  const fill: Record<string, number> = {hft:9, code:3, info:2, map:1};
  const reads: string[] = [];
  env.host = {read:async (id: string) => { reads.push(id); return new Uint8Array(4).fill(fill[id]!); }};
  env.families.set(9,['Body']); env.families.set(8,['Early']);
  const adapter = new HeemangAdapter(); await adapter.initialize();
  adapter.loadDocument(new Uint8Array([0x50,0x4b]));
  // 데스크톱 글꼴 준비가 엔진보다 먼저 HFT 를 넘겨도 표가 먼저 들어간다.
  provideEngineFont('/hnc/Shared/Fonts/EARLY.HFT', new Uint8Array(4).fill(8));
  await adapter.prepareFonts(['Body'],{});
  const fonts = env.events.filter((event: string) => event.startsWith('font:') || event.startsWith('table:'));
  assert.deepEqual(fonts.slice(0,3),['table:fontmap:1','table:hftinfo:2','table:code:3']);
  assert.deepEqual(new Set(fonts.slice(3)),new Set(['font:8','font:9']));
  // 같은 엔진의 다음 문서는 표를 다시 읽거나 넣지 않는다.
  const next = new HeemangAdapter(); await next.initialize();
  next.loadDocument(new Uint8Array([0x50,0x4b]));
  await next.prepareFonts(['Body'],{});
  assert.equal(env.events.filter((event: string) => event.startsWith('table:')).length,3);
  assert.ok(['code','info','map'].every(id => reads.includes(id)));
});

test('a progressive open lays out only the first pages, keeps unchanged page packets while the rest lays out and repaints every page after another call completes it', async () => {
  const { HeemangAdapter } = await setup([asset(1,'Body.ttf','Body')], () => req(['Body'],[]));
  // 엔진처럼 상태 읽기는 아직 조판하지 않았거나 글꼴이 바뀐 문서를 끝까지 조판하고, layoutFirst 는 앞쪽만 조판한다.
  const total = 10;
  let laid = 0, epoch = 0, laidWith = -1;
  const range = (from: number, to: number) => Array.from({length: to - from}, (_, i) => from + i);
  const stale = () => laid === 0 || laidWith !== env.registered.length;
  const lay = (pages: number, label: string) => { env.events.push(label); laid = Math.min(total, pages); epoch++; laidWith = env.registered.length; };
  const progress = (changedPages: number[]) => JSON.stringify({pageCount:laid,complete:laid === total,layoutEpoch:epoch,changedPages});
  env.packetHeader = () => ({layoutEpoch:epoch,fontGeneration:env.registered.length});
  Object.assign(env.doc, {
    state: () => {
      if (stale()) lay(total, 'layout:all');
      return JSON.stringify({pageCount:laid,fontGeneration:env.registered.length,layoutEpoch:epoch,layoutComplete:laid === total});
    },
    layoutFirst: (pages: number) => { if (stale()) lay(pages + 1, 'layout:first'); return progress(range(0, laid)); },
    layoutMore: (pages: number) => {
      if (stale()) lay(total, 'layout:all');
      if (laid === total) return progress([]);
      const before = laid;
      lay(pages ? laid + pages : total, 'layout:more');
      // 끝까지 조판하면 전체 쪽 수를 보이는 첫 쪽 꼬리말도 바뀐다.
      return progress(laid === total ? [0, ...range(before, laid)] : range(before, laid));
    },
    query: () => { if (laid < total) lay(total, 'layout:rest'); return '[]'; },
    page: (i: number) => { env.events.push(`page:${i}`); return new Uint8Array(); },
  });
  const fetched = () => env.events.filter((event: string) => event.startsWith('page:'));
  const open = async (adapter: any) => {
    laid = 0;
    adapter.loadDocument(new Uint8Array([0x50,0x4b]));
    assert.equal(adapter.beginFirstPages(3), true);
    await adapter.prepareFonts(['Body'],{});
    assert.equal(adapter.pageCount, 4);
    assert.equal(env.events.includes('layout:all'), false, 'opening reads lay out only the first pages, also after fonts arrive');
    assert.equal(adapter.finishFirstPages(), true);
  };
  const adapter = new HeemangAdapter(); await adapter.initialize();
  await open(adapter);
  const first = canvas(), second = canvas();
  adapter.renderPageToCanvas(0,first,1); adapter.renderPageToCanvas(1,second,1);
  env.events = [];
  let p = adapter.layoutMore(3);
  assert.deepEqual([p.pageCount, p.complete, p.changedPages], [7, false, [4,5,6]]);
  adapter.renderPageToCanvas(0,first,1); adapter.renderPageToCanvas(1,second,1);
  assert.deepEqual(fetched(), [], 'pages the layout left alone keep their packets');
  p = adapter.layoutMore(0);
  assert.deepEqual([p.pageCount, p.complete], [total, true]);
  adapter.renderPageToCanvas(0,first,1); adapter.renderPageToCanvas(1,second,1);
  assert.deepEqual(fetched(), ['page:0'], 'pages the layout changed are read again');

  // 위치 찾기 같은 다른 호출이 남은 조판을 끝내면 그 차이는 진행 결과에 없으므로 모든 쪽을 다시 그린다.
  env.events = [];
  await open(adapter);
  adapter.renderPageToCanvas(1,second,1);
  adapter.hmDoc().query('{}');
  env.events = [];
  p = adapter.layoutMore(3);
  assert.equal(p.complete, true);
  assert.deepEqual(p.changedPages, range(0, total));
  adapter.renderPageToCanvas(1,second,1);
  assert.deepEqual(fetched(), ['page:1']);
});
