import fs from 'node:fs/promises';
import path from 'node:path';

function failure(message) {
  return Object.assign(new Error(message), { code: 'BROWSER_CLEANUP_FAILED' });
}

/** Called only after the owner has stopped browser processes and checkpoint writers. */
export async function removeOwnedBrowserState({ dataDir } = {}) {
  if (typeof dataDir !== 'string' || !path.isAbsolute(dataDir)) throw failure('Browser cleanup requires the configured owner directory.');
  const root = await fs.lstat(dataDir);
  if (!root.isDirectory() || root.isSymbolicLink()
    || (process.platform !== 'win32' && root.uid !== process.getuid())) {
    throw failure('Browser cleanup requires an owner-controlled directory.');
  }
  const markerPath = path.join(dataDir, 'browser-policy.json');
  const marker = await fs.lstat(markerPath);
  if (!marker.isFile() || marker.isSymbolicLink() || marker.size > 1024 * 1024) throw failure('Browser ownership metadata is unavailable.');
  const policy = JSON.parse(await fs.readFile(markerPath, 'utf8'));
  if (!policy || policy.schema !== 1 || typeof policy.ownerId !== 'string' || !Array.isArray(policy.accounts)) throw failure('Browser ownership metadata is invalid.');

  const browserRoot = path.join(dataDir, 'browser');
  let info;
  try { info = await fs.lstat(browserRoot); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (info) {
    if (!info.isDirectory() || info.isSymbolicLink()
      || (process.platform !== 'win32' && info.uid !== process.getuid())) throw failure('Browser profile storage is not owned by this app.');
    // Keep installed Chromium and runtime configuration. Only these fixed paths
    // hold profile, history, unfinished transfer, or tab restoration data.
    const entries = [];
    const tabPartials = (await fs.readdir(browserRoot)).filter((name) => /^tabs\.json\.[a-f0-9]{16}\.part$/.test(name));
    for (const name of ['profile', 'native-profile', 'transfers', 'tabs.json', ...tabPartials]) {
      const location = path.join(browserRoot, name);
      let entry;
      try { entry = await fs.lstat(location); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (!entry) continue;
      if (entry.isSymbolicLink() || (name.startsWith('tabs.json') ? !entry.isFile() : !entry.isDirectory())
        || (process.platform !== 'win32' && entry.uid !== process.getuid())) throw failure('Browser profile storage is not owned by this app.');
      entries.push(location);
    }
    for (const location of entries) {
      try { await fs.rm(location, { recursive: true, maxRetries: 3, retryDelay: 100 }); }
      catch { throw failure('Close the browser and retry clearing its stored profile.'); }
    }
  }
  return { cleared: true, preserved: ['downloads', 'projects', 'provider-credentials', 'site-permissions'] };
}
