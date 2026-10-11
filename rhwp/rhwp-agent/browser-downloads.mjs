// 브라우저가 전달한 바이트를 보존하는 소유자 다운로드함. URL 을 다시 요청하지 않는다.
import crypto from 'node:crypto';
import { constants as fsConstants, promises as fs } from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fetchPublic, sanitizeDownloadUrl, sanitizeFilename } from './download-manager.mjs';
import { recoverInterruptedFileReplacement, replaceFileAtomically } from './harness-update.mjs';

const ID = /^bd_[a-f0-9]{32}$/;
const STATES = new Set(['downloading', 'downloaded', 'importing', 'imported', 'cancelled', 'interrupted', 'import-failed']);
const MAX_MANIFEST_BYTES = 16 * 1024;
const MAX_FILE_BYTES = 512 * 1024 * 1024;
const COMPLETE = new Set(['downloaded', 'importing', 'imported', 'import-failed']);

function failure(code, message) { return Object.assign(new Error(message), { code }); }
function cleanId(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\u0000-\u001f\u007f]/.test(value) ? value : null;
}
function targetOf(tab, actor, ownerId) {
  const target = { ownerId };
  for (const key of ['projectId', 'threadId', 'documentId', 'agentId', 'taskId']) {
    const value = cleanId(tab && Object.hasOwn(tab, key) ? tab[key] : actor?.[key]);
    if (value) target[key] = value;
  }
  const tabId = cleanId(tab?.tabId ?? tab?.id);
  if (tabId) target.tabId = tabId;
  return target;
}
function jobActor(job, requestingActor = null) {
  const isHuman = requestingActor?.isHuman === true || job.initiatedByUser === true;
  return { ...job.target, kind: isHuman ? 'user' : 'agent', ...(isHuman ? { isHuman: true } : {}) };
}
function publicJob(job) {
  return structuredClone({ ...job, actor: undefined });
}
function safeError(error) {
  const code = String(error?.code ?? 'BROWSER_DOWNLOAD_FAILED');
  return { code: /^[A-Z_]{1,100}$/.test(code) ? code : 'BROWSER_DOWNLOAD_FAILED',
    message: 'Download could not complete. Retained files can be opened or retried.' };
}
async function plainDirectory(directory, recursive = false) {
  await fs.mkdir(directory, { mode: 0o700, recursive }).catch((error) => { if (error.code !== 'EEXIST') throw error; });
  const info = await fs.lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw failure('BROWSER_DOWNLOAD_PATH', 'Download storage is not a plain directory');
  if (process.platform !== 'win32' && typeof process.getuid === 'function' && info.uid !== process.getuid()) {
    throw failure('BROWSER_DOWNLOAD_PATH', 'Download storage belongs to another user');
  }
  await fs.chmod(directory, 0o700);
}
async function atomicManifest(file, job) {
  const text = JSON.stringify(job) + '\n';
  if (Buffer.byteLength(text) > MAX_MANIFEST_BYTES) throw failure('BROWSER_DOWNLOAD_METADATA_LIMIT', 'Download metadata is too large');
  const temp = `${file}.tmp-${crypto.randomUUID()}`;
  try {
    const handle = await fs.open(temp, 'wx', 0o600);
    try { await handle.writeFile(text); await handle.sync(); } finally { await handle.close(); }
    await replaceFileAtomically(temp, file);
    if (process.platform !== 'win32') {
      const dir = await fs.open(path.dirname(file), 'r');
      try { await dir.sync(); } finally { await dir.close(); }
    }
  } finally { await fs.unlink(temp).catch(() => undefined); }
}

/** BrowserRuntime may pass a Playwright Download or a native adapter with createReadStream/cancel. */
export function createBrowserDownloads(options) { return new BrowserDownloads(options); }
export class BrowserDownloads {
  constructor({ dataDir, agentDir, projectIngest, ownerId = 'local', authorizeImport = () => true, authorizeDownload = null, onEvent = null,
    maxBytes = 100 * 1024 * 1024, maxTotalBytes = 2 * 1024 * 1024 * 1024, maxJobs = 2_000,
    maxConcurrent = 4, freeSpaceReserve = 256 * 1024 * 1024, timeoutMs = 120_000, autoImport = true,
    fetchPublicImpl = fetchPublic } = {}) {
    if (!dataDir && !agentDir) throw new Error('BrowserDownloads requires hub-owned dataDir');
    this.root = path.resolve(dataDir ?? agentDir, 'downloads');
    this.projectIngest = projectIngest;
    this.ownerId = ownerId;
    this.authorizeImport = authorizeImport;
    this.authorizeDownload = authorizeDownload;
    this.onEvent = onEvent;
    this.maxBytes = maxBytes;
    this.autoImport = autoImport;
    this.maxTotalBytes = maxTotalBytes;
    this.maxJobs = maxJobs;
    this.maxConcurrent = maxConcurrent;
    this.freeSpaceReserve = freeSpaceReserve;
    this.timeoutMs = timeoutMs;
    this.fetchPublicImpl = fetchPublicImpl;
    this.jobs = new Map();
    this.storedBytes = new Map();
    this.active = new Map();
    this.pending = new Set();
    this.writeQueues = new Map();
    this.importQueues = new Map();
    this.closed = false;
    this.allocating = Promise.resolve();
    this.ready = this.#recover();
  }

  configure({ maxFileBytes = this.maxBytes, autoImport = this.autoImport } = {}) {
    if (!Number.isSafeInteger(maxFileBytes) || maxFileBytes < 1 || maxFileBytes > MAX_FILE_BYTES || typeof autoImport !== 'boolean') {
      throw failure('BROWSER_CONFIGURATION_INVALID', 'Download configuration is invalid');
    }
    this.maxBytes = maxFileBytes;
    this.autoImport = autoImport;
    for (const [id, live] of this.active) {
      const job = this.jobs.get(id);
      if (!COMPLETE.has(job.state) && job.size > maxFileBytes) {
        live.failure = failure('BROWSER_DOWNLOAD_TOO_LARGE', 'Download exceeds the current managed byte limit');
        live.cancelled = true; live.interrupted = true; live.abort();
        live.stream?.destroy?.(live.failure);
        Promise.resolve(live.download?.cancel?.()).catch(() => undefined);
      }
    }
    return this.getConfiguration();
  }
  getConfiguration() { return { maxFileBytes: this.maxBytes, autoImport: this.autoImport }; }

  #directory(id) {
    if (!ID.test(String(id))) throw failure('BROWSER_DOWNLOAD_NOT_FOUND', 'Download was not found');
    return path.join(this.root, id);
  }
  #file(id, leaf) { return path.join(this.#directory(id), leaf); }
  #allowed(job, actor) {
    if (!actor || (actor.ownerId && actor.ownerId !== this.ownerId)) return false;
    if (actor.isHuman === true) return true;
    return cleanId(actor.threadId) === job.target.threadId && cleanId(actor.agentId) === job.target.agentId
      && Boolean(job.target.threadId && job.target.agentId);
  }
  #owned(id, actor) {
    this.#directory(id);
    const job = this.jobs.get(id);
    if (!job || !this.#allowed(job, actor)) throw failure('BROWSER_DOWNLOAD_NOT_FOUND', 'Download was not found');
    return job;
  }
  #notify(job) {
    try { Promise.resolve(this.onEvent?.({ type: 'browser-download', job: publicJob(job) })).catch(() => undefined); } catch {}
  }
  #track(promise) {
    this.pending.add(promise);
    promise.then(() => this.pending.delete(promise), () => this.pending.delete(promise));
    return promise;
  }
  #persist(job, patch = {}) {
    const previous = this.writeQueues.get(job.downloadId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(async () => {
      const updated = { ...job, ...patch, updatedAt: new Date().toISOString() };
      await atomicManifest(this.#file(job.downloadId, 'manifest.json'), updated);
      Object.assign(job, updated);
      this.#notify(job);
      return publicJob(job);
    });
    this.writeQueues.set(job.downloadId, next);
    next.finally(() => { if (this.writeQueues.get(job.downloadId) === next) this.writeQueues.delete(job.downloadId); }).catch(() => undefined);
    return next;
  }

  async #recover() {
    await plainDirectory(this.root, true);
    const entries = await fs.readdir(this.root, { withFileTypes: true });
    if (entries.length > this.maxJobs * 3 + 64) throw failure('BROWSER_DOWNLOAD_LIMIT', 'Download storage contains too many entries');
    for (const entry of entries) {
      if (!ID.test(entry.name) || !entry.isDirectory() || entry.isSymbolicLink()) continue;
      if (this.jobs.size >= this.maxJobs) throw failure('BROWSER_DOWNLOAD_LIMIT', 'Download storage contains too many jobs');
      try {
        await plainDirectory(this.#directory(entry.name));
        const manifestPath = this.#file(entry.name, 'manifest.json');
        await recoverInterruptedFileReplacement(manifestPath);
        const info = await fs.lstat(manifestPath);
        if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_MANIFEST_BYTES) continue;
        const raw = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
        if (raw.schemaVersion !== 1 || raw.downloadId !== entry.name || !STATES.has(raw.state)
          || raw.target?.ownerId !== this.ownerId || !Number.isSafeInteger(raw.size) || raw.size < 0 || raw.size > MAX_FILE_BYTES
          || typeof raw.createdAt !== 'string' || !Number.isFinite(Date.parse(raw.createdAt))) continue;
        // 장부는 URL이나 임의 경로를 재시도 권한으로 취급하지 않는다.
        const job = { schemaVersion: 1, downloadId: raw.downloadId, state: raw.state, filename: sanitizeFilename(raw.filename),
          mimeType: raw.mimeType === 'application/pdf' ? 'application/pdf' : 'application/octet-stream',
          size: raw.size, sha256: /^[a-f0-9]{64}$/.test(raw.sha256 ?? '') ? raw.sha256 : null,
          target: targetOf(raw.target, null, this.ownerId), source: {}, createdAt: raw.createdAt,
          ...(raw.initiatedByUser === true ? { initiatedByUser: true } : {}),
          updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : raw.createdAt };
        if (cleanId(raw.target?.tabId)) job.target.tabId = raw.target.tabId;
        for (const key of ['url', 'pageUrl', 'finalUrl']) { const url = sanitizeDownloadUrl(raw.source?.[key]); if (url) job.source[key] = url; }
        for (const key of ['fileId', 'projectItemId', 'importProjectId', 'extractionStatus', 'inboxMovedAt']) {
          if (cleanId(raw[key])) job[key] = raw[key];
        }
        if (raw.error) job.error = safeError(raw.error);
        if (raw.extractionError) job.extractionError = safeError(raw.extractionError);
        this.jobs.set(job.downloadId, job);
        const retained = await fs.lstat(this.#file(job.downloadId, 'bytes.bin')).catch(() => null);
        if (retained?.isFile() && !retained.isSymbolicLink()) this.storedBytes.set(job.downloadId, retained.size);
        if (job.state === 'downloading' || (job.state === 'interrupted' && job.sha256 && job.size)) {
          // rename 뒤 manifest 쓰기 전 종료된 경우 완성된 바이트를 복구한다.
          try {
            const bytes = await this.#readVerified(job, { allowMissingChecksum: job.state === 'downloading' });
            await this.#persist(job, { state: 'downloaded', size: bytes.length,
              sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
              mimeType: bytes.subarray(0, 5).toString('ascii') === '%PDF-' ? 'application/pdf' : job.mimeType });
          } catch {
            await this.#persist(job, { state: 'interrupted', error: { code: 'BROWSER_DOWNLOAD_INTERRUPTED', message: 'Download was interrupted. Start the browser download again.' } });
            await fs.unlink(this.#file(job.downloadId, 'transfer.part')).catch(() => undefined);
          }
        } else if (job.state === 'importing') {
          await this.#persist(job, { state: 'downloaded' });
        }
        await fs.unlink(this.#file(job.downloadId, 'transfer.part')).catch(() => undefined);
        if (job.state === 'downloaded' && (job.importProjectId || job.target.projectId)) {
          this.#track(this.#import(job, job.importProjectId ?? job.target.projectId, { automatic: true }).catch(() => undefined));
        } else if (job.state === 'imported' && ['pending', 'running'].includes(job.extractionStatus)) {
          this.#scheduleExtraction(job);
        }
      } catch { /* 손상된 장부는 디스크에 보존한다. 다른 다운로드의 복구를 막지 않는다. */ }
    }
  }

  async #allocate({ actor, tab, download, pageUrl, source, permission }) {
    if (this.closed) throw failure('BROWSER_DOWNLOAD_CLOSED', 'Downloads are shutting down');
    if (actor?.ownerId && actor.ownerId !== this.ownerId) throw failure('BROWSER_DOWNLOAD_FORBIDDEN', 'Download owner does not match');
    if (permission === false || permission?.download === false) throw failure('BROWSER_DOWNLOAD_FORBIDDEN', 'Downloads are blocked');
    if (this.active.size >= this.maxConcurrent || this.jobs.size >= this.maxJobs) throw failure('BROWSER_DOWNLOAD_LIMIT', 'Too many managed downloads');
    const used = [...this.storedBytes.values()].reduce((sum, size) => sum + size, 0);
    const reserved = [...this.active.values()].reduce((sum, live) => sum + live.byteLimit, 0);
    if (used + reserved + this.maxBytes > this.maxTotalBytes) throw failure('BROWSER_DOWNLOAD_QUOTA', 'Managed Downloads inbox is full');
    if (typeof fs.statfs === 'function') {
      const disk = await fs.statfs(this.root);
      // 전송 중에는 Chromium 임시 원본과 앱 복사본이 함께 존재한다.
      if (Number(disk.bavail) * Number(disk.bsize) < this.freeSpaceReserve + 2 * (reserved + this.maxBytes)) {
        throw failure('BROWSER_DOWNLOAD_DISK_FULL', 'Not enough disk space for this download');
      }
    }
    const downloadId = `bd_${crypto.randomBytes(16).toString('hex')}`;
    const getValue = (key) => typeof download?.[key] === 'function' ? download[key]() : download?.[key];
    const rawUrl = typeof source === 'string' ? source : source?.url ?? getValue('url');
    const job = { schemaVersion: 1, downloadId, state: 'downloading', filename: sanitizeFilename(getValue('suggestedFilename') ?? download?.filename),
      mimeType: 'application/octet-stream', size: 0, sha256: null,
      target: targetOf(tab, actor, this.ownerId), source: {}, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    if (actor?.isHuman === true) job.initiatedByUser = true;
    const url = sanitizeDownloadUrl(rawUrl), cleanPage = sanitizeDownloadUrl(pageUrl ?? source?.pageUrl);
    if (url) job.source.url = url;
    if (cleanPage) job.source.pageUrl = cleanPage;
    // 서명 URL 은 현재 정책 확인에만 쓴다. 장부에는 위에서 정리한 URL 만 저장한다.
    const authorize = async () => {
      const deliveredUrl = getValue('url');
      const policyUrl = sanitizeDownloadUrl(deliveredUrl) ? deliveredUrl : pageUrl ?? source?.pageUrl;
      if (this.authorizeDownload && !await this.authorizeDownload({ actor: { ...actor }, url: policyUrl, target: { ...job.target } })) {
        throw failure('BROWSER_DOWNLOAD_FORBIDDEN', 'Download permission was revoked');
      }
    };
    await authorize();
    await plainDirectory(this.#directory(downloadId));
    await atomicManifest(this.#file(downloadId, 'manifest.json'), job);
    this.jobs.set(downloadId, job);
    const live = { download, authorize, byteLimit: this.maxBytes, cancelled: false, interrupted: false, stream: null, timer: null };
    live.aborted = new Promise((resolve) => { live.abort = resolve; });
    this.active.set(downloadId, live);
    this.#notify(job);
    live.timer = setTimeout(() => {
      live.failure = failure('BROWSER_DOWNLOAD_TIMEOUT', 'Download timed out');
      live.cancelled = true;
      live.interrupted = true;
      live.abort();
      live.stream?.destroy?.(live.failure);
      Promise.resolve(download?.cancel?.()).catch(() => undefined);
    }, this.timeoutMs);
    live.timer.unref?.();
    if (this.authorizeDownload) {
      live.policyTimer = setInterval(() => {
        if (live.checkingPolicy || live.cancelled || COMPLETE.has(job.state)) return;
        live.checkingPolicy = true;
        authorize().catch((error) => {
          if (COMPLETE.has(job.state)) return;
          live.failure = error; live.cancelled = true; live.interrupted = true; live.abort();
          live.stream?.destroy?.(error);
          Promise.resolve(download?.cancel?.()).catch(() => undefined);
        }).finally(() => { live.checkingPolicy = false; });
      }, 100);
      live.policyTimer.unref?.();
    }
    live.done = this.#track(this.#receive(job, live));
    return publicJob(job);
  }

  async handleBrowserDownload(args) {
    // ready/용량 확인을 기다리는 사이 탭이나 현재 프로젝트가 바뀌어도 목적지는 바뀌지 않는다.
    const captured = { ...args, actor: { ...args?.actor }, tab: { ...args?.tab },
      ...(args?.source && typeof args.source === 'object' ? { source: { ...args.source } } : {}) };
    await this.ready;
    const previous = this.allocating;
    const running = previous.catch(() => undefined).then(() => this.#allocate(captured));
    this.allocating = running;
    try { return await running; } catch (error) {
      await args?.download?.cancel?.().catch?.(() => undefined);
      throw error;
    }
  }
  acceptBrowserDownload(args) { return this.handleBrowserDownload(args); }

  async #receive(job, live) {
    let handle;
    try {
      handle = await fs.open(this.#file(job.downloadId, 'transfer.part'), 'wx', 0o600);
      live.stream = await Promise.race([
        typeof live.download.createReadStream === 'function' ? live.download.createReadStream() : live.download.stream,
        live.aborted.then(() => { throw live.failure; }),
      ]);
      if (!live.stream) throw failure('BROWSER_DOWNLOAD_NO_BYTES', 'Browser did not provide download bytes');
      const hash = crypto.createHash('sha256');
      let size = 0, lastProgress = 0;
      const iterator = live.stream[Symbol.asyncIterator]();
      for (;;) {
        const { value: raw, done } = await Promise.race([iterator.next(), live.aborted.then(() => { throw live.failure; })]);
        if (done) break;
        if (live.cancelled || this.closed) throw live.failure ?? failure('BROWSER_DOWNLOAD_CANCELLED', 'Download was cancelled');
        await live.authorize();
        const chunk = Buffer.from(raw);
        size += chunk.length;
        if (size > Math.min(live.byteLimit, this.maxBytes)) throw failure('BROWSER_DOWNLOAD_TOO_LARGE', 'Download exceeds the managed byte limit');
        hash.update(chunk);
        await handle.writeFile(chunk);
        if (Date.now() - lastProgress > 200) { await this.#persist(job, { size }); lastProgress = Date.now(); }
      }
      if (live.cancelled || this.closed) throw live.failure ?? failure('BROWSER_DOWNLOAD_CANCELLED', 'Download was cancelled');
      await live.authorize();
      if (!size) throw failure('BROWSER_DOWNLOAD_EMPTY', 'Download is empty');
      await handle.sync();
      await handle.close(); handle = null;
      await fs.rename(this.#file(job.downloadId, 'transfer.part'), this.#file(job.downloadId, 'bytes.bin'));
      this.storedBytes.set(job.downloadId, size);
      const checksum = hash.digest('hex');
      const bytes = await this.#readVerified({ ...job, size, sha256: checksum });
      const mimeType = bytes.subarray(0, 5).toString('ascii') === '%PDF-' ? 'application/pdf' : 'application/octet-stream';
      const filename = sanitizeFilename(typeof live.download.suggestedFilename === 'function' ? live.download.suggestedFilename() : job.filename);
      const finalUrl = sanitizeDownloadUrl(typeof live.download.url === 'function' ? live.download.url() : live.download.url);
      await this.#persist(job, { state: 'downloaded', size, sha256: checksum, mimeType, filename,
        ...(finalUrl && finalUrl !== job.source.url ? { source: { ...job.source, finalUrl } } : {}), error: undefined });
      clearTimeout(live.timer);
      clearInterval(live.policyTimer);
      // 앱 복사본이 커밋되면 Chromium 임시 원본을 먼저 정리한다. 프로젝트 복사가 세 번째가 되지 않는다.
      try { await live.download?.delete?.(); live.sourceReleased = true; } catch {}
      if (job.target.projectId) await this.#import(job, job.target.projectId, { automatic: true });
    } catch (error) {
      if (!COMPLETE.has(job.state)) {
        await this.#persist(job, { state: live.interrupted ? 'interrupted' : live.cancelled ? 'cancelled' : 'interrupted',
          error: safeError(live.failure ?? error) }).catch(() => undefined);
        await live.download?.cancel?.().catch?.(() => undefined);
        live.stream?.destroy?.();
        await handle?.close().catch(() => undefined); handle = null;
        await fs.unlink(this.#file(job.downloadId, 'transfer.part')).catch(() => undefined);
      }
    } finally {
      await handle?.close().catch(() => undefined);
      // Chromium 임시 파일은 복사/취소가 끝난 뒤에만 지운다. 앱 원본은 별도 bytes.bin 에 있다.
      if (!live.sourceReleased) { try { await live.download?.delete?.(); } catch {} }
      clearTimeout(live.timer);
      clearInterval(live.policyTimer);
      this.active.delete(job.downloadId);
    }
  }

  async #readVerified(job, { allowMissingChecksum = false } = {}) {
    await plainDirectory(this.#directory(job.downloadId));
    const file = this.#file(job.downloadId, 'bytes.bin');
    const lexical = await fs.lstat(file);
    if (!lexical.isFile() || lexical.isSymbolicLink()) throw failure('BROWSER_DOWNLOAD_PATH', 'Managed download is not a plain file');
    const handle = await fs.open(file, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size < 1 || info.size > MAX_FILE_BYTES
        || info.ino !== lexical.ino || info.dev !== lexical.dev
        || (process.platform !== 'win32' && typeof process.getuid === 'function' && info.uid !== process.getuid())) {
        throw failure('BROWSER_DOWNLOAD_PATH', 'Managed download is outside its bounds');
      }
      const bytes = await handle.readFile();
      if (bytes.length !== info.size || bytes.length > MAX_FILE_BYTES) throw failure('BROWSER_DOWNLOAD_CHANGED', 'Managed file changed during reading');
      if (!allowMissingChecksum && (bytes.length !== job.size || crypto.createHash('sha256').update(bytes).digest('hex') !== job.sha256)) {
        throw failure('BROWSER_DOWNLOAD_CHANGED', 'Managed file checksum did not match');
      }
      return bytes;
    } finally { await handle.close(); }
  }

  async #import(job, projectId, { automatic = false, requestingActor = null } = {}) {
    if (automatic && !this.autoImport) return publicJob(job);
    if (!this.projectIngest?.importDownload) return publicJob(job);
    if (job.state === 'imported') {
      if (job.importProjectId !== projectId) throw failure('BROWSER_DOWNLOAD_ALREADY_IMPORTED', 'Download is already in another project');
      return publicJob(job);
    }
    try {
      if (!await this.authorizeImport({ ...publicJob(job), actor: jobActor(job, requestingActor) })) {
        throw failure('BROWSER_DOWNLOAD_IMPORT_BLOCKED', 'Research import permission was revoked');
      }
      const bytes = await this.#readVerified(job);
      if (typeof fs.statfs === 'function') {
        const disk = await fs.statfs(this.root);
        if (Number(disk.bavail) * Number(disk.bsize) < this.freeSpaceReserve + bytes.length) {
          throw failure('BROWSER_DOWNLOAD_DISK_FULL', 'Not enough disk space to create the project copy');
        }
      }
      await this.#persist(job, { state: 'importing', importProjectId: projectId, error: undefined });
      const result = await this.projectIngest.importDownload({ projectId, download: publicJob(job), bytes, actor: jobActor(job, requestingActor),
        authorize: () => (!automatic || this.autoImport) && this.authorizeImport({ ...publicJob(job), actor: jobActor(job, requestingActor) }) });
      await this.#persist(job, { state: 'imported', importProjectId: projectId,
        fileId: result.file?.id ?? result.item?.fileId, projectItemId: result.item?.id,
        extractionStatus: result.extractionStatus ?? 'ready',
        ...(job.target.projectId ? {} : { inboxMovedAt: new Date().toISOString() }), error: undefined });
      this.#scheduleExtraction(job);
    } catch (error) {
      await this.#persist(job, { state: 'import-failed', error: safeError(error) });
    }
    return publicJob(job);
  }
  #scheduleExtraction(job) {
    if (!job.fileId || job.extractionStatus === 'ready' || !this.projectIngest?.extractDownload) return;
    const pending = (async () => {
      await this.#persist(job, { extractionStatus: 'running', extractionError: undefined });
      try {
        const result = await this.projectIngest.extractDownload({ projectId: job.importProjectId, fileId: job.fileId });
        await this.#persist(job, { extractionStatus: result?.file?.extractionStatus ?? 'ready', extractionError: undefined });
      } catch (error) {
        await this.#persist(job, { extractionStatus: 'failed', extractionError: safeError(error) });
      }
    })();
    this.#track(pending.catch(() => undefined));
  }

  async list(actor) {
    await this.ready;
    return [...this.jobs.values()].filter((job) => this.#allowed(job, actor)).map(publicJob).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  async awaitCompletion(downloadId) {
    await this.ready;
    this.#directory(downloadId);
    const live = this.active.get(downloadId);
    if (live?.done) await live.done;
    const job = this.jobs.get(downloadId);
    if (!job) throw failure('BROWSER_DOWNLOAD_NOT_FOUND', 'Download was not found');
    return publicJob(job);
  }
  async get({ downloadId, actor }) { await this.ready; return publicJob(this.#owned(downloadId, actor)); }
  async readBytes({ downloadId, actor }) {
    await this.ready;
    const job = this.#owned(downloadId, actor);
    if (!COMPLETE.has(job.state)) throw failure('BROWSER_DOWNLOAD_NOT_READY', 'Download bytes are not complete');
    return { bytes: await this.#readVerified(job), mimeType: job.mimeType, filename: job.filename, job: publicJob(job) };
  }
  async cancel({ downloadId, actor }) {
    await this.ready;
    const job = this.#owned(downloadId, actor), live = this.active.get(downloadId);
    if (!live || COMPLETE.has(job.state)) return publicJob(job);
    live.cancelled = true;
    live.failure = failure('BROWSER_DOWNLOAD_CANCELLED', 'Download was cancelled');
    live.abort();
    await this.#persist(job, { state: 'cancelled', error: undefined });
    live.stream?.destroy?.(live.failure);
    await live.download?.cancel?.().catch?.(() => undefined);
    return publicJob(job);
  }
  async retry({ downloadId, actor }) {
    await this.ready;
    const job = this.#owned(downloadId, actor);
    if (job.state === 'imported' && job.extractionStatus === 'failed') { this.#scheduleExtraction(job); return publicJob(job); }
    if (!COMPLETE.has(job.state)) {
      throw failure('BROWSER_DOWNLOAD_RETRY_SOURCE', 'Repeat the browser export to retry an interrupted transfer');
    }
    const projectId = job.importProjectId ?? job.target.projectId;
    return projectId ? this.#import(job, projectId, { requestingActor: actor }) : publicJob(job);
  }
  async importDownload({ downloadId, actor, projectId }) {
    await this.ready;
    const job = this.#owned(downloadId, actor);
    if (!COMPLETE.has(job.state)) throw failure('BROWSER_DOWNLOAD_NOT_READY', 'Download bytes are not complete');
    if (actor.isHuman !== true && projectId !== job.target.projectId) throw failure('BROWSER_DOWNLOAD_FORBIDDEN', 'Agent cannot redirect a captured download');
    if (!/^p[a-z2-7]{10}$/.test(String(projectId))) throw failure('PROJECT_INGEST_INVALID', 'Project ID is invalid');
    // 같은 다운로드의 이동/재시도는 직렬화한다. 다른 프로젝트 자료를 덮어쓰지 않는다.
    const pending = (this.importQueues.get(downloadId) ?? Promise.resolve()).catch(() => undefined).then(() => this.#import(job, projectId, { requestingActor: { ...actor } }));
    this.importQueues.set(downloadId, pending);
    pending.finally(() => { if (this.importQueues.get(downloadId) === pending) this.importQueues.delete(downloadId); }).catch(() => undefined);
    return this.#track(pending);
  }
  async downloadPublic({ actor, url, filename }) {
    const controller = new AbortController();
    let fetched, currentUrl = url;
    const capturedActor = { ...actor };
    const authorizeUrl = async (candidate) => {
      if (this.authorizeDownload && !await this.authorizeDownload({ actor: capturedActor, url: candidate, target: targetOf(capturedActor, capturedActor, this.ownerId) })) {
        throw failure('BROWSER_DOWNLOAD_FORBIDDEN', 'Download destination permission was revoked');
      }
      currentUrl = candidate;
      return true;
    };
    const download = { url: () => currentUrl, suggestedFilename: () => filename || fetched?.filename || 'download', cancel: async () => controller.abort(),
      createReadStream: async () => {
        fetched = await this.fetchPublicImpl(url, { maxBytes: this.maxBytes, timeoutMs: this.timeoutMs, signal: controller.signal, authorizeUrl });
        if (fetched.finalUrl) await authorizeUrl(fetched.finalUrl);
        return Readable.from([fetched.bytes]);
      } };
    const job = await this.handleBrowserDownload({ download, actor, tab: actor, pageUrl: url });
    await this.awaitCompletion(job.downloadId);
    const completed = await this.get({ downloadId: job.downloadId, actor });
    if (!COMPLETE.has(completed.state)) throw failure(completed.error?.code ?? 'DOWNLOAD_FAILED', 'Public download failed');
    return { ...completed, checksum: completed.sha256, source: completed.source.url,
      ...(completed.source.finalUrl ? { finalUrl: completed.source.finalUrl } : {}),
      mime: fetched?.mime ?? completed.mimeType };
  }
  async settle() { while (this.pending.size) await Promise.allSettled([...this.pending]); }
  async close() {
    this.closed = true;
    await this.ready;
    await this.allocating.catch(() => undefined);
    for (const [id, live] of this.active) {
      if (COMPLETE.has(this.jobs.get(id)?.state)) continue;
      live.interrupted = true; live.cancelled = true;
      live.failure = failure('BROWSER_DOWNLOAD_INTERRUPTED', 'Hub shut down during download');
      live.abort();
      live.stream?.destroy?.(live.failure);
      await live.download?.cancel?.().catch?.(() => undefined);
      await this.#persist(this.jobs.get(id), { state: 'interrupted', error: safeError(live.failure) });
    }
    await this.settle();
  }
}
