import crypto from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { replaceFileAtomically } from './harness-update.mjs';
import { API_KEY_MAX_BYTES, textFitsByteLimit } from './input-bounds.mjs';
import {
  normalizeRauAgentStatus,
  RAU_AGENT_MODEL,
  rauAgentModelConfigs,
  rauAgentModelsJson,
  rauApiBase,
} from './rau-agent.mjs';

/**
 * Rau 하네스의 허브 쪽 상태. BYOK(pi) 와 따로 산다 — 자격(라이선스 lease), 모델, 홈(agent-rau/)이 모두 따로다.
 * 데스크톱 main 이 사이트 API 에 `GET /v1/rau/status` 를 묻고, Rau 플랜이나 Rau 체험이 살아 있을 때만 Pi 에 줄
 * lease 를 넘긴다.
 *
 * 상태(availability)
 * - active: Rau 를 쓸 수 있다 (eligible). lease 와 사이트 API 주소가 있고 agent-rau/models.json 을 썼다.
 *   크레딧을 다 썼으면 exhausted 다 — 다음 초기화까지 보내도 429 로 끝난다.
 * - not_eligible: 서버가 eligible:false(rau_plan_required)로 답했다 (무료·Hama 요금제).
 * - unavailable: 브라우저 Studio, 서버 꺼짐, 네트워크 오류, 라이선스 없음.
 * 요금제 이름으로 Rau 를 짐작하지 않는다. 서버의 답만 믿는다.
 */
export const RAU_AGENT_STATUS_STALE_MS = 60_000;
export const RAU_AGENT_SOURCE_TIMEOUT_MS = 15_000;
const LEASE_MAX_BYTES = Math.min(API_KEY_MAX_BYTES, 16 * 1024);

/**
 * 데스크톱 main 에 Rau 자격을 묻는 IPC 경로. RHWP_RAU_AGENT_BROKER=ipc 로 띄운 허브에서만 쓸 수 있다.
 * status() → { availability, lease?, apiBase?, status? }.
 */
export function createIpcRauAgentSource({ processRef = process, timeoutMs = RAU_AGENT_SOURCE_TIMEOUT_MS } = {}) {
  const pending = new Map();
  const listeners = new Set();
  const available = processRef.env?.RHWP_RAU_AGENT_BROKER === 'ipc' && typeof processRef.send === 'function';

  processRef.on?.('message', (message) => {
    if (!message || typeof message !== 'object') return;
    if (message.type === 'rhwp-rau-agent-changed') {
      if (!available) return;
      for (const listener of listeners) {
        try { listener(); } catch {}
      }
      return;
    }
    if (message.type !== 'rhwp-rau-agent-response' || typeof message.id !== 'string') return;
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    clearTimeout(request.timer);
    if (message.ok) request.resolve(message.value ?? null);
    else request.reject(Object.assign(new Error(message.error || 'Rau status failed.'), { code: message.code || 'RAU_AGENT_SOURCE_FAILED' }));
  });

  function status() {
    if (!available) {
      return Promise.reject(Object.assign(new Error('Rau needs the desktop app.'), { code: 'RAU_AGENT_SOURCE_UNAVAILABLE' }));
    }
    return new Promise((resolve, reject) => {
      const id = crypto.randomUUID();
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(Object.assign(new Error('Rau status did not respond.'), { code: 'RAU_AGENT_SOURCE_TIMEOUT' }));
      }, timeoutMs);
      timer.unref?.();
      pending.set(id, { resolve, reject, timer });
      processRef.send({ type: 'rhwp-rau-agent-request', id, operation: 'status' }, (error) => {
        if (!error) return;
        if (!pending.delete(id)) return;
        clearTimeout(timer);
        reject(Object.assign(error, { code: 'RAU_AGENT_SOURCE_FAILED' }));
      });
    });
  }

  return {
    available,
    status,
    /** 데스크톱이 계정·라이선스가 바뀌었다고 알릴 때 부른다. 해제 함수를 돌려준다. */
    onChange(callback) {
      listeners.add(callback);
      return () => listeners.delete(callback);
    },
  };
}

/** 테스트·미리보기용 고정 응답. value 가 함수면 부를 때마다 값을 새로 만든다. set() 은 값을 바꾸고 onChange 를 울린다. */
export function createStaticRauAgentSource(value, { available = true } = {}) {
  let current = value;
  const listeners = new Set();
  return {
    available,
    calls: 0,
    async status() {
      this.calls += 1;
      return typeof current === 'function' ? current() : current;
    },
    onChange(callback) {
      listeners.add(callback);
      return () => listeners.delete(callback);
    },
    set(next) {
      current = next;
      for (const listener of listeners) listener();
    },
  };
}

function settingsText() {
  return `${JSON.stringify({
    defaultProjectTrust: 'never',
    enableSkillCommands: false,
    enableInstallTelemetry: false,
  }, null, 2)}\n`;
}

function validLease(raw) {
  const lease = typeof raw === 'string' ? raw.trim() : '';
  return lease && textFitsByteLimit(lease, LEASE_MAX_BYTES) && !/[\s\x00-\x1f\x7f]/u.test(lease) ? lease : null;
}

/**
 * @param {{ piRoot: string, source: ReturnType<typeof createStaticRauAgentSource> | ReturnType<typeof createIpcRauAgentSource> | null,
 *   isPiInstalled?: () => boolean, now?: () => number, platform?: string }} deps
 *   piRoot: Pi 루트. 홈은 `<piRoot>/agent-rau`, rg/fd 는 BYOK 홈(`<piRoot>/agent/bin`)의 것을 같이 쓴다.
 */
export function createRauAgentHarness({
  piRoot,
  source,
  isPiInstalled = () => false,
  now = Date.now,
  platform = process.platform,
}) {
  const agentDir = path.join(piRoot, 'agent-rau');
  const modelsPath = path.join(agentDir, 'models.json');
  const settingsPath = path.join(agentDir, 'settings.json');
  /** @type {'active'|'not_eligible'|'unavailable'} */
  let availability = 'unavailable';
  /** @type {{ lease: string, apiBase: string } | null} lease 는 메모리에만 둔다. */
  let credentials = null;
  /** @type {import('./rau-agent.mjs').RauAgentServerStatus | null} */
  let status = null;
  let models = [];
  let writtenText = null;
  let writtenBase = null;
  let checkedAt = 0;
  let chain = Promise.resolve();
  let tempSeq = 0;

  async function writeAtomic(file, text) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    const temp = `${file}.tmp-${process.pid}-${now()}-${(tempSeq += 1)}`;
    try {
      await fs.writeFile(temp, text, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      await replaceFileAtomically(temp, file, { platform });
    } finally {
      await fs.rm(temp, { force: true }).catch(() => {});
    }
  }

  /** BYOK 홈의 rg/fd 를 같이 쓴다. Windows 는 권한 없이 되는 디렉터리 정션을 쓴다. */
  async function linkSharedBin() {
    const binLink = path.join(agentDir, 'bin');
    const ownBin = path.join(piRoot, 'agent', 'bin');
    if (platform === 'linux' || await fs.lstat(binLink).catch(() => null)) return;
    if (!(await fs.stat(ownBin).catch(() => null))?.isDirectory()) return;
    await (platform === 'win32'
      ? fs.symlink(ownBin, binLink, 'junction')
      : fs.symlink(path.join('..', 'agent', 'bin'), binLink)).catch(() => {});
  }

  async function writeHome() {
    const json = rauAgentModelsJson({ apiBase: credentials.apiBase, status });
    const text = `${JSON.stringify(json, null, 2)}\n`;
    if (text !== writtenText) {
      writtenText = null;
      await writeAtomic(settingsPath, settingsText());
      await writeAtomic(modelsPath, text);
      await linkSharedBin();
      writtenText = text;
    }
    writtenBase = credentials.apiBase;
    models = rauAgentModelConfigs(json);
  }

  function clear(next) {
    availability = next;
    credentials = null;
    status = null;
    models = [];
  }

  async function refreshNow() {
    if (!source?.available) {
      clear('unavailable');
      checkedAt = now();
      return snapshot();
    }
    let value;
    try {
      value = await source.status();
    } catch {
      // 데스크톱이 잠깐 늦었다. 자격이 끝났다는 뜻이 아니니 마지막 상태를 지킨다.
      if (!checkedAt) clear('unavailable');
      checkedAt = now();
      return snapshot();
    }
    checkedAt = now();
    if (value?.availability !== 'active') {
      clear(value?.availability === 'not_eligible' ? 'not_eligible' : 'unavailable');
      return snapshot();
    }
    const lease = validLease(value.lease);
    const apiBase = rauApiBase(value.apiBase);
    const normalized = normalizeRauAgentStatus(value.status);
    if (!lease || !apiBase || !normalized?.eligible) {
      clear(normalized && !normalized.eligible ? 'not_eligible' : 'unavailable');
      return snapshot();
    }
    credentials = { lease, apiBase };
    status = normalized;
    try {
      await writeHome();
      availability = 'active';
    } catch {
      // 홈 파일을 못 쓰면 Pi 를 띄울 수 없다. 다음 새로고침에서 다시 쓴다.
      clear('unavailable');
    }
    return snapshot();
  }

  function refresh() {
    const run = chain.then(refreshNow);
    chain = run.then(() => {}, () => {});
    return run;
  }

  function active() {
    return availability === 'active' && models.length > 0 && writtenBase === credentials?.apiBase;
  }

  /** Studio 로 보내는 스냅샷 (rhwp-studio/src/agent/types.ts 의 RauAgentStatus). 시각은 epoch ms. */
  function snapshot() {
    if (availability !== 'active' || !status) {
      return {
        availability, source: null, credits: null, exhausted: false, models: [], defaultModelId: RAU_AGENT_MODEL, ready: false,
      };
    }
    return {
      availability,
      source: status.source,
      credits: status.credits ? { ...status.credits } : null,
      exhausted: status.exhausted,
      models: models.map((model) => ({ ...model, efforts: [...model.efforts], pricing: { ...model.pricing } })),
      defaultModelId: RAU_AGENT_MODEL,
      ready: isPiInstalled() === true,
    };
  }

  /** 상태를 한 번도 받지 못했으면 받을 때까지(최대 timeoutMs) 기다린다. 오래된 상태는 뒤에서 새로 받는다. */
  async function ensureFresh({ timeoutMs = 3_000 } = {}) {
    if (checkedAt) {
      if (now() - checkedAt > RAU_AGENT_STATUS_STALE_MS) void refresh().catch(() => {});
      return snapshot();
    }
    let timer = null;
    const timeout = new Promise((resolve) => { timer = setTimeout(resolve, timeoutMs); });
    try {
      await Promise.race([refresh().catch(() => {}), timeout]);
    } finally {
      clearTimeout(timer);
    }
    return snapshot();
  }

  function modelConfig(id) {
    return models.find((model) => model.id === id) ?? null;
  }

  return {
    agentDir,
    refresh,
    ensureFresh,
    snapshot,
    active,
    modelConfig,
    defaultModelId: () => (models.length > 0 ? RAU_AGENT_MODEL : null),
    models: () => models.map((model) => ({ ...model, pricing: { ...model.pricing } })),

    /**
     * Rau 스폰마다 부른다. lease 를 키로, agent-rau 를 홈으로, 모델은 언제나 'rau' 다.
     * 자격이 없으면 mode 'none' — 스폰하지 않고 알린다. 사용자 키로 넘어가지 않는다.
     */
    resolveSpawn() {
      if (source?.available && now() - checkedAt > RAU_AGENT_STATUS_STALE_MS) void refresh().catch(() => {});
      if (!active()) {
        return { mode: 'none', key: null, agentDir, model: null, reasoning: false, fallback: 'none', reason: 'rau-unavailable' };
      }
      return {
        mode: 'rau',
        key: credentials.lease,
        agentDir,
        model: RAU_AGENT_MODEL,
        reasoning: Boolean(modelConfig(RAU_AGENT_MODEL)?.reasoning),
        fallback: 'none',
      };
    },

    /**
     * 턴이 크레딧 소진(`[rau-credits:…]`)으로 끝났다. 서버 답을 기다리지 않고 다 쓴 상태를 먼저 적고 다시 묻는다.
     */
    noteCreditsExhausted({ resetsAt } = {}) {
      if (status) {
        const credits = status.credits
          ? { ...status.credits, usedUsd: Math.max(status.credits.usedUsd, status.credits.allowanceUsd), remainingUsd: 0 }
          : null;
        if (credits && Number.isFinite(resetsAt)) credits.resetsAt = resetsAt;
        status = { ...status, credits, exhausted: true };
      }
      return refresh();
    },

    /** 허브 내부 전용 — Pi 에 넘기는 lease. 가림 목록에 넣는다. */
    secret: () => credentials?.lease ?? null,
  };
}
