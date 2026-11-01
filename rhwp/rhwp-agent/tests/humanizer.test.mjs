import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { RHWP_SUBAGENTS, systemBriefFor } from '../agents/backend.mjs';
import { HUMANIZE_KOREAN_RULES, humanizerPromptBlock, isBuildPhase } from '../humanizer.mjs';
import { PlanningState, buildApprovedPlanPrompt } from '../planning-state.mjs';
import { SkillRegistry } from '../skills.mjs';

test('작문 트리거는 문서 쓰기가 열린 단계에서만 붙는다', () => {
  assert.equal(isBuildPhase('direct'), true);
  assert.equal(isBuildPhase('implementing'), true);
  assert.equal(isBuildPhase('switching'), true);
  assert.equal(isBuildPhase('planning'), false);
  assert.equal(isBuildPhase('awaiting-approval'), false);
  assert.equal(humanizerPromptBlock('planning'), '');
  assert.match(humanizerPromptBlock('direct'), /<humanize_korean_trigger>/);
  // 문서 글은 늘 한국어로 본다 — 영어 규율 경로는 없다.
  assert.doesNotMatch(humanizerPromptBlock('direct', { language: 'en' }), /english_writing_discipline/);
  assert.doesNotMatch(humanizerPromptBlock('direct'), /user_memory/);
  assert.match(humanizerPromptBlock('direct', { personalProfile: true }), /user_memory block holds the user's own 문체 rules/);
});

test('번들 humanize-korean 스킬이 카탈로그에 뜬다', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-humanizer-'));
  const registry = await new SkillRegistry({ bundledRoot: fileURLToPath(new URL('../skills', import.meta.url)), userRoot: path.join(root, 'user') }).init();
  const row = (await registry.catalog()).rows.find((item) => item.name === 'humanize-korean');
  assert.equal(row?.kind, 'skill');
  await fs.rm(root, { recursive: true, force: true });
});

test('promptContext 는 단계에 따라 규율을 켜고 끈다', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-humanizer-'));
  const registry = await new SkillRegistry({ bundledRoot: path.join(root, 'bundled'), userRoot: path.join(root, 'user') }).init();
  const build = await registry.promptContext('표를 요약해 줘', undefined, { phase: 'implementing' });
  const planning = await registry.promptContext('표를 요약해 줘', undefined, { phase: 'planning' });
  assert.match(build, /<humanize_korean_trigger>/);
  assert.doesNotMatch(planning, /<humanize_korean_trigger>/);
  // 기본값은 바로 실행 채팅이므로 규율이 켜져 있어야 한다.
  assert.match(await registry.promptContext('표를 요약해 줘'), /<humanize_korean_trigger>/);
  // 개인 문체는 기억(계정 단계)의 문체 규칙이 있을 때만 가리킨다. 예전 말투 블록은 없다.
  const personal = await registry.promptContext('표를 요약해 줘', undefined, { phase: 'implementing', personalProfile: true });
  assert.match(personal, /user_memory block holds the user's own 문체 rules/);
  assert.doesNotMatch(build, /user_memory block|personal_writing_style/);
  await fs.rm(root, { recursive: true, force: true });
});

test('승인된 계획 프롬프트도 규율을 함께 전달한다', () => {
  const state = new PlanningState({ workflow: 'plan', createPlanId: () => 'plan-1', now: () => '2026-01-01T00:00:00.000Z' });
  state.present({ title: '보고서 초안', steps: [{ title: '초안 작성', details: '보고서를 작성합니다.' }] });
  const approved = state.beginApproval({ planId: 'plan-1', sessionStatus: 'idle' });
  const prompt = buildApprovedPlanPrompt(approved.approvedPlan);
  assert.match(prompt, /<humanize_korean_trigger>/);
  assert.match(prompt, /Plan ID: plan-1/);
});
