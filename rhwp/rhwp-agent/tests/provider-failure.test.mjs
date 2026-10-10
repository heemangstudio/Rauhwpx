// 프로바이더 실패 분류: 구조화된 단서·HTTP 상태·문구가 각자의 클래스로 가고,
// 비밀은 Studio 로 가기 전에 지워지며, 문구 속 벽시계 시각은 해석하지 않는다.
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MAX_FAILURE_MESSAGE,
  classifyProviderFailure,
  codexResetAtFromSnapshot,
  failureForHubError,
  mergeTurnFailure,
  normalizeProviderFailureEvent,
  redactFailureText,
} from '../provider-failure.mjs';
import { redactDiagnosticText } from '../agents/backend.mjs';

const classify = (input) => classifyProviderFailure({ agent: 'claude', origin: 'error', ...input });

test('structured provider codes decide the class before any text', () => {
  const cases = [
    [{ source: 'claude', code: 'authentication_failed' }, 'auth_required', 'claude:authentication_failed'],
    [{ source: 'claude', code: 'oauth_org_not_allowed' }, 'auth_required'],
    [{ source: 'claude', code: 'account_on_hold' }, 'auth_required'],
    [{ source: 'claude', code: 'verification_required' }, 'auth_required'],
    [{ source: 'claude', code: 'cloud_credential_error' }, 'auth_required'],
    [{ source: 'claude', code: 'billing_error' }, 'usage_limit'],
    [{ source: 'claude', code: 'rate_limit', rateLimitRejected: true }, 'usage_limit'],
    [{ source: 'claude', code: 'rate_limit' }, 'provider_error'],
    [{ source: 'claude', code: 'overloaded' }, 'provider_error'],
    [{ source: 'claude', code: 'server_error' }, 'provider_error'],
    [{ source: 'claude', code: 'invalid_request' }, 'invalid_request'],
    [{ source: 'claude', code: 'model_not_found' }, 'invalid_request', 'claude:model_not_found'],
    [{ source: 'claude', terminalReason: 'prompt_too_long' }, 'invalid_request', 'claude:prompt_too_long'],
    [{ source: 'codex', code: 'unauthorized' }, 'auth_required', 'codex:unauthorized'],
    [{ source: 'codex', code: 'usageLimitExceeded' }, 'usage_limit', 'codex:usageLimitExceeded'],
    [{ source: 'codex', code: 'sessionBudgetExceeded' }, 'usage_limit'],
    [{ source: 'codex', code: 'serverOverloaded' }, 'provider_error'],
    [{ source: 'codex', code: 'internalServerError' }, 'provider_error'],
    [{ source: 'codex', code: 'rateLimitExceeded' }, 'provider_error'],
    [{ source: 'codex', code: 'flexUnavailable' }, 'provider_error'],
    [{ source: 'codex', code: 'httpConnectionFailed' }, 'network'],
    [{ source: 'codex', code: 'responseStreamDisconnected' }, 'network'],
    [{ source: 'codex', code: 'responseTooManyFailedAttempts', httpStatus: 401 }, 'auth_required'],
    [{ source: 'codex', code: 'responseStreamConnectionFailed', httpStatus: 429 }, 'provider_error'],
    [{ source: 'codex', code: 'contextWindowExceeded' }, 'invalid_request', 'codex:contextWindowExceeded'],
    [{ source: 'codex', code: 'badRequest' }, 'invalid_request'],
    [{ source: 'codex', code: 'cyberPolicy' }, 'invalid_request'],
    [{ source: 'codex', code: 'sandboxError' }, 'invalid_request'],
    [{ source: 'pi', code: 'openrouter_credits' }, 'usage_limit', 'openrouter_credits'],
    [{ source: 'pi', code: 'PI_MODEL_MISSING' }, 'invalid_request', 'PI_MODEL_MISSING'],
    [{ source: 'claude', code: 'cli_missing' }, 'process_exited', 'cli_missing'],
  ];
  for (const [hint, expected, code] of cases) {
    // 문구는 일부러 다른 클래스를 가리킨다 — 구조화된 단서가 이겨야 한다.
    const failure = classify({ hint, message: 'Service unavailable 503, please log in again' });
    assert.equal(failure.class, expected, JSON.stringify(hint));
    if (code !== undefined) assert.equal(failure.code, code, JSON.stringify(hint));
  }
});

test('retryable follows the class, and cleanup or a missing CLI never offers a retry', () => {
  const retryable = (hint, message = '') => classify({ hint, message }).retryable;
  assert.equal(retryable({ source: 'claude', code: 'authentication_failed' }), false);
  assert.equal(retryable({ source: 'codex', code: 'usageLimitExceeded' }), false);
  assert.equal(retryable({ source: 'claude', code: 'overloaded' }), true);
  assert.equal(retryable({ source: 'codex', code: 'httpConnectionFailed' }), true);
  assert.equal(retryable({ source: 'claude', code: 'process_exit' }), true);
  assert.equal(retryable({ source: 'claude', code: 'cli_missing' }), false);
  assert.equal(retryable({ source: 'pi', code: 'PI_MODEL_MISSING' }), false);
  assert.equal(retryable(null, 'something odd happened'), true, 'unknown');
  const cleanup = classify({ message: 'Claude process-tree cleanup could not be confirmed after the terminal result' });
  assert.deepEqual([cleanup.class, cleanup.code, cleanup.retryable], ['process_exited', 'cleanup_uncertain', false]);
});

test('HTTP status classifies when no structured code resolved', () => {
  const cases = [
    [401, 'auth_required'], [402, 'usage_limit'],
    [429, 'provider_error'], [500, 'provider_error'], [503, 'provider_error'], [529, 'provider_error'],
    [400, 'invalid_request'], [404, 'invalid_request'], [413, 'invalid_request'],
  ];
  for (const [httpStatus, expected] of cases) {
    assert.equal(classify({ hint: { source: 'pi', httpStatus }, message: 'opaque' }).class, expected, String(httpStatus));
  }
  assert.equal(classify({ hint: { source: 'claude', httpStatus: 403 }, message: 'opaque' }).class, 'auth_required');
  assert.equal(
    classify({ hint: { source: 'pi', httpStatus: 429 }, message: "You've hit your usage limit" }).class,
    'usage_limit',
    'a 429 that says the usage limit is spent is a usage limit',
  );
});

test('a Pi (OpenRouter) 403 is a refused request or a key spend limit, not a login problem', () => {
  // OpenRouter: 403 = 모더레이션에 걸린 입력, 또는 키의 지출 한도. 로그인을 권하면 고칠 길이 없다.
  const moderation = classifyProviderFailure({
    agent: 'pi', hint: { source: 'pi', httpStatus: 403 },
    message: '403 openai/gpt-x requires moderation on OpenRouter. Your input was flagged for "violence".',
  });
  assert.deepEqual([moderation.class, moderation.retryable], ['invalid_request', false]);
  const keyLimit = classifyProviderFailure({
    agent: 'pi', hint: { source: 'pi', httpStatus: 403 },
    message: '403 Key limit exceeded (daily limit). Manage it using https://openrouter.ai/settings/keys',
  });
  assert.equal(keyLimit.class, 'usage_limit');
  const codex = classifyProviderFailure({ agent: 'codex', hint: { source: 'codex', httpStatus: 403 }, message: 'Forbidden' });
  assert.equal(codex.class, 'auth_required', 'other providers keep 403 as a login problem');
});

test('text patterns classify messages from older paths, in order', () => {
  const cases = [
    ['Invalid API key · Please run /login', 'auth_required'],
    ['OAuth token has expired', 'auth_required'],
    ['401 No auth credentials found', 'auth_required'],
    ['invalid x-api-key', 'auth_required'],
    ["You've hit your usage limit. Try again later.", 'usage_limit'],
    ['Claude AI usage limit reached|1760000000', 'usage_limit'],
    ['Your credit balance is too low to access the API', 'usage_limit'],
    ['insufficient_quota', 'usage_limit'],
    ['getaddrinfo ENOTFOUND api.anthropic.com', 'network'],
    ['fetch failed', 'network'],
    ['stream disconnected before completion', 'network'],
    ['request timed out', 'network'],
    ['Overloaded', 'provider_error'],
    ['upstream returned 502', 'provider_error'],
    ['Too many requests', 'provider_error'],
    ['prompt is too long: 210000 tokens > 200000 maximum', 'invalid_request'],
    ['Context limit reached · /compact or /clear to continue', 'invalid_request'],
    ['model gpt-x not found', 'invalid_request'],
    ['invalid_request_error: messages: field required', 'invalid_request'],
    ['the mailbox exploded', 'unknown'],
  ];
  for (const [message, expected] of cases) {
    assert.equal(classify({ message }).class, expected, message);
  }
  assert.equal(classify({ message: 'prompt is too long' }).code, 'context_window');
  assert.equal(classify({ message: 'Context limit reached · /compact or /clear to continue' }).code, 'context_window',
    'a full conversation is not a usage limit even though it says "limit reached"');
  const exited = classifyProviderFailure({
    agent: 'claude', hint: { source: 'claude', code: 'process_exit' }, message: 'Context limit reached · /compact or /clear to continue',
  });
  assert.equal(exited.class, 'invalid_request', 'a CLI that exits on a full context is not reported as a usage limit');
  assert.equal(classify({ message: 'model gpt-x not found' }).code, 'model_not_found');
});

test('a process exit stays a process exit unless its text says login or usage limit', () => {
  const exit = { source: 'claude', code: 'process_exit' };
  const crash = classify({ hint: exit, message: 'Claude 실행이 중단되었습니다 (code 1).\nAPI Error: Connection error.' });
  assert.deepEqual([crash.class, crash.retryable], ['process_exited', true]);
  assert.equal(classify({ hint: exit, message: 'Error: Invalid API key · Please run /login' }).class, 'auth_required');
  assert.equal(classify({ hint: exit, message: "You've hit your usage limit" }).class, 'usage_limit');
  const model = classify({ hint: { source: 'pi', code: 'process_exit' }, message: 'Error: Model "nope/nope" not found.' });
  assert.deepEqual([model.class, model.code], ['invalid_request', 'model_not_found']);
  const missing = classify({ hint: exit, message: 'claude process error: spawn claude ENOENT' });
  assert.deepEqual([missing.class, missing.code, missing.retryable], ['process_exited', 'cli_missing', false]);
  const exited = classifyProviderFailure({ agent: 'pi', origin: 'turn-end', stopReason: 'exited', message: '' });
  assert.equal(exited.class, 'process_exited');
  assert.ok(exited.message, 'a silent exit still carries a readable default message');
});

test('a process exit is not read as a login or usage failure from stack line numbers or file paths', () => {
  const exit = { source: 'pi', code: 'process_exit' };
  const exits = [
    'Pi 실행이 중단되었습니다 (code 1).\nTypeError: Cannot read properties of undefined\n    at render (file:///opt/pi/dist/ui.js:401:12)\n    at main (main.js:402:3)',
    'Pi 실행이 중단되었습니다 (code 1).\nError: Failed to load /Users/a/login/settings.json',
    'Pi 실행이 중단되었습니다 (code 1).\n    at Object.<anonymous> (/srv/app/node_modules/x/lib/authentication/index.js:12:7)',
    'Claude 실행이 중단되었습니다 (code 1).\nat parse (C:\\Users\\a\\usage limit\\cli.js:88:1)',
    'Pi 실행이 중단되었습니다 (code 1).\n    at step (vendor.js:402:9)',
  ];
  for (const message of exits) {
    const failure = classifyProviderFailure({ agent: 'pi', hint: exit, message });
    assert.deepEqual([failure.class, failure.retryable], ['process_exited', true], message);
  }
  // HTTP 맥락이 있는 상태 코드와 명령으로서의 /login 은 여전히 로그인·한도다.
  const auth = (message) => classifyProviderFailure({ agent: 'codex', hint: { source: 'codex', code: 'process_exit' }, message }).class;
  assert.equal(auth('Codex app-server disconnected.\nERROR codex_core: unexpected status 401 Unauthorized'), 'auth_required');
  assert.equal(auth('request failed: HTTP 401 from https://api.example.com/v1/responses'), 'auth_required');
  assert.equal(auth('{"error":{"code":401,"message":"bad key"}}'), 'auth_required');
  assert.equal(auth('Invalid API key · Please run /login'), 'auth_required');
  assert.equal(auth('request failed with status code 402'), 'usage_limit');
});

test('max_output_tokens is not a failure code', () => {
  // 어댑터는 max_output_tokens 에 단서를 붙이지 않는다. 붙더라도 실패 클래스를 만들지 않는다.
  const failure = classify({ hint: { source: 'claude', code: 'max_output_tokens' }, message: '' });
  assert.equal(failure.class, 'unknown');
  const normalized = normalizeProviderFailureEvent(
    { type: 'turn-end', agent: 'claude', stopReason: 'max_tokens' },
    { agent: 'claude', running: true },
  );
  assert.equal(normalized.failure, null);
  assert.equal('failure' in normalized.event, false);
});

test('redaction removes credentials, every query string and JWTs, and caps the length', () => {
  const jwt = `eyJ${'a'.repeat(24)}.${'b'.repeat(40)}.${'c'.repeat(30)}`;
  const secretToken = 'hub-session-token-abcdef0123456789';
  const raw = [
    'Authorization: Bearer abcdefghijklmnop0123456789',
    'proxy auth Basic dXNlcjpwYXNzd29yZDEyMzQ=',
    'key sk-ant-oat01-REPLAYSECRETabcdefghij0123456789',
    'openrouter sk-or-v1-REPLAYSECRET0123456789abcdef',
    'api_key=REPLAYSECRETassignment',
    'x-api-key: REPLAYSECRETheader',
    'https://user:REPLAYSECRETpw@example.com/path',
    'see https://chatgpt.com/codex/settings/usage?session=REPLAYSECRETquery#frag and https://example.com/a?x=1',
    `token ${jwt}`,
    `mcp ${secretToken}`,
    '\u001b[31mred\u001b[0m   spaced\t\ttext',
  ].join('\n');
  const text = redactFailureText(raw, [secretToken]);
  assert.doesNotMatch(text, /REPLAYSECRET/);
  assert.doesNotMatch(text, /abcdefghijklmnop0123456789|dXNlcjpwYXNzd29yZDEyMzQ/);
  assert.equal(text.includes(jwt), false, 'JWT access tokens are removed');
  assert.equal(text.includes(secretToken), false, 'secrets passed by the hub are removed');
  assert.doesNotMatch(text, /\?session=|x=1|#frag/, 'any query string or fragment is stripped');
  assert.match(text, /https:\/\/chatgpt\.com\/codex\/settings\/usage\?\[redacted\]/);
  assert.match(text, /red spaced text/, 'ANSI codes and runs of whitespace are normalized');

  const long = redactFailureText(`${'가'.repeat(MAX_FAILURE_MESSAGE * 3)}`);
  assert.ok(long.length <= MAX_FAILURE_MESSAGE);
  const emoji = redactFailureText('😀'.repeat(MAX_FAILURE_MESSAGE));
  assert.ok(emoji.length <= MAX_FAILURE_MESSAGE);
  assert.doesNotMatch(emoji.slice(-2, -1), /[\uD800-\uDBFF]/, 'no split surrogate pair before the ellipsis');

  const failure = classify({ hint: { source: 'claude', code: 'authentication_failed' }, message: raw });
  assert.doesNotMatch(failure.message, /REPLAYSECRET/);
  assert.ok(failure.message.length <= MAX_FAILURE_MESSAGE);
});

test('redaction also covers escaped JSON pairs, token-only userinfo, any URL scheme and schemeless hosts', () => {
  const cases = [
    ['{"error":"{\\"api_key\\":\\"REPLAYSECRETescaped\\"}"}', /\\"api_key\\":\[redacted\]/],
    ['GET https://REPLAYSECRETtoken0123@api.example.com/v1', /https:\/\/\[redacted\]@api\.example\.com\/v1/],
    ['connect ws://127.0.0.1:5175/mcp?auth=REPLAYSECRETws failed', /ws:\/\/127\.0\.0\.1:5175\/mcp\?\[redacted\] failed/],
    ['wss://user:REPLAYSECRETpw@hub.example.com/socket', /wss:\/\/\[redacted\]@hub\.example\.com\/socket/],
    ['POST api.example.com/v1?key=REPLAYSECRETbare returned 403', /api\.example\.com\/v1\?\[redacted\] returned 403/],
    ['dial 127.0.0.1:5175/mcp?token=REPLAYSECRETip refused', /127\.0\.0\.1:5175\/mcp\?\[redacted\] refused/],
    ['localhost:8080/cb?code=REPLAYSECRETlocal', /localhost:8080\/cb\?\[redacted\]/],
  ];
  for (const [raw, expected] of cases) {
    const text = redactFailureText(raw);
    assert.doesNotMatch(text, /REPLAYSECRET/, raw);
    assert.match(text, expected, raw);
  }
  // 쿼리를 통째로 지운 자리에 공용 가림의 꼬리가 남지 않는다.
  assert.equal(redactFailureText('https://x.com/a?password=REPLAYSECRET'), 'https://x.com/a?[redacted]');
  // 쿼리가 아닌 물음표 문장은 그대로다.
  assert.equal(redactFailureText('Is the file at docs.example.com ready? yes'), 'Is the file at docs.example.com ready? yes');
});

test('resetAt comes only from structured data or the Claude epoch suffix, never from a wall-clock phrase', () => {
  const structured = classifyProviderFailure({
    agent: 'claude', message: "You've hit your limit · resets 3pm (UTC)",
    hint: { source: 'claude', code: 'rate_limit', rateLimitRejected: true, resetAt: 4102444800000 },
  });
  assert.equal(structured.resetAt, 4102444800000);
  const wallClock = classifyProviderFailure({ agent: 'claude', message: "You've hit your limit · resets 3pm (UTC)" });
  assert.equal(wallClock.class, 'usage_limit');
  assert.equal(wallClock.resetAt, null);
  const codexText = classifyProviderFailure({ agent: 'codex', message: "You've hit your usage limit ... try again at 3:15 PM." });
  assert.equal(codexText.resetAt, null);
  const suffix = classifyProviderFailure({ agent: 'claude', message: 'Claude AI usage limit reached|1760000000' });
  assert.equal(suffix.resetAt, 1_760_000_000_000);
  const notUsage = classifyProviderFailure({ agent: 'claude', message: 'Overloaded', hint: { source: 'claude', resetAt: 5 } });
  assert.equal(notUsage.resetAt, null, 'only usage limits carry a reset time');
});

test('codexResetAtFromSnapshot reads only exhausted windows and needs all of them to reset', () => {
  const now = 1_000_000_000_000;
  assert.equal(codexResetAtFromSnapshot({
    primary: { usedPercent: 100, resetsAt: 1_000_100_000 },
    secondary: { usedPercent: 40, resetsAt: 1_000_900_000 },
  }, now), 1_000_100_000_000);
  assert.equal(codexResetAtFromSnapshot({
    primary: { usedPercent: 100, resetsAt: 1_000_100_000 },
    secondary: { usedPercent: 100, resetsAt: 1_000_900_000 },
  }, now), 1_000_900_000_000, 'both windows must reset before Codex can be used again');
  assert.equal(codexResetAtFromSnapshot({ primary: { usedPercent: 100, resetsAt: 999_000_000 } }, now), null, 'past');
  assert.equal(codexResetAtFromSnapshot({ primary: { usedPercent: 99, resetsAt: 1_000_100_000 } }, now), null);
  assert.equal(codexResetAtFromSnapshot(null, now), null);
});

test('mergeTurnFailure keeps the first known class and upgrades an unknown one', () => {
  const unknown = classify({ message: 'odd' });
  const auth = classify({ message: '401 Unauthorized' });
  const usage = classify({ message: 'usage limit reached' });
  assert.equal(mergeTurnFailure(null, auth), auth);
  assert.equal(mergeTurnFailure(auth, usage), auth);
  assert.equal(mergeTurnFailure(unknown, usage), usage);
  assert.equal(mergeTurnFailure(auth, unknown), auth);
  assert.equal(mergeTurnFailure(auth, null), auth);
});

test('failureForHubError classifies only the provider codes', () => {
  assert.equal(failureForHubError('AGENT_BUSY', new Error('busy'), 'claude'), null);
  assert.equal(failureForHubError('INVALID_REQUEST', new Error('bad'), 'claude'), null);
  const auth = failureForHubError('AGENT_AUTH_REQUIRED', new Error('Claude 로그인이 필요합니다.'), 'claude');
  assert.deepEqual([auth.class, auth.code, auth.retryable, auth.agent], ['auth_required', 'AGENT_AUTH_REQUIRED', false, 'claude']);
  assert.equal(failureForHubError('PI_NOT_CONFIGURED', new Error('Pi 설정'), 'pi').class, 'auth_required');
  const spawn = failureForHubError('AGENT_SPAWN_FAILED', new Error('spawn exploded'), 'codex');
  assert.deepEqual([spawn.class, spawn.retryable], ['process_exited', true]);
  const missing = failureForHubError('AGENT_SPAWN_FAILED', new Error('spawn codex ENOENT'), 'codex');
  assert.deepEqual([missing.code, missing.retryable], ['cli_missing', false]);
  const cleanup = failureForHubError('AGENT_PROCESS_CLEANUP_UNCERTAIN', new Error('Restart the app'), 'claude');
  assert.deepEqual([cleanup.class, cleanup.retryable], ['process_exited', false]);
  const secret = failureForHubError('AGENT_SPAWN_FAILED', new Error('failed with token=REPLAYSECRETx'), 'pi');
  assert.doesNotMatch(secret.message, /REPLAYSECRET/);
});

test('normalizeProviderFailureEvent merges a turn into one failure and fills a silent failure', () => {
  let held = null;
  const first = normalizeProviderFailureEvent(
    { type: 'error', agent: 'codex', message: 'usage limit reached', failure: { source: 'codex', code: 'usageLimitExceeded' } },
    { agent: 'codex', held, running: true },
  );
  held = first.held;
  assert.equal(first.event.failure.class, 'usage_limit');
  const end = normalizeProviderFailureEvent(
    { type: 'turn-end', agent: 'codex', stopReason: 'failed', errorMessage: 'usage limit reached' },
    { agent: 'codex', held, running: true },
  );
  assert.equal(end.event.failure.class, 'usage_limit');
  assert.equal(end.event.failure.code, 'codex:usageLimitExceeded', 'the held structured failure wins');

  const silent = normalizeProviderFailureEvent({ type: 'turn-end', agent: 'pi', stopReason: 'failed' }, { agent: 'pi', running: true });
  assert.equal(silent.event.failure.class, 'unknown');
  assert.equal(silent.event.errorMessage, silent.event.failure.message, 'older Studios still get a line');

  const interrupted = normalizeProviderFailureEvent(
    { type: 'turn-end', agent: 'pi', stopReason: 'interrupted', failure: { source: 'pi', code: 'process_exit' } },
    { agent: 'pi', held: first.held, running: true },
  );
  assert.deepEqual(interrupted.event, { type: 'turn-end', agent: 'pi', stopReason: 'interrupted' });

  const idle = normalizeProviderFailureEvent({ type: 'error', agent: 'pi', message: 'boom' }, { agent: 'pi', running: false });
  assert.equal(idle.held, null, 'an idle error is not merged into a turn');
});

test('redaction removes vendor-shaped tokens that carry no key name', () => {
  const secrets = {
    github: 'ghp_0123456789abcdefABCDEF0123456789abcd',
    githubPat: 'github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz',
    stripeLike: 'sk_live_0123456789abcdefABCD',
    slack: 'xoxb-1234567890-abcdefghij',
    aws: 'AKIAABCDEFGHIJKLMNOP',
    google: 'AIzaSyA0123456789abcdefghijklmnopqrstuv',
  };
  const text = Object.values(secrets).map((value, index) => `line ${index}: ${value}`).join('\n');
  const redacted = redactFailureText(text);
  for (const [name, value] of Object.entries(secrets)) {
    assert.ok(!redacted.includes(value), `${name} is removed`);
  }
  assert.match(redacted, /line 0: \[redacted\]/);
  // 비슷하지만 토큰이 아닌 낱말은 남는다.
  assert.equal(redactFailureText('the ghp_ prefix and sk_live_ mode are documented'), 'the ghp_ prefix and sk_live_ mode are documented');
});

test('every Authorization scheme, Proxy-Authorization, PEM private keys and Hugging Face tokens are removed', () => {
  const cases = {
    tokenScheme: 'Authorization: token REPLAYSECRETgithubtoken01',
    apiKeyScheme: 'authorization=ApiKey REPLAYSECRETapikey02',
    tokenUpper: 'Authorization: Token REPLAYSECRETtoken03, retry=1',
    negotiate: 'Authorization: Negotiate REPLAYSECRETnegotiate04',
    proxyBasic: 'Proxy-Authorization: Basic REPLAYSECRETbasic05==',
    proxyDigest: 'Proxy-Authorization: Digest username="me", realm="corp", nonce="n1", response="REPLAYSECRETdigest06"; next',
    pem: 'loaded key:\n-----BEGIN RSA PRIVATE KEY-----\nREPLAYSECRETpem07\nMIIEowIBAAKCAQEA\n-----END RSA PRIVATE KEY-----\ndone',
    pemCutEnd: 'key -----BEGIN OPENSSH PRIVATE KEY-----\nREPLAYSECRETpem08\nb3BlbnNzaC',
    pemCutStart: 'REPLAYSECRETpem09\nMIIEowIBAAKCAQEA\n-----END PRIVATE KEY-----\nafter the key',
    huggingFace: 'HF_TOKEN missing; got hf_REPLAYSECREThuggingface0123456789',
  };
  for (const [name, raw] of Object.entries(cases)) {
    for (const [redactor, text] of [['diagnostic', redactDiagnosticText(raw)], ['failure', redactFailureText(raw)]]) {
      assert.doesNotMatch(text, /REPLAYSECRET/, `${name} (${redactor}): ${text}`);
      assert.match(text, /\[redacted\]/, `${name} (${redactor})`);
    }
  }
  // 헤더 이름과 뒤따르는 글은 남아 무엇이 지워졌는지 읽힌다.
  assert.equal(redactDiagnosticText(cases.tokenUpper), 'Authorization: [redacted], retry=1');
  assert.equal(redactDiagnosticText(cases.proxyDigest), 'Proxy-Authorization: [redacted]; next');
  assert.match(redactDiagnosticText(cases.pem), /^loaded key:\n\[redacted\]\ndone$/);
  assert.match(redactDiagnosticText(cases.pemCutStart), /after the key$/);
  // 키 이름이 아닌 문구, 공개 키는 남는다.
  assert.equal(redactDiagnosticText('Authorization required to continue'), 'Authorization required to continue');
  const publicKey = '-----BEGIN PUBLIC KEY-----\nMFkwEwYHKoZIzj0CAQYI\n-----END PUBLIC KEY-----';
  assert.equal(redactDiagnosticText(publicKey), publicKey);
});

test('a secret cut by the classification length limit never shows as a fragment', () => {
  const secret = 'hub-session-token-REPLAYSECRETcut0123456789';
  // 분류 상한(16,000자) 가운데를 지나는 비밀 — 앞부분만 남으면 알아보지 못해 가림을 빠져나간다.
  // 긴 공백은 문구를 정리할 때 하나로 줄어, 잘린 자리가 보이는 문구 안으로 들어온다.
  const message = `stderr:${' '.repeat(15_983)}${secret} tail`;
  assert.ok(message.indexOf(secret) < 16_000 && message.indexOf(secret) + secret.length > 16_000);
  const failure = classify({ message }, { secrets: [secret] });
  assert.doesNotMatch(failure.message, /hub-sess/);
  assert.match(failure.message, /^stderr:/);
});
