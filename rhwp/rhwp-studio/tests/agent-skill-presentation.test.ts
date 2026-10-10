import assert from 'node:assert/strict';
import test from 'node:test';

import {
  skillGlyphForName,
  skillGlyphForSkill,
} from '../src/ui/agent-sidebar/skill-presentation.ts';

test('document-writing skills use the pencil glyph', () => {
  for (const name of ['draft-document', 'proofread-korean', 'rewrite-tone']) {
    assert.equal(skillGlyphForName(name), 'pencil');
  }
});

test('internal and primarily read-only skills use the minimal bot glyph', () => {
  for (const name of ['skill-creator', 'summarize-document']) {
    assert.equal(skillGlyphForName(name), 'bot');
  }
});

test('other skills use the familiar system gear', () => {
  for (const name of ['present-plan', 'my-custom-skill']) {
    assert.equal(skillGlyphForName(name), 'system');
  }
});

test('every uncategorized skill receives the system gear', () => {
  assert.equal(skillGlyphForName('future-bundled-skill'), 'system');
  assert.equal(skillGlyphForName('disabled-custom-skill'), 'system');
});

test('explicit creator icon choices override name-based defaults', () => {
  assert.equal(skillGlyphForSkill({ name: 'draft-document', icon: 'bot' }), 'bot');
  assert.equal(skillGlyphForSkill({ name: 'skill-creator', icon: 'pencil' }), 'pencil');
  assert.equal(skillGlyphForSkill({ name: 'my-skill', icon: 'system' }), 'system');
});
