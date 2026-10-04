import { createHash } from 'node:crypto';
import path from 'node:path';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { resolveCommandOnPath, resolveNpmCliLaunch } from './npm-cli-launch.mjs';
import { OFFICIAL_CLAUDE_MODELS, claudeModelDescription, claudeModelLabel } from './claude-model-label.mjs';

const CACHE_MS = 5 * 60 * 1000;
const TIMEOUT_MS = 12_000;

/** Ask the managed Claude CLI for the models available to this account. */
export async function discoverClaudeModels({
  bin, env = process.env, cwd = process.cwd(), queryModels = query, timeoutMs = TIMEOUT_MS,
  platform = process.platform,
} = {}) {
  // 채팅(agents/claude.mjs)과 같은 실행 파일을 고른다. 경로가 없으면 SDK 는 PATH 대신
  // 자체 번들 런타임으로 떨어져 채팅과 다른 버전의 목록을 돌려준다.
  const launch = resolveNpmCliLaunch(bin || 'claude', { platform, env });
  let executable = launch.leadingArgs[0] ?? launch.command;
  if (!path.isAbsolute(executable)) {
    executable = platform === 'win32' ? null : resolveCommandOnPath(executable, { env });
  }
  const stream = queryModels({
    // An empty input stream opens the SDK control channel without sending a prompt.
    prompt: (async function* () {})(),
    options: {
      cwd, env: { ...env, ...launch.env }, settingSources: [], tools: [],
      ...(executable ? { pathToClaudeCodeExecutable: executable } : {}),
    },
  });
  let timeout;
  try {
    const deadline = new Promise((_, reject) => {
      timeout = setTimeout(() => reject(new Error('Claude model discovery timed out')), timeoutMs);
    });
    return await Promise.race([stream.supportedModels(), deadline]);
  } finally {
    clearTimeout(timeout);
    stream.close();
  }
}

export function normalizeClaudeModels(models) {
  const seen = new Set();
  const catalog = [];
  for (const entry of [...models].sort((a, b) =>
    Number(a?.value === 'default') - Number(b?.value === 'default'))) {
    if (typeof entry?.value !== 'string' || !entry.value) continue;
    // A full value with a context suffix is a distinct option from its base model.
    const id = entry.value.startsWith('claude-') ? entry.value : entry.resolvedModel ?? entry.value;
    if (!id.startsWith('claude-') || seen.has(id)) continue;
    seen.add(id);
    // CLI 표시 이름("Sonnet")에는 버전이 없어 해석된 ID에서 "Sonnet 5"를 만든다.
    const displayName = typeof entry.displayName === 'string' && entry.displayName.trim()
      ? entry.displayName : id;
    const description = claudeModelDescription(entry.description);
    catalog.push({
      id,
      label: claudeModelLabel(id, displayName),
      ...(description ? { description } : {}),
      ...(Array.isArray(entry.supportedEffortLevels)
        ? { supportedEfforts: entry.supportedEffortLevels.filter((value) =>
          ['low', 'medium', 'high', 'xhigh', 'max'].includes(value)) } : {}),
    });
  }
  // Codex 목록처럼 성능 순으로 세운다: Fable → Opus → Sonnet → Haiku, 같은 계열은 새 버전 먼저.
  return withOfficialModels(catalog)
    .map((model, index) => ({ model, index, rank: claudeModelRank(model.id) }))
    .sort((a, b) => compareRank(a.rank, b.rank) || a.index - b.index)
    .map(({ model }) => model);
}

const FAMILY_ORDER = ['fable', 'opus', 'sonnet', 'haiku'];

/**
 * 공식 목록보다 오래된 CLI 항목은 같은 계열의 공식 최신 모델로 올린다. 1M 같은 문맥
 * 변형은 붙인 채로 옮기고, 설명과 추론 강도는 CLI 항목의 값을 이어 쓴다. CLI에 없는
 * 공식 모델도 목록에 넣는다.
 */
function withOfficialModels(catalog) {
  // CLI가 아무 모델도 주지 않으면 계정·설치 문제이므로 공식 목록으로 가리지 않는다.
  if (!catalog.length) return catalog;
  const official = new Map(OFFICIAL_CLAUDE_MODELS.map((id) => [claudeModelRank(id).familyName, id]));
  const result = [];
  const seen = new Set();
  const push = (model) => {
    if (seen.has(model.id)) return;
    seen.add(model.id);
    result.push(model);
  };
  for (const model of catalog) {
    const rank = claudeModelRank(model.id);
    const latest = official.get(rank.familyName);
    if (!latest || compareRank(rank, claudeModelRank(latest)) <= 0) {
      push(model);
      continue;
    }
    const id = `${latest}${rank.context}`;
    push({ ...model, id, label: claudeModelLabel(id, model.label) });
  }
  for (const id of OFFICIAL_CLAUDE_MODELS) {
    if (result.some((model) => model.id === id || model.id.startsWith(`${id}[`))) continue;
    const family = result.find((model) => claudeModelRank(model.id).familyName === claudeModelRank(id).familyName);
    push({
      id,
      label: claudeModelLabel(id),
      ...(family?.description ? { description: family.description } : {}),
      ...(family?.supportedEfforts ? { supportedEfforts: family.supportedEfforts } : {}),
    });
  }
  return result;
}

function claudeModelRank(id) {
  const match = /^claude-([a-z]+)((?:-\d+)+?)(?:-\d{8})?(\[[^\]]+\])?$/.exec(id);
  if (!match) return { family: FAMILY_ORDER.length, familyName: null, version: [], context: '' };
  const family = FAMILY_ORDER.indexOf(match[1]);
  return {
    family: family === -1 ? FAMILY_ORDER.length : family,
    familyName: match[1],
    version: match[2].slice(1).split('-').map(Number),
    context: match[3] ?? '',
  };
}

function compareRank(a, b) {
  if (a.family !== b.family) return a.family - b.family;
  for (let i = 0; i < Math.max(a.version.length, b.version.length); i++) {
    const difference = (b.version[i] ?? 0) - (a.version[i] ?? 0);
    if (difference) return difference;
  }
  return 0;
}

/** 캐시 키에 넣을 자격 증명 지문. 계정이 바뀌면 이전 계정의 목록을 쓰지 않는다. */
function credentialFingerprint(env) {
  const secret = env?.CLAUDE_CODE_OAUTH_TOKEN || env?.ANTHROPIC_API_KEY || '';
  return secret ? createHash('sha256').update(secret).digest('hex').slice(0, 16) : '';
}

export function createClaudeModelCatalog({ discover = discoverClaudeModels, now = Date.now } = {}) {
  const cache = new Map();
  return async function claudeModelCatalog(options = {}, { refresh = false } = {}) {
    const key = `${options.bin ?? ''}\0${options.env?.CLAUDE_CONFIG_DIR ?? ''}\0${credentialFingerprint(options.env)}`;
    let entry = cache.get(key);
    if (refresh || !entry || entry.expiresAt <= now()) {
      const pending = Promise.resolve().then(() => discover(options)).then((models) => {
        const catalog = normalizeClaudeModels(models);
        if (!catalog.length) throw new Error('Claude returned an empty model catalog');
        return catalog;
      });
      entry = { pending, expiresAt: Number.POSITIVE_INFINITY };
      cache.set(key, entry);
      pending.then(
        (models) => { if (cache.get(key) === entry) cache.set(key, { models, expiresAt: now() + CACHE_MS }); },
        () => { if (cache.get(key) === entry) cache.delete(key); },
      );
    }
    return entry.pending ?? entry.models;
  };
}
