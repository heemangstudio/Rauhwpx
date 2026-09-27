// Run against a checkout with --root=/path/to/rhwp-studio to compare revisions.
import { resolve } from 'node:path';
import { createServer } from 'vite';
import puppeteer from 'puppeteer-core';
import { browserExecutable, browserLaunchArgs } from '../tests/browser-support.ts';

const root = resolve(process.argv.find((arg) => arg.startsWith('--root='))?.slice(7) ?? new URL('../', import.meta.url).pathname);
const server = await createServer({ root, configFile: false, logLevel: 'silent', server: { host: '127.0.0.1', port: 0 } });
let browser;
try {
  await server.listen();
  browser = await puppeteer.launch({ executablePath: browserExecutable(), headless: true, args: [...browserLaunchArgs(), '--enable-precise-memory-info'] });
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/tests/fixtures/version-store-idb.html`);
  const result = await page.evaluate(async () => {
    const v = await import('/src/versioning/index.ts');
    const store = new v.VersionGraphStore();
    const payload = (value) => {
      const bytes = new Uint8Array(128 * 1024).fill(value % 251);
      bytes.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
      new DataView(bytes.buffer).setUint32(8, value);
      return { bytes, contentFingerprint: v.fingerprintBytes(bytes),
        compareSnapshot: { meta: { name: 'Benchmark', sectionCount: 1, pageCount: 10 },
          paragraphs: Array.from({ length: 100 }, (_, n) => ({ section: 0, paragraph: n,
            sectionPage: 1, globalIndex: n, stableId: `p-${n}`, text: `Paragraph ${n}: revision ${value}`,
            normalizedText: `Paragraph ${n}: revision ${value}`, controlCount: 0,
            signature: `p-${n}`, isAnchorCandidate: true })), controls: [] },
        title: `Revision ${value}`, titleRevision: 0, titleOrigin: 'manual', author: { kind: 'user', label: 'Benchmark' } };
    };
    const create = async (name, count, offset) => {
      const initial = payload(offset);
      let state = await store.createRepository({ documentId: v.documentId(name), lastSavedFingerprint: initial.contentFingerprint, initial });
      const rootCommit = state.commit;
      for (let n = 1; n < count; n++) state = await store.createCheckpoint({
        repositoryId: state.repository.id, branch: state.branch.name,
        expectedRepositoryRevision: state.repository.revision, expectedBranchRevision: state.branch.revision,
        reason: 'manual', ...payload(offset + n),
      });
      return { ...state, rootCommit };
    };
    let state = await create('long-history', 200, 0);
    await create('unrelated-history', 200, 1000);
    const imagePayload = payload(5000);
    imagePayload.bytes = new Uint8Array(8 * 1024 * 1024).fill(57);
    imagePayload.bytes.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
    imagePayload.contentFingerprint = v.fingerprintBytes(imagePayload.bytes);
    let imageRepo = await store.createRepository({ documentId: v.documentId('image-heavy'), lastSavedFingerprint: imagePayload.contentFingerprint, initial: imagePayload });
    // Warm connections and any metadata migrated by the implementation.
    await store.getRepositoryStorageUsage(state.repository.id);
    const originalGet = IDBObjectStore.prototype.get;
    const originalGetAll = IDBObjectStore.prototype.getAll;
    let payloadReads = 0;
    let globalScans = 0;
    IDBObjectStore.prototype.get = function (...args) {
      if (this.name === 'blobs' || this.name === 'compareSnapshots') payloadReads++;
      return originalGet.apply(this, args);
    };
    IDBObjectStore.prototype.getAll = function (...args) { globalScans++; return originalGetAll.apply(this, args); };
    const measurements = {};
    let sampledPeakHeapBytes = 0;
    const sampleHeap = () => { sampledPeakHeapBytes = Math.max(sampledPeakHeapBytes, performance.memory?.usedJSHeapSize ?? 0); };
    const sampler = setInterval(sampleHeap, 10);
    const measure = async (name, operation) => {
      const samples = [];
      const reads = payloadReads, scans = globalScans;
      for (let n = 0; n < 5; n++) {
        const start = performance.now(); await operation(n); samples.push(performance.now() - start); sampleHeap();
      }
      samples.sort((a, b) => a - b);
      measurements[name] = { medianMs: Math.round(samples[2] * 100) / 100, payloadReads, globalScans };
      measurements[name].payloadReads -= reads;
      measurements[name].globalScans -= scans;
    };
    try {
      await measure('checkpoint', async (n) => {
        const next = await store.createCheckpoint({ repositoryId: state.repository.id, branch: state.branch.name,
          expectedRepositoryRevision: state.repository.revision, expectedBranchRevision: state.branch.revision,
          reason: 'manual', ...payload(200 + n) }); state = { ...state, ...next };
      });
      await measure('historyRefresh', async () => {
        const commits = await store.listCommits(state.repository.id);
        await Promise.all([store.listRefs(state.repository.id), store.getBlobSizes(commits.map((c) => c.blobId)), store.getRepositoryStorageUsage(state.repository.id)]);
      });
      await measure('ancestry', () => store.getMergeRelation(state.repository.id, state.rootCommit.id, state.commit.id));
      await measure('export', async () => {
        const snapshot = await store.exportRepositorySnapshot(state.repository.id);
        v.createPortableHistoryArchive({ documentFileName: 'benchmark.hwp', sourceFormat: 'hwp', activeBranch: state.branch.name, currentBlobId: state.commit.blobId, snapshot });
      });
      await measure('imageAccounting', () => store.getRepositoryStorageUsage(imageRepo.repository.id));
      await measure('imageCheckpoint', async (n) => {
        const bytes = imagePayload.bytes.slice();
        new DataView(bytes.buffer).setUint32(8, n);
        imageRepo = await store.createCheckpoint({ repositoryId: imageRepo.repository.id, branch: imageRepo.branch.name,
          expectedRepositoryRevision: imageRepo.repository.revision, expectedBranchRevision: imageRepo.branch.revision,
          reason: 'manual', ...imagePayload, bytes, contentFingerprint: v.fingerprintBytes(bytes) });
      });
      await measure('imageExport', async () => {
        const snapshot = await store.exportRepositorySnapshot(imageRepo.repository.id);
        v.createPortableHistoryArchive({ documentFileName: 'images.hwp', sourceFormat: 'hwp', activeBranch: imageRepo.branch.name, currentBlobId: imageRepo.commit.blobId, snapshot });
      });
      return { fixture: { historyCommits: 205, unrelatedCommits: 200, imageCommits: 6, imageBlobBytes: imagePayload.bytes.length, repetitions: 5 }, measurements,
        sampledPeakHeapBytes, memoryNote: 'Renderer JS heap sampled every 10ms and after each operation; native IndexedDB memory is excluded.' };
    } finally { clearInterval(sampler); IDBObjectStore.prototype.get = originalGet; IDBObjectStore.prototype.getAll = originalGetAll; await store.close(); }
  });
  console.log(JSON.stringify(result, null, 2));
} finally { await browser?.close(); await server.close(); }
