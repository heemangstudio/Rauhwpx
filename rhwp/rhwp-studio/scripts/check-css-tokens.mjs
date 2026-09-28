#!/usr/bin/env node
// 에이전트 UI 스타일시트에 직접 적은 색(hex·rgb·hsl)을 찾는다.
// 색은 토큰(--n-* → --ui-* → --ag-*)에서만 온다. 예외는 세 가지다.
//   1. src/styles/base.css (이 검사 범위 밖)
//   2. agent-sidebar.css 의 토큰 블록(아래 TOKEN_BLOCKS 선택자)의 사용자 정의 속성
//   3. 같은 줄에 /* token-ok */ 주석이 있는 선언
// mask 계열 속성의 색은 알파만 뜻하므로 세지 않는다.
// 사용: node scripts/check-css-tokens.mjs [--summary]
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const studioRoot = fileURLToPath(new URL('..', import.meta.url));
const scanRoot = join(studioRoot, 'src/ui/agent-sidebar');

const TOKEN_BLOCKS = new Map([
  [
    'agent-sidebar.css',
    new Set([':root, .ag-root', '.ag-root', ":root[data-theme-effective='dark'] .ag-root"]),
  ],
]);

const COLOR_RE = /#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?)\(/g;

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...walk(path));
    else if (name.endsWith('.css')) out.push(path);
  }
  return out;
}

// 주석·문자열·url() 안의 글자를 같은 길이의 공백으로 지워 위치(줄 번호)를 보존한다.
function blank(text) {
  return text.replace(/[^\n]/g, ' ');
}

function scrub(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, blank)
    .replace(/"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'/g, (m) => m[0] + blank(m.slice(1, -1)) + m[0])
    .replace(/url\([^)]*\)/g, blank);
}

function lineOf(src, index) {
  let line = 1;
  for (let i = 0; i < index; i++) if (src.charCodeAt(i) === 10) line++;
  return line;
}

function check(file) {
  const raw = readFileSync(file, 'utf8');
  const rawLines = raw.split('\n');
  const src = scrub(raw);
  const allowed = TOKEN_BLOCKS.get(relative(scanRoot, file)) ?? new Set();
  const violations = [];
  const stack = [];
  let start = 0;

  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (ch === '{') {
      // 선택자는 주석만 지운 원문에서 읽는다(속성 선택자의 따옴표를 살린다).
      const selector = raw.slice(start, i).replace(/\/\*[\s\S]*?\*\//g, '');
      stack.push(selector.trim().replace(/\s+/g, ' ').replace(/\s*,\s*/g, ', '));
      start = i + 1;
    } else if (ch === '}' || ch === ';') {
      const decl = src.slice(start, i);
      const selector = stack.at(-1) ?? '';
      const prop = decl.trim().split(':')[0].trim();
      const inTokenBlock = allowed.has(selector) && prop.startsWith('--');
      // 마스크 그라디언트의 색은 알파만 뜻한다.
      const isMask = /^(-webkit-)?mask/.test(prop);
      if (!inTokenBlock && !isMask) {
        for (const m of decl.matchAll(COLOR_RE)) {
          const line = lineOf(src, start + m.index);
          if (rawLines[line - 1].includes('/* token-ok */')) continue;
          violations.push({ line, text: rawLines[line - 1].trim() });
        }
      }
      if (ch === '}') stack.pop();
      start = i + 1;
    }
  }
  return violations;
}

const summaryOnly = process.argv.includes('--summary');
let total = 0;
const rows = [];
for (const file of walk(scanRoot).sort()) {
  const v = check(file);
  if (!v.length) continue;
  total += v.length;
  const rel = relative(studioRoot, file);
  rows.push([rel, v.length]);
  if (!summaryOnly) for (const { line, text } of v) console.log(`${rel}:${line}  ${text}`);
}

if (total === 0) {
  console.log('check-css-tokens: 직접 적은 색이 없습니다.');
  process.exit(0);
}
console.log('');
for (const [rel, n] of rows.sort((a, b) => b[1] - a[1])) console.log(`${String(n).padStart(5)}  ${rel}`);
console.log(`${String(total).padStart(5)}  합계 — 토큰을 쓰거나, 꼭 필요하면 줄 끝에 /* token-ok */ 를 붙입니다.`);
process.exit(1);
