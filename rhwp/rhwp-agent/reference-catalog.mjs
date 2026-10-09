import path from 'node:path';

import { ReferenceStore, ReferenceStoreError, normalizeReferenceScope } from './reference-store.mjs';

/**
 * 표준 배치: references/ 는 옛 빌드와 같은 legacy 저장소, 프로젝트 파일은 projectsRoot/files,
 * 다시 추출한 글 캐시는 projectsRoot/text-cache 아래다(legacy 루트에는 새 파일을 두지 않는다).
 */
export function createReferenceCatalog({ referencesRoot, projectsRoot, projectRoot = null, logger = null, legacyOptions = {}, projectOptions = {} }) {
  return new ReferenceCatalog({
    legacy: new ReferenceStore({
      format: 'legacy',
      root: referencesRoot,
      projectRoot,
      textCacheDir: path.join(projectsRoot, 'text-cache', 'references'),
      logger,
      ...legacyOptions,
    }),
    projects: new ReferenceStore({
      format: 'project',
      root: path.join(projectsRoot, 'files'),
      projectRoot,
      textCacheDir: path.join(projectsRoot, 'text-cache', 'files'),
      logger,
      ...projectOptions,
    }),
    logger,
  });
}

/**
 * 참고 자료 저장소 두 개를 하나처럼 쓴다.
 * - legacy: references/ (채팅·문서·공용). 옛 빌드가 같은 폴더를 그대로 읽는다.
 * - projects: RHWP_PROJECTS_DIR/files (연구 프로젝트). 새 빌드만 쓴다.
 *
 * legacy 기록을 프로젝트로 옮길 때는 같은 id 로 복사(하드 링크)하고 legacy 쪽은 손대지 않는다.
 * 옮긴 id 는 프로젝트 저장소의 그림자 목록에 남아 여기서 legacy 쪽을 가린다. 그래서 옛 빌드로
 * 돌아가도 옛 자료가 그대로 보이고, 이주는 프로젝트 폴더 안에서만 일어난다.
 */
export class ReferenceCatalog {
  /** @param {{ legacy: import('./reference-store.mjs').ReferenceStore, projects: import('./reference-store.mjs').ReferenceStore, logger?: (line: string) => void }} options */
  constructor({ legacy, projects, logger = null }) {
    if (legacy?.format !== 'legacy' || projects?.format !== 'project') {
      throw new ReferenceStoreError('REFERENCE_CONFIG_INVALID', 'ReferenceCatalog needs a legacy store and a project store');
    }
    this.legacy = legacy;
    this.projects = projects;
    this.logger = logger;
  }

  async init() {
    await this.legacy.init();
    await this.projects.init();
    await this.#adoptInterim();
    return this;
  }

  /**
   * 잠시 쓰였던 v2 references/metadata.json 에 들어 있던 project 범위 기록을 프로젝트 저장소로 옮긴 뒤
   * legacy 를 v1 로 되돌린다. 하나라도 실패하면 legacy 는 그 기록을 계속 붙든다(파일을 지우지 않는다).
   */
  async #adoptInterim() {
    const interim = this.legacy.interimRecords();
    const aliases = this.legacy.interimAliases();
    if (interim.length === 0 && Object.keys(aliases).length === 0) return;
    try {
      for (const entry of interim) {
        await this.projects.importRecord({ ...entry, to: { scope: 'project', scopeId: entry.record.scopeId } });
      }
      await this.projects.addAliases(aliases);
      await this.legacy.releaseInterim();
      this.logger?.(`moved ${interim.length} project reference record(s) out of references/metadata.json`);
    } catch (error) {
      this.logger?.(`project reference records stay in references/ for now: ${error?.message ?? error}`);
    }
  }

  #storeFor(scope) {
    return scope === 'project' ? this.projects : this.legacy;
  }

  #visible(file) {
    return !this.projects.shadowedIds().has(file.id);
  }

  #split(scopes) {
    const normalized = (scopes ?? []).map((item) => normalizeReferenceScope(item.scope, item.scopeId));
    return {
      projects: normalized.filter((item) => item.scope === 'project'),
      legacy: normalized.filter((item) => item.scope !== 'project'),
    };
  }

  /** 읽기 대상 저장소. 프로젝트 저장소가 아는 id(별칭 포함)면 그쪽, 아니면 가려지지 않은 legacy. */
  #storeForFile(fileId) {
    if (this.projects.getFile(fileId)) return this.projects;
    if (this.projects.shadowedIds().has(String(fileId ?? ''))) {
      throw new ReferenceStoreError('REFERENCE_NOT_FOUND', 'Reference file is not available to this chat');
    }
    return this.legacy;
  }

  addStream(options) {
    return this.#storeFor(options?.scope).addStream(options);
  }

  addBuffer(options) {
    return this.#storeFor(options?.scope).addBuffer(options);
  }

  stageStream(options) {
    return this.legacy.stageStream(options);
  }

  getStaged(options) {
    return this.legacy.getStaged(options);
  }

  discardStaged(options) {
    return this.legacy.discardStaged(options);
  }

  /** 채팅 첨부를 채팅 범위로, 또는 to 가 프로젝트면 곧장 프로젝트 파일로 올린다. */
  promoteStaged({ stageId, scopeId, to = null }) {
    if (to?.scope !== 'project') return this.legacy.promoteStaged({ stageId, scopeId });
    const target = normalizeReferenceScope('project', to.scopeId);
    return this.legacy.transferStaged({
      stageId,
      scopeId,
      consume: ({ stream, name, mimeType, size }) => this.projects.addStream({
        stream, name, mimeType, contentLength: size, scope: target.scope, scopeId: target.scopeId,
      }),
    });
  }

  async cleanupStaged() {
    return (await this.legacy.cleanupStaged()) + (await this.projects.cleanupStaged());
  }

  list({ scope, scopeId }) {
    const files = this.#storeFor(scope).list({ scope, scopeId });
    return scope === 'project' ? files : files.filter((file) => this.#visible(file));
  }

  listAccessible(scopes) {
    const split = this.#split(scopes);
    return [
      ...(split.projects.length > 0 ? this.projects.listAccessible(split.projects) : []),
      ...(split.legacy.length > 0 ? this.legacy.listAccessible(split.legacy).filter((file) => this.#visible(file)) : []),
    ].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  listScopes(kind) {
    if (kind === 'project') return this.projects.listScopes('project');
    return this.legacy.listScopes(kind)
      .map((entry) => {
        const files = this.list(entry);
        return { ...entry, files: files.length, bytes: files.reduce((total, file) => total + file.size, 0) };
      })
      .filter((entry) => entry.files > 0);
  }

  getFile(fileId) {
    const project = this.projects.getFile(fileId);
    if (project) return project;
    if (this.projects.shadowedIds().has(String(fileId ?? ''))) return null;
    return this.legacy.getFile(fileId);
  }

  remove(options) {
    return this.#storeFor(options?.scope).remove(options);
  }

  removeScope(options) {
    return this.#storeFor(options?.scope).removeScope(options);
  }

  /**
   * 프로젝트로 옮긴다. 프로젝트 사이의 이동은 프로젝트 저장소 안에서 일어나고, legacy 기록은 같은 id 로
   * 복사돼 legacy 쪽을 가린다(legacy 의 metadata.json 은 그대로다).
   */
  async rescope({ fileId, to }) {
    const target = normalizeReferenceScope(to?.scope, to?.scopeId);
    if (target.scope !== 'project') {
      throw new ReferenceStoreError('REFERENCE_SCOPE_INVALID', 'References can only move into a project');
    }
    if (this.projects.getFile(fileId)) return this.projects.rescope({ fileId, to: target });
    if (this.projects.shadowedIds().has(String(fileId ?? ''))) {
      throw new ReferenceStoreError('REFERENCE_NOT_FOUND', 'Reference file was not found');
    }
    return this.projects.importRecord({ ...this.legacy.exportRecord(fileId), to: target });
  }

  async activateScopes(scopes) {
    const split = this.#split(scopes);
    const results = await Promise.all([
      split.projects.length > 0 ? this.projects.activateScopes(split.projects) : null,
      split.legacy.length > 0 ? this.legacy.activateScopes(split.legacy) : null,
    ]);
    return results.filter(Boolean).reduce((total, result) => ({
      indexedObjects: total.indexedObjects + result.indexedObjects,
      indexedChars: total.indexedChars + result.indexedChars,
      complete: total.complete && result.complete,
    }), { indexedObjects: 0, indexedChars: 0, complete: true });
  }

  retainScopes(scopes) {
    const split = this.#split(scopes);
    const releases = [
      split.projects.length > 0 ? this.projects.retainScopes(split.projects) : null,
      split.legacy.length > 0 ? this.legacy.retainScopes(split.legacy) : null,
    ].filter(Boolean);
    return () => { for (const release of releases) release(); };
  }

  unloadScopeIndexes(options) {
    return this.#storeFor(options?.scope).unloadScopeIndexes(options);
  }

  /** 두 저장소의 BM25 결과를 점수 순으로 합친다. 가려진 legacy 기록은 뺀다. */
  search({ query, scopes, maxResults = 8 }) {
    const split = this.#split(scopes);
    const limit = Math.min(20, Math.max(1, Number.isSafeInteger(maxResults) ? maxResults : 8));
    return [
      ...(split.projects.length > 0 ? this.projects.search({ query, scopes: split.projects, maxResults: limit }) : []),
      ...(split.legacy.length > 0
        ? this.legacy.search({ query, scopes: split.legacy, maxResults: limit }).filter((hit) => this.#visible({ id: hit.fileId }))
        : []),
    ].sort((left, right) => right.score - left.score).slice(0, limit);
  }

  readChunk(options) {
    return this.#storeForFile(options?.fileId).readChunk(options);
  }

  readImage(options) {
    return this.#storeForFile(options?.fileId).readImage(options);
  }

  openBlob(options) {
    return this.#storeForFile(options?.fileId).openBlob(options);
  }

  readPageText(options) {
    return this.#storeForFile(options?.fileId).readPageText(options);
  }

  /** 글자 층이 없는 쪽 (project_read item). 범위 검사 없이 기록을 따라간다. */
  textlessPages(fileId, options) {
    return this.#storeForFile(fileId).textlessPages(fileId, options);
  }

  storageUsage() {
    return { legacy: this.legacy.storageUsage(), projects: this.projects.storageUsage() };
  }

  async settleUpgrades() {
    await Promise.all([this.legacy.settleUpgrades(), this.projects.settleUpgrades()]);
  }
}
