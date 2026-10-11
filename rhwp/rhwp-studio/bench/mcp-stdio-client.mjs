/**
 * 벤치용 최소 MCP stdio 클라이언트 — 실제 rhwp-agent/mcp-stdio.mjs 를 자식으로 띄우고
 * 줄 단위 JSON-RPC 로 말한다 (provider CLI 가 하는 것과 같은 경로). 요청마다 보낸/받은 시각을
 * epoch ms 로 남겨 허브 추적 행(rpcId)과 이을 수 있다.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { createInterface } from 'node:readline';

import { repoRoot } from '../e2e/agent-bench-harness.mjs';

export const epochNow = () => Math.round((performance.timeOrigin + performance.now()) * 1000) / 1000;

export class McpStdioClient {
  /**
   * env: mcp-stdio 환경 (RHWP_WS_URL, RHWP_AGENT_TOKEN, RHWP_SESSION_ID, RHWP_AGENT_NAME, ...)
   */
  constructor({ env, logPath }) {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    this.logFd = fs.openSync(logPath, 'a');
    this.child = spawn(process.execPath, [path.join(repoRoot, 'rhwp-agent', 'mcp-stdio.mjs')], {
      cwd: path.join(repoRoot, 'rhwp-agent'),
      env: { ...process.env, NODE_ENV: 'test', ...env },
      stdio: ['pipe', 'pipe', this.logFd],
    });
    this.nextId = 1;
    this.pending = new Map();
    this.closed = false;
    const lines = createInterface({ input: this.child.stdout });
    lines.on('line', (line) => {
      const recv = epochNow();
      let msg;
      try { msg = JSON.parse(line); } catch { return; }
      if (msg?.id === undefined || !this.pending.has(msg.id)) return;
      const entry = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      entry.resolve({ msg, recv });
    });
    this.child.on('exit', () => {
      this.closed = true;
      for (const entry of this.pending.values()) entry.reject(new Error('mcp-stdio exited'));
      this.pending.clear();
    });
  }

  request(method, params, timeoutMs = 60_000) {
    if (this.closed) return Promise.reject(new Error('mcp-stdio exited'));
    const id = this.nextId++;
    const send = epochNow();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP ${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve({ id, send, ...value }); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      });
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }

  notify(method, params = {}) {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  }

  async initialize() {
    const { msg } = await this.request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'rhwp-tool-bench', version: '0.0.0' },
    });
    if (msg.error) throw new Error(`MCP initialize failed: ${msg.error.message}`);
    this.notify('notifications/initialized');
    const { msg: list } = await this.request('tools/list', {});
    this.tools = new Set((list.result?.tools ?? []).map((tool) => tool.name));
    return this;
  }

  /**
   * 도구 호출 — { id, send, recv, ms, isError, text, revision, errorCode, content } 를 돌려준다.
   */
  async callTool(name, args) {
    const { id, send, recv, msg } = await this.request('tools/call', { name, arguments: args });
    if (msg.error) {
      return { id, send, recv, ms: recv - send, isError: true, errorCode: 'JSONRPC', text: msg.error.message, content: [] };
    }
    const content = msg.result?.content ?? [];
    const text = content.filter((block) => block?.type === 'text').map((block) => block.text).join('\n');
    const isError = msg.result?.isError === true;
    const revisions = [...text.matchAll(/"revision":(\d+)|^revision (\d+)/gm)].map((m) => Number(m[1] ?? m[2]));
    return {
      id, send, recv, ms: recv - send, isError,
      errorCode: isError ? (/^([A-Z_]+):/.exec(text)?.[1] ?? 'ERROR') : null,
      text,
      content,
      revision: revisions.length > 0 ? Math.max(...revisions) : null,
    };
  }

  async close() {
    if (this.closed) return;
    const exited = new Promise((resolve) => this.child.once('exit', resolve));
    try { this.child.stdin.end(); } catch { /* 이미 닫힘 */ }
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 3000))]);
    if (!this.closed) this.child.kill('SIGKILL');
    try { fs.closeSync(this.logFd); } catch { /* 이미 닫힘 */ }
  }
}
