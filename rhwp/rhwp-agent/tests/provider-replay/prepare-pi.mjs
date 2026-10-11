/**
 * Prepare an `RHWP_PI_DIR` whose Pi is a replay of a fixture, for
 * fixture-backed live checks of the real hub and Studio:
 *
 *   node rhwp/rhwp-agent/tests/provider-replay/prepare-pi.mjs pi/credits-402 [dir]
 *   RHWP_PI_DIR=<printed dir> npm run dev:studio
 *
 * Then pick Pi / mock-model in the sidebar. Each process script in the bundle
 * answers one Pi turn; a turn beyond them fails (the replay CLI exits 97).
 * What each replay process saw is written next to the launcher as
 * `<dir>/prefix/node_modules/.bin/pi-replay.ndjson.result-<n>.json`.
 * Label such checks fixture-backed: the provider is not real.
 */
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { prepareFakePi } from '../hub-harness.mjs';
import { providerReplayFixture } from './replay.mjs';
import { installReplayCli } from './replay-cli.mjs';

/** Lay out a configured Pi under `root` that replays `fixture`. */
export function preparePiReplayDir(fixture, root = mkdtempSync(path.join(os.tmpdir(), 'rhwp-pi-replay-'))) {
  const bundlePath = fixture.endsWith('.ndjson') ? path.resolve(fixture) : providerReplayFixture(fixture);
  const { binDir } = prepareFakePi(root, null);
  const cli = installReplayCli(binDir, 'pi', bundlePath);
  return { root, binDir, cli };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [fixture, dir] = process.argv.slice(2);
  if (!fixture) {
    process.stderr.write('usage: prepare-pi.mjs <fixture, e.g. pi/credits-402> [RHWP_PI_DIR]\n');
    process.exit(2);
  }
  const { root, cli } = preparePiReplayDir(fixture, dir ? path.resolve(dir) : undefined);
  process.stdout.write(`RHWP_PI_DIR=${root}\n`);
  process.stderr.write(`replay results: ${path.dirname(cli.bundlePath)}\n`);
}
