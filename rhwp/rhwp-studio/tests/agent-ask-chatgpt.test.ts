import assert from 'node:assert/strict';
import test from 'node:test';
import { presentToolCall, presentToolResult } from '../src/ui/agent-sidebar/tool-presentation.ts';
import { readWebAssistantStatus, webAssistantStatusView } from '../src/ui/agent-sidebar/web-assistant-settings.ts';
import { readChatPermissionRequest } from '../src/agent/chat-permissions.ts';

const CHAT = 'https://chatgpt.com/g/g-p-0123456789abcdef0123456789abcdef-hamaeditor/c/6adc5c72-88e4-83e8-9af1-76f614c6b91b';
const args = JSON.stringify({ question: '보고서를 쓸 때 내가 선호하는 말투는?' });

test('ask_chatgpt cards show the question, the full answer and an Open in ChatGPT link', () => {
  const call = presentToolCall('mcp__rhwp__ask_chatgpt', args);
  assert.equal(call.label, 'ChatGPT에 묻기');
  assert.match(call.summary, /선호하는 말투/);
  const answer = '평소 **간결한** 말투를 선호합니다.\n\n- 짧은 문장';
  // 허브가 보낸 잘리지 않은 결과
  const full = presentToolResult({ tool: 'ask_chatgpt', argsJson: args, ok: true, preview: '', result: { chatUrl: CHAT, answer } });
  assert.equal(full.text, '답 받음');
  assert.equal(full.answer, answer);
  assert.deepEqual(full.link, { href: CHAT, label: 'ChatGPT에서 열기' });
  // 프로바이더의 잘린 미리보기에서도 채팅 링크는 남는다.
  const preview = JSON.stringify([{ type: 'text', text: JSON.stringify({ chatUrl: CHAT, answer: 'x'.repeat(3000) }) }]).slice(0, 2000);
  assert.deepEqual(presentToolResult({ tool: 'mcp__rhwp__ask_chatgpt', argsJson: args, ok: true, preview }).link?.href, CHAT);
  // 다른 사이트 주소는 링크가 되지 않는다.
  const foreign = presentToolResult({ tool: 'ask_chatgpt', argsJson: args, ok: true, preview: '', result: { chatUrl: 'https://evil.example/c/1', answer } });
  assert.equal(foreign.link, undefined);
  const failed = presentToolResult({ tool: 'ask_chatgpt', argsJson: args, ok: false, preview: '', error: { code: 'CHATGPT_SIGNED_OUT', message: 'ChatGPT is signed out.' } });
  assert.equal(failed.ok, false);
  assert.equal(failed.text, 'ChatGPT 로그인 필요');
});

test('ask_claude cards show the answer with an Open in Claude link and only accept claude.ai chats', () => {
  const chat = 'https://claude.ai/chat/0b5c3f9e-1d2a-4c8b-9e7f-123456789abc';
  const claudeArgs = JSON.stringify({ question: '내가 선호하는 말투는?' });
  const call = presentToolCall('mcp__rhwp__ask_claude', claudeArgs);
  assert.equal(call.label, 'Claude에 묻기');
  const full = presentToolResult({ tool: 'ask_claude', argsJson: claudeArgs, ok: true, preview: '', result: { chatUrl: chat, answer: '간결한 말투' } });
  assert.equal(full.answer, '간결한 말투');
  assert.deepEqual(full.link, { href: chat, label: 'Claude에서 열기' });
  // ChatGPT 주소를 Claude 링크로 쓰지 않는다.
  assert.equal(presentToolResult({ tool: 'ask_claude', argsJson: claudeArgs, ok: true, preview: '', result: { chatUrl: CHAT, answer: 'x' } }).link, undefined);
  const limited = presentToolResult({ tool: 'ask_claude', argsJson: claudeArgs, ok: false, preview: '', error: { code: 'CLAUDE_LIMIT', message: 'limit' } });
  assert.equal(limited.text, 'Claude 사용 한도 도달');
});
