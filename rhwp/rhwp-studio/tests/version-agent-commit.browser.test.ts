// 전체 모드 에이전트의 commit_version 은 자기 턴 안에서 불린다 — 실제 브리지 도구 경로와 실제 버전
// 컨트롤러로, 턴 중에도 커밋되고(사용자 커밋은 계속 막힌다) 저장 전 문서는 행동할 수 있는 오류를 받는지 본다.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import puppeteer, { type Browser } from 'puppeteer-core';
import { createServer, type ViteDevServer } from 'vite';
import { browserExecutable, browserLaunchArgs, requireWasmPackage } from './browser-support.ts';

const studioRoot = fileURLToPath(new URL('../', import.meta.url));
const rhwpRoot = resolve(studioRoot, '..');
const wasmPackageRoot = process.env.RHWP_WASM_PACKAGE_DIR ?? resolve(rhwpRoot, 'pkg');
requireWasmPackage(wasmPackageRoot);
let server: ViteDevServer | null = null;
let browser: Browser | null = null;
let baseUrl = '';

test.before(async () => {
  server = await createServer({
    root: studioRoot,
    configFile: false,
    cacheDir: resolve(studioRoot, 'node_modules/.vite-version-agent-commit-test'),
    logLevel: 'silent',
    resolve: {
      alias: {
        '@': resolve(studioRoot, 'src'),
        '@wasm/rhwp.js': resolve(wasmPackageRoot, 'rhwp.js'),
        '@wasm': wasmPackageRoot,
      },
    },
    server: {
      host: '127.0.0.1',
      port: 0,
      hmr: false,
      fs: { allow: [studioRoot, wasmPackageRoot, resolve(rhwpRoot, 'samples')] },
    },
    plugins: [{
      // 브리지가 들여오는 데스크톱 연동은 PWA 플러그인의 가상 모듈을 부른다 — 테스트에서는 빈 모듈이다.
      name: 'pwa-register-stub',
      resolveId: (id) => (id === 'virtual:pwa-register' ? '\0virtual:pwa-register' : null),
      load: (id) => (id === '\0virtual:pwa-register' ? 'export function registerSW() {}' : null),
    }, {
      name: 'version-agent-commit-sample',
      configureServer(vite) {
        vite.middlewares.use('/samples', (request, response, next) => {
          const relative = decodeURIComponent(request.url?.split('?')[0] ?? '').replace(/^\/+/, '');
          if (!relative || relative.includes('..')) return next();
          void readFile(resolve(rhwpRoot, 'samples', relative)).then((bytes) => {
            response.setHeader('Content-Type', 'application/octet-stream');
            response.end(bytes);
          }, () => {
            response.statusCode = 404;
            response.end();
          });
        });
      },
    }],
  });
  await server.listen();
  const address = server.httpServer?.address();
  assert.ok(address && typeof address !== 'string');
  baseUrl = `http://127.0.0.1:${address.port}`;
  browser = await puppeteer.launch({ executablePath: browserExecutable(), headless: true, args: browserLaunchArgs() });
});

test.after(async () => {
  await browser?.close();
  await server?.close();
});

test('the agent commits from inside its running turn; user commits stay blocked and unsaved documents get SAVE_REQUIRED', { timeout: 30_000 }, async () => {
  assert.ok(browser);
  const page = await browser.newPage();
  try {
    await page.goto(`${baseUrl}/tests/fixtures/version-store-idb.html`);
    const result = await page.evaluate(async () => {
      const [{ WasmBridge }, { EventBus }, { DocumentDirtyState }, versions, { DocumentVersionController }, { AgentBridgeImpl }] = await Promise.all([
        import('/src/core/wasm-bridge.ts'),
        import('/src/core/event-bus.ts'),
        import('/src/core/document-dirty-state.ts'),
        import('/src/versioning/index.ts'),
        import('/src/versioning/controller.ts'),
        import('/src/agent/bridge.ts'),
      ]);
      const response = await fetch('/samples/shift-return.hwp');
      const wasm = new WasmBridge();
      await wasm.initialize();
      wasm.loadDocument(new Uint8Array(await response.arrayBuffer()), 'shift-return.hwp');
      const eventBus = new EventBus();
      const dirty = new DocumentDirtyState(eventBus);
      const store = new versions.VersionGraphStore({ indexedDB: null });
      let turnRunning = false;
      const pendingEdits = {
        hasPending: () => false,
        onChange: () => () => undefined,
        commitOpen: () => false,
        setDirectApply: () => undefined,
      };
      const agentFacade = {
        pendingEdits,
        onEvent: () => () => undefined,
        isTurnRunning: () => turnRunning,
        getEditingLease: () => ({ active: turnRunning, agent: 'pi' as const }),
        requestCheckpointTitle: async () => null,
      };
      const inputHandler = {
        canRedo: () => false,
        prepareSnapshotCapacity() {},
        replaceContentFromBytes(bytes: Uint8Array) {
          wasm.loadDocument(bytes, 'shift-return.hwp');
          eventBus.emit('document-changed');
        },
      };
      const makeController = (documentId: string | null) => new DocumentVersionController({
        store, wasm, eventBus, documentState: dirty,
        getInputHandler: () => inputHandler as never,
        getDocumentId: () => documentId,
        agentBridge: agentFacade as never,
      });
      const controller = makeController('agent-commit');
      const unsaved = makeController(null);

      // 실제 브리지 도구 경로 — main.ts 와 같은 commitVersion 배선, 전체 모드, 진행 중인 턴.
      const makeBridge = (target: InstanceType<typeof DocumentVersionController>) => {
        const responses: Array<{ ok: boolean; result?: unknown; error?: { code: string; message: string } }> = [];
        const bridge = Object.create(AgentBridgeImpl.prototype) as Record<string, unknown> & {
          handleToolRequest(msg: unknown): void;
        };
        Object.assign(bridge, {
          activeProviderTurnId: 'turn-1', turnRunning: true,
          activeToolRequests: 0, activeToolRequestControllers: new Map(),
          inFlightWrites: new Set(), versionCommitInFlight: null,
          workflow: 'direct', phase: 'direct', permissionProfile: 'unrestricted', activeAgent: 'pi',
          pendingEdits, listeners: new Set(),
          executor: { execute: async () => ({ revision: 1 }) },
          versionCommit: (message: string) => target.checkpoint(message, { agentTurn: true }),
          syncEditingLease: () => {},
          sendJson: () => true,
          sendToolResponse: (frame: { ok: boolean; result?: unknown; error?: { code: string; message: string } }) => {
            responses.push(frame);
          },
        });
        return { bridge, responses };
      };
      const commitVia = async (target: InstanceType<typeof DocumentVersionController>, message: string) => {
        const { bridge, responses } = makeBridge(target);
        bridge.handleToolRequest({
          id: 1, tool: 'commit_version', args: { message }, agent: 'pi', providerTurnId: 'turn-1',
        });
        for (let i = 0; i < 200 && responses.length === 0; i++) await new Promise((r) => setTimeout(r, 10));
        return responses[0];
      };
      const errorCode = async (run: Promise<unknown>) => {
        try {
          await run;
          return 'ok';
        } catch (error) {
          const cause = (error as Error).cause as { code?: string } | undefined;
          return cause?.code ?? (error as { code?: string }).code ?? String(error);
        }
      };
      try {
        await controller.enable();
        const before = controller.getState().commits.length;
        wasm.insertText(0, 0, 0, 'AGENT ');
        dirty.markDirty('agent');
        eventBus.emit('document-mutated');
        turnRunning = true;

        const userCommit = await errorCode(controller.checkpoint('user'));
        const agentCommit = await commitVia(controller, '에이전트 정리');
        const after = controller.getState().commits;
        const unsavedCommit = await commitVia(unsaved, '저장 전');
        return {
          userCommit,
          agentOk: agentCommit?.ok,
          agentError: agentCommit?.error ?? null,
          committed: after.length - before,
          headMessage: after[0]?.message ?? after[0]?.title ?? null,
          unsaved: unsavedCommit?.error ?? null,
        };
      } finally {
        controller.dispose();
        unsaved.dispose();
        await store.close();
        wasm.releaseDocument();
      }
    });
    assert.equal(result.userCommit, 'ACTIVE_AGENT_TURN', '사용자 커밋은 턴 중에 계속 막힌다');
    assert.equal(result.agentOk, true, JSON.stringify(result.agentError));
    assert.equal(result.committed, 1);
    assert.equal(result.unsaved?.code, 'SAVE_REQUIRED');
    assert.match(result.unsaved?.message ?? '', /Do not retry.*save/);
  } finally {
    await page.close();
  }
});
