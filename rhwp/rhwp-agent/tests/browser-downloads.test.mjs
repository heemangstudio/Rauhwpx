import assert from 'node:assert/strict';
import http from 'node:http';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { createBrowserDownloads } from '../browser-downloads.mjs';
import { fetchPublic } from '../download-manager.mjs';
import { createProjectIngest } from '../project-ingest.mjs';
import { createBrowserDownloadsHttpHandler } from '../project-http.mjs';
import { createReferenceCatalog } from '../reference-catalog.mjs';
import { ProjectStore } from '../project-store.mjs';
import { pagedPdf } from './fixtures/paged-pdf.mjs';

const actor = { threadId: 'chat-a', agentId: 'agent-a', ownerId: 'local' };
const human = { isHuman: true, ownerId: 'local' };
function source(bytes, extra = {}) {
  return { url: () => 'https://user:secret@example.org/private.pdf?token=secret#private',
    suggestedFilename: () => 'report.pdf', createReadStream: async () => Readable.from([bytes]), cancel: async () => {}, ...extra };
}
async function fixture(t, options = {}) {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-browser-downloads-'));
  const referenceStore = await createReferenceCatalog({ referencesRoot: path.join(parent, 'references'), projectsRoot: path.join(parent, 'projects') }).init();
  const projectStore = await new ProjectStore({ referenceStore, root: path.join(parent, 'projects') }).init();
  const project = await projectStore.createProject({ name: 'Research' });
  const projectIngest = createProjectIngest({ referenceStore, projectStore, settings: {} });
  const downloads = createBrowserDownloads({ dataDir: parent, projectIngest, ...options });
  await downloads.ready;
  t.after(async () => { await downloads.close(); await fs.rm(parent, { recursive: true, force: true }); });
  return { parent, downloads, projectIngest, referenceStore, projectStore, projectId: project.id };
}

test('delivered PDF bytes create a captured project card before extraction and survive parser failure', async (t) => {
  let unblock, extractionStarted;
  const began = new Promise((resolve) => { extractionStarted = resolve; });
  const blocked = new Promise((resolve) => { unblock = resolve; });
  const fx = await fixture(t);
  const original = fx.projectIngest.extractDownload.bind(fx.projectIngest);
  fx.projectIngest.extractDownload = async (args) => { extractionStarted(); await blocked; return original(args); };
  const bytes = Buffer.from('%PDF-1.7\nmalformed retained original');
  const tab = { tabId: 'tab-a', projectId: fx.projectId, threadId: actor.threadId, agentId: actor.agentId, taskId: 'task-start' };
  const first = await fx.downloads.handleBrowserDownload({ download: source(bytes), actor, tab, pageUrl: 'https://example.org/view?auth=hidden#fragment' });
  tab.projectId = 'paaaaaaaaaa'; tab.taskId = 'task-later';
  await began;
  const early = await fx.downloads.get({ downloadId: first.downloadId, actor });
  assert.equal(early.state, 'imported');
  assert.equal(early.importProjectId, fx.projectId);
  const item = await fx.projectStore.getItem(fx.projectId, early.projectItemId);
  assert.equal(item.status, 'ready');
  assert.equal(item.captures[0].taskId, 'task-start');
  assert.deepEqual((await fx.downloads.readBytes({ downloadId: early.downloadId, actor })).bytes, bytes);
  const manifest = await fs.readFile(path.join(fx.parent, 'downloads', early.downloadId, 'manifest.json'), 'utf8');
  assert.doesNotMatch(manifest, /secret|hidden|fragment|auth=/);
  unblock(); await fx.downloads.settle();
  const finished = await fx.downloads.get({ downloadId: first.downloadId, actor });
  assert.equal(finished.state, 'imported');
  assert.equal(finished.extractionStatus, 'failed');
  assert.equal((await fx.projectStore.getItem(fx.projectId, finished.projectItemId)).extractionStatus, 'failed');
  assert.deepEqual((await fx.downloads.readBytes({ downloadId: first.downloadId, actor })).bytes, bytes);
  const restarted = createBrowserDownloads({ dataDir: fx.parent, projectIngest: fx.projectIngest });
  await restarted.ready;
  assert.equal((await restarted.get({ downloadId: first.downloadId, actor })).extractionStatus, 'failed');
  await restarted.close();
});

test('real PDF extraction produces citations, scope dedupe and bounded capture provenance', async (t) => {
  const fx = await fixture(t);
  const bytes = pagedPdf(['durable browser citation evidence']);
  for (let index = 0; index < 3; index += 1) {
    const job = await fx.downloads.handleBrowserDownload({ download: source(bytes), actor,
      tab: { projectId: fx.projectId, tabId: `tab-${index}`, ...actor, taskId: `task-${index}` } });
    await fx.downloads.settle();
    assert.equal((await fx.downloads.get({ downloadId: job.downloadId, actor })).extractionStatus, 'ready');
  }
  const project = await fx.projectStore.get(fx.projectId);
  assert.equal(project.items.filter((item) => item.kind === 'file').length, 1);
  assert.equal(project.items[0].captures.length, 3);
  assert.equal(fx.referenceStore.list({ scope: 'project', scopeId: fx.projectId }).length, 1);
  const results = fx.referenceStore.search({ query: 'citation', scopes: [{ scope: 'project', scopeId: fx.projectId }] });
  assert.ok(results.length > 0);
  const restartedReferences = await createReferenceCatalog({ referencesRoot: path.join(fx.parent, 'references'), projectsRoot: path.join(fx.parent, 'projects') }).init();
  assert.equal(restartedReferences.getFile(project.items[0].fileId).extractionStatus, 'ready');
  assert.ok(restartedReferences.search({ query: 'citation', scopes: [{ scope: 'project', scopeId: fx.projectId }] }).length > 0);
});

test('no project downloads remain in the owner inbox, failed move keeps bytes and successful move is idempotent', async (t) => {
  const fx = await fixture(t);
  const bytes = pagedPdf(['inbox evidence']);
  const job = await fx.downloads.handleBrowserDownload({ download: source(bytes), actor, tab: { tabId: 'tab-inbox', ...actor } });
  await fx.downloads.settle();
  assert.equal((await fx.downloads.list(human))[0].state, 'downloaded');
  await assert.rejects(fx.downloads.readBytes({ downloadId: job.downloadId, actor: { ...actor, agentId: 'guessed-other' } }), { code: 'BROWSER_DOWNLOAD_NOT_FOUND' });
  await assert.rejects(fx.downloads.importDownload({ downloadId: job.downloadId, actor, projectId: fx.projectId }), { code: 'BROWSER_DOWNLOAD_FORBIDDEN' });
  const failed = await fx.downloads.importDownload({ downloadId: job.downloadId, actor: human, projectId: 'paaaaaaaaaa' });
  assert.equal(failed.state, 'import-failed');
  assert.equal(failed.inboxMovedAt, undefined);
  assert.deepEqual((await fx.downloads.readBytes({ downloadId: job.downloadId, actor: human })).bytes, bytes);
  const moved = await fx.downloads.importDownload({ downloadId: job.downloadId, actor: human, projectId: fx.projectId });
  assert.equal(moved.state, 'imported');
  assert.ok(moved.inboxMovedAt);
  const same = await fx.downloads.importDownload({ downloadId: job.downloadId, actor: human, projectId: fx.projectId });
  assert.equal(same.projectItemId, moved.projectItemId);
  await fx.downloads.settle();
  assert.equal((await fx.projectStore.get(fx.projectId)).items.length, 1);
});

test('unknown-length transfers are bounded; cancellation and timeout remove partial bytes', async (t) => {
  const fx = await fixture(t, { maxBytes: 32, freeSpaceReserve: 0, timeoutMs: 50 });
  let cancelled = 0;
  const huge = await fx.downloads.handleBrowserDownload({ download: source(Buffer.alloc(80), { cancel: async () => { cancelled += 1; } }), actor });
  await fx.downloads.settle();
  assert.equal((await fx.downloads.get({ downloadId: huge.downloadId, actor })).state, 'interrupted');
  assert.ok(cancelled);
  await assert.rejects(fs.access(path.join(fx.parent, 'downloads', huge.downloadId, 'transfer.part')), { code: 'ENOENT' });
  const hanging = () => source(Buffer.alloc(1), { createReadStream: async () => new Promise(() => {}), cancel: async () => { cancelled += 1; } });
  const job = await fx.downloads.handleBrowserDownload({ download: hanging(), actor });
  const cancel = await fx.downloads.cancel({ downloadId: job.downloadId, actor });
  assert.equal(cancel.state, 'cancelled');
  await fx.downloads.settle();
  const timed = await fx.downloads.handleBrowserDownload({ download: hanging(), actor });
  // Keep the event loop alive while the transfer timer runs.
  await new Promise((resolve) => setTimeout(resolve, 80));
  await fx.downloads.settle();
  assert.equal((await fx.downloads.get({ downloadId: timed.downloadId, actor })).state, 'interrupted');
  await assert.rejects(fx.downloads.retry({ downloadId: timed.downloadId, actor }), { code: 'BROWSER_DOWNLOAD_RETRY_SOURCE' });
});

test('restart recovers interrupted manifests and completed rename gaps; symlink bytes are refused', async (t) => {
  const fx = await fixture(t);
  const bytes = pagedPdf(['recovery evidence']);
  const job = await fx.downloads.handleBrowserDownload({ download: source(bytes), actor });
  await fx.downloads.settle();
  const manifestPath = path.join(fx.parent, 'downloads', job.downloadId, 'manifest.json');
  const saved = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  await fs.writeFile(manifestPath, JSON.stringify({ ...saved, state: 'downloading', size: 0, sha256: null }));
  const recovered = createBrowserDownloads({ dataDir: fx.parent }); await recovered.ready;
  assert.equal((await recovered.get({ downloadId: job.downloadId, actor })).state, 'downloaded');
  assert.deepEqual((await recovered.readBytes({ downloadId: job.downloadId, actor })).bytes, bytes);
  await recovered.close();
  const payloadPath = path.join(fx.parent, 'downloads', job.downloadId, 'bytes.bin');
  await fs.unlink(payloadPath);
  await fs.symlink(manifestPath, payloadPath);
  await assert.rejects(fx.downloads.readBytes({ downloadId: job.downloadId, actor }), { code: 'BROWSER_DOWNLOAD_PATH' });
});

test('PDF extension cannot import login HTML; revoked research import preserves downloaded bytes', async (t) => {
  const fx = await fixture(t);
  const html = Buffer.from('<html>Sign in</html>');
  const bad = await fx.downloads.handleBrowserDownload({ download: source(html), actor, tab: { projectId: fx.projectId, ...actor } });
  await fx.downloads.settle();
  assert.equal((await fx.downloads.get({ downloadId: bad.downloadId, actor })).state, 'import-failed');
  assert.equal((await fx.projectStore.get(fx.projectId)).items.length, 0);
  assert.deepEqual((await fx.downloads.readBytes({ downloadId: bad.downloadId, actor })).bytes, html);
  fx.downloads.authorizeImport = () => false;
  const good = await fx.downloads.handleBrowserDownload({ download: source(pagedPdf(['retained blocked reference'])), actor,
    tab: { projectId: fx.projectId, ...actor } });
  await fx.downloads.settle();
  assert.equal((await fx.downloads.get({ downloadId: good.downloadId, actor })).error.code, 'BROWSER_DOWNLOAD_IMPORT_BLOCKED');
});

test('download bytes and inbox moves require authenticated owner routes without a document', async (t) => {
  const fx = await fixture(t);
  const bytes = pagedPdf(['authenticated viewer']);
  const job = await fx.downloads.handleBrowserDownload({ download: source(bytes), actor }); await fx.downloads.settle();
  const handler = createBrowserDownloadsHttpHandler({ downloads: fx.downloads, tokens: ['owner-session-token'], actor: human });
  const server = http.createServer((req, res) => { handler(req, res, new URL(req.url, 'http://localhost')).catch(() => { res.writeHead(500); res.end(); }); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}/browser-downloads`;
  const headers = { authorization: 'Bearer owner-session-token' };
  assert.equal((await fetch(`${base}/${job.downloadId}/bytes`)).status, 401);
  assert.equal((await fetch(`${base}/${job.downloadId}/bytes?token=owner-session-token`)).status, 401);
  assert.equal((await fetch(`${base}/${job.downloadId}/bytes`, { headers: { ...headers, origin: 'https://untrusted.example' } })).status, 403);
  const pdf = await fetch(`${base}/${job.downloadId}/bytes`, { headers });
  assert.equal(pdf.status, 200); assert.equal(pdf.headers.get('content-type'), 'application/pdf');
  assert.deepEqual(Buffer.from(await pdf.arrayBuffer()), bytes);
  const moved = await fetch(`${base}/${job.downloadId}/import`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ projectId: fx.projectId }) });
  assert.equal(moved.status, 200); assert.equal((await moved.json()).job.state, 'imported');
  await fx.downloads.settle();
});

test('destination is pinned before asynchronous readiness and explicit inbox tabs stay unbound', async (t) => {
  const fx = await fixture(t);
  let release;
  fx.downloads.ready = new Promise((resolve) => { release = resolve; });
  const originalActor = { ...actor, projectId: fx.projectId };
  const tab = { tabId: 'unbound', projectId: null, ...actor };
  const pending = fx.downloads.handleBrowserDownload({ download: source(pagedPdf(['pinned inbox'])), actor: originalActor, tab });
  tab.projectId = fx.projectId;
  originalActor.projectId = 'paaaaaaaaaa';
  release();
  const job = await pending; await fx.downloads.settle();
  const saved = await fx.downloads.get({ downloadId: job.downloadId, actor });
  assert.equal(saved.target.projectId, undefined);
  assert.equal(saved.state, 'downloaded');
});

test('startup finishes interrupted card imports once and stores only bounded capture history', async (t) => {
  const fx = await fixture(t);
  const bytes = pagedPdf(['idempotent research reference']);
  const job = await fx.downloads.handleBrowserDownload({ download: source(bytes), actor,
    tab: { ...actor, tabId: 'recover-tab', projectId: fx.projectId } });
  await fx.downloads.settle();
  const manifestPath = path.join(fx.parent, 'downloads', job.downloadId, 'manifest.json');
  const saved = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  await fs.writeFile(manifestPath, JSON.stringify({ ...saved, state: 'importing', fileId: undefined, projectItemId: undefined }));
  const restarted = createBrowserDownloads({ dataDir: fx.parent, projectIngest: fx.projectIngest });
  await restarted.ready; await restarted.settle();
  assert.equal((await restarted.get({ downloadId: job.downloadId, actor })).state, 'imported');
  const item = (await fx.projectStore.get(fx.projectId)).items[0];
  assert.equal((await fx.projectStore.get(fx.projectId)).items.length, 1);
  assert.equal(item.captures.length, 1);
  for (let index = 0; index < 40; index += 1) {
    await fx.projectStore.addFileItem(fx.projectId, { fileId: item.fileId, capture: {
      downloadId: `bd_${index.toString(16).padStart(32, '0')}`, taskId: `task-${index}`,
      url: 'https://account:password@example.org/export?secret=1#fragment',
    } });
  }
  const history = (await fx.projectStore.getItem(fx.projectId, item.id)).captures;
  assert.equal(history.length, 32);
  assert.equal(history.at(-1).taskId, 'task-39');
  assert.ok(history.every((capture) => capture.url === 'https://example.org/export'));
  await restarted.close();
});

test('import revocation while storage is awaiting commit retains bytes without a card', async (t) => {
  const fx = await fixture(t);
  let allow = true;
  fx.downloads.authorizeImport = () => allow;
  const original = fx.referenceStore.addBuffer.bind(fx.referenceStore);
  fx.referenceStore.addBuffer = async (input) => {
    const file = await original(input);
    allow = false;
    return file;
  };
  const job = await fx.downloads.handleBrowserDownload({ download: source(pagedPdf(['revoked after bytes'])), actor,
    tab: { ...actor, projectId: fx.projectId } });
  await fx.downloads.settle();
  const completed = await fx.downloads.get({ downloadId: job.downloadId, actor });
  assert.equal(completed.state, 'import-failed');
  assert.equal(completed.error.code, 'BROWSER_DOWNLOAD_IMPORT_BLOCKED');
  assert.equal((await fx.projectStore.get(fx.projectId)).items.length, 0);
  assert.ok((await fx.downloads.readBytes({ downloadId: job.downloadId, actor })).bytes.length > 0);
  allow = true;
  fx.referenceStore.addBuffer = original;
  assert.equal((await fx.downloads.retry({ downloadId: job.downloadId, actor })).state, 'imported');
  await fx.downloads.settle();
});

test('hub shutdown after completion retains readable bytes across a restart', async (t) => {
  let shutdown;
  const fx = await fixture(t, { onEvent: ({ job }) => {
    if (job.state === 'downloaded' && !shutdown) shutdown = fx.downloads.close();
  } });
  const bytes = pagedPdf(['completed before shutdown']);
  const job = await fx.downloads.handleBrowserDownload({ download: source(bytes), actor });
  await fx.downloads.settle(); await shutdown;
  assert.equal((await fx.downloads.get({ downloadId: job.downloadId, actor })).state, 'downloaded');
  const restarted = createBrowserDownloads({ dataDir: fx.parent }); await restarted.ready;
  assert.deepEqual((await restarted.readBytes({ downloadId: job.downloadId, actor })).bytes, bytes);
  await restarted.close();
  // Older hubs could write interrupted after the complete manifest. Recover those bytes too.
  const manifestPath = path.join(fx.parent, 'downloads', job.downloadId, 'manifest.json');
  const saved = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  await fs.writeFile(manifestPath, JSON.stringify({ ...saved, state: 'interrupted' }));
  const repaired = createBrowserDownloads({ dataDir: fx.parent }); await repaired.ready;
  assert.equal((await repaired.get({ downloadId: job.downloadId, actor })).state, 'downloaded');
  assert.deepEqual((await repaired.readBytes({ downloadId: job.downloadId, actor })).bytes, bytes);
  await repaired.close();
});

test('configured caps govern transfers, preference disables automatic import, and old completed bytes stay readable', async (t) => {
  const fx = await fixture(t, { maxBytes: 2 * 1024 * 1024, autoImport: false });
  const bytes = Buffer.concat([pagedPdf(['old larger managed PDF']), Buffer.alloc(1024 * 1024)]);
  const job = await fx.downloads.handleBrowserDownload({ download: source(bytes), actor, tab: { ...actor, projectId: fx.projectId } });
  await fx.downloads.settle();
  assert.equal((await fx.downloads.get({ downloadId: job.downloadId, actor })).state, 'downloaded');
  assert.equal((await fx.projectStore.get(fx.projectId)).items.length, 0);
  fx.downloads.configure({ maxFileBytes: 1024 * 1024, autoImport: false });
  assert.deepEqual((await fx.downloads.readBytes({ downloadId: job.downloadId, actor })).bytes, bytes);
  const oversized = await fx.downloads.handleBrowserDownload({ download: source(bytes), actor });
  await fx.downloads.settle();
  assert.equal((await fx.downloads.get({ downloadId: oversized.downloadId, actor })).error.code, 'BROWSER_DOWNLOAD_TOO_LARGE');
  // Manual movement remains available while the automatic import preference is off.
  assert.equal((await fx.downloads.importDownload({ downloadId: job.downloadId, actor: human, projectId: fx.projectId })).state, 'imported');
  await fx.downloads.settle();
  const restarted = createBrowserDownloads({ dataDir: fx.parent, maxBytes: 1024 * 1024, autoImport: false }); await restarted.ready;
  assert.deepEqual((await restarted.readBytes({ downloadId: job.downloadId, actor })).bytes, bytes);
  await restarted.close();
});

test('changing a cap during an unknown-length stream cancels it without expanding the original reservation', async (t) => {
  const fx = await fixture(t, { maxBytes: 2 * 1024 * 1024 });
  const stream = new Readable({ read() {} });
  const download = source(null, { createReadStream: async () => stream });
  const job = await fx.downloads.handleBrowserDownload({ download, actor });
  stream.push(Buffer.alloc(512 * 1024));
  await new Promise((resolve) => setTimeout(resolve, 10));
  fx.downloads.configure({ maxFileBytes: 1024 * 1024 });
  stream.push(Buffer.alloc(1024 * 1024)); stream.push(null);
  await fx.downloads.settle();
  assert.equal((await fx.downloads.get({ downloadId: job.downloadId, actor })).error.code, 'BROWSER_DOWNLOAD_TOO_LARGE');
  const second = new Readable({ read() {} });
  const start = await fx.downloads.handleBrowserDownload({ download: source(null, { createReadStream: async () => second }), actor });
  fx.downloads.configure({ maxFileBytes: 2 * 1024 * 1024 });
  second.push(Buffer.alloc(1536 * 1024)); second.push(null);
  await fx.downloads.settle();
  assert.equal((await fx.downloads.get({ downloadId: start.downloadId, actor })).error.code, 'BROWSER_DOWNLOAD_TOO_LARGE');
});

test('public download waits only its own durable bytes and card while another agent transfer is stalled', async (t) => {
  const bytes = pagedPdf(['fast public paper']);
  const fx = await fixture(t, { fetchPublicImpl: async () => ({ bytes, filename: 'public.pdf', mime: 'application/pdf' }) });
  const otherActor = { threadId: 'slow-chat', agentId: 'slow-agent' };
  const stalled = await fx.downloads.handleBrowserDownload({ actor: otherActor,
    download: source(null, { createReadStream: async () => new Promise(() => {}) }) });
  const publicJob = await fx.downloads.downloadPublic({ actor, url: 'https://example.org/paper.pdf', filename: 'paper.pdf' });
  assert.equal(publicJob.state, 'downloaded');
  assert.deepEqual((await fx.downloads.readBytes({ downloadId: publicJob.downloadId, actor })).bytes, bytes);
  assert.equal((await fx.downloads.get({ downloadId: stalled.downloadId, actor: otherActor })).state, 'downloading');
  await fx.downloads.cancel({ downloadId: stalled.downloadId, actor: otherActor });
});

test('runtime source is removed only after durable bytes and before project copying', async (t) => {
  const fx = await fixture(t);
  const bytes = pagedPdf(['source cleanup ordering']);
  let sourceRemoved = false;
  const original = fx.projectIngest.importDownload.bind(fx.projectIngest);
  fx.projectIngest.importDownload = async (args) => {
    assert.equal(sourceRemoved, true);
    assert.deepEqual((await fx.downloads.readBytes({ downloadId: args.download.downloadId, actor })).bytes, bytes);
    return original(args);
  };
  const job = await fx.downloads.handleBrowserDownload({ actor, tab: { ...actor, projectId: fx.projectId },
    download: source(bytes, { delete: async () => { sourceRemoved = true; } }) });
  await fx.downloads.settle();
  assert.equal((await fx.downloads.get({ downloadId: job.downloadId, actor })).state, 'imported');
});

test('allocation reserves both runtime and managed copies before accepting browser bytes', async (t) => {
  const fx = await fixture(t, { maxBytes: 1024, freeSpaceReserve: 2048 });
  const originalStatfs = fs.statfs;
  fs.statfs = async () => ({ bavail: 3500, bsize: 1 });
  t.after(() => { fs.statfs = originalStatfs; });
  let cancelled = false;
  await assert.rejects(fx.downloads.handleBrowserDownload({ actor,
    download: source(Buffer.alloc(1), { cancel: async () => { cancelled = true; } }) }), { code: 'BROWSER_DOWNLOAD_DISK_FULL' });
  assert.equal(cancelled, true);
  assert.equal((await fx.downloads.list(actor)).length, 0);
  fs.statfs = originalStatfs;
});

test('retained bytes still count against quota when a corrupt completed manifest is recovered as interrupted', async (t) => {
  const fx = await fixture(t, { maxBytes: 32, maxTotalBytes: 64, freeSpaceReserve: 0 });
  const first = await fx.downloads.handleBrowserDownload({ actor, download: source(Buffer.alloc(32, 1)) });
  await fx.downloads.settle();
  const manifestPath = path.join(fx.parent, 'downloads', first.downloadId, 'manifest.json');
  const saved = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  await fs.writeFile(manifestPath, JSON.stringify({ ...saved, state: 'interrupted' }));
  await fs.writeFile(path.join(fx.parent, 'downloads', first.downloadId, 'bytes.bin'), Buffer.alloc(32, 2));
  const restarted = createBrowserDownloads({ dataDir: fx.parent, maxBytes: 32, maxTotalBytes: 64, freeSpaceReserve: 0 });
  await restarted.ready;
  assert.equal((await restarted.get({ downloadId: first.downloadId, actor })).state, 'interrupted');
  await restarted.handleBrowserDownload({ actor, download: source(Buffer.alloc(32, 3)) }); await restarted.settle();
  await assert.rejects(restarted.handleBrowserDownload({ actor, download: source(Buffer.alloc(1)) }), { code: 'BROWSER_DOWNLOAD_QUOTA' });
  await restarted.close();
});

test('revoking active public download authorization aborts fetching while preserving prior completed bytes', async (t) => {
  let allowed = true, fetching;
  const fetchStarted = new Promise((resolve) => { fetching = resolve; });
  const fx = await fixture(t, {
    authorizeDownload: async ({ url }) => {
      assert.equal(url, 'https://example.org/private.pdf?transient=signed');
      return allowed;
    },
    fetchPublicImpl: async (_url, { signal }) => {
      fetching();
      return new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => reject(Object.assign(new Error('cancelled'), { code: 'DOWNLOAD_ABORTED' })), { once: true });
      });
    },
  });
  const prior = await fx.downloads.handleBrowserDownload({ actor, download: source(pagedPdf(['retained before revocation']), {
    url: () => 'https://example.org/private.pdf?transient=signed',
  }) });
  await fx.downloads.settle();
  const waiting = fx.downloads.downloadPublic({ actor, url: 'https://example.org/private.pdf?transient=signed' });
  const rejected = assert.rejects(waiting, { code: 'BROWSER_DOWNLOAD_FORBIDDEN' });
  await fetchStarted;
  allowed = false;
  // Bound the fixture itself so an absent revocation monitor fails instead of hanging the test worker.
  const deadline = new Promise((_, reject) => setTimeout(() => reject(new Error('revocation did not abort transfer')), 1500));
  await Promise.race([rejected, deadline]);
  const jobs = await fx.downloads.list(actor);
  assert.ok(jobs.some((job) => job.state === 'interrupted' && job.error?.code === 'BROWSER_DOWNLOAD_FORBIDDEN'));
  assert.ok((await fx.downloads.readBytes({ downloadId: prior.downloadId, actor })).bytes.length > 0);
  for (const job of jobs) {
    assert.doesNotMatch(await fs.readFile(path.join(fx.parent, 'downloads', job.downloadId, 'manifest.json'), 'utf8'), /transient|signed/);
  }
});

test('explicit owner move uses owner authorization while background imports keep captured agent authorization', async (t) => {
  const fx = await fixture(t, { authorizeImport: async (job) => job.actor.isHuman === true });
  const job = await fx.downloads.handleBrowserDownload({ actor, tab: { ...actor, projectId: fx.projectId },
    download: source(pagedPdf(['owner manual movement'])) });
  await fx.downloads.settle();
  assert.equal((await fx.downloads.get({ downloadId: job.downloadId, actor })).state, 'import-failed');
  assert.equal((await fx.projectStore.get(fx.projectId)).items.length, 0);
  const moved = await fx.downloads.retry({ downloadId: job.downloadId, actor: human });
  assert.equal(moved.state, 'imported');
  assert.equal(moved.target.threadId, actor.threadId);
  await fx.downloads.settle();
  assert.equal((await fx.projectStore.getItem(fx.projectId, moved.projectItemId)).addedBy.kind, 'user');
});

test('public redirect policy rejects a blocked destination before fetching it and retains sanitized final provenance for allowed exports', async (t) => {
  const bytes = pagedPdf(['redirect research evidence']);
  const fetched = [], authorized = [];
  let blocked = true;
  const response = (status, headers, body) => ({ status, ok: status === 200, headers: new Headers(headers),
    body: Readable.from(body ? [body] : []) });
  const fx = await fixture(t, {
    authorizeDownload: async ({ url }) => {
      authorized.push(url);
      return !blocked || new URL(url).hostname !== 'delivery.example.org';
    },
    fetchPublicImpl: (url, options) => fetchPublic(url, { ...options, fetchImpl: async (target) => {
      fetched.push(target.href);
      return target.hostname === 'example.org'
        ? response(302, { location: 'https://delivery.example.org/paper.pdf?signed=final-secret#export' })
        : response(200, { 'content-type': 'application/pdf' }, bytes);
    } }),
  });
  await assert.rejects(fx.downloads.downloadPublic({ actor, url: 'https://example.org/export?private=start-secret' }), { code: 'DOWNLOAD_DESTINATION_BLOCKED' });
  assert.deepEqual(fetched, ['https://example.org/export?private=start-secret']);
  assert.ok(authorized.some((candidate) => new URL(candidate).hostname === 'delivery.example.org'));
  blocked = false; fetched.length = 0;
  const result = await fx.downloads.downloadPublic({ actor, url: 'https://example.org/export?private=start-secret' });
  assert.deepEqual(fetched, ['https://example.org/export?private=start-secret', 'https://delivery.example.org/paper.pdf?signed=final-secret#export']);
  const completed = await fx.downloads.get({ downloadId: result.downloadId, actor });
  assert.equal(completed.source.url, 'https://example.org/export');
  assert.equal(completed.source.finalUrl, 'https://delivery.example.org/paper.pdf');
  assert.deepEqual((await fx.downloads.readBytes({ downloadId: completed.downloadId, actor })).bytes, bytes);
  for (const job of await fx.downloads.list(actor)) {
    assert.doesNotMatch(await fs.readFile(path.join(fx.parent, 'downloads', job.downloadId, 'manifest.json'), 'utf8'), /start-secret|final-secret|signed=|private=|#export/);
  }
});

test('public transfer monitoring follows the redirected delivery origin when it is revoked during fetching', async (t) => {
  let deliveryAllowed = true, streaming;
  const started = new Promise((resolve) => { streaming = resolve; });
  const fx = await fixture(t, {
    authorizeDownload: async ({ url }) => deliveryAllowed || new URL(url).hostname !== 'delivery.example.org',
    fetchPublicImpl: async (url, { authorizeUrl, signal }) => {
      await authorizeUrl('https://delivery.example.org/paper.pdf?signed=transient');
      streaming();
      return new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => reject(Object.assign(new Error('cancelled'), { code: 'DOWNLOAD_ABORTED' })), { once: true });
      });
    },
  });
  const pending = fx.downloads.downloadPublic({ actor, url: 'https://example.org/export' });
  const rejected = assert.rejects(pending, { code: 'BROWSER_DOWNLOAD_FORBIDDEN' });
  await started; deliveryAllowed = false;
  let deadlineTimer;
  try {
    await Promise.race([rejected, new Promise((_, reject) => {
      deadlineTimer = setTimeout(() => reject(new Error('delivery revocation did not abort transfer')), 1500);
    })]);
  } finally { clearTimeout(deadlineTimer); }
  assert.equal((await fx.downloads.list(actor))[0].state, 'interrupted');
});
