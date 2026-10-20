/**
 * 렌더러 오류를 데스크톱 메인의 진단 기록(문제 보고에 실린다)으로 보낸다.
 * window error · unhandledrejection · console.error 를 듣는다. 같은 오류는 30초 안에 한 번만 보내고
 * 몇 번 더 났는지 붙이며, 10초에 30줄을 넘으면 버린 수만 남긴다. 한 줄은 4000자까지다.
 */
export interface DiagnosticEntry {
  level: 'error' | 'warn';
  text: string;
}

export interface RendererDiagnosticsOptions {
  now?: () => number;
  dedupeMs?: number;
  windowMs?: number;
  maxPerWindow?: number;
  flushMs?: number;
  schedule?: (run: () => void, ms: number) => unknown;
}

const ENTRY_MAX_CHARS = 4000;
const SEEN_LIMIT = 200;

export interface RendererDiagnostics {
  record(level: DiagnosticEntry['level'], text: string): void;
  flush(): void;
}

export function createRendererDiagnostics(
  send: (entries: DiagnosticEntry[]) => void,
  {
    now = Date.now,
    dedupeMs = 30_000,
    windowMs = 10_000,
    maxPerWindow = 30,
    flushMs = 500,
    schedule = (run, ms) => setTimeout(run, ms),
  }: RendererDiagnosticsOptions = {},
): RendererDiagnostics {
  const seen = new Map<string, { at: number; repeats: number }>();
  let queue: DiagnosticEntry[] = [];
  let scheduled = false;
  let windowStart = 0;
  let windowCount = 0;
  let dropped = 0;

  const flush = (): void => {
    scheduled = false;
    if (dropped > 0) {
      queue.push({ level: 'warn', text: `${dropped} renderer log entries dropped (rate limit)` });
      dropped = 0;
    }
    if (queue.length === 0) return;
    const batch = queue;
    queue = [];
    try {
      send(batch);
    } catch {
      // 보내지 못한 기록은 버린다.
    }
  };

  const record = (level: DiagnosticEntry['level'], raw: string): void => {
    const text = raw.length > ENTRY_MAX_CHARS ? `${raw.slice(0, ENTRY_MAX_CHARS)}…` : raw;
    if (!text.trim()) return;
    const at = now();
    const signature = text.slice(0, 300);
    const previous = seen.get(signature);
    if (previous && at - previous.at < dedupeMs) {
      previous.repeats += 1;
      return;
    }
    if (at - windowStart >= windowMs) {
      windowStart = at;
      windowCount = 0;
    }
    if (windowCount >= maxPerWindow) {
      dropped += 1;
    } else {
      windowCount += 1;
      const repeats = previous?.repeats ?? 0;
      queue.push({ level, text: repeats > 0 ? `${text}\n(repeated ${repeats} more times before this)` : text });
    }
    seen.delete(signature);
    seen.set(signature, { at, repeats: 0 });
    if (seen.size > SEEN_LIMIT) seen.delete(seen.keys().next().value as string);
    if (!scheduled) {
      scheduled = true;
      schedule(flush, flushMs);
    }
  };

  return { record, flush };
}

function describeError(error: Error): string {
  const head = `${error.name || 'Error'}: ${error.message}`;
  const stack = typeof error.stack === 'string' ? error.stack : '';
  return stack.includes(error.message) ? stack : `${head}${stack ? `\n${stack}` : ''}`;
}

/** console 인자를 한 줄 글로. 오류는 스택을, 객체는 JSON 을 쓴다. */
export function describeValue(value: unknown): string {
  if (value instanceof Error) return describeError(value);
  if (typeof value === 'string') return value;
  if (value === undefined) return 'undefined';
  if (typeof value === 'object' && value !== null) {
    try {
      const json = JSON.stringify(value);
      if (json && json !== '{}') return json.length > 2000 ? `${json.slice(0, 2000)}…` : json;
    } catch {
      // 순환 객체
    }
    if (value instanceof Event) return `[${value.type} event]`;
  }
  return String(value);
}

interface DiagnosticsHost {
  addEventListener: Window['addEventListener'];
  console: Pick<Console, 'error'>;
}

/**
 * 데스크톱 앱에서만 켠다. 해제 함수를 돌려준다.
 */
export function installRendererDiagnostics(
  log: ((entries: DiagnosticEntry[]) => void) | undefined,
  host: DiagnosticsHost = { addEventListener: window.addEventListener.bind(window), console },
): () => void {
  if (typeof log !== 'function') return () => {};
  const diagnostics = createRendererDiagnostics(log);
  let inside = false;
  const guarded = (level: DiagnosticEntry['level'], text: () => string): void => {
    if (inside) return;
    inside = true;
    try {
      diagnostics.record(level, text());
    } catch {
      // 기록 실패는 앱 동작에 닿지 않는다.
    } finally {
      inside = false;
    }
  };
  const onError = (event: ErrorEvent): void => {
    // 그림·스크립트 같은 자원 오류는 ErrorEvent 가 아니다. 문서 쪽 오류만 남긴다.
    if (!(event instanceof ErrorEvent)) return;
    guarded('error', () => (event.error instanceof Error
      ? `window error: ${describeError(event.error)}`
      : `window error: ${event.message} (${event.filename}:${event.lineno}:${event.colno})`));
  };
  const onRejection = (event: PromiseRejectionEvent): void => {
    guarded('error', () => `unhandled rejection: ${describeValue(event.reason)}`);
  };
  host.addEventListener('error', onError as EventListener);
  host.addEventListener('unhandledrejection', onRejection as EventListener);
  const original = host.console.error;
  host.console.error = function teedConsoleError(this: unknown, ...args: unknown[]) {
    original.apply(this, args);
    guarded('error', () => `console.error: ${args.map(describeValue).join(' ')}`);
  };
  return () => {
    host.console.error = original;
    diagnostics.flush();
  };
}
