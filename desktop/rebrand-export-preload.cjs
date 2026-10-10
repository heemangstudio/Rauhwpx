// Runs only in the hidden window that reads a copy of the 2.0.11 profile on its
// hamaeditor://app origin. It sends that origin's Studio storage as chunks that
// Studio's rebrand importer reassembles (src/core/rebrand-storage-import.ts).
const { ipcRenderer } = require('electron');

// Font folder handles cannot cross IPC; the user picks the folder again.
const DATABASES = [
  'hamaeditorAgentThreads',
  'hamaeditorDocHistory',
  'hamaeditorRecent',
  'hamaeditorAutosave',
  'hamaeditorVersionGraph',
];

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

// One IPC message stays well below Chromium's message size limit.
const MAX_CHUNK_BYTES = 8 * 1024 * 1024;
const MAX_CHUNK_RECORDS = 500;

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
      const store = db.transaction(storeName, 'readonly').objectStore(storeName);
      const [keys, values] = await Promise.all([request(store.getAllKeys()), request(store.getAll())]);
      let batch = [];
      let bytes = 0;
      for (let position = 0; position < keys.length; position += 1) {
        const record = { key: keys[position], value: values[position] };
        const size = approximateBytes(record);
        if (batch.length && (bytes + size > MAX_CHUNK_BYTES || batch.length >= MAX_CHUNK_RECORDS)) {
          send({ kind: 'records', database: name, store: storeName, records: batch });
          batch = [];
          bytes = 0;
        }
        batch.push(record);
        bytes += size;
      }
      if (batch.length) send({ kind: 'records', database: name, store: storeName, records: batch });
    }
  } finally {
    db.close();
  }
}

async function dump() {
  const entries = [];
  for (let index = 0; index < localStorage.length; index += 1) {
    const key = localStorage.key(index);
    const value = key === null ? null : localStorage.getItem(key);
    if (value !== null) entries.push([key, value]);
  }
  send({ kind: 'localStorage', entries });
  const listed = new Set((await indexedDB.databases()).map((database) => database.name));
  for (const name of DATABASES) {
    if (listed.has(name)) await sendDatabase(name);
  }
}

window.addEventListener('DOMContentLoaded', () => {
  dump().then(
    () => ipcRenderer.send('rebrand-export:done'),
    (error) => ipcRenderer.send('rebrand-export:error', String(error?.message ?? error)),
  );
});
