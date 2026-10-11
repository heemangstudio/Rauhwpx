import test from 'node:test';
import assert from 'node:assert/strict';
import { APP_PARTS, changedPaths, selectChecks } from './ci-changes.mjs';

// Selected check names, with app parts listed as `app:<part>`.
const selected = (files) => {
  const { app, ...jobs } = selectChecks(files);
  return [
    ...Object.entries(jobs).filter(([, on]) => on).map(([name]) => name),
    ...app.split(' ').filter(Boolean).map((part) => `app:${part}`),
  ].sort();
};
const everything = selected(['<full-check>']);

for (const [description, files, expected] of [
  ['notes, media and local tools', ['docs/releasing.md', 'promo/a.mp4', 'output/x.png', 'research/a.md', 'THIRD_PARTY_LICENSES.md', 'rhwp/pdf/a.pdf', 'rhwp/tools/compare.py', 'rhwp/rhwp-vscode/src/a.ts', 'build/entitlements.mac.plist'], []],
  ['publish docs and website', ['README.md', 'DESIGN.md', 'PRODUCT.md', 'rhwp/rhwp-agent/README.md', 'website/index.html'], ['docs']],
  ['engine source', ['rhwp/src/parser/hwp.rs'], ['browser', 'engine']],
  ['Cargo manifest', ['rhwp/Cargo.toml', 'rhwp/Cargo.lock'], ['browser', 'engine']],
  ['engine tests', ['rhwp/tests/issue_1.rs'], ['engine']],
  ['sample corpus', ['rhwp/samples/report.hwpx'], ['app:studio', 'browser', 'engine']],
  ['Studio UI', ['rhwp/rhwp-studio/src/ui/toolbar.ts'], ['app:studio', 'browser']],
  ['Studio agent bridge', ['rhwp/rhwp-studio/src/agent/tool-executor.ts'], ['app:hub', 'app:studio', 'browser']],
  ['Studio desktop tests', ['rhwp/rhwp-studio/tests/desktop-shell.test.ts'], ['app:studio', 'sessions']],
  ['npm editor package', ['rhwp/npm/editor/index.js'], ['app:studio']],
  ['owned browser runtime and permissions', ['rhwp/rhwp-agent/owned-browser-service.mjs', 'rhwp/rhwp-agent/browser-policy.mjs', 'rhwp/rhwp-agent/tests/owned-browser-runtime.test.mjs', 'rhwp/rhwp-agent/download-manager.mjs'], ['app:hub', 'app:studio', 'browser', 'sessions']],
  ['agent hub browser routing', ['rhwp/rhwp-agent/server.mjs'], ['app:hub', 'app:studio', 'browser', 'sessions']],
  ['MCP tool list', ['rhwp/rhwp-agent/tools.mjs'], ['app:hub', 'app:studio', 'browser', 'docs', 'sessions']],
  ['desktop browser host', ['desktop/browser-host.mjs', 'desktop/browser-guest-preload.cjs'], ['app:desktop', 'app:hub', 'app:studio', 'browser', 'sessions']],
  ['desktop shell', ['desktop/main.mjs', 'tests/desktop-file-replace.test.mjs'], ['app:desktop', 'app:hub', 'app:studio', 'sessions']],
  ['site service', ['site-api/server.mjs'], ['app:site']],
  ['extension', ['rhwp/rhwp-chrome/sw/fetch-security.mjs'], ['app:extensions']],
  ['shared fonts', ['rhwp/rhwp-shared/fonts/font-index-core.mjs'], ['app:desktop', 'app:extensions', 'app:hub', 'browser', 'sessions']],
]) {
  test(`change selection covers ${description}`, () => assert.deepEqual(selected(files), expected));
}

test('unknown paths and build or CI configuration run every check', () => {
  assert.equal(everything.length, 4 + APP_PARTS.length);
  for (const file of ['new-component/index.ts', '.github/workflows/checks.yml', 'scripts/ci-changes.mjs', 'package.json', 'package-lock.json', '.gitattributes']) {
    assert.deepEqual(selected([file]), everything, file);
  }
});

test('deletions and renamed code still select checks', () => {
  const event = { pull_request: { base: { sha: 'a'.repeat(40) }, head: { sha: 'b'.repeat(40) } } };
  const paths = changedPaths(event, (args) => {
    assert.deepEqual(args, ['diff', '--name-only', '--no-renames', '-z', 'a'.repeat(40), 'b'.repeat(40), '--']);
    return 'rhwp/src/removed.rs\0docs/removed.md\0';
  });
  assert.deepEqual(selected(paths), ['browser', 'engine']);
});

test('dispatch and new-branch events request full verification', () => {
  assert.deepEqual(selected(changedPaths({})), everything);
  assert.deepEqual(selected(changedPaths({ before: '0'.repeat(40), after: 'a'.repeat(40) })), everything);
  assert.throws(() => changedPaths({ before: '--unsafe', after: 'a'.repeat(40) }), /Invalid event commit SHA/);
});
