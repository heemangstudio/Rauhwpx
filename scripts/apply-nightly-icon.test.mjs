import assert from 'node:assert/strict';
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  NIGHTLY_ICON_DIR,
  NIGHTLY_ICON_FILES,
  applyNightlyIcon,
  assertPackagedIcon,
  isNightlyVersion,
} from './apply-nightly-icon.mjs';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const NIGHTLY = '2.0.12-nightly.20261010.300045a';
const RELEASE = '2.0.12';

// A checkout with the real release icons and the committed nightly set.
function fixtureRoot(t, version) {
  const root = mkdtempSync(path.join(tmpdir(), 'nightly-icon-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version }));
  cpSync(path.join(ROOT, NIGHTLY_ICON_DIR), path.join(root, NIGHTLY_ICON_DIR), { recursive: true });
  for (const dest of Object.keys(NIGHTLY_ICON_FILES)) {
    mkdirSync(path.dirname(path.join(root, dest)), { recursive: true });
    copyFileSync(path.join(ROOT, dest), path.join(root, dest));
  }
  return root;
}

const read = (root, rel) => readFileSync(path.join(root, rel));

test('only nightly package versions count as nightly', () => {
  assert.equal(isNightlyVersion(NIGHTLY), true);
  assert.equal(isNightlyVersion('3.0.0-nightly'), true);
  for (const version of [RELEASE, '2.0.12-beta.1', '2.0.12-nightlyish', 'nightly', '', undefined]) {
    assert.equal(isNightlyVersion(version), false, String(version));
  }
});

test('a nightly version replaces every app and Studio icon with the nightly set', (t) => {
  const root = fixtureRoot(t, NIGHTLY);
  assert.deepEqual(applyNightlyIcon({ root }), Object.keys(NIGHTLY_ICON_FILES));
  for (const [dest, source] of Object.entries(NIGHTLY_ICON_FILES)) {
    assert.ok(read(root, dest).equals(read(root, path.join(NIGHTLY_ICON_DIR, source))), dest);
  }
  assertPackagedIcon({ root, version: NIGHTLY, favicon: read(root, 'rhwp/rhwp-studio/public/favicon.ico') });
});

test('a release version keeps the release icon', (t) => {
  const root = fixtureRoot(t, RELEASE);
  assert.deepEqual(applyNightlyIcon({ root }), []);
  for (const dest of Object.keys(NIGHTLY_ICON_FILES)) {
    assert.ok(read(root, dest).equals(read(ROOT, dest)), dest);
  }
  assertPackagedIcon({ root, version: RELEASE, favicon: read(root, 'rhwp/rhwp-studio/public/favicon.ico') });
});

test('a missing nightly file fails before any release icon is replaced', (t) => {
  const root = fixtureRoot(t, NIGHTLY);
  unlinkSync(path.join(root, NIGHTLY_ICON_DIR, 'icon-512.png'));
  assert.throws(() => applyNightlyIcon({ root }), /Nightly icon is missing/);
  for (const dest of Object.keys(NIGHTLY_ICON_FILES)) {
    assert.ok(read(root, dest).equals(read(ROOT, dest)), dest);
  }
});

test('package verification rejects a package whose icon does not match its version', () => {
  const releaseFavicon = read(ROOT, 'rhwp/rhwp-studio/public/favicon.ico');
  const nightlyFavicon = read(ROOT, path.join(NIGHTLY_ICON_DIR, 'icon.ico'));
  assert.throws(() => assertPackagedIcon({ version: NIGHTLY, favicon: releaseFavicon }), /without the nightly icon/);
  assert.throws(() => assertPackagedIcon({ version: RELEASE, favicon: nightlyFavicon }), /with the nightly icon/);
});

function pngSize(buffer) {
  assert.ok(buffer.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')), 'PNG signature');
  return [buffer.readUInt32BE(16), buffer.readUInt32BE(20)];
}

test('the committed nightly icon set is packaging-ready and differs from the release icon', () => {
  const dir = path.join(ROOT, NIGHTLY_ICON_DIR);
  assert.deepEqual(pngSize(readFileSync(path.join(dir, 'hamaeditor-nightly-master.png'))), [2048, 2048]);
  for (const size of [128, 192, 256, 512]) {
    assert.deepEqual(pngSize(readFileSync(path.join(dir, `icon-${size}.png`))), [size, size]);
  }

  // electron-builder and rcedit on Windows need 32-bpp PNG-compressed ICO entries.
  const ico = readFileSync(path.join(dir, 'icon.ico'));
  assert.deepEqual([ico.readUInt16LE(0), ico.readUInt16LE(2)], [0, 1]);
  const count = ico.readUInt16LE(4);
  assert.ok(count > 0);
  for (let i = 0; i < count; i += 1) {
    const entry = 6 + 16 * i;
    assert.equal(ico.readUInt16LE(entry + 6), 32, `ICO entry ${i} bit depth`);
    const offset = ico.readUInt32LE(entry + 12);
    pngSize(ico.subarray(offset, offset + ico.readUInt32LE(entry + 8)));
  }

  const icns = readFileSync(path.join(dir, 'icon.icns'));
  assert.equal(icns.subarray(0, 4).toString('latin1'), 'icns');
  assert.equal(icns.readUInt32BE(4), icns.length);

  for (const [dest, source] of Object.entries(NIGHTLY_ICON_FILES)) {
    assert.ok(!readFileSync(path.join(dir, source)).equals(read(ROOT, dest)), `${source} must differ from ${dest}`);
  }
});
