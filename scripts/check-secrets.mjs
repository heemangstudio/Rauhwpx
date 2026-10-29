import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Fails when a tracked file holds a key-shaped literal: an OpenRouter key, an Anthropic API,
// OAuth or admin key, or an OpenAI-style `sk-` / `sk-proj-` key. Short fake test tokens such as
// `sk-ant-oat01-token` or `sk-or-v1-leak` stay below the lengths below. Tests that need a
// real-shaped key build it at runtime.
//   node scripts/check-secrets.mjs [repo dir]

// A key starts at a word boundary, so `task-...` or `desk-...` never match.
const START = '(?<![A-Za-z0-9_-])';
export const SECRET_PATTERNS = Object.freeze([
  { name: 'OpenRouter key', re: new RegExp(`${START}sk-or-v1-[A-Za-z0-9]{32,}`) },
  { name: 'Anthropic key', re: new RegExp(`${START}sk-ant-(?:api|oat|admin)\\d\\d-[A-Za-z0-9_-]{40,}`) },
  { name: 'OpenAI-style key', re: new RegExp(`${START}sk-(?!or-|ant-)(?:proj-)?[A-Za-z0-9_-]{32,}`) },
]);
// Cheap prefilter for git grep (POSIX ERE); the patterns above decide.
const PREFILTER = 'sk-(or-v1-|ant-|proj-)?[A-Za-z0-9_-]{32,}';

/** Every key-shaped literal in `text` as `{ name, match }`. */
export function findSecrets(text) {
  const found = [];
  for (const { name, re } of SECRET_PATTERNS) {
    const global = new RegExp(re.source, 'g');
    for (const m of String(text).matchAll(global)) found.push({ name, match: m[0] });
  }
  return found;
}

/** `{ file, line, name }` for every hit in the tracked files of `cwd`. Never returns the literal. */
export function scanRepository(cwd) {
  let output = '';
  try {
    output = execFileSync('git', ['grep', '-I', '-n', '-E', '-e', PREFILTER], { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  } catch (error) {
    if (error.status === 1) return []; // git grep found nothing
    throw error;
  }
  const hits = [];
  for (const row of output.split('\n')) {
    const match = /^(.*?):(\d+):(.*)$/.exec(row);
    if (!match) continue;
    for (const { name } of findSecrets(match[3])) hits.push({ file: match[1], line: Number(match[2]), name });
  }
  return hits;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const cwd = process.argv[2] ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const hits = scanRepository(cwd);
  if (hits.length) {
    for (const hit of hits) process.stderr.write(`${hit.file}:${hit.line}: ${hit.name}\n`);
    process.stderr.write(`${hits.length} key-shaped literal(s) in tracked files. Build test keys at runtime instead.\n`);
    process.exit(1);
  }
  process.stdout.write('No key-shaped literals in tracked files.\n');
}
