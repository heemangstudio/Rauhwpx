// Browser-side helpers for rebrand-storage-import.browser.test.ts. Every record is
// written by the real store modules; 2.0.11 data is then moved under the names
// 2.0.11 used, exactly as that release left it.
import { createEmptyThread, listThreads, removeThread, upsertThread, waitForThreadsPersistence } from '../../src/agent/threads.ts';
import { listAutosaveDrafts, listRecoverableAutosaveDrafts, saveAutosaveDraft } from '../../src/recovery/autosave-store.ts';
import { addRecentDoc, listRecentDocs } from '../../src/recent/recent-store.ts';
import { fingerprintBytes } from '../../src/versioning/hash.ts';
import { VersionGraphStore } from '../../src/versioning/store.ts';
import { documentId } from '../../src/versioning/types.ts';

const CANONICAL = ['rhwpAgentThreads', 'rhwpStudioAutosave', 'rhwpStudioRecent', 'rhwpStudioVersionGraph'];
const REBRANDED: Record<string, string> = {
  rhwpAgentThreads: 'hamaeditorAgentThreads',
  rhwpStudioAutosave: 'hamaeditorAutosave',
  rhwpStudioRecent: 'hamaeditorRecent',
  rhwpStudioVersionGraph: 'hamaeditorVersionGraph',
};

function request<T>(target: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    target.onsuccess = () => resolve(target.result);
    target.onerror = () => reject(target.error);
  });
}

function deleteDatabase(name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const deleting = indexedDB.deleteDatabase(name);
    deleting.onsuccess = () => resolve();
    deleting.onerror = () => reject(deleting.error);
    // A store module may still be closing its hydration connection; the delete then completes.
  });
}

export async function reset(): Promise<void> {
  localStorage.clear();
  for (const name of [...CANONICAL, ...Object.values(REBRANDED)]) await deleteDatabase(name);
}

export async function databaseNames(): Promise<string[]> {
  return (await indexedDB.databases()).map((entry) => entry.name ?? '').sort();
}

/** Move one database under another name with the same schema and rows. */
async function renameDatabase(from: string, to: string): Promise<void> {
  const source = await request(indexedDB.open(from));
  const stores = Array.from(source.objectStoreNames).map((name) => {
    const store = source.transaction(name, 'readonly').objectStore(name);
    return {
      name,
      keyPath: store.keyPath,
      autoIncrement: store.autoIncrement,
      indexes: Array.from(store.indexNames).map((indexName) => store.index(indexName)),
      rows: Promise.all([request(store.getAllKeys()), request(store.getAll())]),
    };
  });
  const rows = await Promise.all(stores.map((store) => store.rows));
  const version = source.version;
  source.close();
  const opening = indexedDB.open(to, version);
  opening.onupgradeneeded = () => {
    for (const store of stores) {
      const created = opening.result.createObjectStore(store.name, {
        ...(store.keyPath === null ? {} : { keyPath: store.keyPath }),
        autoIncrement: store.autoIncrement,
      });
      for (const index of store.indexes) {
        created.createIndex(index.name, index.keyPath, { unique: index.unique, multiEntry: index.multiEntry });
      }
    }
  };
  const target = await request(opening);
  for (const [position, store] of stores.entries()) {
    const tx = target.transaction(store.name, 'readwrite');
    const [keys, values] = rows[position];
    keys.forEach((key, index) => {
      if (store.keyPath === null) tx.objectStore(store.name).put(values[index], key);
      else tx.objectStore(store.name).put(values[index]);
    });
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }
  target.close();
  await deleteDatabase(from);
}

function snapshot(label: string) {
  return {
    meta: { name: label, sectionCount: 1, pageCount: 1 },
    paragraphs: [{
      section: 0,
      paragraph: 0,
      sectionPage: 1,
      globalIndex: 0,
      stableId: `stable-${label}`,
      text: label,
      normalizedText: label,
      controlCount: 0,
      signature: `signature-${label}`,
      isAnchorCandidate: true,
    }],
    controls: [],
  };
}

/** One chat, one unsaved draft, one recent file and one version history for `label`. */
export async function writeGeneration(label: string, docId: string): Promise<void> {
  const thread = createEmptyThread({ agent: 'claude', model: 'sonnet', effort: 'high' });
  thread.id = `thread-${label}`;
  thread.documentId = docId;
  thread.docKey = `${label}.hwpx`;
  thread.messages.push({ role: 'user', text: `chat from ${label}` });
  upsertThread(thread);
  await waitForThreadsPersistence();

  await saveAutosaveDraft({
    id: `draft-${label}`,
    fileName: `${label}.hwpx`,
    sourceFormat: 'hwpx',
    savedAt: Date.now(),
    byteLength: 3,
    data: new Uint8Array([7, 8, 9]),
    ownerLaunchId: `launch-${label}`,
    ownerSessionId: `session-${label}`,
  }, { locks: null });

  await addRecentDoc({ documentId: docId, sourceDigest: `sha256:${label}`, fileName: `${label}.hwpx`, sourceFormat: 'hwpx' });

  const store = new VersionGraphStore();
  const bytes = new TextEncoder().encode(`document ${label}`);
  await store.createRepository({
    documentId: documentId(docId),
    lastSavedFingerprint: fingerprintBytes(bytes),
    enabledAt: 1,
    initial: {
      bytes,
      compareSnapshot: snapshot(label),
      contentFingerprint: fingerprintBytes(bytes),
      title: `first version of ${label}`,
      titleRevision: 0,
      titleOrigin: 'manual',
      author: { kind: 'user', label: 'Tester' },
      stats: { added: 1, removed: 0, modified: 0 },
      createdAt: 1,
    },
  });
  await store.close();
}

/** Leave what was just written under the names 2.0.11 used. */
export async function moveToRebrandedNames(): Promise<void> {
  for (const name of CANONICAL) await renameDatabase(name, REBRANDED[name]);
}

export async function readCanonical() {
  // Threads hydrate from IndexedDB in the background after the module loads.
  const deadline = Date.now() + 3000;
  let threads = listThreads();
  while (threads.length < 2 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    threads = listThreads();
  }
  const store = new VersionGraphStore();
  const repositories: Record<string, number> = {};
  for (const docId of ['doc-2010', 'doc-2011', 'doc-2010-same-file']) {
    const repository = await store.findRepositoryByDocumentId(documentId(docId));
    if (repository) repositories[docId] = (await store.listCommits(repository.id)).length;
  }
  await store.close();
  return {
    threads: threads.map((thread) => ({ id: thread.id, documentId: thread.documentId })).sort((a, b) => a.id.localeCompare(b.id)),
    drafts: (await listAutosaveDrafts()).map((draft) => draft.id).sort(),
    recoverable: (await listRecoverableAutosaveDrafts({ locks: null })).map((draft) => draft.id).sort(),
    recent: (await listRecentDocs()).map((doc) => doc.documentId).sort(),
    repositories,
    settings: localStorage.getItem('rhwp-settings'),
    sidebarWidth: localStorage.getItem('rhwp-agent-sidebar-width-v3'),
    docOrder: JSON.parse(localStorage.getItem('rhwp-agent-doc-order') ?? '[]'),
  };
}

export async function removeImportedThread(): Promise<void> {
  listThreads();
  await waitForThreadsPersistence();
  removeThread('thread-2011');
  await waitForThreadsPersistence();
}

/** The autosave database as 2.0.7 and earlier left it: version 2, no metadata store. */
export async function writeVersion2Autosave(): Promise<void> {
  const opening = indexedDB.open('rhwpStudioAutosave', 2);
  opening.onupgradeneeded = () => {
    opening.result.createObjectStore('drafts', { keyPath: 'id' });
    opening.result.createObjectStore('sessions', { keyPath: 'sessionId' });
  };
  const db = await request(opening);
  const tx = db.transaction('drafts', 'readwrite');
  tx.objectStore('drafts').put({
    id: 'draft-2007',
    fileName: 'old.hwp',
    sourceFormat: 'hwp',
    savedAt: Date.now() - 1000,
    byteLength: 2,
    data: new Uint8Array([1, 2]).buffer,
  });
  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

/** Raise a 2.0.11 database to a version this build does not know, as a later release might. */
export async function bumpRebrandedVersion(name: string, version: number): Promise<void> {
  const db = await request(indexedDB.open(name, version));
  db.close();
}

export async function listDraftIds(): Promise<string[]> {
  return (await listAutosaveDrafts()).map((draft) => draft.id).sort();
}

export async function listRecentIds(): Promise<string[]> {
  return (await listRecentDocs()).map((doc) => doc.id).sort();
}

export async function deleteCanonicalThread(id: string): Promise<void> {
  const db = await request(indexedDB.open('rhwpAgentThreads'));
  const tx = db.transaction('threads', 'readwrite');
  tx.objectStore('threads').delete(id);
  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

export async function canonicalThreadIds(): Promise<string[]> {
  const db = await request(indexedDB.open('rhwpAgentThreads'));
  const ids = await request(db.transaction('threads').objectStore('threads').getAllKeys());
  db.close();
  return ids.map(String).sort();
}
