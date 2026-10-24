/**
 * MCP tool parity: old rhwp WASM engine (baseline worktree, URL `/`) vs HeemangEngine
 * (candidate worktree, URL `/?engine=heemang`).
 *
 * Each worktree runs its own hub + Vite + headless Chrome with a fake pi provider turn and a fake
 * MCP WebSocket client (same frames as mcp-stdio.mjs). Every document-engine tool from
 * filterToolDefinitions('direct') is called on the same sample with args derived from the baseline's
 * get_structure. Writes are checked with a follow-up read.
 *
 * Run from the studio-verify root: node rhwp/rhwp-studio/e2e/heemang-verify/mcp-parity.mjs
 * Output: rhwp/rhwp-studio/e2e/heemang-verify/out/mcp-parity.json + a markdown table on stdout.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import { PNG } from 'pngjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CANDIDATE_ROOT = path.resolve(__dirname, '../../../..');
const BASELINE_ROOT = process.env.HV_BASELINE_ROOT
  || path.resolve(CANDIDATE_ROOT, '..', 'studio-baseline');
const OUT_DIR = path.join(__dirname, 'out');
const SAMPLE = process.env.HV_SAMPLE || 'biz_plan.hwp';
const TOKEN = 'parity';
const CALL_TIMEOUT_MS = 15000;

const ENGINE_INDEPENDENT = /^(browser_|project_|request_|ask_user_question$|download_file$|publish_artifact$|delegate_|register_copy_layout_template$|read_agent_instructions$|update_agent_instructions$|read_product_skill$|commit_product_skill$|list_harness_skills$|search_reference_files$|read_reference_chunk$|read_reference_image$)/;

// ─── setup helpers ──────────────────────────────────────────────

function ensureCandidatePkg() {
  const target = path.join(CANDIDATE_ROOT, 'rhwp', 'pkg');
  if (fs.existsSync(path.join(target, 'rhwp_bg.wasm'))) return;
  const source = path.join(BASELINE_ROOT, 'rhwp', 'pkg');
  if (!fs.existsSync(path.join(source, 'rhwp_bg.wasm'))) throw new Error(`baseline wasm missing: ${source}`);
  fs.cpSync(source, target, { recursive: true });
  console.log(`  [setup] copied ${source} -> ${target}`);
}

function solidPngBase64(width, height, [r, g, b]) {
  const png = new PNG({ width, height });
  for (let i = 0; i < width * height; i += 1) {
    png.data[i * 4] = r; png.data[i * 4 + 1] = g; png.data[i * 4 + 2] = b; png.data[i * 4 + 3] = 255;
  }
  return PNG.sync.write(png).toString('base64');
}

function connectMcpClient(hubPort, token, sessionId, capabilityEpoch, prepareInsertImageArgs) {
  const ws = new WebSocket(
    `ws://127.0.0.1:${hubPort}/mcp?token=${encodeURIComponent(token)}&sessionId=${encodeURIComponent(sessionId)}&agent=pi`,
  );
  let nextId = 1;
  const inflight = new Map();
  const rejectAll = (error) => {
    for (const entry of inflight.values()) { clearTimeout(entry.timer); entry.reject(error); }
    inflight.clear();
  };
  ws.addEventListener('message', (ev) => {
    let msg;
    try { msg = JSON.parse(typeof ev.data === 'string' ? ev.data : ''); } catch { return; }
    if (msg?.type === 'protocol-error') { rejectAll(new Error(msg.message)); return; }
    if (msg?.type !== 'tool-result') return;
    const entry = inflight.get(msg.id);
    if (!entry) return;
    inflight.delete(msg.id);
    clearTimeout(entry.timer);
    entry.resolve(msg);
  });
  ws.addEventListener('close', (event) => rejectAll(new Error(`MCP WS closed (${event.code}): ${event.reason}`)));
  const opened = new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', () => reject(new Error('MCP WS connect failed')), { once: true });
  });
  const call = async (tool, rawArgs) => {
    const args = tool === 'insert_image' ? await prepareInsertImageArgs(rawArgs, []) : rawArgs;
    const id = nextId++;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        inflight.delete(id);
        resolve({ ok: false, error: { code: 'CLIENT_TIMEOUT', message: `no tool-result in ${CALL_TIMEOUT_MS} ms` } });
      }, CALL_TIMEOUT_MS);
      inflight.set(id, { resolve, reject: (e) => { clearTimeout(timer); resolve({ ok: false, error: { code: 'TRANSPORT', message: e.message } }); }, timer });
      ws.send(JSON.stringify({ v: 5, type: 'tool-call', id, tool, args, workflow: 'direct', capabilityEpoch }));
    });
  };
  return { ws, opened, call };
}

// ─── result signatures ──────────────────────────────────────────

function pngInfo(b64) {
  try {
    const buf = Buffer.from(b64.slice(0, 64), 'base64');
    if (buf.readUInt32BE(0) !== 0x89504e47) return { bytes: Math.floor(b64.length * 0.75) };
    return { bytes: Math.floor(b64.length * 0.75), width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  } catch { return { bytes: Math.floor(b64.length * 0.75) }; }
}

/** Compact, comparable shape of a tool result. */
function signature(result) {
  if (result === null || typeof result !== 'object') return { type: typeof result };
  const sig = { keys: Object.keys(result).filter((k) => k !== 'revision').sort() };
  const counts = {};
  const empties = [];
  for (const [k, v] of Object.entries(result)) {
    if (Array.isArray(v)) { counts[k] = v.length; if (v.length === 0) empties.push(k); }
    else if (typeof v === 'string' && v.length === 0) empties.push(k);
  }
  if (Object.keys(counts).length) sig.counts = counts;
  if (empties.length) sig.empty = empties;
  const text = result.mcpContent?.find?.((b) => b?.type === 'text')?.text;
  if (typeof text === 'string') sig.textLen = text.length;
  if (typeof result.text === 'string') sig.textLen = (sig.textLen ?? 0) + result.text.length;
  if (typeof result.svg === 'string') sig.svgLen = result.svg.length;
  const image = result.image?.data ?? result.mcpContent?.find?.((b) => b?.type === 'image')?.data
    ?? (typeof result.data === 'string' && result.data.length > 200 ? result.data : null);
  if (typeof image === 'string') sig.image = pngInfo(image);
  if (Array.isArray(result.sections)) {
    sig.sections = result.sections.map((s) => ({
      paragraphs: s.paragraphs?.length ?? s.paragraphCount, tables: s.tables?.length ?? 0,
    }));
  }
  if (Array.isArray(result.warnings) && result.warnings.length) sig.warnings = result.warnings.map((w) => String(w).slice(0, 120));
  if (Array.isArray(result.results)) {
    const failed = result.results.filter((item) => item?.error);
    sig.itemErrors = failed.length;
    if (failed.length) sig.itemErrorCodes = failed.map((item) => `${item.tool}: ${trunc(item.error.message ?? item.error.code, 90)}`);
  }
  sig.jsonLen = JSON.stringify(result).length;
  return sig;
}

/** Short JSON of a result with binary payloads elided. */
function excerpt(result, n = 360) {
  const text = JSON.stringify(result, (k, v) => (typeof v === 'string' && v.length > 300 ? `<${v.length} chars>` : v));
  return text && text.length > n ? `${text.slice(0, n)}…` : text;
}

const stripRevision = (r) => JSON.stringify(r, (k, v) => (k === 'revision' || k === 'changeSetId' ? undefined : v));

const trunc = (s, n = 220) => (s && s.length > n ? `${s.slice(0, n)}…` : s);

// ─── per-engine run ─────────────────────────────────────────────

async function startEngine({ label, root, search, hubStart, viteStart }) {
  const harness = await import(path.join(root, 'rhwp/rhwp-studio/e2e/agent-bench-harness.mjs'));
  const hubMod = await import(path.join(root, 'desktop/agent-hub.mjs'));
  const imageMod = await import(path.join(root, 'rhwp/rhwp-agent/insert-image-source.mjs'));
  harness.ensureChromePath();
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), `hv-mcp-${label}-`));
  const { piRoot, finishTurnPath } = harness.writeFakePi(fixtureRoot);
  const hubPort = await harness.findAvailablePort(hubStart);
  const vitePort = await harness.findAvailablePort(viteStart);
  const offline = {
    NODE_USE_ENV_PROXY: '1', HTTPS_PROXY: 'http://127.0.0.1:9', HTTP_PROXY: 'http://127.0.0.1:9',
    NO_PROXY: '127.0.0.1,localhost', npm_config_offline: 'true',
  };
  const ctx = { label, root, search, harness, hubMod, imageMod, fixtureRoot, finishTurnPath, hubPort, vitePort };
  const [hub, vite] = await Promise.all([
    harness.startHub({
      hubPort, token: TOKEN, fixtureRoot, logName: `hv-mcp-parity-${label}-hub.log`,
      env: { RHWP_PI_DIR: piRoot, RHWP_CLI_DIR: path.join(fixtureRoot, 'cli'), ...offline },
    }),
    harness.startVite({ vitePort, hubPort, token: TOKEN, logName: `hv-mcp-parity-${label}-vite.log` }),
  ]);
  ctx.hub = hub; ctx.vite = vite;
  console.log(`  [${label}] hub :${hubPort}, vite :${vitePort}`);
  return ctx;
}

async function stopEngine(ctx) {
  if (!ctx) return;
  try { await ctx.browser?.close(); } catch { /* ignore */ }
  await ctx.harness.stopServer(ctx.vite);
  await ctx.harness.stopServer(ctx.hub);
  ctx.harness.removeTempDir(ctx.fixtureRoot);
}

async function openDoc(page, name) {
  await page.evaluate(async (fileName) => {
    const response = await fetch(`/samples/${encodeURIComponent(fileName)}`);
    if (!response.ok) throw new Error(`Sample load failed: ${response.status}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    const requestId = `hv-${Date.now()}-${Math.random()}`;
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('open-document-bytes timeout')), 30000);
      const off = window.__eventBus.on('open-document-bytes:done', (payload) => {
        if (payload?.requestId !== requestId) return;
        off(); clearTimeout(timer);
        if (payload.ok) resolve(); else reject(new Error(payload.error || 'open failed'));
      });
      window.__eventBus.emit('open-document-bytes', { bytes, fileName, requestId, suppressDialogs: true, skipUnsavedGuard: true });
    });
  }, name);
  await page.waitForFunction(() => window.__wasm?.pageCount > 0, { timeout: 30000 });
}

async function runEngine(ctx, scenario) {
  const { harness, hubMod, label } = ctx;
  const executablePath = process.env.CHROME_PATH || process.env.PUPPETEER_EXECUTABLE_PATH;
  ctx.browser = await puppeteer.launch({
    headless: true, executablePath, protocolTimeout: 60000, args: ['--no-sandbox', '--disable-gpu'],
    handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false,
  });
  const page = await ctx.browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(trunc(String(e?.message ?? e), 200)));
  const t0 = performance.now();
  await page.goto(`http://127.0.0.1:${ctx.vitePort}/${ctx.search}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction(() => Boolean(window.__wasm && window.__agentBridge?.getConnectionState?.() === 'connected'), { timeout: 60000 });
  const engineKind = await page.evaluate(() => window.__wasm?.engineKind ?? null);
  console.log(`  [${label}] app ready in ${Math.round(performance.now() - t0)} ms (engineKind=${engineKind})`);

  const health = await (await fetch(`http://127.0.0.1:${ctx.hubPort}/healthz?token=${TOKEN}`)).json();
  let telemetryRows = 0;
  const readTelemetryRows = async () => {
    const file = path.join(ctx.fixtureRoot, 'tool-telemetry.jsonl');
    try { return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean); } catch { return []; }
  };

  const beginTurn = async () => {
    await page.evaluate(async () => {
      window.__hvTurnStarted = false;
      const unsubscribe = window.__agentBridge.onEvent((event) => {
        if (event.type === 'agent' && event.event.type === 'turn-start') { window.__hvTurnStarted = true; unsubscribe(); }
      });
      await window.__agentBridge.sendUserMessage('Parity turn.');
    });
    await page.waitForFunction(() => window.__hvTurnStarted, { timeout: 15000 });
    const capabilityEpoch = await page.evaluate(() => window.__agentBridge.getWorkflowState().capabilityEpoch);
    const h = await (await fetch(`http://127.0.0.1:${ctx.hubPort}/healthz?token=${TOKEN}`)).json();
    const sessionId = h.sessions?.[0]?.sessionId;
    if (!sessionId) throw new Error('Studio hub session was not registered');
    const capabilities = await hubMod.registerHubSession({ port: ctx.hubPort, token: TOKEN, launchId: health.launchId, sessionId });
    const mcp = connectMcpClient(ctx.hubPort, capabilities.mcp, sessionId, capabilityEpoch, ctx.imageMod.prepareInsertImageArgs);
    await mcp.opened;
    const end = async () => {
      fs.writeFileSync(ctx.finishTurnPath, 'finish');
      for (let i = 0; i < 200; i += 1) {
        const rows = await readTelemetryRows();
        if (rows.length > telemetryRows) { telemetryRows = rows.length; break; }
        await delay(25);
      }
      try {
        await page.waitForFunction(() => !window.__inputHandler?.isUserEditingLocked?.(), { timeout: 15000 });
      } catch { /* recorded through later failures */ }
      try { mcp.ws.close(); } catch { /* ignore */ }
      try { fs.rmSync(ctx.finishTurnPath); } catch { /* ignore */ }
    };
    return { call: mcp.call, end };
  };

  const records = {};
  let revision = null;
  let turn = null;
  const track = (msg) => { if (Number.isInteger(msg?.result?.revision)) revision = msg.result.revision; return msg; };
  const rawCall = async (tool, args) => {
    const start = performance.now();
    const msg = await turn.call(tool, args);
    return { msg: track(msg), ms: Math.round((performance.now() - start) * 10) / 10 };
  };
  // get_structure first (what an agent does); fall back to any read that carries a revision so a
  // broken get_structure does not hide the write tools behind a missing expectedRevision.
  const refresh = async () => {
    for (const [tool, args] of [['get_structure', { maxParagraphs: 1 }], ['get_document_info', {}], ['get_selection', {}]]) {
      const { msg } = await rawCall(tool, args);
      if (msg.ok && Number.isInteger(msg.result?.revision)) { refreshSource = tool; return; }
    }
  };
  let refreshSource = null;

  const setWriteGate = (on) => page.evaluate((enable) => {
    const deps = window.__agentBridge?.executor?.deps;
    if (!deps) throw new Error('executor deps not reachable');
    if (!deps.__hvIsReadOnly) deps.__hvIsReadOnly = deps.isReadOnly;
    deps.isReadOnly = enable ? deps.__hvIsReadOnly : () => false;
  }, on);

  /** Records one tool invocation. `check` = { tool, args, test(result) } for writes. */
  const record = (name, entry) => { (records[name] ??= []).push(entry); };
  const api = {
    label,
    async read(tool, args = {}, { as } = {}) {
      const { msg, ms } = await rawCall(tool, args);
      const entry = { args: summarizeArgs(args), ms, ok: Boolean(msg.ok) };
      if (msg.ok) { entry.sig = signature(msg.result); entry.excerpt = excerpt(msg.result); }
      else entry.error = { code: msg.error?.code ?? 'NO_RESPONSE', message: trunc(msg.error?.message ?? '') };
      record(as ?? tool, entry);
      return msg.ok ? msg.result : null;
    },
    async write(tool, args = {}, { check, as } = {}) {
      if (revision === null) await refresh();
      let diffBefore = null;
      if (check?.diff) {
        const { msg: d } = await rawCall(check.tool, check.args);
        diffBefore = d.ok ? stripRevision(d.result) : null;
      }
      let gated = null;
      if (ctx.bypassWriteGate) {
        // As shipped: the candidate's agent bridge marks every HeemangEngine document read-only.
        await setWriteGate(true);
        const { msg: g } = await rawCall(tool, { ...args, expectedRevision: revision });
        gated = g.ok ? 'ok' : `${g.error?.code}`;
        // Test-only: lift the bridge gate (executor deps, in-page) to reach the engine underneath.
        await setWriteGate(false);
      }
      const before = revision;
      let { msg, ms } = await rawCall(tool, { ...args, expectedRevision: revision });
      if (!msg.ok && msg.error?.code === 'REVISION_MISMATCH') {
        await refresh();
        ({ msg, ms } = await rawCall(tool, { ...args, expectedRevision: revision }));
      }
      const entry = { args: summarizeArgs(args), ms, ok: Boolean(msg.ok) };
      if (gated) entry.shippedGate = gated;
      if (refreshSource && refreshSource !== 'get_structure') entry.revisionFrom = refreshSource;
      if (msg.ok) {
        entry.sig = signature(msg.result);
        entry.excerpt = excerpt(msg.result);
        entry.revisionBumped = Number.isInteger(msg.result?.revision) ? msg.result.revision !== before : null;
        if (check?.self) {
          let pass = false;
          try { pass = Boolean(check.self(msg.result)); } catch { pass = false; }
          entry.reflected = { ok: pass };
        } else if (check?.after) {
          let spec = null;
          try { spec = check.after(msg.result); } catch { spec = null; }
          if (!spec) entry.reflected = { ok: false, error: 'write result lacks an address' };
          else {
            const { msg: c } = await rawCall(spec.tool, spec.args);
            if (!c.ok) entry.reflected = { ok: false, error: `${c.error?.code}: ${trunc(c.error?.message ?? '', 120)}` };
            else { let pass = false; try { pass = Boolean(spec.test(c.result)); } catch { pass = false; } entry.reflected = { ok: pass }; }
          }
        } else if (check?.diff) {
          const { msg: c } = await rawCall(check.tool, check.args);
          if (!c.ok) entry.reflected = { ok: false, error: `${c.error?.code}: ${trunc(c.error?.message ?? '', 120)}` };
          else if (diffBefore === null) entry.reflected = { ok: false, error: 'pre-write read failed' };
          else {
            const after = stripRevision(c.result);
            entry.reflected = { ok: after !== diffBefore };
            if (!entry.reflected.ok) entry.reflected.unchanged = trunc(after, 300);
          }
        } else if (check) {
          const { msg: c } = await rawCall(check.tool, check.args);
          if (!c.ok) entry.reflected = { ok: false, error: `${c.error?.code}: ${trunc(c.error?.message ?? '', 120)}` };
          else {
            let pass = false;
            try { pass = Boolean(check.test(c.result)); } catch { pass = false; }
            entry.reflected = { ok: pass };
          }
        }
      } else {
        entry.error = { code: msg.error?.code ?? 'NO_RESPONSE', message: trunc(msg.error?.message ?? '') };
      }
      record(as ?? tool, entry);
      return msg.ok ? msg.result : null;
    },
    skip(tool, reason) { record(tool, { skipped: reason }); },
  };

  const groups = scenario.groups;
  for (const group of groups) {
    const g0 = performance.now();
    await openDoc(page, SAMPLE);
    await harness.ensureChat(page);
    revision = null;
    turn = await beginTurn();
    try {
      await group.run(api, scenario.context);
    } catch (error) {
      console.error(`  [${label}] group ${group.name} aborted: ${error.message}`);
      record(`__group_${group.name}`, { aborted: trunc(error.message) });
    } finally {
      await turn.end();
    }
    console.log(`  [${label}] group ${group.name} done in ${Math.round(performance.now() - g0)} ms`);
  }
  return { engineKind, records, pageErrors: [...new Set(pageErrors)].slice(0, 20) };
}

function summarizeArgs(args) {
  const out = {};
  for (const [k, v] of Object.entries(args)) {
    if (typeof v === 'string' && v.length > 80) out[k] = `<${v.length} chars>`;
    else out[k] = v;
  }
  return out;
}

// ─── scenario ───────────────────────────────────────────────────

/** Coordinates from the baseline get_structure(json); reused verbatim for the candidate. */
function deriveContext(structure, extras) {
  const section = structure.sections[0];
  const paragraphs = section.paragraphs ?? [];
  const textParas = paragraphs.filter((p) => (p.length ?? p.text?.length ?? 0) >= 12 && p.text
    && !/^\s/.test(p.text) && !/[·…]/.test(p.text) && /[가-힣]{2,}/.test(p.text));
  const textPara = textParas[0]?.paraIdx ?? 0;
  const otherPara = textParas[1]?.paraIdx ?? textPara + 1;
  const listParas = textParas.slice(2, 4).map((p) => p.paraIdx);
  const last = paragraphs[paragraphs.length - 1] ?? { paraIdx: 0, length: 0 };
  const table = (section.tables ?? [])[0] ?? null;
  return {
    textPara, otherPara,
    textParaText: textParas[0]?.text ?? '',
    listStart: listParas[0] ?? otherPara, listEnd: listParas[1] ?? otherPara,
    lastPara: last.paraIdx ?? paragraphs.length - 1, lastLen: last.length ?? last.text?.length ?? 0,
    table: table ? { paraIdx: table.paraIdx, controlIdx: table.controlIdx, rowCount: table.rowCount, colCount: table.colCount } : null,
    findWord: /[가-힣]{2,}/.exec(textParas[0]?.text ?? '')?.[0] ?? '사업',
    tablesCount: (section.tables ?? []).length,
    ...extras,
  };
}

const s = (o) => JSON.stringify(o ?? null);
/** Addresses only the baseline could read back (created table, inserted footnote/image), reused by the candidate. */
const learned = {};
const paraText = (r) => (r?.text ?? r?.mcpContent?.[0]?.text ?? s(r));

const scenario = {
  context: null,
  groups: [
    {
      name: 'reads',
      async run(t, c) {
        await t.read('get_structure', {}, { as: 'get_structure' });
        await t.read('get_structure', { format: 'json' }, { as: 'get_structure#json' });
        await t.read('get_text_range', { sectionIdx: 0, paraIdx: c.textPara });
        await t.read('get_selection', {});
        await t.read('get_fields', {});
        await t.read('get_document_info', { fontQuery: ['함초롬바탕', '맑은 고딕'] });
        await t.read('materialize_document_snapshot', {});
        await t.read('find_text', { query: c.findWord });
        await t.read('render_page', { pageIndex: 0 }, { as: 'render_page' });
        await t.read('render_page', { pageIndex: 0, format: 'svg' }, { as: 'render_page#svg' });
        await t.read('render_page', { pageIndex: 0, regionMm: { x: 10, y: 10, width: 80, height: 60 } }, { as: 'render_page#region' });
        await t.read('get_page_geometry', { pageIndex: 0, include: ['lines', 'runs', 'objects'] });
        await t.read('get_para_format', { sectionIdx: 0, paraIdx: c.textPara });
        await t.read('get_char_format', { sectionIdx: 0, paraIdx: c.textPara, charOffset: 1 });
        if (c.table) {
          await t.read('get_table_properties', { sectionIdx: 0, paraIdx: c.table.paraIdx, controlIdx: c.table.controlIdx });
          await t.read('get_table_layout', { sectionIdx: 0, paraIdx: c.table.paraIdx, controlIdx: c.table.controlIdx });
        } else {
          t.skip('get_table_properties', 'no table in sample'); t.skip('get_table_layout', 'no table in sample');
        }
        await t.read('get_engine_edit_capabilities', {});
        await t.read('get_engine_edit_capabilities', { query: 'insertText', detail: true }, { as: 'get_engine_edit_capabilities#detail' });
        await t.read('read_batch', { reads: [
          { tool: 'get_structure', args: {} }, { tool: 'list_styles', args: {} },
          { tool: 'get_para_format', args: { sectionIdx: 0, paraIdx: c.textPara } },
        ] });
        await t.read('list_styles', {});
        await t.read('list_numberings', {});
        await t.read('preview_equation', { script: 'a over b + sqrt {x}' });
        await t.read('get_outline', {});
        await t.read('list_footnotes', {});
        await t.read('list_bookmarks', {});
        await t.read('list_documents', {});
        const template = await t.read('get_active_template', {});
        const templateRevision = template?.templateRevision ?? template?.revision ?? 1;
        await t.read('template_get_page_layout', { templateRevision, sectionIdx: 0 });
        await t.read('verify_changes', {}, { as: 'verify_changes#clean' });
      },
    },
    {
      name: 'text',
      async run(t, c) {
        const p = c.textPara;
        const range = { tool: 'get_text_range', args: { sectionIdx: 0, paraIdx: p } };
        await t.write('insert_text', { sectionIdx: 0, paraIdx: p, charOffset: 0, text: 'MCPX1 ' },
          { check: { ...range, test: (r) => paraText(r).includes('MCPX1') } });
        await t.write('replace_range', { sectionIdx: 0, startParaIdx: p, startCharOffset: 0, endParaIdx: p, endCharOffset: 5, text: 'MCPY1' },
          { check: { ...range, test: (r) => paraText(r).includes('MCPY1') } });
        await t.write('delete_range', { sectionIdx: 0, startParaIdx: p, startCharOffset: 0, endParaIdx: p, endCharOffset: 6 },
          { check: { ...range, test: (r) => !paraText(r).includes('MCPY1') } });
        await t.write('apply_char_format', { sectionIdx: 0, paraIdx: p, startOffset: 0, endOffset: 4, bold: true, textColor: '#C00000' },
          { check: { tool: 'get_char_format', args: { sectionIdx: 0, paraIdx: p, charOffset: 1 }, test: (r) => r.bold === true || s(r).includes('"bold":true') } });
        await t.write('apply_para_format', { sectionIdx: 0, paraIdx: p, alignment: 'center', spaceAfterPt: 6 },
          { check: { tool: 'get_para_format', args: { sectionIdx: 0, paraIdx: p }, test: (r) => s(r).includes('center') } });
        // textPara is body text; otherPara is often already a heading in the target style.
        await t.write('apply_style', { sectionIdx: 0, paraIdx: p, styleId: c.styleId },
          { check: { diff: true, tool: 'read_batch', args: { reads: [
            { tool: 'get_para_format', args: { sectionIdx: 0, paraIdx: p, full: true } },
            { tool: 'get_char_format', args: { sectionIdx: 0, paraIdx: p, charOffset: 0, full: true } },
          ] } } });
        await t.write('apply_list', { sectionIdx: 0, startParaIdx: c.listStart, endParaIdx: c.listEnd, format: '1.' },
          { check: { tool: 'get_para_format', args: { sectionIdx: 0, paraIdx: c.listStart }, test: (r) => s(r).includes('number') } });
        await t.write('replace_all', { query: c.findWord, replacement: `${c.findWord}Z` },
          { check: { tool: 'find_text', args: { query: `${c.findWord}Z` }, test: (r) => (r.matches?.length ?? r.count ?? 0) > 0 } });
        await t.write('apply_edits', { edits: [
          { tool: 'insert_text', args: { sectionIdx: 0, paraIdx: p, charOffset: 0, text: 'BATCH1 ' } },
          { tool: 'apply_char_format', args: { sectionIdx: 0, paraIdx: p, startOffset: 0, endOffset: 6, italic: true } },
        ] }, { check: { ...range, test: (r) => paraText(r).includes('BATCH1') } });
        await t.write('apply_engine_edits', { operations: [{ method: 'insertText', args: [0, p, 0, 'ENG1 '] }] },
          { check: { ...range, test: (r) => paraText(r).includes('ENG1') } });
        if (c.sessionMethod) {
          const args = c.sessionMethod.method === 'copyControl' && c.table ? [0, c.table.paraIdx, c.table.controlIdx] : c.sessionMethod.args;
          await t.write('prepare_engine_edit_session', { method: c.sessionMethod.method, args },
            { check: { self: (r) => /prepared/.test(r.status ?? '') && r.result?.parsedJson?.ok !== false } });
        } else t.skip('prepare_engine_edit_session', 'no session method in baseline capabilities');
        await t.write('insert_hyperlink', { sectionIdx: 0, paraIdx: p, charOffset: 0, url: 'https://example.com', text: 'LINK1 ' },
          { check: { ...range, test: (r) => paraText(r).includes('LINK1') } });
        await t.write('set_bookmark', { op: 'add', name: 'hvbm1', sectionIdx: 0, paraIdx: p, charOffset: 0 },
          { check: { tool: 'list_bookmarks', args: {}, test: (r) => s(r).includes('hvbm1') } });
        const notesBefore = c.footnoteCount;
        await t.write('insert_footnote', { sectionIdx: 0, paraIdx: p, charOffset: 2, text: 'FNOTE1' },
          { check: { tool: 'list_footnotes', args: {}, test: (r) => (r.footnotes ?? r.notes ?? []).length > notesBefore || s(r).includes('FNOTE1') } });
        const notes = await t.read('list_footnotes', {}, { as: 'list_footnotes#after' });
        const note = (notes?.footnotes ?? notes?.notes ?? []).find((n) => n.sourceType === 'body') ?? c.footnote ?? learned.footnote;
        if (t.label === 'baseline' && note) learned.footnote = note;
        if (note) {
          await t.write('edit_footnote', { sectionIdx: note.sectionIdx, paraIdx: note.paraIdx, controlIdx: note.controlIdx, text: 'FNEDIT' },
            { check: { tool: 'list_footnotes', args: {}, test: (r) => s(r).includes('FNEDIT') } });
        } else t.skip('edit_footnote', 'no footnote address');
        if (c.field) {
          await t.write('set_field_value', { name: c.field.name, value: 'FIELDV' },
            { check: { tool: 'get_fields', args: {}, test: (r) => s(r).includes('FIELDV') } });
        } else {
          await t.write('set_field_value', { name: 'hv-missing-field', value: 'FIELDV' });
        }
        await t.write('insert_page_break', { sectionIdx: 0, paraIdx: c.otherPara },
          { check: { tool: 'get_document_info', args: {}, test: (r) => (r.pageCount ?? 0) > c.pageCount } });
        await t.read('verify_changes', { includeImage: true }, { as: 'verify_changes#after-writes' });
        // commit_version takes no expectedRevision (strict schema).
        await t.read('commit_version', { message: 'parity check' });
      },
    },
    {
      name: 'tables',
      async run(t, c) {
        if (!c.table) { for (const n of ['set_table_props', 'set_cell_props', 'set_zone_borders', 'edit_table']) t.skip(n, 'no table in sample'); }
        else {
          const addr = { sectionIdx: 0, paraIdx: c.table.paraIdx, controlIdx: c.table.controlIdx };
          const props = { tool: 'get_table_properties', args: { ...addr, full: true } };
          await t.write('set_table_props', { ...addr, tableProps: { repeatHeader: true, pageBreak: 'row' } },
            { check: { ...props, test: (r) => s(r).includes('"repeatHeader":true') } });
          await t.write('set_cell_props', { ...addr, cellIdx: 0, cellProps: { fillColor: '#FFEECC', verticalAlign: 'center' } },
            { check: { tool: 'get_table_properties', args: { ...addr, cellIdx: 0, full: true }, test: (r) => /ffeecc/i.test(s(r)) } });
          await t.write('set_zone_borders', { ...addr, startCell: { row: 0, col: 0 }, endCell: { row: 0, col: Math.max(0, c.table.colCount - 1) },
            borderBottom: { type: 1, width: 2, color: '#000000' } },
          { check: { diff: true, tool: 'get_table_properties', args: { ...addr, cellIdx: 0, full: true } } });
          await t.write('edit_table', { ...addr, op: 'insert_row', rowIdx: c.table.rowCount - 1, below: true },
            { check: { ...props, test: (r) => s(r).includes(`"rowCount":${c.table.rowCount + 1}`) } });
          await t.write('edit_table', { ...addr, op: 'set_caption', text: 'HV caption' },
          { as: 'edit_table#set_caption', check: { diff: true, tool: 'get_table_properties', args: { ...addr, full: true } } });
        }
        const created = await t.write('create_table', { sectionIdx: 0, paraIdx: c.lastPara, charOffset: c.lastLen, rows: 2, cols: 2, cells: [['A1', 'B1'], ['A2', 'B2']] },
          { check: { tool: 'get_structure', args: { format: 'json' }, test: (r) => (r.sections[0].tables ?? []).length > c.tablesCount } });
        const st = await t.read('get_structure', { format: 'json' }, { as: 'get_structure#json-after-create' });
        const newTable = (st?.sections?.[0]?.tables ?? []).find((tb) => s(tb).includes('A1') && s(tb).includes('B2'))
          ?? (created?.table && Number.isInteger(created.table.paraIdx) ? created.table : null)
          ?? learned.createdTable;
        if (t.label === 'baseline' && newTable) learned.createdTable = { paraIdx: newTable.paraIdx, controlIdx: newTable.controlIdx };
        if (newTable) {
          await t.write('delete_table', { sectionIdx: 0, paraIdx: newTable.paraIdx, controlIdx: newTable.controlIdx },
            { check: { tool: 'get_structure', args: { format: 'json' }, test: (r) => !s(r.sections[0].tables).includes('B2') } });
        } else t.skip('delete_table', 'create_table did not produce a table to delete');
      },
    },
    {
      name: 'objects',
      async run(t, c) {
        const p = c.textPara;
        const img = await t.write('insert_image', {
          sectionIdx: 0, paraIdx: p, charOffset: 0, imageBase64: solidPngBase64(64, 40, [90, 140, 90]), extension: 'png',
          widthMm: 40, heightMm: 25, description: 'hv parity image',
        }, { check: { tool: 'get_page_geometry', args: { pageIndex: c.textParaPage ?? 0, include: ['objects'] }, test: (r) => (r.objects?.length ?? 0) > (c.objectCount ?? 0) } });
        const geo = await t.read('get_structure', { format: 'json', range: { sectionIdx: 0, fromPara: p, toPara: p } }, { as: 'get_structure#json-after-image' });
        const ctrls = s(geo).match(/"controlIdx":(\d+)/);
        const imgAddr = img?.image && Number.isInteger(img.image.controlIdx)
          ? { paraIdx: img.image.paraIdx ?? p, controlIdx: img.image.controlIdx }
          : (ctrls ? { paraIdx: p, controlIdx: Number(ctrls[1]) } : learned.image ?? { paraIdx: p, controlIdx: 0 });
        if (t.label === 'baseline') learned.image = imgAddr;
        await t.write('edit_object', { sectionIdx: 0, ...imgAddr, widthMm: 50, heightMm: 31, keepAspect: false },
          { check: { self: (r) => r.after != null } });
        await t.write('insert_equation', { sectionIdx: 0, paraIdx: c.otherPara, charOffset: 0, script: 'x = {-b +- sqrt {b^2 - 4ac}} over {2a}' },
          { check: { tool: 'get_text_range', args: { sectionIdx: 0, paraIdx: c.otherPara }, test: (r) => s(r).length > 0 } });
        await t.write('insert_shape', { sectionIdx: 0, paraIdx: c.otherPara, shape: 'rectangle', widthMm: 30, heightMm: 15, fillColor: '#DDEEFF' },
          { check: { after: (r) => {
            const o = r.shape ?? r.chart; const page = r.after?.pages?.[0] ?? 0;
            return { tool: 'get_page_geometry', args: { pageIndex: page, include: ['objects'] },
              test: (g) => (g.objects ?? []).some((x) => x.paraIdx === (o.paraIdx) && (x.controlIdx ?? x.ctrlIdx) === o.controlIdx) };
          } } });
        await t.write('insert_chart', { sectionIdx: 0, paraIdx: c.lastPara, charOffset: c.lastLen,
          spec: { type: 'bar', title: 'HV', categories: ['a', 'b', 'c'], series: [{ name: 's1', values: [1, 3, 2] }] }, widthMm: 80, heightMm: 50 },
          { check: { after: (r) => {
            const o = r.shape ?? r.chart; const page = r.after?.pages?.[0] ?? 0;
            return { tool: 'get_page_geometry', args: { pageIndex: page, include: ['objects'] },
              test: (g) => (g.objects ?? []).some((x) => x.paraIdx === (o.paraIdx) && (x.controlIdx ?? x.ctrlIdx) === o.controlIdx) };
          } } });
        await t.write('edit_header_footer', { sectionIdx: 0, which: 'header', lines: ['HDR-HV'] },
          { check: { diff: true, tool: 'render_page', args: { pageIndex: 1, regionMm: { x: 0, y: 0, width: 210, height: 40 } } } });
        await t.write('edit_header_footer', { sectionIdx: 0, which: 'footer', pageNumber: { template: '- {n} -', align: 'center' } },
          { as: 'edit_header_footer#pagenum', check: { diff: true, tool: 'render_page', args: { pageIndex: 1, regionMm: { x: 0, y: 257, width: 210, height: 40 } } } });
        await t.write('set_page_layout', { sectionIdx: 0, marginsMm: { left: 25, right: 25 } },
          { check: { tool: 'get_page_geometry', args: { pageIndex: 0 }, test: (r) => /25(\.0+)?\b/.test(s(r)) } });
        const tr = c.templateRevision;
        await t.write('template_apply_section_layout', { templateRevision: tr, mappings: [{ templateSectionIdx: 0, targetSectionIdx: 0 }] });
        await t.write('template_apply_paragraph_format', { templateRevision: tr, source: { sectionIdx: 0, paraIdx: 0 }, targets: [{ sectionIdx: 0, paraIdx: p }] });
        await t.write('template_insert_block', { templateRevision: tr, source: { sectionIdx: 0, startParaIdx: 0, endParaIdx: 0 }, target: { sectionIdx: 0, paraIdx: c.lastPara, charOffset: 0 } });
        await t.read('verify_changes', { full: true }, { as: 'verify_changes#objects' });
        await t.read('render_page', { pageIndex: 0 }, { as: 'render_page#after-edits' });
      },
    },
  ],
};

/** Baseline-only discovery pass: coordinates and addresses used by every later call. */
const discoveryGroup = {
  name: 'discover',
  async run(t) {
    const st = await t.read('get_structure', { format: 'json' }, { as: '__discover_structure' });
    const styles = await t.read('list_styles', {}, { as: '__discover_styles' });
    const notes = await t.read('list_footnotes', {}, { as: '__discover_footnotes' });
    const fields = await t.read('get_fields', {}, { as: '__discover_fields' });
    const info = await t.read('get_document_info', {}, { as: '__discover_info' });
    const caps = await t.read('get_engine_edit_capabilities', { detail: true }, { as: '__discover_caps' });
    const tmpl = await t.read('get_active_template', {}, { as: '__discover_template' });
    const style = (styles?.styles ?? []).find((x) => x.id > 0 && /개요 1|Outline 1/.test(x.name)) ?? (styles?.styles ?? []).find((x) => x.id > 0);
    const noteList = notes?.footnotes ?? notes?.notes ?? [];
    scenario.discovered = {
      st, styleId: style?.id ?? 1, styleName: style?.name,
      footnoteCount: noteList.length, footnote: noteList.find((n) => n.sourceType === 'body') ?? null,
      field: (fields?.fields ?? []).find((f) => f.name) ?? null,
      pageCount: info?.pageCount ?? 1,
      templateRevision: tmpl?.templateRevision ?? 1,
      caps,
    };
  },
};

function pickSessionMethod(caps) {
  const text = s(caps);
  // Prefer a selection/copy setup that needs only coordinates.
  const m = /"(copySelection|copyRange|copyText|copyControl)"/.exec(text);
  return m ? m[1] : null;
}

// ─── verdicts ───────────────────────────────────────────────────

function verdictFor(b, c) {
  if (!b || !c) return { verdict: 'missing' };
  if (b.skipped || c.skipped) return { verdict: 'skipped', reason: b.skipped ?? c.skipped };
  if (!b.ok && !c.ok) return { verdict: 'both-fail' };
  if (b.ok && !c.ok) return { verdict: 'candidate-fails' };
  if (!b.ok && c.ok) return { verdict: 'candidate-better' };
  const reasons = [];
  const better = [];
  if (b.reflected?.ok && c.reflected && !c.reflected.ok) reasons.push(`write not reflected${c.reflected.error ? ` (${c.reflected.error})` : ''}`);
  if (b.reflected && !b.reflected.ok && c.reflected?.ok) better.push('write reflected (baseline not)');
  const bk = new Set(b.sig?.keys ?? []);
  const ck = new Set(c.sig?.keys ?? []);
  const missing = [...bk].filter((k) => !ck.has(k));
  if (missing.length) reasons.push(`missing keys: ${missing.join(',')}`);
  for (const [k, n] of Object.entries(b.sig?.counts ?? {})) {
    if (k === 'warnings') continue;
    const cn = c.sig?.counts?.[k];
    if (n > 0 && (cn ?? 0) === 0) reasons.push(`${k} empty (baseline ${n})`);
    else if (cn !== undefined && n > 0 && cn < n * 0.5) reasons.push(`${k} ${cn} vs ${n}`);
  }
  if ((b.sig?.textLen ?? 0) > 0 && (c.sig?.textLen ?? 0) < b.sig.textLen * 0.5) reasons.push(`text ${c.sig?.textLen ?? 0} vs ${b.sig.textLen} chars`);
  if ((b.sig?.svgLen ?? 0) > 0 && (c.sig?.svgLen ?? 0) < b.sig.svgLen * 0.2) reasons.push(`svg ${c.sig?.svgLen ?? 0} vs ${b.sig.svgLen}`);
  if ((c.sig?.itemErrors ?? 0) > (b.sig?.itemErrors ?? 0)) reasons.push(`batch item errors ${c.sig.itemErrors} vs ${b.sig?.itemErrors ?? 0}: ${c.sig.itemErrorCodes.join(' / ')}`);
  if (b.sig?.image && !c.sig?.image) reasons.push('image missing');
  if (b.sig?.image && c.sig?.image && c.sig.image.bytes < b.sig.image.bytes * 0.2) reasons.push(`image ${c.sig.image.bytes} vs ${b.sig.image.bytes} bytes`);
  if (b.sig?.sections && c.sig?.sections && s(b.sig.sections) !== s(c.sig.sections)) reasons.push(`sections ${s(c.sig.sections)} vs ${s(b.sig.sections)}`);
  if (c.ms > b.ms * 3 && c.ms - b.ms > 30) reasons.push(`slower ${c.ms} vs ${b.ms} ms`);
  if (reasons.length) return { verdict: 'candidate-poorer', reason: reasons.join('; ') };
  if (better.length) return { verdict: 'candidate-better', reason: better.join('; ') };
  return { verdict: 'parity' };
}

const cell = (e) => {
  if (!e) return '—';
  if (e.skipped) return `skip: ${e.skipped}`;
  const gate = e.shippedGate && e.shippedGate !== 'ok' ? ` [shipped: ${e.shippedGate}]` : '';
  if (!e.ok) return `ERR ${e.error.code}: ${trunc(e.error.message, 90)}${gate}`;
  const bits = [`ok ${e.ms}ms`];
  if (e.reflected) bits.push(e.reflected.ok ? 'reflected' : 'NOT reflected');
  if (e.sig?.image) bits.push(`img ${e.sig.image.width ?? '?'}x${e.sig.image.height ?? '?'} ${Math.round(e.sig.image.bytes / 1024)}KB`);
  if (e.sig?.textLen) bits.push(`text ${e.sig.textLen}`);
  if (e.sig?.svgLen) bits.push(`svg ${e.sig.svgLen}`);
  return bits.join(', ') + gate;
};
const md = (x) => String(x).replace(/\|/g, '\\|').replace(/\n/g, ' ');

// ─── main ───────────────────────────────────────────────────────

const started = performance.now();
let baseline = null;
let candidate = null;
let exitCode = 0;
try {
  if (!fs.existsSync(path.join(BASELINE_ROOT, 'rhwp/pkg/rhwp_bg.wasm'))) throw new Error(`baseline wasm not built: ${BASELINE_ROOT}/rhwp/pkg`);
  ensureCandidatePkg();
  const { filterToolDefinitions } = await import(path.join(CANDIDATE_ROOT, 'rhwp/rhwp-agent/tools.mjs'));
  const toolNames = filterToolDefinitions('direct').map((d) => d.name);

  [baseline, candidate] = await Promise.all([
    startEngine({ label: 'baseline', root: BASELINE_ROOT, search: '', hubStart: 5890, viteStart: 7890 }),
    startEngine({ label: 'candidate', root: CANDIDATE_ROOT, search: '?engine=heemang', hubStart: 5920, viteStart: 7920 }),
  ]);

  // Baseline: discovery first, then the scenario. Candidate reuses the baseline coordinates.
  const baseRun = await runEngine(baseline, {
    context: null,
    groups: [discoveryGroup, ...scenario.groups.map((g) => ({ ...g, run: (t) => {
      if (!scenario.context) {
        const d = scenario.discovered;
        if (!d?.st) throw new Error('baseline discovery failed: no get_structure');
        scenario.context = deriveContext(d.st, {
          styleId: d.styleId, styleName: d.styleName, footnoteCount: d.footnoteCount, footnote: d.footnote,
          field: d.field, pageCount: d.pageCount, templateRevision: d.templateRevision,
          sessionMethod: (() => { const m = pickSessionMethod(d.caps); return m ? { method: m, args: [] } : null; })(),
        });
        console.log(`  [context] ${s({ ...scenario.context, textParaText: trunc(scenario.context.textParaText, 40) })}`);
      }
      return g.run(t, scenario.context);
    } }))],
  });
  candidate.bypassWriteGate = true;
  const candRun = await runEngine(candidate, { context: scenario.context, groups: scenario.groups });

  // Merge per tool (each invocation variant is its own row).
  const rows = [];
  const engineTools = new Set();
  for (const name of toolNames) {
    if (ENGINE_INDEPENDENT.test(name)) { rows.push({ tool: name, verdict: 'skipped', reason: 'engine-independent' }); continue; }
    engineTools.add(name);
    const variants = new Set([...Object.keys(baseRun.records), ...Object.keys(candRun.records)]
      .filter((k) => k === name || k.startsWith(`${name}#`)));
    if (variants.size === 0) { rows.push({ tool: name, verdict: 'not-exercised' }); continue; }
    for (const key of [...variants].sort()) {
      const bList = baseRun.records[key] ?? [];
      const cList = candRun.records[key] ?? [];
      const n = Math.max(bList.length, cList.length);
      for (let i = 0; i < n; i += 1) {
        const b = bList[i]; const c = cList[i];
        const v = verdictFor(b, c);
        rows.push({ tool: n > 1 ? `${key}[${i}]` : key, ...v, baseline: b ?? null, candidate: c ?? null });
      }
    }
  }
  for (const key of Object.keys(candRun.records)) if (key.startsWith('__group_')) rows.push({ tool: key, verdict: 'candidate-aborted', candidate: candRun.records[key] });
  for (const key of Object.keys(baseRun.records)) if (key.startsWith('__group_')) rows.push({ tool: key, verdict: 'baseline-aborted', baseline: baseRun.records[key] });

  const counts = {};
  for (const r of rows) counts[r.verdict] = (counts[r.verdict] ?? 0) + 1;
  const errorGroups = {};
  for (const r of rows) {
    if (r.verdict !== 'candidate-fails') continue;
    const key = `${r.candidate.error.code}: ${r.candidate.error.message}`;
    (errorGroups[key] ??= []).push(r.tool);
  }
  const shippedGate = {};
  for (const r of rows) {
    const g = r.candidate?.shippedGate;
    if (g) (shippedGate[g] ??= []).push(r.tool);
  }
  const output = {
    generatedAt: new Date().toISOString(), sample: SAMPLE,
    runtimeMs: Math.round(performance.now() - started),
    baseline: { root: BASELINE_ROOT, url: '/', engineKind: baseRun.engineKind, pageErrors: baseRun.pageErrors },
    candidate: { root: CANDIDATE_ROOT, url: '/?engine=heemang', engineKind: candRun.engineKind, pageErrors: candRun.pageErrors },
    context: { ...scenario.context, textParaText: trunc(scenario.context?.textParaText, 60) },
    counts, candidateErrorGroups: errorGroups,
    // Candidate writes are first sent as shipped (bridge marks HeemangEngine read-only), then with the
    // gate lifted in-page; verdicts use the ungated call.
    candidateShippedWriteGate: shippedGate,
    rows,
    discovery: Object.fromEntries(Object.entries(baseRun.records).filter(([k]) => k.startsWith('__discover'))),
  };
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const gi = path.join(__dirname, '.gitignore');
  if (!fs.existsSync(gi)) fs.writeFileSync(gi, 'out/\n');
  fs.writeFileSync(path.join(OUT_DIR, 'mcp-parity.json'), `${JSON.stringify(output, null, 2)}\n`);

  console.log('\n| tool | baseline | candidate | verdict |\n| --- | --- | --- | --- |');
  for (const r of rows) {
    console.log(`| ${md(r.tool)} | ${md(r.baseline ? cell(r.baseline) : (r.verdict === 'skipped' ? '—' : '—'))} | ${md(r.candidate ? cell(r.candidate) : '—')} | ${md(r.verdict + (r.reason && r.verdict !== 'skipped' ? ` (${r.reason})` : (r.verdict === 'skipped' ? ` (${r.reason})` : '')))} |`);
  }
  console.log(`\ncounts: ${s(counts)}`);
  console.log(`candidate writes as shipped (before lifting the read-only gate): ${s(Object.fromEntries(Object.entries(shippedGate).map(([k, v]) => [k, v.length])))}`);
  console.log(`candidate error groups (gate lifted):`);
  for (const [k, v] of Object.entries(errorGroups)) console.log(`  - ${k}\n      ${v.join(', ')}`);
  console.log(`\nwrote ${path.join(OUT_DIR, 'mcp-parity.json')} in ${(output.runtimeMs / 1000).toFixed(1)} s`);
} catch (error) {
  console.error('mcp-parity failed:', error?.stack ?? error);
  exitCode = 1;
} finally {
  await Promise.all([stopEngine(baseline), stopEngine(candidate)]);
}
process.exit(exitCode);
