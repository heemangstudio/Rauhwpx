import { appendFileSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Checks a path can select. `app` is one job whose steps run per part.
export const APP_PARTS = ['studio', 'hub', 'desktop', 'site', 'extensions'];
const JOBS = ['engine', 'browser', 'sessions', 'docs'];
const ALL = [...JOBS, ...APP_PARTS];

// First matching rule wins. A path no rule matches runs every check, so new
// directories and CI/build configuration (.github, scripts, root package files) fail safe.
const RULES = [
  // Not read by any build or test.
  [/^(?:docs|research|promo|output|build|\.audit|\.claude|\.impeccable|\.commandcode)\//, []],
  [/^rhwp\/(?:docs|pdf|pdf-large|bindings|typescript|rhwp-vscode)\//, []],
  [/^rhwp\/tools\/(?!rhwp-subsecond\/)/, []],
  [/(?:^|\/)(?:LICENSE[^/]*|THIRD_PARTY_LICENSES\.md|CHANGELOG\.md|SECURITY\.md)$/, []],
  // Publish docs, website and the tool list the docs must not hardcode.
  [/(?:^|\/)(?:README[^/]*|CONTRIBUTING|AGENTS|CLAUDE|DESIGN|PRODUCT|PRIVACY|DEVELOPER_GUIDE)\.md$/, ['docs']],
  [/^website\/|^scripts\/check-publish-docs/, ['docs']],
  [/^rhwp\/rhwp-agent\/tools\.mjs$/, ['docs', 'hub', 'studio', 'sessions']],
  // Engine: WASM inputs rebuild rhwp/pkg for the browser job; fixtures are also read by Studio tests.
  [/^rhwp\/(?:src\/|Cargo\.(?:toml|lock)$|rust-toolchain\.toml$|build\.rs$|\.cargo\/)/, ['engine', 'browser']],
  [/^rhwp\/(?:samples|saved|ttfs|assets)\//, ['engine', 'browser', 'studio']],
  [/^rhwp\/(?:tests|fuzz|\.config|tools\/rhwp-subsecond)\/|^rhwp\/rustfmt\.toml$/, ['engine']],
  // Hub tests read Studio's tool executor; Studio tests import hub modules.
  [/^rhwp\/rhwp-studio\/src\/agent\//, ['studio', 'hub', 'browser']],
  [/^rhwp\/rhwp-studio\/tests\/desktop-/, ['studio', 'sessions']],
  [/^rhwp\/rhwp-studio\//, ['studio', 'browser']],
  // Studio `npm test` runs the npm/editor tests and e2e:check reads rhwp/scripts.
  [/^rhwp\/(?:npm|scripts)\//, ['studio']],
  [/^rhwp\/rhwp-agent\//, ['hub', 'studio', 'sessions']],
  // Root tests, packaging script tests, Studio desktop-* tests and the hub all import desktop modules.
  [/^(?:desktop|tests)\//, ['desktop', 'studio', 'hub', 'sessions']],
  [/^site-api\//, ['site']],
  // The desktop and hub font index uses rhwp-shared/fonts.
  [/^rhwp\/rhwp-shared\/fonts\//, ['extensions', 'browser', 'desktop', 'hub', 'sessions']],
  [/^rhwp\/rhwp-shared\//, ['extensions', 'browser']],
  [/^rhwp\/rhwp-(?:chrome|firefox|safari)\//, ['extensions']],
];

export function selectChecks(paths) {
  const selected = new Set();
  for (const file of paths) {
    const rule = RULES.find(([pattern]) => pattern.test(file));
    for (const name of rule ? rule[1] : ALL) selected.add(name);
  }
  return {
    ...Object.fromEntries(JOBS.map((name) => [name, selected.has(name)])),
    app: APP_PARTS.filter((part) => selected.has(part)).join(' '),
  };
}

export function changedPaths(event, git = (args) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })) {
  const base = event.pull_request?.base.sha ?? event.before;
  const head = event.pull_request?.head.sha ?? event.after;
  if (!head || !base || /^0+$/.test(base)) return ['<full-check>'];
  if (![base, head].every((sha) => /^[0-9a-f]{40,64}$/.test(sha))) throw new Error('Invalid event commit SHA');
  // Disable rename detection so moving code into a docs directory still checks its deletion.
  return git(['diff', '--name-only', '--no-renames', '-z', base, head, '--']).split('\0').filter(Boolean);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const paths = process.env.GITHUB_EVENT_PATH
    ? changedPaths(JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8')))
    : process.argv.slice(2);
  const checks = selectChecks(paths);
  for (const [name, value] of Object.entries(checks)) {
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
  }
  console.log(checks);
}
