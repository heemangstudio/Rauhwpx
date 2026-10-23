// Synthetic protocol faults, served by real child processes under the real hub.
// No model requests. The normal CLI login remains untouched.
const readline = require('node:readline');
const agent = process.argv.includes('app-server') ? 'codex' : 'claude';
if (process.argv.includes('--version')) {
  console.log(agent === 'codex' ? 'codex-cli 0.163.0' : '2.1.307 (Claude Code)');
  process.exit(0);
}
const send = (frame) => process.stdout.write(JSON.stringify(frame) + '\n');
const full = '확인 완료. 편집을 저장했습니다.';
const threadId = '11111111-1111-4111-8111-111111111111';
let turnId;
function answer(scenario) {
  scenario = [...scenario.matchAll(/stream-test (healthy|partial|missing|duplicate|auth-failure|crash|stop|reconnect)/g)].at(-1)?.[1] ?? 'healthy';
  if (scenario === 'reconnect') {
    answer('stream-test stop');
    const timer = setInterval(() => {
      if (!require('node:fs').existsSync(releasePath)) return;
      clearInterval(timer);
      if (agent === 'codex') {
        send({ method: 'item/completed', params: { threadId, turnId, item: { id: 'answer', type: 'agentMessage', text: full } } });
        send({ method: 'turn/completed', params: { threadId, turn: { id: turnId, status: 'completed' } } });
      } else {
        send({ type: 'assistant', message: { id: 'first', role: 'assistant', content: [{ type: 'text', text: full }] }, parent_tool_use_id: null, session_id: threadId });
        send({ type: 'result', subtype: 'success', is_error: false, stop_reason: 'end_turn', result: full, session_id: threadId, num_turns: 1, usage: {}, modelUsage: {}, permission_denials: [] });
      }
      process.stdout.write('', () => require('node:fs').writeFileSync(releasePath + '.done', 'done'));
    }, 10);
    return;
  }
  const partial = scenario.includes('partial');
  const missing = scenario.includes('missing');
  const crash = scenario.includes('crash');
  const auth = scenario.includes('auth-failure');
  const stop = scenario.includes('stop');
  if (agent === 'codex') {
    const params = { threadId, turnId, itemId: 'answer' };
    if (auth) {
      send({ method: 'turn/completed', params: { ...params, turn: { id: turnId, status: 'failed', error: { message: 'Authentication failed: please log in again', codexErrorInfo: 'unauthorized' } } } });
      return;
    }
    if (!missing) send({ method: 'item/agentMessage/delta', params: { ...params, delta: partial || crash || stop ? '확인 ' : full } });
    if (stop) return;
    if (crash) { process.exitCode = 23; process.stdin.destroy(); return; }
    const item = { id: 'answer', type: 'agentMessage', text: full };
    send({ method: 'item/completed', params: { ...params, item } });
    if (scenario.includes('duplicate')) send({ method: 'item/completed', params: { ...params, item } });
    send({ method: 'turn/completed', params: { ...params, turn: { id: turnId, status: 'completed' } } });
  } else {
    send({ type: 'system', subtype: 'init', session_id: threadId, model: 'claude-haiku-5-5', tools: [], mcp_servers: [{ name: 'rhwp', status: 'connected' }] });
    if (auth) {
      send({ type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['Authentication failed: please log in again'], session_id: threadId, num_turns: 1 });
      return;
    }
    send({ type: 'stream_event', event: { type: 'message_start', message: { id: 'first' } }, parent_tool_use_id: null, session_id: threadId });
    if (!missing) send({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: partial || crash || stop ? '확인 ' : full } }, parent_tool_use_id: null, session_id: threadId });
    if (stop) return;
    if (crash) { process.exitCode = 23; process.stdin.destroy(); return; }
    const message = { type: 'assistant', message: { id: 'first', role: 'assistant', content: [{ type: 'text', text: partial ? '확인 완료. ' : full }] }, parent_tool_use_id: null, session_id: threadId };
    send(message);
    if (scenario.includes('duplicate')) send(message);
    if (partial) send({ type: 'assistant', message: { id: 'second', role: 'assistant', content: [{ type: 'text', text: '편집을 저장했습니다.' }] }, parent_tool_use_id: null, session_id: threadId });
    send({ type: 'result', subtype: 'success', is_error: false, stop_reason: 'end_turn', result: full, session_id: threadId, num_turns: 1, usage: {}, modelUsage: {}, permission_denials: [] });
  }
}
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const frame = JSON.parse(line);
  if (frame.type === 'control_request') {
    send({ type: 'control_response', response: { subtype: 'success', request_id: frame.request_id, response: { commands: [], agents: [], models: [{ value: 'claude-haiku-5-5', displayName: 'Haiku 5.5' }], account: {} } } });
    return;
  }
  if (frame.type === 'user') {
    answer(JSON.stringify(frame.message.content));
    return;
  }
  if (frame.id === undefined) return;
  let result = {};
  if (frame.method === 'initialize') result = { userAgent: 'codex/0.163.0' };
  if (frame.method === 'experimentalFeature/list') result = { data: [{ name: 'default_mode_request_user_input', enabled: true }], nextCursor: null };
  if (frame.method === 'model/list') result = { data: [{ id: 'gpt-6-luna', model: 'gpt-6-luna', displayName: 'GPT-6 Luna', supportedReasoningEfforts: [], defaultReasoningEffort: 'low' }], nextCursor: null };
  if (frame.method === 'thread/start' || frame.method === 'thread/resume') result = { thread: { id: threadId } };
  if (frame.method === 'turn/start') {
    turnId = require('node:crypto').randomUUID();
    result = { turn: { id: turnId, status: 'inProgress' } };
    send({ method: 'turn/started', params: { threadId, turn: result.turn } });
  }
  send({ id: frame.id, result });
  if (frame.method === 'turn/start') answer(JSON.stringify(frame.params.input));
});
