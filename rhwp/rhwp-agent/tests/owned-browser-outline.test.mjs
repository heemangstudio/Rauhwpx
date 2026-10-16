import assert from 'node:assert/strict';
import test from 'node:test';
import { outlineFromAria, renderOutline } from '../owned-browser-outline.mjs';

// Playwright AI aria JSON과 같은 모양의 고정 입력. 브라우저 없이 개요 규칙을 확인한다.
const page = [{ role: 'generic', ref: 'e1', children: [
  { role: 'navigation', name: 'Primary', ref: 'e2', children: [{ role: 'list', ref: 'e3', children: [{ role: 'listitem', ref: 'e4', children: [{ role: 'link', name: 'Docs', ref: 'e5', cursor: 'pointer', url: '/docs' }] }] }] },
  { role: 'heading', name: 'Sign in', level: 1, ref: 'e6' },
  { role: 'generic', ref: 'e7', children: ['Email', { role: 'textbox', name: 'Email', ref: 'e8', text: 'person@example.com' }] },
  { role: 'textbox', name: 'Password', ref: 'e9', text: 'hunter2' },
  { role: 'button', name: 'Hidden', children: [] },
  { role: 'iframe', ref: 'e10', children: [{ role: 'textbox', name: 'Card number', ref: 'f1e2', text: '4111111111111111' }] },
  { role: 'paragraph', ref: 'e11', text: 'Welcome back' },
] }];

test('outline keeps refs on controls, masks private fields and drops frames and invisible controls', () => {
  const { outline, refs, truncated } = renderOutline(outlineFromAria(page, { masked: new Set(['e8', 'e9']) }));
  assert.equal(outline, [
    '- navigation "Primary" [ref=e2]',
    '  - link "Docs" [ref=e5]',
    '- heading "Sign in" [level=1]',
    '- textbox "Email" [ref=e8]: [masked]',
    '- textbox "Password" [ref=e9]: [masked]',
    '- paragraph: Welcome back',
  ].join('\n'));
  assert.equal(truncated, false);
  assert.deepEqual([...refs.keys()], ['e2', 'e5', 'e8', 'e9']);
  for (const secret of ['person@example.com', 'hunter2', '4111111111111111']) assert.equal(outline.includes(secret), false);
});

test('find keeps matching lines with their ancestors and scope keeps one subtree', () => {
  const nodes = outlineFromAria(page);
  const found = renderOutline(nodes, { find: 'docs' });
  assert.equal(found.outline, '- navigation "Primary" [ref=e2]\n  - link "Docs" [ref=e5]');
  assert.equal(found.matches, 1);
  assert.equal(renderOutline(nodes, { find: 'missing' }).matches, 0);
  assert.equal(renderOutline(nodes, { scope: 'e2' }).outline, '- navigation "Primary" [ref=e2]\n  - link "Docs" [ref=e5]');
  assert.equal(renderOutline(nodes, { scope: 'e404' }).scoped, false);
});

test('outline stops at the byte cap and long option lists stay short until scoped', () => {
  const links = Array.from({ length: 3000 }, (_, index) => ({ role: 'link', name: `Result ${index}`, ref: `e${index + 1}` }));
  const capped = renderOutline(outlineFromAria(links), { maxBytes: 20_000 });
  assert.equal(capped.truncated, true);
  assert.ok(Buffer.byteLength(capped.outline) <= 20_000);
  assert.equal(capped.refs.size, 3000);
  const select = [{ role: 'combobox', name: 'Country', ref: 'e1', children: Array.from({ length: 200 }, (_, index) => ({ role: 'option', name: `Country ${index}`, ...(index === 150 ? { selected: true } : {}) })) }];
  const short = renderOutline(outlineFromAria(select)).outline.split('\n');
  assert.equal(short[0], '- combobox "Country" [ref=e1]: Country 150');
  assert.equal(short.length, 22);
  assert.equal(short.at(-1), '  - text: +180 more options');
  assert.equal(renderOutline(outlineFromAria(select), { scope: 'e1' }).outline.split('\n').length, 201);
});

test('large menus fold into one line, while scope and find still reach every link', () => {
  const menu = [{ role: 'navigation', name: 'Main', ref: 'e1', children: Array.from({ length: 12 }, (_, index) => ({ role: 'link', name: `Section ${index}`, ref: `e${index + 2}` })) }, { role: 'link', name: 'Body link', ref: 'e99' }];
  const nodes = outlineFromAria(menu);
  assert.equal(renderOutline(nodes).outline, '- navigation "Main" [ref=e1]: +12 links\n- link "Body link" [ref=e99]');
  assert.equal(renderOutline(nodes, { scope: 'e1' }).outline.split('\n').length, 13);
  assert.equal(renderOutline(nodes, { find: 'section 11' }).outline, '- navigation "Main" [ref=e1]\n  - link "Section 11" [ref=e13]');
  assert.ok(renderOutline(nodes).refs.has('e13'));
});
