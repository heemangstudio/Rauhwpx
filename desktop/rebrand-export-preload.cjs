// Runs only in the hidden window that reads a copy of the 2.0.11 profile on its
// hamaeditor://app origin. It dumps that origin's Studio storage in the format
// Studio's rebrand importer reads (src/core/rebrand-storage-import.ts).
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

async function dumpDatabase(name) {
  const db = await open(name);
  if (!db) return null;
  try {
    const stores = [];
    for (const storeName of Array.from(db.objectStoreNames)) {
      const store = db.transaction(storeName, 'readonly').objectStore(storeName);
      const [keys, values] = await Promise.all([request(store.getAllKeys()), request(store.getAll())]);
      stores.push({
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
        records: keys.map((key, position) => ({ key, value: values[position] })),
      });
    }
    return { name, version: db.version, stores };
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
  const listed = new Set((await indexedDB.databases()).map((database) => database.name));
  const databases = [];
  for (const name of DATABASES) {
    if (!listed.has(name)) continue;
    const database = await dumpDatabase(name);
    if (database) databases.push(database);
  }
  return { localStorage: entries, databases };
}

window.addEventListener('DOMContentLoaded', () => {
  dump().then(
    (result) => ipcRenderer.send('rebrand-export:result', result),
    (error) => ipcRenderer.send('rebrand-export:error', String(error?.message ?? error)),
  );
});
