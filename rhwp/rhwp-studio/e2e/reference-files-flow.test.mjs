/**
 * E2E: reference-file upload/search and project isolation through the real Studio UI and hub.
 *
 * Starts an isolated hub and Vite instance. A composer attachment and a 프로젝트-tab upload land
 * in the document's research project, a 공용 upload lands in global storage. A second chat on
 * the same document shares that project by design; a chat on another document gets its own
 * project and does not see the first document's files, while global files stay available.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import { prepareFakePi, seedFakePiPrefs } from './fake-pi.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const studioRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(studioRoot, '..');
const hubToken = 'reference-e2e';

async function availablePort(start) {
  for (let port = start; port < start + 30; port += 1) {
    const free = await new Promise((resolve) => {
      const server = net.createServer();
      server.once('error', () => resolve(false));
      server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)));
    });
    if (free) return port;
  }
  throw new Error(`No available port from ${start}`);
}

async function waitForHttp(url, label, child, headers = {}) {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode)
      throw new Error(`${label} exited before startup`);
    try {
      if ((await fetch(url, { headers })).ok) return;
    } catch {}
    await delay(300);
  }
  throw new Error(`${label} startup timed out`);
}

function spawnLogged(command, args, cwd, env, logPath) {
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  const logFile = fs.openSync(logPath, 'w');
  const child = spawn(command, args, {
    cwd,
    env: { ...process.env, ...env },
    stdio: ['ignore', logFile, logFile],
  });
  child.logFile = logFile;
  return child;
}

async function stop(child) {
  if (!child) return;
  if (child.exitCode === null && !child.signalCode) {
    const exited = new Promise((resolve) => child.once('exit', resolve));
    child.kill('SIGTERM');
    await Promise.race([exited, delay(5_000)]);
    if (child.exitCode === null && !child.signalCode) child.kill('SIGKILL');
  }
  if (child.logFile !== undefined) fs.closeSync(child.logFile);
}

async function chooseScope(page, scope) {
  await page.click('.ag-references-btn');
  await page.waitForSelector('.ag-references-page[aria-hidden="false"]');
  await page.click(`.ag-reference-tab[data-scope="${scope}"]`);
}

async function chooseFile(page, { name, content }) {
  await page.evaluate(
    ({ fileName, fileContent }) => {
      const input = document.querySelector('.ag-reference-file-input');
      if (!(input instanceof HTMLInputElement))
        throw new Error('Reference input not found');
      const transfer = new DataTransfer();
      transfer.items.add(
        new File([fileContent], fileName, { type: 'text/plain' }),
      );
      input.files = transfer.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    },
    { fileName: name, fileContent: content },
  );
}

async function uploadFile(page, { scope, name, content }) {
  await chooseScope(page, scope);
  await page.click('.ag-reference-add');
  await chooseFile(page, { name, content });
}

async function stageQuickFile(page, { name, content }) {
  await page.click('.ag-reference-quick-add');
  await chooseFile(page, { name, content });
}

if (!process.env.CHROME_PATH && !process.env.PUPPETEER_EXECUTABLE_PATH) {
  const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  if (fs.existsSync(chrome)) process.env.CHROME_PATH = chrome;
}

const hubPort = await availablePort(
  Number(process.env.RHWP_AGENT_PORT || 5741),
);
const vitePort = await availablePort(Number(process.env.VITE_PORT || 7741));
const viteUrl = `http://127.0.0.1:${vitePort}`;
const referenceRoot = fs.mkdtempSync(
  path.join(os.tmpdir(), 'rhwp-reference-e2e-'),
);
const projectsRoot = fs.mkdtempSync(
  path.join(os.tmpdir(), 'rhwp-projects-e2e-'),
);
// 정리 도우미는 끈다 — 이 테스트는 파일이 어느 프로젝트에 들어가는지만 본다.
fs.writeFileSync(
  path.join(projectsRoot, 'settings.json'),
  JSON.stringify({ version: 1, librarian: { enabled: false } }),
);
const piRoot = prepareFakePi('rhwp-reference-pi-');
const logRoot = path.join(repoRoot, 'target');
let hub;
let vite;
let failed = false;

try {
  hub = spawnLogged(
    process.execPath,
    [path.join(repoRoot, 'rhwp-agent', 'server.mjs')],
    path.join(repoRoot, 'rhwp-agent'),
    {
      RHWP_AGENT_PORT: String(hubPort),
      RHWP_AGENT_TOKEN: hubToken,
      RHWP_REFERENCES_DIR: referenceRoot,
      RHWP_PROJECTS_DIR: projectsRoot,
      RHWP_PI_DIR: piRoot,
    },
    path.join(logRoot, 'reference-files-e2e-hub.log'),
  );
  await waitForHttp(`http://127.0.0.1:${hubPort}/healthz`, 'hub', hub, {
    Authorization: `Bearer ${hubToken}`,
  });

  vite = spawnLogged(
    process.execPath,
    [
      path.join(studioRoot, 'node_modules/vite/bin/vite.js'),
      '--host',
      '127.0.0.1',
      '--port',
      String(vitePort),
      '--strictPort',
    ],
    studioRoot,
    {
      BROWSER: 'none',
      VITE_RHWP_AGENT_URL: `ws://127.0.0.1:${hubPort}`,
      RHWP_AGENT_TOKEN: hubToken,
    },
    path.join(logRoot, 'reference-files-e2e-vite.log'),
  );
  await waitForHttp(viteUrl, 'Vite', vite);

  process.env.VITE_URL = viteUrl;
  const { runTest, assert, createNewDocument, screenshot } =
    await import('./helpers.mjs');
  const { openSample } = await import('./agent-bench-harness.mjs');
  await runTest('프로젝트·공용 자료 업로드와 문서 사이 격리', async ({ page }) => {
    // 새 채팅은 첫 메시지를 보낼 때 사이드바의 선택으로 시작한다. 가짜 Pi 를 기본으로 두고
    // 다시 불러 오면, 첫 메시지가 실제 CLI 를 띄우지 않고 이 Pi 로 간다.
    await seedFakePiPrefs(page);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(
      () => window.__agentBridge?.getConnectionState?.() === 'connected',
    );

    // 문서를 열거나 첫 메시지를 보내기 전에도 현재 채팅 초안에 첨부할 수 있다.
    await page.click('.ag-reference-quick-add');
    const draftFileInput = await page.$('.ag-reference-file-input');
    await draftFileInput.uploadFile(path.join(repoRoot, 'samples/hwpx/landscape-001.hwpx'));
    await page.waitForFunction(() => document.querySelector(
      '.ag-reference-upload-chip.ag-ready, .ag-reference-upload-chip.ag-error',
    ));
    const emptyEditorUpload = await page.$eval('.ag-reference-upload-chip', (chip) => ({
      ready: chip.classList.contains('ag-ready'),
      error: chip.getAttribute('title'),
    }));
    assert(emptyEditorUpload.ready, `empty-editor attachment should be ready: ${JSON.stringify(emptyEditorUpload)}`);
    await screenshot(page, 'memo1-empty-editor-upload');
    await page.click('button[aria-label="landscape-001.hwpx 첨부 취소"]');
    await page.waitForFunction(() => document.querySelectorAll('.ag-reference-upload-chip').length === 0);
    await createNewDocument(page);

    // 지운 초안 첨부는 어디에도 쌓이지 않는다.
    await page.type('.ag-input', 'draft message');
    await stageQuickFile(page, {
      name: 'discarded-draft.txt',
      content: 'THIS_DRAFT_MUST_NOT_REACH_THE_PROJECT',
    });
    await page.waitForSelector('.ag-reference-upload-chip.ag-ready');
    await page.evaluate(() => {
      const input = document.querySelector('.ag-input');
      if (!(input instanceof HTMLTextAreaElement))
        throw new Error('Composer input not found');
      input.value = '';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    assert(
      (await page.$$eval('.ag-reference-upload-chip.ag-ready', (chips) => chips.length)) === 1,
      'clearing text preserves the attachment draft',
    );
    await page.click('button[aria-label="discarded-draft.txt 첨부 취소"]');
    await page.waitForFunction(
      () => document.querySelectorAll('.ag-reference-upload-chip').length === 0,
    );

    // 첫 채팅: 입력기 첨부와 함께 보내면 파일이 이 문서의 프로젝트로 들어간다.
    await stageQuickFile(page, {
      name: 'chat-notes.txt',
      content: 'CHAT_MARKER launch checklist attached in the first chat.',
    });
    await page.waitForSelector('.ag-reference-upload-chip.ag-ready');
    await page.type('.ag-input', 'first chat');
    await page.click('.ag-send');
    const firstProjectId = await page.waitForFunction(
      (name) => {
        const project = window.__agentBridge.projects.store.get();
        return project?.items.some((item) => item.kind === 'file' && item.originalName === name)
          ? project.id
          : null;
      },
      { timeout: 20_000 },
      'chat-notes.txt',
    ).then((handle) => handle.jsonValue());

    // 프로젝트 탭의 파일 추가는 같은 프로젝트로, 공용 탭은 모든 문서가 보는 자리로 간다.
    await uploadFile(page, {
      scope: 'project',
      name: 'project-guide.txt',
      content: 'PROJECT_MARKER instructions for this document project.',
    });
    await page.waitForFunction(
      (name) => window.__agentBridge.projects.store.get()?.items
        .some((item) => item.kind === 'file' && item.originalName === name),
      { timeout: 15_000 },
      'project-guide.txt',
    );
    await page.click('.ag-references-close');
    await uploadFile(page, {
      scope: 'global',
      name: 'global-glossary.txt',
      content: 'GLOBAL_MARKER background glossary available in every chat.',
    });
    await page.waitForFunction(
      async () => (await window.__agentBridge.listReferences('global', 'global'))
        .some((file) => file.name === 'global-glossary.txt'),
      { timeout: 15_000 },
    );
    await page.type('.ag-reference-search', 'GLOBAL_MARKER');
    await page.waitForFunction(() =>
      document.querySelector('.ag-reference-search-snippet')?.textContent?.includes('GLOBAL_MARKER'),
    );
    await page.click('.ag-references-close');

    const projectNames = async () => page.evaluate(async () => {
      const project = await window.__agentBridge.projects.service.current();
      return {
        id: project?.id ?? null,
        names: (project?.items ?? [])
          .filter((item) => item.kind === 'file')
          .map((item) => item.originalName)
          .sort(),
      };
    });
    const first = await projectNames();
    assert(
      first.id === firstProjectId
        && JSON.stringify(first.names) === JSON.stringify(['chat-notes.txt', 'project-guide.txt']),
      `the first chat's project holds the chat attachment and the project upload only (${JSON.stringify(first)})`,
    );

    // 같은 문서의 두 번째 채팅은 같은 프로젝트를 본다.
    const firstThreadId = await page.evaluate(() => window.__agentBridge.threadId);
    await page.click('button[aria-label="채팅 목록"]');
    await page.waitForSelector('.ag-threads-page[aria-hidden="false"]');
    await page.evaluate(() => document.querySelector('.ag-threads-new')?.click());
    await page.waitForFunction(() => !document.documentElement.classList.contains('ag-fs-vt'));
    // 이전 채팅의 idle provider 를 그대로 두는 새 초안도 첨부를 준비할 수 있다.
    await stageQuickFile(page, { name: 'next-chat-draft.txt', content: 'DRAFT_WITH_PREVIOUS_PROVIDER_ALIVE' });
    await page.waitForFunction(() => document.querySelector('.ag-reference-upload-chip.ag-ready, .ag-reference-upload-chip.ag-error'));
    assert(await page.$eval('.ag-reference-upload-chip', (chip) => chip.classList.contains('ag-ready')),
      'a new draft can attach before replacing the previous provider');
    await page.click('button[aria-label="next-chat-draft.txt 첨부 취소"]');
    await page.type('.ag-input', 'second chat');
    await page.click('.ag-send');
    await page.waitForFunction(
      (previous) => window.__agentBridge.getActiveAgent() === 'pi'
        && window.__agentBridge.threadId !== previous,
      { timeout: 20_000 },
      firstThreadId,
    );
    const sameDocument = await projectNames();
    assert(
      sameDocument.id === firstProjectId && sameDocument.names.includes('chat-notes.txt'),
      `a second chat on the same document shares its project (${JSON.stringify(sameDocument)})`,
    );

    // 다른 문서의 채팅은 그 문서의 프로젝트를 받는다 — 앞 문서의 자료는 보이지 않는다.
    await openSample(page, 'text-align-2.hwp');
    await page.waitForFunction(
      () => window.__documentSessions.list().length === 2
        && window.__agentBridge?.getConnectionState?.() === 'connected',
      { timeout: 15_000 },
    );
    await page.waitForFunction(() => {
      const input = document.querySelector('.ag-input');
      return input instanceof HTMLTextAreaElement && !input.disabled;
    }, { timeout: 15_000 });
    await page.type('.ag-input', 'other document chat');
    await page.click('.ag-send');
    await page.waitForFunction(
      (previous) => {
        const project = window.__agentBridge.projects.store.get();
        return Boolean(project && project.id !== previous);
      },
      { timeout: 20_000 },
      firstProjectId,
    );
    const otherDocument = await projectNames();
    const otherSearch = await page.evaluate(async () => ({
      global: (await window.__agentBridge.listReferences('global', 'global')).map((file) => file.name),
    }));
    console.log(`  [scope] ${JSON.stringify({ first, sameDocument, otherDocument, otherSearch })}`);
    assert(
      otherDocument.id !== firstProjectId
        && !otherDocument.names.includes('chat-notes.txt')
        && !otherDocument.names.includes('project-guide.txt'),
      `a chat on another document does not see the first document's project files (${JSON.stringify(otherDocument)})`,
    );
    assert(
      otherSearch.global.includes('global-glossary.txt'),
      'global files stay available from the other document',
    );
    await screenshot(page, 'reference-files-scopes');
  });
} catch (error) {
  console.error(`reference-files E2E setup failed: ${error?.stack ?? error}`);
  failed = true;
} finally {
  await stop(vite);
  await stop(hub);
  fs.rmSync(referenceRoot, { recursive: true, force: true });
  fs.rmSync(projectsRoot, { recursive: true, force: true });
  fs.rmSync(piRoot, { recursive: true, force: true });
}

if (failed) process.exitCode = 1;
