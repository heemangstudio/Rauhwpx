/**
 * 실제 프로바이더 실측 공용 — agent-claude-live-bench.mjs 와 agent-live-suite.mjs 가 같이 쓴다.
 *
 *   사이드바 입력창 → 브리지 → 허브 → 프로바이더 CLI(claude|codex|pi) → MCP → 허브 → 스튜디오 → wasm
 *
 * 허브는 RHWP_TOOL_TRACE=1 로 띄우고, 사용자 앱 상태(관리형 CLI, Pi 루트)는 임시 픽스처로 격리한다.
 * pi 는 픽스처 Pi 루트를 미리 채운다 — prefix 는 사용자가 설치한 Pi 를 심볼릭 링크로 빌리고,
 * OpenRouter 키는 OPENROUTER_API_KEY 또는 ~/.env 에서 읽어 agent/models.json(0600)에 넣는다.
 * 키는 로그나 결과에 남기지 않는다.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { ensureChromePath, findAvailablePort, removeTempDir, startHub, startVite, stats, stopServer } from '../e2e/agent-bench-harness.mjs';
import { analyzeProviderTurn, joinCalls, maxOverlap, readTraceRows, round } from './tool-trace-analysis.mjs';

export const arg = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? null;

const QUESTION_TOOL = /^(AskUserQuestion|ask_user_question|mcp__rhwp__ask_user_question)$/;

// ─────────────────────────────────────────────────────────────────────────────
// Pi 픽스처
// ─────────────────────────────────────────────────────────────────────────────

export function defaultUserPiRoot() {
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'rhwp', 'pi');
  if (process.platform === 'win32') return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'rhwp', 'pi');
  return path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'rhwp', 'pi');
}

/** OPENROUTER_API_KEY 환경 변수, 없으면 ~/.env 의 OPENROUTER_API_KEY="…" 줄. 값은 절대 출력하지 않는다. */
export function loadOpenRouterKey() {
  const fromEnv = process.env.OPENROUTER_API_KEY?.trim();
  if (fromEnv) return fromEnv;
  try {
    const text = fs.readFileSync(path.join(os.homedir(), '.env'), 'utf8');
    for (const line of text.split('\n')) {
      const match = /^\s*(?:export\s+)?OPENROUTER_API_KEY\s*=\s*(.*)\s*$/.exec(line);
      if (!match) continue;
      const value = match[1].trim().replace(/^(['"])(.*)\1$/, '$2').trim();
      if (value) return value;
    }
  } catch { /* ~/.env 없음 */ }
  return null;
}

/** OpenRouter 카탈로그에서 모델 메타데이터(가격·문맥·추론 지원)를 읽는다. */
export async function fetchOpenRouterModel(id, key) {
  const response = await fetch('https://openrouter.ai/api/v1/models', {
    headers: key ? { Authorization: `Bearer ${key}` } : {},
  });
  if (!response.ok) throw new Error(`OpenRouter 모델 목록을 읽지 못했습니다 (HTTP ${response.status})`);
  const body = await response.json();
  const model = (body?.data ?? []).find((entry) => entry.id === id);
  if (!model) throw new Error(`OpenRouter 에 없는 모델입니다: ${id}`);
  const params = new Set(model.supported_parameters ?? []);
  return {
    id: model.id,
    name: model.name ?? model.id,
    reasoning: params.has('reasoning') || params.has('include_reasoning'),
    supportsImages: (model.architecture?.input_modalities ?? []).includes('image'),
    contextLength: model.context_length ?? model.top_provider?.context_length ?? null,
    maxCompletionTokens: model.top_provider?.max_completion_tokens ?? null,
    // 토큰 1개당 USD
    pricing: {
      prompt: Number(model.pricing?.prompt) || 0,
      completion: Number(model.pricing?.completion) || 0,
      cacheRead: Number(model.pricing?.input_cache_read) || 0,
      cacheWrite: Number(model.pricing?.input_cache_write) || 0,
    },
  };
}

/**
 * 픽스처 Pi 루트를 pi-manager 가 읽는 모양으로 채운다 (config.json + agent/models.json).
 * 허브는 기동 시 syncAssets 로 settings.json 을 쓰고 models.json 을 다시 만든다(키는 보존).
 * 확장·스킬은 스폰마다 앱 번들 경로로 넘어가므로 픽스처에 둘 필요가 없다.
 * 사용자 Pi 루트는 읽기만 한다 — prefix 는 심볼릭 링크라 허브의 자동 갱신도 링크 자체만 바꾼다.
 */
export async function seedPiFixture({ piRoot, modelId, userPiRoot = process.env.RHWP_BENCH_PI_SOURCE || defaultUserPiRoot() }) {
  const userPrefix = path.join(userPiRoot, 'prefix');
  const userBin = path.join(userPrefix, 'node_modules', '.bin', process.platform === 'win32' ? 'pi.cmd' : 'pi');
  const manifest = path.join(userPrefix, 'node_modules', '@earendil-works', 'pi-coding-agent', 'package.json');
  if (!fs.existsSync(userBin) || !fs.existsSync(manifest)) {
    throw new Error(`Pi 가 설치돼 있지 않습니다: ${userBin} 가 없습니다. 앱 설정에서 Pi 를 설치하거나 RHWP_BENCH_PI_SOURCE=<Pi 루트> 를 지정하세요.`);
  }
  const version = JSON.parse(fs.readFileSync(manifest, 'utf8')).version;
  const key = loadOpenRouterKey();
  if (!key) throw new Error('OpenRouter 키가 없습니다: OPENROUTER_API_KEY 를 설정하거나 ~/.env 에 OPENROUTER_API_KEY="…" 줄을 넣으세요.');
  const meta = await fetchOpenRouterModel(modelId, key);

  fs.mkdirSync(path.join(piRoot, 'agent'), { recursive: true });
  fs.mkdirSync(path.join(piRoot, 'sessions'), { recursive: true });
  fs.symlinkSync(userPrefix, path.join(piRoot, 'prefix'), 'dir');
  const efforts = meta.reasoning ? ['low', 'medium', 'high'] : [];
  fs.writeFileSync(path.join(piRoot, 'config.json'), `${JSON.stringify({
    version: 1,
    installedVersion: version,
    keyTail: key.slice(-4),
    models: [{
      id: meta.id,
      name: meta.name,
      reasoning: meta.reasoning,
      supportsImages: meta.supportsImages,
      efforts,
      defaultEffort: efforts.length ? 'medium' : null,
      contextLength: meta.contextLength,
      pricing: { prompt: meta.pricing.prompt, completion: meta.pricing.completion },
    }],
    defaultModelId: meta.id,
    setupComplete: true,
  }, null, 2)}\n`, { mode: 0o600 });
  // 데스크톱 금고가 없는 독립 허브는 legacy 경로(models.json 의 apiKey)로 키를 읽는다.
  fs.writeFileSync(path.join(piRoot, 'agent', 'models.json'), `${JSON.stringify({
    providers: { openrouter: { apiKey: key } },
  }, null, 2)}\n`, { mode: 0o600 });
  return { piRoot, sessionsDir: path.join(piRoot, 'sessions'), version, model: meta };
}

// ─────────────────────────────────────────────────────────────────────────────
// 허브 + vite
// ─────────────────────────────────────────────────────────────────────────────

/** 이 세션을 띄운 Claude Code 의 환경 변수가 허브 → claude 자식에 새지 않게 뺀다. */
const dropEnv = (key) => key === 'CLAUDECODE' || key.startsWith('CLAUDE_CODE_') || key === 'CLAUDE_PID'
  || key === 'CLAUDE_EFFORT' || key === 'CLAUDE_AGENT_SDK_VERSION';

/**
 * 격리된 허브와 vite 를 띄운다. 반환한 stop() 은 서버를 내리고 픽스처를 지운다.
 * helpers.mjs 는 로드 시점에 VITE_URL 을 고정하므로 이 함수 뒤에 import 해야 한다.
 */
export async function startLiveStack({ agent, model, tag = 'live' }) {
  ensureChromePath();
  const token = `${tag}-${process.pid}`;
  const hubPort = await findAvailablePort(Number(process.env.RHWP_AGENT_PORT || '5781'));
  const vitePort = await findAvailablePort(Number(process.env.VITE_PORT || '7781'));
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), `rhwp-${tag}-`));
  const traceFile = path.join(fixtureRoot, 'tool-trace.jsonl');
  const piRoot = path.join(fixtureRoot, 'pi');
  let pi = null;
  try {
    if (agent === 'pi') pi = await seedPiFixture({ piRoot, modelId: model });
  } catch (error) {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
    throw error;
  }
  const hub = await startHub({
    hubPort, token, fixtureRoot, dropEnv,
    env: {
      RHWP_TOOL_TRACE: '1',
      RHWP_TOOL_TRACE_FILE: traceFile,
      // 사용자 앱 상태(관리형 CLI·Pi 설정)를 건드리지 않는다. claude 자격 증명은 호스트 ~/.claude 또는 Keychain 에서 읽는다.
      RHWP_CLI_DIR: path.join(fixtureRoot, 'cli'),
      RHWP_PI_DIR: piRoot,
    },
    logName: `rhwp-agent-${tag}-hub.log`,
  });
  const vite = await startVite({ vitePort, hubPort, token, logName: `rhwp-studio-${tag}-vite.log` });
  process.env.VITE_URL = `http://127.0.0.1:${vitePort}`;
  return {
    hubPort, vitePort, fixtureRoot, traceFile, pi,
    async stop() {
      await stopServer(vite);
      await stopServer(hub);
      removeTempDir(fixtureRoot);
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 페이지 쪽 — 이벤트 수집, 입력, 턴 대기
// ─────────────────────────────────────────────────────────────────────────────

/** 브리지 이벤트를 epoch 시각과 함께 모은다 (턴 시작/끝, 오류, 도구 실행, 답 텍스트, 사용량). */
export async function installEventCapture(page) {
  await page.waitForFunction(() => window.__agentBridge?.getConnectionState?.() === 'connected', { timeout: 30000 });
  await page.evaluate(() => {
    if (window.__liveEvents) return;
    const now = () => performance.timeOrigin + performance.now();
    window.__liveEvents = [];
    window.__liveText = '';
    window.__liveAnswer = '';
    window.__agentBridge.onEvent((event) => {
      if (event.type === 'agent') {
        const inner = event.event ?? {};
        if (inner.parentTaskId) return; // 하위 에이전트 스트림은 답에 넣지 않는다
        if (['turn-start', 'turn-end', 'error'].includes(inner.type)) {
          window.__liveEvents.push({
            t: now(), type: inner.type, stopReason: inner.stopReason ?? null,
            message: inner.message ?? inner.errorMessage ?? null,
          });
        } else if (inner.type === 'text-delta' && typeof inner.text === 'string') {
          window.__liveText += inner.text;
          window.__liveAnswer += inner.text;
        } else if (inner.type === 'tool-call') {
          // 도구 호출 전 텍스트는 진행 메모다 — 마지막 도구 호출 뒤의 텍스트가 최종 답이다.
          window.__liveAnswer = '';
        } else if (inner.type === 'usage') {
          window.__liveEvents.push({ t: now(), type: 'usage', usage: inner.usage ?? null, costUsd: inner.costUsd ?? null, model: inner.model ?? null });
        }
      } else if (event.type === 'connection' || event.type === 'connection-state') {
        window.__liveEvents.push({ t: now(), type: 'connection', state: event.state ?? null });
      } else if (event.type === 'tool-executed') {
        window.__liveEvents.push({ t: now(), type: 'tool-executed', tool: event.tool, ok: event.ok });
      } else if (event.type === 'hub-error') {
        window.__liveEvents.push({ t: now(), type: 'hub-error', code: event.code ?? null, message: event.message ?? null });
      }
    });
  });
}

export async function resetEventCapture(page) {
  await page.evaluate(() => { window.__liveEvents.length = 0; window.__liveText = ''; window.__liveAnswer = ''; });
}

export async function readEventCapture(page) {
  return page.evaluate(() => ({
    events: window.__liveEvents?.slice() ?? [],
    text: window.__liveText ?? '',
    answer: window.__liveAnswer ?? '',
  }));
}

/** 에이전트 모드에서 턴 끝에 남은 검토 대기 편집. */
export async function readPendingEdits(page) {
  return page.evaluate(() => {
    const pending = window.__agentBridge?.pendingEdits;
    if (!pending) return null;
    const sets = pending.getChangeSets().filter((set) => set.ops.length > 0);
    return {
      hasPending: pending.hasPending(),
      sets: sets.length,
      ops: sets.reduce((n, set) => n + set.ops.length, 0),
      statuses: sets.map((set) => set.status),
    };
  });
}

export async function rejectPendingEdits(page) {
  await page.evaluate(() => window.__agentBridge?.pendingEdits?.rejectAll?.()).catch(() => {});
}

export async function sendThroughComposer(page, text) {
  // 사용자가 하는 것처럼 사이드바 입력창에 치고 Enter. 입력창이 안 보이면 브리지로 보낸다.
  const visible = await page.evaluate(() => {
    const input = document.querySelector('#agent-sidebar textarea.ag-input');
    if (!(input instanceof HTMLTextAreaElement)) return false;
    const rect = input.getBoundingClientRect();
    // 입력기의 보이는 잠금은 늦게 따라온다 — 실제 준비 상태는 data-composer-ready 가 말한다.
    return rect.width > 0 && rect.height > 0
      && document.querySelector('#agent-sidebar')?.dataset.composerReady === 'true';
  });
  if (visible) {
    await page.focus('#agent-sidebar textarea.ag-input');
    await page.evaluate((value) => {
      const input = document.querySelector('#agent-sidebar textarea.ag-input');
      input.value = value;
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }, text);
    await page.keyboard.press('Enter');
    return 'composer';
  }
  await page.evaluate((value) => { void window.__agentBridge.sendUserMessage(value); }, text);
  return 'bridge';
}

/** 새 채팅을 연다. workflow/permission 은 모드 선택기와 같은 조합이다. */
export async function startFreshChat(page, { agent, model, effort, permissionProfile = 'unrestricted', workflow = 'direct' }) {
  const since = await page.evaluate(() => performance.timeOrigin + performance.now());
  await page.evaluate((a, m, e, p, w) => window.__agentBridge.startChat(a, m ?? undefined, e ?? undefined, true, p, w),
    agent, model ?? null, effort ?? null, permissionProfile, workflow);
  try {
    await page.waitForFunction((a) => window.__agentBridge?.getActiveAgent?.() === a, { timeout: 60000 }, agent);
  } catch {
    const errors = await page.evaluate((t) => (window.__liveEvents ?? []).filter((e) => e.type === 'hub-error' && e.t >= t), since);
    const detail = errors.map((e) => `${e.code}: ${e.message}`).join('; ') || '허브 오류 없음';
    throw new Error(`${agent} 채팅을 시작하지 못했습니다 (${detail})`);
  }
  await delay(500);
  const errors = await page.evaluate((t) => (window.__liveEvents ?? []).filter((e) => e.type === 'hub-error' && e.t >= t), since);
  if (errors.some((e) => e.code === 'PI_NOT_CONFIGURED')) throw new Error(`허브가 Pi 를 준비되지 않은 상태로 봅니다: ${errors[0].message}`);
}

/**
 * 턴 끝까지 기다린다. 끝은 허브 추적 행(provider turn-end)으로 판정한다 — 페이지가 다시 연결돼도 놓치지 않는다.
 * 모델이 사용자에게 되물으면 턴은 답을 기다리며 끝나지 않는다 — 물은 시각을 턴 끝으로 적고 중단한다.
 */
export async function waitForTurnEnd(page, { traceFile, sentAt, timeoutMs }) {
  const deadline = Date.now() + timeoutMs;
  let turnEndRow = null;
  let questionRow = null;
  let timedOut = false;
  while (!turnEndRow) {
    await delay(500);
    const rows = readTraceRows(traceFile).filter((row) => row.kind === 'provider' && row.t > sentAt);
    turnEndRow = rows.find((row) => row.ev === 'turn-end') ?? null;
    questionRow ??= rows.find((row) => row.ev === 'tool-call' && QUESTION_TOOL.test(row.tool ?? '')) ?? null;
    if (!turnEndRow && questionRow) {
      await page.evaluate(() => window.__agentBridge.interrupt());
      await delay(2000);
      turnEndRow = { t: questionRow.t, status: 'asked-user' };
    }
    if (!turnEndRow && Date.now() > deadline) {
      timedOut = true;
      await page.evaluate(() => window.__agentBridge.interrupt()).catch(() => {});
      await delay(3000);
      turnEndRow = { t: Date.now(), status: 'timeout' };
    }
  }
  return { endedAt: turnEndRow.t, status: turnEndRow.status ?? null, askedUser: questionRow !== null, timedOut };
}

// ─────────────────────────────────────────────────────────────────────────────
// 턴 분석
// ─────────────────────────────────────────────────────────────────────────────

const ERROR_CODE = /\b([A-Z][A-Z0-9_]{3,})\b/;

function errorCodeOf(text) {
  const raw = String(text ?? '');
  try {
    const parsed = JSON.parse(raw);
    const code = parsed?.error?.code ?? parsed?.code;
    if (typeof code === 'string') return code;
  } catch { /* 일반 텍스트 */ }
  return ERROR_CODE.exec(raw)?.[1] ?? 'ERROR';
}

function contentText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((block) => (typeof block?.text === 'string' ? block.text : '')).join('\n');
}

function readJsonl(file) {
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { return []; }
  return text.split('\n').filter(Boolean).flatMap((line) => {
    try { return [JSON.parse(line)]; } catch { return []; }
  });
}

/** Pi 세션 폴더의 .jsonl 목록과 크기 — 턴 전에 찍어 두고 턴 뒤의 차이로 이번 턴 파일을 찾는다. */
export function listPiSessionFiles(sessionsDir) {
  const out = [];
  const walk = (dir) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.jsonl')) out.push(full);
    }
  };
  walk(sessionsDir);
  return out;
}

/**
 * Pi 세션 JSONL 로 모델 요청을 분해한다 — claude 스트림 행과 같은 모양으로.
 * 어시스턴트 메시지 하나 = 모델 요청 하나. message.timestamp 는 요청 시작, 항목 timestamp 는 기록(완료) 시각이다.
 * 첫 바이트 시각은 세션에 없어서 waitMs 는 "직전 경계(사용자 메시지·도구 결과) → 요청 시작" 으로,
 * genMs 는 "요청 시작 → 완료" (대기+생성) 로 적는다.
 */
export function analyzePiSession(files, { from, to, pricing = null }) {
  const entries = files.flatMap((file) => readJsonl(file))
    .filter((entry) => entry.type === 'message' && entry.message)
    .map((entry) => ({ ...entry, at: Date.parse(entry.timestamp) }))
    .filter((entry) => Number.isFinite(entry.at) && entry.at >= from - 1000 && entry.at <= to + 5000)
    .sort((a, b) => a.at - b.at);
  const requests = [];
  const toolNames = new Map();
  const failures = [];
  let boundary = from;
  let finalText = '';
  for (const entry of entries) {
    const message = entry.message;
    if (message.role === 'user') {
      boundary = Number(message.timestamp) || entry.at;
    } else if (message.role === 'assistant') {
      const start = Number(message.timestamp) || entry.at;
      const content = Array.isArray(message.content) ? message.content : [];
      const toolCalls = content.filter((block) => block.type === 'toolCall');
      for (const call of toolCalls) toolNames.set(call.id, call.name);
      const usage = message.usage ?? {};
      const textChars = content.filter((b) => b.type === 'text').reduce((n, b) => n + (b.text?.length ?? 0), 0);
      const thinkingChars = content.filter((b) => b.type === 'thinking').reduce((n, b) => n + (b.thinking?.length ?? 0), 0);
      const argChars = toolCalls.reduce((n, b) => n + JSON.stringify(b.arguments ?? {}).length, 0);
      const text = content.filter((b) => b.type === 'text').map((b) => b.text ?? '').join('');
      if (text.trim()) finalText = text;
      const input = usage.input ?? 0;
      const output = usage.output ?? 0;
      const cacheRead = usage.cacheRead ?? 0;
      const cacheWrite = usage.cacheWrite ?? 0;
      requests.push({
        at: round(start - from),
        waitMs: round(start - boundary),
        genMs: round(entry.at - start),
        inTok: input,
        cacheRead,
        cacheWrite,
        outTok: output,
        reasoningTok: usage.reasoning ?? null,
        costUsd: usage.cost?.total ?? null,
        // OpenRouter 카탈로그 가격으로 다시 센 비용 — pi 의 models.json 은 캐시 읽기 가격을 0 으로 둔다.
        catalogCostUsd: pricing
          ? input * pricing.prompt + output * pricing.completion + cacheRead * pricing.cacheRead + cacheWrite * pricing.cacheWrite
          : null,
        stopReason: message.stopReason ?? null,
        errorMessage: message.errorMessage ? String(message.errorMessage).slice(0, 300) : undefined,
        thinkingChars,
        textChars,
        toolArgChars: argChars,
        toolCalls: toolCalls.map((call) => ({ id: call.id, name: call.name })),
        blocks: content.map((b) => b.type),
      });
    } else if (message.role === 'toolResult') {
      boundary = entry.at;
      if (message.isError) {
        const text = contentText(message.content);
        failures.push({
          tool: message.toolName ?? toolNames.get(message.toolCallId) ?? 'tool',
          code: errorCodeOf(text),
          message: text.slice(0, 240),
        });
      }
    }
  }
  const sum = (key) => requests.reduce((n, r) => n + (Number(r[key]) || 0), 0);
  return {
    requests,
    failures,
    finalText,
    modelRequests: requests.length,
    inputTokens: sum('inTok'),
    cacheReadTokens: sum('cacheRead'),
    cacheWriteTokens: sum('cacheWrite'),
    outputTokens: sum('outTok'),
    reasoningTokens: sum('reasoningTok'),
    costUsd: round(sum('costUsd'), 6),
    catalogCostUsd: pricing ? round(sum('catalogCostUsd'), 6) : null,
    modelMs: round(sum('genMs')),
    stopReasons: requests.reduce((acc, r) => { acc[r.stopReason] = (acc[r.stopReason] ?? 0) + 1; return acc; }, {}),
  };
}

/**
 * Pi 병렬 묶음 — 어시스턴트 메시지 하나에 실린 도구 호출들이 실제로 겹쳐 실행됐는지.
 * provider 추적 행(tool_execution_start/end)의 callId 로 구간을 만들고, 허브 행은 도구 이름 순서로 잇는다.
 */
export function piBatches(session, traceRows, { from, to }) {
  const provider = traceRows.filter((row) => row.kind === 'provider' && row.t >= from && row.t <= to + 1000);
  const starts = new Map(provider.filter((r) => r.ev === 'tool-call' && r.callId).map((r) => [r.callId, r.t]));
  const ends = new Map(provider.filter((r) => r.ev === 'tool-result' && r.callId).map((r) => [r.callId, r.t]));
  const calls = joinCalls(traceRows).filter((call) => call.hub.hubIn >= from && call.hub.hubIn <= to + 1000)
    .sort((a, b) => a.hub.hubIn - b.hub.hubIn);
  const hubQueue = new Map();
  for (const call of calls) {
    if (!hubQueue.has(call.tool)) hubQueue.set(call.tool, []);
    hubQueue.get(call.tool).push(call);
  }
  const batches = [];
  for (const request of session.requests) {
    if (request.toolCalls.length < 2) {
      for (const call of request.toolCalls) hubQueue.get(call.name)?.shift();
      continue;
    }
    const cli = [];
    const hub = [];
    const exec = [];
    for (const call of request.toolCalls) {
      const a = starts.get(call.id);
      const b = ends.get(call.id);
      if (Number.isFinite(a) && Number.isFinite(b)) cli.push([a, b]);
      const hubCall = hubQueue.get(call.name)?.shift();
      if (hubCall) {
        hub.push([hubCall.hub.hubIn, hubCall.hub.hubOut]);
        if (hubCall.studio) exec.push([hubCall.studio.exec0, hubCall.studio.stSend]);
      }
    }
    batches.push({
      size: request.toolCalls.length,
      tools: request.toolCalls.map((c) => c.name),
      maxConcurrentCli: maxOverlap(cli),
      maxConcurrentHub: maxOverlap(hub),
      maxConcurrentStudioExec: maxOverlap(exec),
      makespanMs: cli.length ? round(Math.max(...cli.map(([, b]) => b)) - Math.min(...cli.map(([a]) => a))) : null,
      sumToolMs: round(cli.reduce((n, [a, b]) => n + (b - a), 0)),
    });
  }
  return batches;
}

/** 격리된 claude 홈의 세션 기록에서 오류로 끝난 도구 결과를 뽑는다. */
export function claudeFailures(fixtureRoot) {
  const failures = [];
  for (const file of claudeTranscriptFiles(fixtureRoot)) {
    const names = new Map();
    for (const row of readJsonl(file)) {
      const content = row?.message?.content;
      if (!Array.isArray(content)) continue;
      for (const block of content) {
        if (block?.type === 'tool_use') names.set(block.id, block.name);
        if (block?.type === 'tool_result' && block.is_error) {
          const text = contentText(block.content);
          failures.push({ tool: String(names.get(block.tool_use_id) ?? 'tool').replace(/^mcp__rhwp__/, ''), code: errorCodeOf(text), message: text.slice(0, 240) });
        }
      }
    }
  }
  return failures;
}

function claudeTranscriptFiles(fixtureRoot) {
  const files = [];
  const sessionsRoot = path.join(fixtureRoot, 'sessions');
  let sessions = [];
  try { sessions = fs.readdirSync(sessionsRoot); } catch { return files; }
  for (const session of sessions) {
    const projects = path.join(sessionsRoot, session, 'home', '.claude', 'projects');
    if (!fs.existsSync(projects)) continue;
    for (const project of fs.readdirSync(projects)) {
      for (const file of fs.readdirSync(path.join(projects, project))) {
        if (file.endsWith('.jsonl')) files.push(path.join(projects, project, file));
      }
    }
  }
  return files;
}

/** 다음 채팅이 시작되면 허브가 claude 세션 홈을 지운다 — 그 전에 옮긴다. pi 는 이번 턴의 세션 파일을 옮긴다. */
export function keepTranscripts({ agent, fixtureRoot, dir, prefix = '', piFiles = [] }) {
  let kept = 0;
  try {
    fs.mkdirSync(dir, { recursive: true });
    const files = agent === 'pi' ? piFiles : claudeTranscriptFiles(fixtureRoot);
    for (const file of files) {
      fs.copyFileSync(file, path.join(dir, `${prefix}${path.basename(file)}`));
      kept += 1;
    }
  } catch (error) {
    console.log(`  [transcripts] 복사 실패: ${error?.message ?? error}`);
  }
  if (kept === 0) console.log('  [transcripts] 세션 기록을 찾지 못했습니다');
  return kept;
}

/**
 * 한 턴의 공통 지표. claude 는 스트림 추적 행, pi 는 세션 JSONL 로 모델 요청을 나눈다.
 * 실패한 도구 호출은 이름과 오류 코드를 함께 남긴다.
 */
export function analyzeTurn({ agent, traceFile, fixtureRoot, from, to, piFiles = [], pricing = null, usageEvents = [] }) {
  const rows = readTraceRows(traceFile);
  const base = analyzeProviderTurn(rows, { from, to: to + 1000 });
  const hubCalls = joinCalls(rows).filter((call) => call.hub.hubIn >= from && call.hub.hubIn <= to + 1000);
  const hubFailures = hubCalls.filter((call) => call.ok === false)
    .map((call) => ({ tool: call.tool, code: errorCodeOf(call.error), message: String(call.error ?? '').slice(0, 240) }));
  const metrics = {
    turnWallMs: base.turnWallMs,
    toolCalls: base.toolCalls,
    rhwpToolCalls: agent === 'pi' ? base.hubToolCalls : base.rhwpToolCalls,
    failedToolCalls: base.failedToolCalls,
    toolsUsed: base.toolsUsed,
    toolUnionMs: base.toolUnionMs,
    latency: { pipelineMs: base.latency.pipelineMs, toolMs: base.latency.toolMs },
    startup: base.startup,
  };
  if (agent === 'pi') {
    const session = analyzePiSession(piFiles, { from, to, pricing });
    const batches = piBatches(session, rows, { from, to });
    const parallel = batches;
    return {
      ...metrics,
      startup: { ...metrics.startup, firstRequestMs: session.requests[0]?.at ?? null },
      modelRequests: session.modelRequests,
      requests: session.requests,
      inputTokens: session.inputTokens,
      cacheReadTokens: session.cacheReadTokens,
      cacheWriteTokens: session.cacheWriteTokens,
      outputTokens: session.outputTokens,
      reasoningTokens: session.reasoningTokens,
      costUsd: session.costUsd,
      catalogCostUsd: session.catalogCostUsd,
      modelMs: session.modelMs,
      stopReasons: session.stopReasons,
      parallelBatches: parallel.length,
      parallelCalls: parallel.reduce((n, b) => n + b.size, 0),
      largestBatch: Math.max(0, ...session.requests.map((r) => r.toolCalls.length)),
      batches: parallel,
      failures: session.failures.length ? session.failures : hubFailures,
      hubFailures,
      finalText: session.finalText,
    };
  }
  const usageCost = usageEvents.reduce((n, e) => n + (Number(e.costUsd) || 0), 0);
  const failures = agent === 'claude' ? claudeFailures(fixtureRoot) : [];
  return {
    ...metrics,
    modelRequests: base.modelRequests,
    subagentModelRequests: base.subagentModelRequests,
    requests: base.requests,
    inputTokens: base.requests.reduce((n, r) => n + (r.inTok ?? 0), 0),
    cacheReadTokens: base.requests.reduce((n, r) => n + (r.cacheRead ?? 0), 0),
    cacheWriteTokens: base.requests.reduce((n, r) => n + (r.cacheWrite ?? 0), 0),
    outputTokens: base.outputTokens,
    costUsd: usageCost > 0 ? round(usageCost, 6) : null,
    modelWaitMs: base.modelWaitMs,
    modelGenMs: base.modelGenMs,
    thinkingMs: base.thinkingMs,
    toolArgsMs: base.toolArgsMs,
    textMs: base.textMs,
    stopReasons: base.requests.reduce((acc, r) => { acc[r.stopReason] = (acc[r.stopReason] ?? 0) + 1; return acc; }, {}),
    parallelBatches: base.parallelBatches,
    parallelCalls: base.parallelCalls,
    largestBatch: base.largestBatch,
    batches: base.batches,
    failures: failures.length ? failures : hubFailures,
    hubFailures,
    perCall: base.perCall,
  };
}

export { stats, round };
