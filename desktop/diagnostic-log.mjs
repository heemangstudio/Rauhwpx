import { appendFileSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { formatWithOptions } from 'node:util';

// 문제 보고에 싣는 진단 기록. 메인 경고·오류, 허브 stderr, 렌더러 오류를 한 파일에 시간순으로 모은다.
// 비정상 종료 뒤에도 남도록 디스크에 쓰고, 파일 하나가 maxBytes 를 넘으면 .1 로 한 번만 돌린다.
export const DIAGNOSTIC_LOG_DIR = 'logs';
export const DIAGNOSTIC_LOG_FILE = 'diagnostic.log';
export const DIAGNOSTIC_LOG_MAX_BYTES = 1024 * 1024;
const ENTRY_MAX_CHARS = 8 * 1024;
const RING_MAX_CHARS = 256 * 1024;
const FLUSH_DELAY_MS = 200;

const REDACTED = '[redacted]';
// 순서가 중요하다: 머리글 전체를 먼저 가리고, 그다음 값 모양으로 알아보는 키를 가린다.
const SECRET_PATTERNS = [
  [/\b((?:proxy-)?authorization)(["']?\s*[:=]\s*["']?)(?:(?:Bearer|Basic|Token)\s+)?[^\s"',;]+/gi, `$1$2${REDACTED}`],
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/g, `$1 ${REDACTED}`],
  [/\bsk-[A-Za-z0-9_-]{16,}/g, REDACTED],
  [/\bxai-[A-Za-z0-9]{20,}/g, REDACTED],
  [/\bAIza[0-9A-Za-z_-]{30,}/g, REDACTED],
  [/\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})/g, REDACTED],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}/g, REDACTED],
  [/\bAKIA[0-9A-Z]{16}\b/g, REDACTED],
  [/\bbb_(?:live|test)_[A-Za-z0-9_-]{12,}/g, REDACTED],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, REDACTED],
  [/\bHAMA(?:-[0-9A-Z]{5}){5}\b/gi, `HAMA-${REDACTED}`],
  // 쿠키 머리글 값(name=value; …)과 URL 의 사용자 정보(scheme://user:pass@).
  [/\b((?:set-)?cookie)(["']?\s*[:=]\s*["']?)[^\s=;"',]+=[^\r\n"']*/gi, `$1$2${REDACTED}`],
  [/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:"']+:[^\s/@"']+@/gi, `$1${REDACTED}@`],
  [
    /\b((?:[a-z0-9]+[_-])?(?:api[_-]?key|apikey|access[_-]?key|private[_-]?key|session[_-]?key|token|secret|password|passwd|credential)s?)(["']?\s*[:=]\s*["']?)(?!\[redacted\])([^\s"'&,;)}\]]{8,})/gi,
    `$1$2${REDACTED}`,
  ],
  // 키 이름이 비밀번호라고 밝히면 짧은 값도 가린다.
  [/\b(password|passwd|pwd)(["']?\s*[:=]\s*["']?)(?!\[redacted\])([^\s"'&,;)}\]]+)/gi, `$1$2${REDACTED}`],
];
// Windows 의 다른 사용자 폴더와 8.3 짧은 이름(C:\Users\MANAG~1)도 사용자 이름을 드러낸다.
const WINDOWS_USER_DIR = /\b([A-Za-z]:(?:\\{1,2}|\/)Users(?:\\{1,2}|\/))(?!Public\b|Default\b|\[user\])[^\\/\s"'`:;,)\]}]+/gi;

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 홈 경로가 기록에 나타나는 모양들. Windows 는 대소문자를 가리지 않고, 스택의 file:// URL 은 / 와
 * URL 인코딩을, util.inspect·JSON 은 \\ 두 번을 쓴다.
 */
let cachedHomePattern = null;
function homePattern(home) {
  if (cachedHomePattern?.home === home) {
    cachedHomePattern.pattern.lastIndex = 0;
    return cachedHomePattern.pattern;
  }
  const windows = /^[A-Za-z]:[\\/]/.test(home);
  const variants = new Set([home, encodeURI(home)]);
  if (windows) {
    const back = home.replaceAll('/', '\\');
    const forward = back.replaceAll('\\', '/');
    for (const variant of [back, forward, encodeURI(forward), back.replaceAll('\\', '\\\\')]) variants.add(variant);
  }
  const alternatives = [...variants].filter((value) => value.length > 1)
    .sort((left, right) => right.length - left.length)
    .map(escapeRegExp);
  // 홈 이름 뒤에 이름 글자가 이어지면 다른 폴더다(C:\Users\manag 와 C:\Users\manager·manag.kim·김하마하).
  // 문장 끝의 마침표(… /Users/andy.)는 이름이 아니므로 가린다.
  const pattern = new RegExp(`(?:${alternatives.join('|')})(?![\\p{L}\\p{N}_-]|\\.[\\p{L}\\p{N}_-])`, windows ? 'giu' : 'gu');
  cachedHomePattern = { home, pattern };
  return pattern;
}

/** 비밀로 보이는 값(키·토큰·Authorization·쿠키)을 가리고, 홈 폴더 경로는 ~ 로 줄인다. */
export function redactSecrets(text, { secrets = [], home = '' } = {}) {
  let out = String(text);
  for (const secret of secrets) {
    if (typeof secret === 'string' && secret.length >= 8) out = out.split(secret).join(REDACTED);
  }
  for (const [pattern, replacement] of SECRET_PATTERNS) out = out.replace(pattern, replacement);
  if (home && home.length > 1) out = out.replace(homePattern(home), '~');
  return out.replace(WINDOWS_USER_DIR, '$1[user]');
}

/** console 인자를 console 과 같은 모양의 한 덩어리 글로 만든다. */
export function formatLogArgs(args) {
  return formatWithOptions({ depth: 4, breakLength: Infinity, colors: false }, ...args);
}

function clip(text, max) {
  return text.length > max ? `${text.slice(0, max)}… (+${text.length - max} chars)` : text;
}

/** 긴 글은 끝을 남긴다. 잘린 첫 줄은 버린다. */
function tailText(text, maxBytes) {
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length <= maxBytes) return text;
  const tail = bytes.subarray(bytes.length - maxBytes).toString('utf8');
  const newline = tail.indexOf('\n');
  return newline >= 0 ? tail.slice(newline + 1) : tail;
}

function fileSize(filePath) {
  try {
    return statSync(filePath).size;
  } catch {
    return 0;
  }
}

function readOrEmpty(filePath) {
  try {
    return readFileSync(filePath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return '';
    throw error;
  }
}

/**
 * @param {{ dir: string, maxBytes?: number, now?: () => number, secrets?: string[], home?: string,
 *   flushDelayMs?: number }} options
 */
export function createDiagnosticLog({
  dir,
  maxBytes = DIAGNOSTIC_LOG_MAX_BYTES,
  now = Date.now,
  secrets = [],
  home = '',
  flushDelayMs = FLUSH_DELAY_MS,
} = {}) {
  const filePath = join(dir, DIAGNOSTIC_LOG_FILE);
  const rotatedPath = `${filePath}.1`;
  const knownSecrets = new Set(secrets.filter((value) => typeof value === 'string' && value.length >= 8));
  let size = fileSize(filePath);
  let pending = [];
  let timer = null;
  let ring = '';

  const redact = (text) => redactSecrets(text, { secrets: [...knownSecrets], home });

  function flushSync() {
    if (timer) clearTimeout(timer);
    timer = null;
    if (pending.length === 0) return;
    let chunk = pending.join('');
    pending = [];
    let bytes = Buffer.byteLength(chunk, 'utf8');
    if (bytes > maxBytes) {
      chunk = tailText(chunk, maxBytes);
      bytes = Buffer.byteLength(chunk, 'utf8');
    }
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      if (size > 0 && size + bytes > maxBytes) {
        try {
          renameSync(filePath, rotatedPath);
        } catch {
          // 돌릴 파일을 잠시 못 옮기면(Windows 백신 등) 지금 파일을 비우고 이어 쓴다.
          writeFileSync(filePath, '', { mode: 0o600 });
        }
        size = 0;
      }
      appendFileSync(filePath, chunk, { encoding: 'utf8', mode: 0o600 });
      size += bytes;
    } catch {
      // 디스크에 못 쓰면 이번 줄은 메모리 기록에만 남는다. 여기서 console 로 알리면 자기 자신을 부른다.
    }
  }

  function scheduleFlush() {
    if (timer) return;
    timer = setTimeout(flushSync, flushDelayMs);
    timer.unref?.();
  }

  function writeText(source, level, text) {
    const message = redact(clip(String(text ?? '').replace(/\s+$/, ''), ENTRY_MAX_CHARS));
    if (!message) return;
    const stamp = new Date(now()).toISOString();
    const line = `${stamp} ${String(level).padEnd(5)} [${source}] ${message.replace(/\n/g, '\n    ')}\n`;
    ring = tailText(ring + line, RING_MAX_CHARS);
    pending.push(line);
    scheduleFlush();
  }

  return {
    filePath,
    write(source, level, ...args) {
      writeText(source, level, formatLogArgs(args));
    },
    writeText,
    /** 로그에 나타나면 안 되는 값(허브 토큰 등)을 더한다. 이미 쓴 줄은 바꾸지 않는다. */
    addSecret(value) {
      if (typeof value === 'string' && value.length >= 8) knownSecrets.add(value);
    },
    flushSync,
    /** 디스크의 기록(돌린 파일 포함)에서 끝 maxBytes 를 읽는다. 읽지 못하면 이번 실행의 메모리 기록을 준다. */
    tail(limit = 512 * 1024) {
      flushSync();
      try {
        return tailText(readOrEmpty(rotatedPath) + readOrEmpty(filePath), limit);
      } catch {
        return tailText(ring, limit);
      }
    },
  };
}

/**
 * 흐름(허브 stderr 등)의 조각을 완성된 줄로 모아 write 에 넘긴다. 조각 경계에서 잘린 비밀도 한 줄로
 * 모인 뒤 가려진다. 줄바꿈 없이 길어지면 ENTRY_MAX_CHARS 에서 끊는다. end() 는 남은 글을 넘긴다.
 */
export function createLineSink(write) {
  const decoder = new StringDecoder('utf8');
  let rest = '';
  const emit = (text) => {
    if (text) write(text);
  };
  return {
    write(chunk) {
      rest += typeof chunk === 'string' ? chunk : decoder.write(chunk);
      const cut = rest.lastIndexOf('\n');
      if (cut >= 0) {
        emit(rest.slice(0, cut));
        rest = rest.slice(cut + 1);
      }
      if (rest.length > ENTRY_MAX_CHARS) {
        emit(rest);
        rest = '';
      }
    },
    end() {
      emit(rest + decoder.end());
      rest = '';
    },
  };
}

/**
 * console.warn/error 를 그대로 출력하면서 기록에도 남긴다. 기록이 실패해도 출력은 막지 않는다.
 * @returns {() => void} 원래 함수로 되돌린다.
 */
export function teeConsole(log, { target = console, source = 'main', levels = ['warn', 'error'] } = {}) {
  const originals = new Map();
  for (const level of levels) {
    const original = target[level];
    originals.set(level, original);
    target[level] = function teed(...args) {
      original.apply(this, args);
      try {
        log.write(source, level, ...args);
      } catch {
        // 기록 실패가 경고 출력을 막지 않는다.
      }
    };
  }
  return () => {
    for (const [level, original] of originals) target[level] = original;
  };
}

/**
 * 메인 프로세스의 치명 오류를 남긴다. uncaughtExceptionMonitor 는 듣기만 하는 이벤트라 종료 동작(Electron 의
 * 오류 창·종료)은 그대로다. unhandledRejection 에 듣는 쪽을 달면 Node 가 기본 처리를 건너뛰므로 달지 않는다 —
 * Electron 메인은 warn 모드라 처리하지 않은 거부를 console.error 로 알리고, 그 줄은 teeConsole 이 남긴다.
 */
export function installProcessDiagnostics(log, target = process) {
  target.on('uncaughtExceptionMonitor', (error, origin) => {
    try {
      log.write('main', 'fatal', `${origin}:`, error);
      log.flushSync();
    } catch {
      // 죽어 가는 프로세스에서 기록 실패는 무시한다.
    }
  });
}
