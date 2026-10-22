import path from 'node:path';
import { readBrowserJson, siteName, siteScope, writeBrowserJson } from './browser-policy.mjs';

// 사이트 사용법 — 에이전트가 알아낸 여러 단계 흐름을 등록 도메인마다 짧은 메모로 남긴다.
// 하위 도메인은 한 메모를 함께 쓰고, IP·localhost·HTTP 는 정확한 출처가 키다(browser-policy siteScope).
// 메모는 페이지 내용에서 왔을 수 있으므로 에이전트에게는 지시가 아닌 믿지 않는 메모로 보여 준다.
// <dataDir>/browser/recipes.json 에 남는다(원자적 쓰기, 0600).
export const RECIPE_LIMITS = Object.freeze({ chars: 1_500, sites: 200, hintChars: 300 });
const RECIPE_AUTHORS = new Set(['agent', 'user']);
const FILE_SCHEMA = 1;
const MAX_FILE_BYTES = 1024 * 1024;

function failure(code, message) { return Object.assign(new Error(message), { code }); }

/** url 이나 사이트 이름(gov.kr, https://www.gov.kr/…) → { key, site }. */
export function recipeSite(value) {
  const raw = String(value ?? '').trim();
  if (!raw || raw.length > 2_000) throw failure('RECIPE_SITE_INVALID', 'Give the site as a URL or domain.');
  const url = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
  try {
    const scope = siteScope(url);
    return { key: scope.key, site: siteName(url) };
  } catch { throw failure('RECIPE_SITE_INVALID', 'Give the site as an HTTP(S) URL or domain.'); }
}

/** 메모 본문: 줄 끝 공백과 제어 문자를 정리하고, 감싸는 태그를 흉내 낸 글을 지운다. */
function normalizeText(value) {
  return String(value ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')
    .replace(/<\/?\s*site_recipe\b[^>]*>/gi, '')
    .split('\n').map((line) => line.replace(/\s+$/, '')).join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const SECRET_LABEL = /(?:password|passwd|passcode|pwd|pin|token|api[-_ ]?key|secret|bearer|비밀번호|암호|토큰|인증\s?번호|인증\s?코드|OTP)\s*[:=]\s*[^\s,;]{4,}/i;
const SECRET_SHAPES = [
  /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}/, /\bgh[pousr]_[A-Za-z0-9]{20,}/, /\bgithub_pat_[A-Za-z0-9_]{20,}/,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/, /\bAKIA[0-9A-Z]{16}\b/, /\bAIza[0-9A-Za-z_-]{30,}/,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/, /-----BEGIN [A-Z ]*PRIVATE KEY-----/, /\bBearer\s+[A-Za-z0-9._~+/-]{16,}/i,
];

/** 긴 불투명 문자열: 32자 이상이면서 글자와 숫자가 섞였거나, 20자 이상에 대소문자·숫자가 모두 있는 마침표 없는 토막. */
function opaqueToken(text) {
  for (const token of text.split(/[\s/?&=#:,;()'"<>[\]{}|]+/)) {
    if (token.length >= 32 && /[A-Za-z]/.test(token) && /\d/.test(token)) return true;
    if (token.length >= 20 && /^[A-Za-z0-9_+-]+$/.test(token) && /[a-z]/.test(token) && /[A-Z]/.test(token) && /\d/.test(token)) return true;
  }
  return false;
}

/** 비밀처럼 보이면 그 이유를, 아니면 null. secrets 는 허브가 페이지에 넣은 값들이다(같은 값이나 인코딩한 모양). */
export function recipeSecretIssue(text, secrets = []) {
  for (const secret of secrets) {
    if (typeof secret !== 'string' || secret.length < 4) continue;
    const variants = [secret, encodeURIComponent(secret), Buffer.from(secret).toString('base64')];
    if (variants.some((variant) => text.includes(variant))) return 'filled-secret';
  }
  if (SECRET_LABEL.test(text)) return 'labelled-secret';
  if (SECRET_SHAPES.some((shape) => shape.test(text))) return 'credential';
  if (opaqueToken(text)) return 'opaque-string';
  return null;
}

/** 에이전트에게 보이는 모양 — 메모를 감싸 지시가 아님을 밝힌다. */
export function wrapRecipe(entry) {
  return `<site_recipe site="${entry.site}" trust="untrusted-note">\n${entry.text}\n</site_recipe>`;
}

/**
 * browser_open·browser_navigate 결과에 그 사이트의 사용법을 탭·사이트마다 한 번 싣는다. 짧으면 감싼 본문을, 길면 글자 수만.
 * seen 은 Studio 연결마다 하나다.
 */
export function attachRecipeHint(store, seen, result, args = {}) {
  if (result?.ok !== true) return result;
  const tabId = result.tab?.tabId ?? args.tabId;
  const recipe = store.peek(result.tab?.url ?? result.url);
  if (!recipe || typeof tabId !== 'string') return result;
  const mark = `${tabId}\n${recipe.key}`;
  if (seen.has(mark)) return result;
  if (seen.size >= 512) seen.clear();
  seen.add(mark);
  const hint = recipe.text.length <= RECIPE_LIMITS.hintChars ? { site: recipe.site, note: wrapRecipe(recipe) } : { site: recipe.site, chars: recipe.text.length };
  if (Array.isArray(result.mcpContent)) result.mcpContent.push({ type: 'text', text: JSON.stringify({ recipe: hint }) });
  else result.recipe = hint;
  return result;
}

/**
 * @param {{ dataDir: string, now?: () => number, onChange?: () => void }} options
 */
export function createBrowserRecipeStore({ dataDir, now = Date.now, onChange = () => {} } = {}) {
  if (!dataDir) throw new TypeError('Recipe dataDir is required.');
  const filePath = path.join(dataDir, 'browser', 'recipes.json');
  /** @type {Map<string, { key: string, site: string, text: string, author: 'agent'|'user', updatedAt: number }>} */
  const recipes = new Map();
  let queue = Promise.resolve();
  const readyPromise = (async () => {
    const stored = await readBrowserJson(filePath, MAX_FILE_BYTES);
    if (!stored) return;
    if (stored.schema !== FILE_SCHEMA || !Array.isArray(stored.recipes)) throw failure('RECIPE_STORAGE_INVALID', 'Saved site recipes cannot be read.');
    for (const entry of stored.recipes.slice(0, RECIPE_LIMITS.sites)) {
      try {
        const { key, site } = recipeSite(entry?.key);
        const text = normalizeText(entry?.text).slice(0, RECIPE_LIMITS.chars);
        if (!text) continue;
        recipes.set(key, { key, site, text, author: RECIPE_AUTHORS.has(entry.author) ? entry.author : 'agent', updatedAt: Number(entry.updatedAt) || 0 });
      } catch {}
    }
  })();

  function serialized(operation) {
    const execute = async () => { await readyPromise; return operation(); };
    const task = queue.then(execute, execute);
    queue = task.catch(() => {});
    return task;
  }
  async function persist(next) {
    await writeBrowserJson(filePath, { schema: FILE_SCHEMA, recipes: [...next.values()] }, MAX_FILE_BYTES);
    recipes.clear();
    for (const [key, entry] of next) recipes.set(key, entry);
    try { onChange(); } catch {}
  }
  const publicEntry = (entry) => entry && { site: entry.site, key: entry.key, text: entry.text, author: entry.author, updatedAt: entry.updatedAt };

  return {
    filePath,
    ready: () => readyPromise,
    /** 최근에 고친 순서. */
    async list() {
      await readyPromise;
      return [...recipes.values()].sort((left, right) => right.updatedAt - left.updatedAt).map(publicEntry);
    },
    async read(value) {
      await readyPromise;
      return publicEntry(recipes.get(recipeSite(value).key)) ?? null;
    },
    /** 도구 결과에 붙일 힌트용 동기 조회. 아직 못 읽었거나 주소가 사이트가 아니면 null. */
    peek(url) {
      try { return publicEntry(recipes.get(recipeSite(url).key)) ?? null; } catch { return null; }
    },
    write({ site, text, author = 'agent', secrets = [] }) {
      return serialized(async () => {
        const target = recipeSite(site);
        const body = normalizeText(text);
        if (!body) throw failure('RECIPE_TEXT_REQUIRED', 'Give the recipe text, or use action delete.');
        if (body.length > RECIPE_LIMITS.chars) throw failure('RECIPE_TOO_LONG', `Keep a recipe under ${RECIPE_LIMITS.chars} characters; summarize the steps.`);
        if (recipeSecretIssue(body, secrets)) {
          throw failure('RECIPE_SECRET_REJECTED', 'The recipe looks like it contains a password, token, key or other secret value. Describe the steps without values.');
        }
        const next = new Map(recipes);
        if (!next.has(target.key) && next.size >= RECIPE_LIMITS.sites) {
          // 가장 오래 손대지 않은 메모를 비운다.
          const oldest = [...next.values()].sort((left, right) => left.updatedAt - right.updatedAt)[0];
          next.delete(oldest.key);
        }
        next.delete(target.key);
        next.set(target.key, { key: target.key, site: target.site, text: body, author: RECIPE_AUTHORS.has(author) ? author : 'agent', updatedAt: now() });
        await persist(next);
        return publicEntry(next.get(target.key));
      });
    },
    remove(value) {
      return serialized(async () => {
        const { key } = recipeSite(value);
        if (!recipes.has(key)) return { deleted: false };
        const next = new Map(recipes);
        next.delete(key);
        await persist(next);
        return { deleted: true };
      });
    },
  };
}
