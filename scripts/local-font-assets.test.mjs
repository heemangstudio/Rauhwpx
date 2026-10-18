import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rhwpLocalFontsPlugin } from '../rhwp/rhwp-studio/vite-plugin-local-fonts.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'hama-font-assets-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const studio = join(root, 'studio');
  const fonts = join(root, 'assets', 'fonts');
  mkdirSync(join(studio, 'public'), { recursive: true });
  mkdirSync(fonts, { recursive: true });
  writeFileSync(join(fonts, 'fixture.woff2'), Buffer.from([1, 2, 3]));
  writeFileSync(join(fonts, 'LICENSE.txt'), 'Not a font');
  return { studio, fonts };
}

test('font fallback replaces a copied Windows Git symlink placeholder with packaged fonts', (t) => {
  const { studio } = fixture(t);
  const placeholder = join(studio, 'public', 'fonts');
  writeFileSync(placeholder, '../../assets/fonts');
  cpSync(join(studio, 'public'), join(studio, 'dist'), { recursive: true });
  const plugin = rhwpLocalFontsPlugin(studio);
  plugin.closeBundle();
  assert.deepEqual(readFileSync(join(studio, 'dist', 'fonts', 'fixture.woff2')), Buffer.from([1, 2, 3]));
  assert.equal(readFileSync(placeholder, 'utf8'), '../../assets/fonts', 'build never rewrites the checkout');
  assert.throws(() => readFileSync(join(studio, 'dist', 'fonts', 'LICENSE.txt')), { code: 'ENOENT' });
  plugin.closeBundle();
  assert.deepEqual(readFileSync(join(studio, 'dist', 'fonts', 'fixture.woff2')), Buffer.from([1, 2, 3]));
});

test('font fallback creates missing output and preserves other generated fonts', (t) => {
  const { studio } = fixture(t);
  const plugin = rhwpLocalFontsPlugin(studio);
  plugin.closeBundle();
  writeFileSync(join(studio, 'dist', 'fonts', 'other.ttf'), 'other');
  plugin.closeBundle();
  assert.equal(readFileSync(join(studio, 'dist', 'fonts', 'other.ttf'), 'utf8'), 'other');
});

test('materialized public font directories keep Vite default copying', (t) => {
  const { studio } = fixture(t);
  mkdirSync(join(studio, 'public', 'fonts'));
  assert.equal(rhwpLocalFontsPlugin(studio).closeBundle, undefined);
});
