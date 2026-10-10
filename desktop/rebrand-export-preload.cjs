// Runs only in the hidden windows that read a copy of the 2.0.11 profile on its
// hamaeditor://app origin. Each window reads one part, named by the page query:
// `?part=index` sends Local Storage and the list of Studio databases, and
// `?part=database&name=<name>` sends one database. A database that crashes or
// fails its reader therefore never takes the others down. Studio's rebrand
// importer reassembles the chunks (src/core/rebrand-storage-import.ts).
const { ipcRenderer } = require('electron');

// Font folder handles cannot cross IPC; the user picks the folder again.
const DATABASES = [
  'hamaeditorAgentThreads',
  'hamaeditorDocHistory',
  'hamaeditorRecent',
  'hamaeditorAutosave',
  'hamaeditorVersionGraph',
];

// One IPC message stays well below Chromium's message size limit.
const MAX_CHUNK_BYTES = 8 * 1024 * 1024;
const MAX_CHUNK_RECORDS = 500;
// A single record this large cannot cross IPC safely. It is reported and skipped.
const MAX_RECORD_BYTES = 64 * 1024 * 1024;

function request(target) {
  return new Promise((resolve, reject) => {
    target.onsuccess = () => resolve(target.result);
    target.onerror = () => reject(target.error);
  });
}

function open(name) {
  return new Promise((resolve, reject) => {
    let created = false;
    const opening = indexedDB.open(name);
    opening.onupgradeneeded = () => {
      created = true;
      opening.transaction.abort();
    };
    opening.onsuccess = () => resolve(opening.result);
    opening.onerror = () => (created ? resolve(null) : reject(opening.error));
  });
}

function copyKeyPath(keyPath) {
  return Array.isArray(keyPath) ? [...keyPath] : keyPath;
}

function approximateBytes(value, depth = 0) {
  if (value === null || value === undefined) return 1;
  if (typeof value === 'string') return value.length * 2;
  if (typeof value !== 'object') return 8;
  if (value instanceof ArrayBuffer) return value.byteLength;
  if (ArrayBuffer.isView(value)) return value.byteLength;
  if (depth > 32) return 64;
  let total = 16;
  for (const key of Object.keys(value)) total += key.length * 2 + approximateBytes(value[key], depth + 1);
  return total;
}

function send(chunk) {
  ipcRenderer.send('rebrand-export:chunk', chunk);
}

function describe(error) {
  return String(error?.message ?? error);
}

function skip(database, store, key, reason) {
  send({ kind: 'skipped', database, store, key, reason });
}

/** Sends a batch; a batch that cannot be sent is retried record by record. */
function sendRecords(database, store, records) {
  try {
    send({ kind: 'records', database, store, records });
  } catch {
    for (const record of records) {
      try {
        send({ kind: 'records', database, store, records: [record] });
      } catch (error) {
        skip(database, store, record.key, describe(error));
      }
    }
  }
}

/** Reads a store with a cursor so only one batch of records is held at a time. */
function sendStore(db, database, storeName) {
  return new Promise((resolve, reject) => {
    const cursorRequest = db.transaction(storeName, 'readonly').objectStore(storeName).openCursor();
    let batch = [];
    let bytes = 0;
    const flush = () => {
      if (batch.length) sendRecords(database, storeName, batch);
      batch = [];
      bytes = 0;
    };
    cursorRequest.onerror = () => reject(cursorRequest.error);
    cursorRequest.onsuccess = () => {
      const cursor = cursorRequest.result;
      if (!cursor) {
        flush();
        resolve();
        return;
      }
      try {
        const record = { key: cursor.primaryKey, value: cursor.value };
        const size = approximateBytes(record);
        if (size > MAX_RECORD_BYTES) {
          skip(database, storeName, record.key, `record of about ${size} bytes is too large to move`);
        } else {
          if (batch.length && (bytes + size > MAX_CHUNK_BYTES || batch.length >= MAX_CHUNK_RECORDS)) flush();
          batch.push(record);
          bytes += size;
        }
        cursor.continue();
      } catch (error) {
        reject(error);
      }
    };
  });
}

async function sendDatabase(name) {
  const db = await open(name);
  if (!db) return;
  try {
    const stores = Array.from(db.objectStoreNames).map((storeName) => {
      const store = db.transaction(storeName, 'readonly').objectStore(storeName);
      return {
        name: storeName,
        keyPath: copyKeyPath(store.keyPath),
        autoIncrement: store.autoIncrement,
        indexes: Array.from(store.indexNames).map((indexName) => {
          const index = store.index(indexName);
          return {
            name: indexName,
            keyPath: copyKeyPath(index.keyPath),
            unique: index.unique,
            multiEntry: index.multiEntry,
          };
        }),
      };
    });
    send({ kind: 'database', name, version: db.version, stores });
    for (const { name: storeName } of stores) {
      try {
        await sendStore(db, name, storeName);
      } catch (error) {
        // Records already sent stay usable; this store is retried on a later launch.
        send({ kind: 'error', database: name, store: storeName, message: describe(error) });
      }
    }
  } finally {
    db.close();
  }
}

async function sendIndex() {
  const entries = [];
  for (let index = 0; index < localStorage.length; index += 1) {
    const key = localStorage.key(index);
    const value = key === null ? null : localStorage.getItem(key);
    if (value !== null) entries.push([key, value]);
  }
  send({ kind: 'localStorage', entries });
  const listed = new Set((await indexedDB.databases()).map((database) => database.name));
  send({ kind: 'index', databases: DATABASES.filter((name) => listed.has(name)) });
}

async function run() {
  const query = new URLSearchParams(location.search);
  if (query.get('part') === 'database') {
    const name = query.get('name');
    if (!DATABASES.includes(name)) throw new Error(`unknown 2.0.11 database ${name}`);
    await sendDatabase(name);
  } else {
    await sendIndex();
  }
}

window.addEventListener('DOMContentLoaded', () => {
  run().then(
    () => ipcRenderer.send('rebrand-export:done'),
    (error) => ipcRenderer.send('rebrand-export:error', describe(error)),
  );
});
