import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createChatAttentionLedger,
  type AttentionNotice,
  type AttentionReport,
} from '../src/agent/chat-attention.ts';
import type { ChatRunStatus } from '../src/agent/chat-status.ts';
import { installAttentionToasts, installWebAgentAttention } from '../src/ui/agent-attention.ts';
import { loadAttentionPrefs, saveAttentionPrefs, subscribeAttentionPrefs } from '../src/agent/attention-prefs.ts';
import type { ToastOptions } from '../src/ui/toast.ts';

function harness(opts: { focused?: boolean; details?: boolean } = {}) {
  const statuses = new Map<string, ChatRunStatus | null>();
  let focused = opts.focused ?? false;
  let details = opts.details ?? false;
  const ledger = createChatAttentionLedger({
    getStatus: (threadId) => statuses.get(threadId) ?? null,
    windowFocused: () => focused,
    showDetails: () => details,
  });
  const notices: AttentionNotice[] = [];
  const counts: number[] = [];
  ledger.subscribe({ notice: (notice) => notices.push(notice), count: (count) => counts.push(count) });
  /** 사이드바가 상태를 쓰고 알리는 것처럼 — 저장소와 장부를 함께 맞춘다. */
  const report = (input: Partial<AttentionReport> & Pick<AttentionReport, 'threadId' | 'status' | 'key'>) => {
    statuses.set(input.threadId, input.status);
    ledger.report({
      seen: false,
      title: '사업 개요 다듬기',
      documentName: '사업 제안서.hwpx',
      ...input,
    });
  };
  return {
    ledger,
    notices,
    counts,
    statuses,
    report,
    focus(next: boolean) { focused = next; },
    showDetails(next: boolean) { details = next; },
  };
}

test('an unseen finish notifies once per turn, showing only the app name and the fixed phrase', () => {
  const h = harness();
  h.report({ threadId: 'a', status: 'finished', key: 'turn-1:end' });
  assert.equal(h.notices.length, 1);
  assert.deepEqual(
    { title: h.notices[0]!.title, body: h.notices[0]!.body, channel: h.notices[0]!.channel },
    { title: 'HamaEditor', body: '작업을 마쳤습니다', channel: 'system' },
  );
  assert.doesNotMatch(JSON.stringify([h.notices[0]!.title, h.notices[0]!.body]), /사업/, 'no chat title or document name');
  h.report({ threadId: 'a', status: 'finished', key: 'turn-1:end' });
  assert.equal(h.notices.length, 1, 'the same key never notifies twice');
  assert.equal(h.ledger.count(), 1);
  assert.deepEqual(h.counts, [1]);
});

test('a focused window gets in-app notices for actionable states only', () => {
  const h = harness({ focused: true });
  h.report({ threadId: 'review', status: 'needs-review', key: 't1:end' });
  h.report({ threadId: 'failed', status: 'failed', key: 't2:end', reason: 'error', label: '로그인 필요', summary: 'Claude 로그인이 필요해요' });
  h.report({ threadId: 'input', status: 'needs-input', key: 't3:input:q1', reason: 'question' });
  h.report({ threadId: 'done', status: 'finished', key: 't4:end' });
  assert.deepEqual(h.notices.map((notice) => [notice.threadId, notice.channel, notice.message]), [
    ['review', 'in-app', '사업 개요 다듬기 — 검토할 변경이 있습니다'],
    ['failed', 'in-app', '사업 개요 다듬기 — Claude 로그인이 필요해요'],
    ['input', 'in-app', '사업 개요 다듬기 — 답변을 기다립니다'],
  ]);
  // 완료는 토스트 없이도 배지(그리고 칩)에 센다.
  assert.equal(h.ledger.count(), 4);
});

test('with chat details on, a system notice names the chat and the document; toasts always name the chat', () => {
  const h = harness();
  h.report({ threadId: 'quiet', status: 'needs-input', key: 't1:input:q1', reason: 'question' });
  h.showDetails(true);
  h.report({ threadId: 'named', status: 'needs-input', key: 't2:input:q2', reason: 'question' });
  assert.deepEqual(h.notices.map((notice) => [notice.title, notice.body, notice.message]), [
    ['HamaEditor', '답변을 기다립니다', '사업 개요 다듬기 — 답변을 기다립니다'],
    ['사업 개요 다듬기', '답변을 기다립니다 · 사업 제안서.hwpx', '사업 개요 다듬기 — 답변을 기다립니다'],
  ], 'the setting is read at each notice');
  h.showDetails(false);
  h.report({ threadId: 'fail', status: 'failed', key: 't3:end', reason: 'error', summary: 'Claude 로그인이 필요해요' });
  assert.deepEqual([h.notices[2]!.title, h.notices[2]!.body], ['HamaEditor', 'Claude 로그인이 필요해요'],
    'a failure shows its fixed failure title');
});

test('copy follows the reason: plan approval, interruption, a bare error, and no document', () => {
  const h = harness({ details: true });
  h.report({ threadId: 'plan', status: 'needs-input', key: 't1:input:plan:p1', reason: 'plan' });
  h.report({ threadId: 'cut', status: 'failed', key: 't2:end', reason: 'interrupted', label: '중단됨' });
  h.report({ threadId: 'err', status: 'failed', key: 't3:end', reason: 'error' });
  h.report({ threadId: 'label', status: 'failed', key: 't4:end', reason: 'error', label: '사용 한도', documentName: null, title: '' });
  assert.deepEqual(h.notices.map((notice) => [notice.title, notice.body]), [
    ['사업 개요 다듬기', '계획 승인을 기다립니다 · 사업 제안서.hwpx'],
    ['사업 개요 다듬기', '작업이 중단됐습니다 · 사업 제안서.hwpx'],
    ['사업 개요 다듬기', '오류로 멈췄습니다 · 사업 제안서.hwpx'],
    ['새 채팅', '사용 한도'],
  ]);
});

test('a chat being watched is never notified or counted', () => {
  const h = harness();
  h.report({ threadId: 'a', status: 'finished', key: 'turn-1:end', seen: true });
  assert.deepEqual(h.notices, []);
  assert.equal(h.ledger.count(), 0);
  // 알린 뒤에 보면 배지에서 빠진다.
  h.report({ threadId: 'b', status: 'needs-input', key: 'turn-2:input:q', reason: 'question' });
  assert.equal(h.ledger.count(), 1);
  h.ledger.seen('b');
  assert.equal(h.ledger.count(), 0);
  assert.deepEqual(h.counts, [1, 0]);
});

test('a second question in one turn notifies again; review then finish in one turn notifies once', () => {
  const h = harness();
  h.report({ threadId: 'a', status: 'needs-input', key: 'turn-1:input:q1', reason: 'question' });
  h.report({ threadId: 'a', status: 'working', key: '' });
  h.report({ threadId: 'a', status: 'needs-input', key: 'turn-1:input:q2', reason: 'question' });
  assert.equal(h.notices.length, 2);

  h.report({ threadId: 'b', status: 'needs-review', key: 'turn-9:end' });
  h.report({ threadId: 'b', status: 'finished', key: 'turn-9:end' });
  assert.deepEqual(h.notices.filter((notice) => notice.threadId === 'b').map((notice) => notice.state), ['needs-review']);
  assert.equal(h.ledger.count(), 2, 'the settled review still counts until the chat is seen');
});

test('refresh drops chats answered, opened or cleared elsewhere', () => {
  const h = harness();
  h.report({ threadId: 'a', status: 'finished', key: 'a:end' });
  h.report({ threadId: 'b', status: 'needs-input', key: 'b:input:q', reason: 'question' });
  h.report({ threadId: 'c', status: 'failed', key: 'c:end', reason: 'error' });
  assert.equal(h.ledger.count(), 3);
  h.statuses.set('a', null); // 다른 창에서 열어 봤다
  h.statuses.set('b', 'working'); // 답했다
  h.ledger.refresh();
  assert.equal(h.ledger.count(), 1);
  assert.deepEqual(h.counts.at(-1), 1);
  // 일하는 상태로 돌아간 채팅의 보고는 그 채팅을 뺀다.
  h.report({ threadId: 'c', status: 'working', key: '' });
  assert.equal(h.ledger.count(), 0);
});

test('turning notifications off clears the badge and silences later reports', () => {
  const h = harness();
  h.report({ threadId: 'a', status: 'finished', key: 'a:end' });
  h.ledger.setEnabled(false);
  assert.equal(h.ledger.count(), 0);
  assert.deepEqual(h.counts, [1, 0]);
  h.report({ threadId: 'b', status: 'needs-input', key: 'b:input:q', reason: 'question' });
  assert.equal(h.notices.length, 1);
  assert.equal(h.ledger.count(), 0);
  h.ledger.setEnabled(true);
  h.report({ threadId: 'c', status: 'failed', key: 'c:end', reason: 'error' });
  assert.equal(h.notices.length, 2);
});

test('remembered keys are bounded', () => {
  const ledger = createChatAttentionLedger({ getStatus: () => 'finished', windowFocused: () => false, maxKeys: 2 });
  const notices: string[] = [];
  ledger.subscribe({ notice: (notice) => notices.push(notice.key) });
  const report = (key: string) => ledger.report({
    threadId: 'a', status: 'finished', key, seen: false, title: 't', documentName: null,
  });
  report('k1');
  report('k2');
  report('k3');
  report('k1');
  assert.deepEqual(notices, ['k1', 'k2', 'k3', 'k1'], 'the oldest key is forgotten first');
});

test('in-app notices become toasts whose 열기 opens that chat; system notices do not', () => {
  const h = harness({ focused: true });
  const toasts: ToastOptions[] = [];
  const opened: string[] = [];
  const off = installAttentionToasts(h.ledger, (id) => opened.push(id), (options) => toasts.push(options));
  h.report({ threadId: 'a', status: 'needs-review', key: 'a:end' });
  h.focus(false);
  h.report({ threadId: 'b', status: 'failed', key: 'b:end', reason: 'error' });
  assert.equal(toasts.length, 1);
  assert.equal(toasts[0]!.message, '사업 개요 다듬기 — 검토할 변경이 있습니다');
  assert.equal(toasts[0]!.action?.label, '열기');
  toasts[0]!.action!.onClick();
  assert.deepEqual(opened, ['a']);
  off();
  h.focus(true);
  h.report({ threadId: 'c', status: 'needs-review', key: 'c:end' });
  assert.equal(toasts.length, 1, 'uninstalled');
});

test('web notifications go out only when the site already has permission, and never ask', () => {
  const h = harness();
  const shown: Array<{ title: string; body?: string; tag?: string; onclick: (() => void) | null; closed: boolean }> = [];
  let permission = 'default';
  let requested = 0;
  let focused = 0;
  class FakeNotification {
    static get permission() { return permission; }
    static requestPermission() { requested += 1; return Promise.resolve('granted'); }
    onclick: (() => void) | null = null;
    entry: (typeof shown)[number];
    constructor(title: string, options?: { body?: string; tag?: string }) {
      this.entry = { title, body: options?.body, tag: options?.tag, onclick: null, closed: false };
      shown.push(this.entry);
      queueMicrotask(() => { this.entry.onclick = this.onclick as (() => void) | null; });
    }
    close() { this.entry.closed = true; }
  }
  const opened: string[] = [];
  installWebAgentAttention(h.ledger, (id) => opened.push(id), {
    Notification: FakeNotification as never,
    focus: () => { focused += 1; },
  });
  h.report({ threadId: 'a', status: 'finished', key: 'a:end' });
  assert.equal(shown.length, 0, 'no permission, no notification');
  permission = 'granted';
  h.report({ threadId: 'b', status: 'needs-input', key: 'b:input:q', reason: 'question' });
  assert.equal(shown.length, 1);
  assert.deepEqual({ title: shown[0]!.title, body: shown[0]!.body, tag: shown[0]!.tag },
    { title: 'HamaEditor', body: '답변을 기다립니다', tag: 'b:input:q' });
  assert.equal(requested, 0, 'Studio never asks for permission');
  return Promise.resolve().then(() => {
    shown[0]!.onclick?.();
    assert.deepEqual(opened, ['b']);
    assert.equal(focused, 1);
    assert.equal(shown[0]!.closed, true);
  });
});

test('the notifications preference defaults on, chat details default off, both persist and tell every listener', () => {
  const mem = new Map<string, string>();
  const storage = { getItem: (key: string) => mem.get(key) ?? null, setItem: (key: string, value: string) => { mem.set(key, value); } };
  assert.deepEqual(loadAttentionPrefs(storage), { notifications: true, showChatDetails: false });
  const heard: Array<[boolean, boolean]> = [];
  const off = subscribeAttentionPrefs((prefs) => heard.push([prefs.notifications, prefs.showChatDetails]));
  saveAttentionPrefs({ notifications: false }, storage);
  assert.equal(loadAttentionPrefs(storage).notifications, false);
  saveAttentionPrefs({ showChatDetails: true }, storage);
  assert.deepEqual(loadAttentionPrefs(storage), { notifications: false, showChatDetails: true }, 'one switch keeps the other');
  assert.deepEqual(heard, [[false, false], [false, true]]);
  off();
  // 이 설정이 생기기 전에 저장된 값은 제목을 싣지 않는다.
  mem.set('rhwp-agent-attention', JSON.stringify({ notifications: true }));
  assert.deepEqual(loadAttentionPrefs(storage), { notifications: true, showChatDetails: false });
  mem.set('rhwp-agent-attention', '{broken');
  assert.deepEqual(loadAttentionPrefs(storage), { notifications: true, showChatDetails: false });
});
