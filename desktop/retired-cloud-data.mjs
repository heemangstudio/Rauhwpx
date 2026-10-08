import { promises as fs } from 'node:fs';
import path from 'node:path';

/** Vault keys written by Cloud, boat.dev and Rau accounts in 2.0.10 and earlier. */
export const RETIRED_SECRET_KEYS = Object.freeze([
  'cloud.boat.account',
  'cloud.boat.setup',
  'cloud.profile',
  'cloud.refresh',
  'cloud.device',
  'cloud.server-mode',
  'cloud.pending-app-sandbox',
  'cloud.managed-device-id',
  'rhwp.account.session-token',
  'rhwp.rau.openrouter-api-key',
]);

/** Document copies from Cloud runs. They stay in `<userData>/cloud` for manual recovery. */
const KEPT_CLOUD_ENTRIES = new Set(['recovery', 'edit-drafts']);

async function removeRetiredCloudFiles(cloudDir) {
  let names;
  try {
    names = await fs.readdir(cloudDir);
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
  const removable = names.filter((name) => !KEPT_CLOUD_ENTRIES.has(name));
  if (removable.length === names.length) {
    await fs.rm(cloudDir, { recursive: true, force: true });
    return;
  }
  // The boat SSH key, known hosts and handoff records go; document copies stay.
  await Promise.all(removable.map((name) => (
    fs.rm(path.join(cloudDir, name), { recursive: true, force: true })
  )));
}

/**
 * Remove credentials and files left by the retired Cloud and account features.
 * Safe to run on every launch. Call it before the hub starts so the purge is
 * queued ahead of any hub secret request.
 */
export async function removeRetiredCloudData({ userDataDir, vault }) {
  const results = await Promise.allSettled([
    vault.purge(RETIRED_SECRET_KEYS),
    removeRetiredCloudFiles(path.join(userDataDir, 'cloud')),
  ]);
  const failure = results.find((result) => result.status === 'rejected');
  if (failure) throw failure.reason;
}
