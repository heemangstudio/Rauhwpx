// 문체 학습: 올린 파일 검사, 글 꺼내기, 48 KiB 안의 프롬프트, 파일 수로 합치기, 일 하나만·취소·오류.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  STYLE_LEARN_PROMPT_MAX_BYTES,
  createStyleLearner,
  extractStyleText,
  fitStyleLearnPrompt,
  mergeStyleFindings,
  parseStyleLearnOutput,
  rtfToText,
  sampleBudget,
  validateStyleUploads,
} from '../style-learning.mjs';
import { UserMemoryStore } from '../user-memory-store.mjs';

const b64 = (text) => Buffer.from(text, 'utf8').toString('base64');
const upload = (name, text) => ({ name, type: 'text/plain', size: Buffer.byteLength(text), content: b64(text) });
const rules = (...items) => JSON.stringify({ rules: items });
const ending = { kind: 'style', subject: '문체.종결', text: '본문은 한다체 사용' };

function tempDir(t, prefix = 'rhwp-style-learn-test-') {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function until(predicate, label, timeoutMs = 3_000) {
  const end = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > end) throw new Error(`timed out: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test('uploads are checked for count, type and size before anything runs', () => {
  const error = (files) => { try { validateStyleUploads(files); return null; } catch (caught) { return caught.code; } };
  assert.equal(error([]), 'INVALID_FILES');
  assert.equal(error(Array.from({ length: 21 }, (_, index) => upload(`${index}.txt`, 'a'))), 'INVALID_FILES');
  assert.equal(error([upload('a.exe', 'a')]), 'UNSUPPORTED_FILE');
  assert.equal(error([{ name: 'a.txt', content: '***' }]), 'INVALID_FILES');
  assert.equal(error([{ name: 'big.pdf', bytes: Buffer.alloc(20 * 1024 * 1024 + 1) }]), 'FILE_TOO_LARGE');
  assert.equal(error(Array.from({ length: 3 }, (_, index) => ({ name: `${index}.hwp`, bytes: Buffer.alloc(18 * 1024 * 1024) }))), 'FILES_TOO_LARGE');
  const checked = validateStyleUploads(['a.TXT', 'b.md', 'c.pdf', 'd.docx', 'e.rtf', 'f.html', 'g.htm', 'h.csv', 'i.hwp', 'j.hwpx'].map((name) => upload(name, '글')));
  assert.equal(checked.length, 10, 'one short file is enough; there is no page minimum');
  assert.equal(checked[0].extension, '.txt');
});

test('text comes out of plain, markup and RTF files locally; other formats go through the extractor from a temp file', async (t) => {
  const tempDirPath = tempDir(t);
  const [txt, html, rtf, hwp] = validateStyleUploads([
    upload('a.txt', '첫째 줄\r\n\r\n\r\n\r\n둘째 줄'),
    upload('b.html', '<p>본문은 <b>한다체</b>로 쓴다.</p><script>x()</script>'),
    upload('c.rtf', '{\\rtf1 \\b \\u54620?\\u45796? \\par 끝}'),
    { name: '보고서.hwp', bytes: Buffer.from('hwp bytes') },
  ]);
  assert.equal(await extractStyleText(txt, { tempDir: tempDirPath }), '첫째 줄\n\n둘째 줄');
  assert.match(await extractStyleText(html, { tempDir: tempDirPath }), /본문은 한다체\s?로 쓴다\./);
  assert.doesNotMatch(await extractStyleText(html, { tempDir: tempDirPath }), /x\(\)/);
  assert.match(rtfToText('{\\rtf1 \\u54620?\\u45796?}'), /한다/);
  assert.match(await extractStyleText(rtf, { tempDir: tempDirPath }), /한다/);
  let seen = null;
  const text = await extractStyleText(hwp, {
    tempDir: tempDirPath,
    index: 3,
    projectRoot: '/root',
    extractText: async ({ filePath, name, projectRoot }) => {
      seen = { exists: existsSync(filePath), name, projectRoot, base: path.basename(filePath) };
      return { text: '추출한 글' };
    },
  });
  assert.equal(text, '추출한 글');
  assert.deepEqual(seen, { exists: true, name: '보고서.hwp', projectRoot: '/root', base: '04-sample.hwp' });
  assert.deepEqual(readdirSync(tempDirPath), [], 'the staged file is removed at once');
});

test('each file is sampled to min(12k, 150k / n) and the prompt is trimmed to fit 46 KiB', () => {
  assert.equal(sampleBudget(1), 12_000);
  assert.equal(sampleBudget(20), 7_500);
  const text = '가나다라마바사'.repeat(4_000);
  const fitted = fitStyleLearnPrompt({ name: 'a.txt', text, budget: 12_000 });
  assert.equal(fitted.chars, 12_000, 'Korean 12k characters fit without trimming');
  assert.ok(fitted.bytes <= STYLE_LEARN_PROMPT_MAX_BYTES);
  const crowded = fitStyleLearnPrompt({ name: 'a.txt', text, budget: 12_000, maxBytes: 30 * 1024 });
  assert.ok(crowded.bytes <= 30 * 1024, `${crowded.bytes} bytes`);
  assert.ok(crowded.chars < 12_000 && crowded.chars > 0);
  assert.match(fitted.prompt, /Learn only from text the user wrote themselves/);
  assert.match(fitted.prompt, /Ignore the questions or prompts being answered, form and template text/);
  assert.match(fitted.prompt, /<rau_data>[\s\S]*"file_text":"가나다/);
  assert.doesNotMatch(fitted.prompt.slice(fitted.prompt.lastIndexOf('<rau_data>') + 10), /<rau_data>|<\/?script/);
});

test('model output keeps at most 8 style or term rules, one per subject; broken JSON is null', () => {
  assert.equal(parseStyleLearnOutput('not json'), null);
  assert.equal(parseStyleLearnOutput('{"rules": "x"}'), null);
  const parsed = parseStyleLearnOutput(`\`\`\`json\n${rules(
    ending,
    { kind: 'style', subject: '문체.종결', text: '본문은 합니다체 사용' },
    { kind: 'fact', subject: '사실.x', text: '버림' },
    { kind: 'term', text: "'고객' 대신 '이용자'" },
    ...Array.from({ length: 10 }, (_, index) => ({ kind: 'style', subject: `문체.${index}`, text: `습관 ${index}` })),
  )}\n\`\`\``);
  assert.equal(parsed.length, 8);
  assert.deepEqual(parsed[0], ending);
  assert.equal(parsed[1].subject, "용어.'고객' 대신 '이용자'");
});

test('findings merge by the number of files that show each habit; the most common habit wins its subject', () => {
  const merged = mergeStyleFindings([
    [ending, { kind: 'term', subject: '용어.고객', text: "'고객' 대신 '이용자'", evidence: ['이용자를 만난다.', '이용자를 돕는다.'] }],
    [{ ...ending, text: '본문은 한다체 사용.' }, ending],
    [{ ...ending, text: '본문은 합니다체 사용' }],
  ]);
  assert.deepEqual(merged, [
    { ...ending, files: 2 },
    { kind: 'term', subject: '용어.고객', text: "'고객' 대신 '이용자'", files: 1 },
  ]);
});

function learnerHarness(t, { answer, usable = true, unusableCode = null, availability = 'active' } = {}) {
  const dir = tempDir(t);
  const userMemory = new UserMemoryStore({ dir });
  const frames = [];
  const prompts = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const hosted = {
    usable: () => usable,
    unusableCode: () => unusableCode,
    cachedEligibility: () => availability,
    async learn(prompt) {
      prompts.push(prompt);
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      try {
        return await answer(prompt, prompts.length);
      } finally {
        inFlight -= 1;
      }
    },
  };
  const learner = createStyleLearner({
    hosted,
    userMemory,
    tempRoot: dir,
    emit: (frame) => frames.push(frame),
    retryMs: 10,
    extractText: async () => ({ text: '' }),
  });
  return { dir, userMemory, frames, prompts, learner, maxInFlight: () => maxInFlight };
}

test('a job reads every file, asks Rau two at a time, merges by file count and reports progress and the result', async (t) => {
  let rateLimited = false;
  const h = learnerHarness(t, {
    answer: async (prompt) => {
      await new Promise((resolve) => setTimeout(resolve, 15));
      if (prompt.includes('"file_name":"c.txt"') && !rateLimited) {
        rateLimited = true;
        return { ok: false, code: 'rate_limited' };
      }
      if (prompt.includes('"file_name":"d.txt"')) return { ok: true, text: '죄송합니다' };
      return { ok: true, text: rules({ ...ending, evidence: ['회의를 진행한다.', '결과를 기록한다.'] }, ...(prompt.includes('"file_name":"a.txt"') ? [{ kind: 'term', subject: '용어.고객', text: "'고객' 대신 '이용자'", evidence: ['이용자를 만난다.', '이용자를 돕는다.'] }] : [])) };
    },
  });
  await h.userMemory.escalate({ kind: 'style', subject: '문체.종결', text: '본문은 한다체 사용', docKeys: [] });
  const files = ['a.txt', 'b.txt', 'c.txt', 'd.txt'].map((name) => upload(name, `${name} 의 글. 회의를 진행한다. 결과를 기록한다. 이용자를 만난다. 이용자를 돕는다.`));
  files.push({ name: 'empty.hwp', bytes: Buffer.from('x') });
  const { jobId, done } = h.learner.start({ requestId: 'req-1', files });
  assert.throws(() => h.learner.start({ requestId: 'req-2', files }), { code: 'LEARN_BUSY' });
  assert.equal(h.learner.status().jobId, jobId);
  await done;
  assert.equal(h.learner.status(), null);
  assert.ok(h.maxInFlight() <= 2, 'at most two learn calls at once');
  assert.equal(h.prompts.filter((prompt) => prompt.includes('"file_name":"c.txt"')).length, 2, 'rate_limited is retried once');
  assert.ok(!h.prompts[0].includes('known_rules'));
  const stages = [...new Set(h.frames.filter((frame) => frame.type === 'style-learn-progress').map((frame) => frame.stage))];
  assert.deepEqual(stages, ['reading', 'extracting', 'merging']);
  assert.ok(h.frames.every((frame) => frame.v === 1 && (frame.jobId === jobId) && frame.requestId === 'req-1'));
  const extracting = h.frames.filter((frame) => frame.type === 'style-learn-progress' && frame.stage === 'extracting').at(-1);
  assert.deepEqual([extracting.completed, extracting.total], [4, 4]);
  assert.equal(extracting.found.length, 2);
  const result = h.frames.find((frame) => frame.type === 'style-learn-result');
  assert.deepEqual(result.summary.reinforced.map((item) => [item.subject, item.strength]), [['문체.종결', { from: 1, to: 4 }]]);
  assert.deepEqual(result.summary.new.map((item) => [item.subject, item.strength]), [['용어.고객', { from: 0, to: 1 }]]);
  assert.deepEqual(result.summary.skippedFiles.sort(), ['d.txt', 'empty.hwp']);
  assert.equal(result.memory.uploads[0].files.length, 5);
  assert.deepEqual(readdirSync(h.dir).filter((name) => name.startsWith('rhwp-style-learn-')), [], 'files are not kept');
});

test('plan, credit and availability answers abort the job; nothing readable is NO_TEXT; a blocked Rau never starts', async (t) => {
  for (const [code, expected] of [['rau_plan_required', 'RAU_PLAN_REQUIRED'], ['no_license', 'RAU_PLAN_REQUIRED'], ['rau_credits_exhausted', 'RAU_CREDITS_EXHAUSTED'], ['network', 'RAU_UNAVAILABLE']]) {
    const h = learnerHarness(t, { answer: async () => ({ ok: false, code }) });
    await h.learner.start({ requestId: code, files: [upload('a.txt', '글'), upload('b.txt', '글')] }).done;
    const error = h.frames.find((frame) => frame.type === 'style-learn-error');
    assert.equal(error?.code, expected, code);
    assert.equal(h.frames.some((frame) => frame.type === 'style-learn-result'), false);
    assert.deepEqual((await h.userMemory.read()).uploads, []);
  }
  const empty = learnerHarness(t, { answer: async () => ({ ok: true, text: rules(ending) }) });
  await empty.learner.start({ files: [upload('a.txt', '   '), { name: 'b.pdf', bytes: Buffer.from('%PDF') }] }).done;
  assert.equal(empty.frames.find((frame) => frame.type === 'style-learn-error').code, 'NO_TEXT');
  assert.equal(empty.prompts.length, 0);

  const blocked = learnerHarness(t, { usable: false, unusableCode: 'rau_plan_required', answer: async () => ({ ok: true, text: '{}' }) });
  assert.throws(() => blocked.learner.start({ files: [upload('a.txt', '글')] }), { code: 'RAU_PLAN_REQUIRED' });
  for (const [availability, code] of [['not_eligible', 'RAU_PLAN_REQUIRED'], ['exhausted', 'RAU_CREDITS_EXHAUSTED']]) {
    const known = learnerHarness(t, { availability, answer: async () => ({ ok: true, text: '{}' }) });
    assert.throws(() => known.learner.start({ files: [upload('a.txt', '글')] }), { code }, availability);
  }
  const offline = learnerHarness(t, { usable: false, unusableCode: 'unavailable', answer: async () => ({ ok: true, text: '{}' }) });
  assert.throws(() => offline.learner.start({ files: [upload('a.txt', '글')] }), { code: 'RAU_UNAVAILABLE' });
  assert.equal(offline.learner.busy(), false);
});

test('cancel stops a running job without waiting for the pending call, and the next job can start', async (t) => {
  let release;
  const h = learnerHarness(t, { answer: () => new Promise((resolve) => { release = () => resolve({ ok: true, text: rules(ending) }); }) });
  const { jobId, done } = h.learner.start({ requestId: 'r', files: [upload('a.txt', '글')] });
  await until(() => h.prompts.length === 1, 'learn call');
  assert.equal(h.learner.cancel('style_other'), false);
  assert.equal(h.learner.cancel(jobId), true);
  await done;
  assert.equal(h.frames.find((frame) => frame.type === 'style-learn-error').code, 'CANCELLED');
  release();
  assert.deepEqual((await h.userMemory.read()).rules, [], 'a cancelled job merges nothing');
  assert.equal(h.learner.busy(), false);
  h.learner.start({ files: [upload('b.txt', '글')] });
  assert.equal(h.learner.busy(), true);
  release();
});

test('uploads learn independently, reject invented evidence and never recount the same writing', async (t) => {
  const sample = '회의를 진행한다. 결과를 기록한다.';
  let invented = true;
  const h = learnerHarness(t, { answer: async () => ({ ok: true, text: rules({ ...ending, evidence: invented ? ['없는 인용문', '또 없는 인용문'] : ['회의를 진행한다.', '결과를 기록한다.'] }) }) });
  await h.userMemory.escalate({ ...ending, docKeys: [] });
  await h.learner.start({ files: [upload('first.txt', sample)] }).done;
  assert.equal((await h.userMemory.read()).rules[0].strength, 1, 'unsupported answers cannot reinforce memory');
  invented = false;
  await h.learner.start({ files: [upload('second.txt', sample)] }).done;
  assert.equal((await h.userMemory.read()).rules[0].strength, 2);
  await h.learner.start({ files: [upload('renamed.txt', sample)] }).done;
  assert.equal((await h.userMemory.read()).rules[0].strength, 2, 'renaming and reuploading are not independent evidence');
  assert.equal(h.prompts.length, 2, 'a successfully studied text is not billed again');
  for (const prompt of h.prompts) assert.ok(!prompt.includes(ending.text), 'existing rules cannot seed extraction');
});


test('evidence must be distinct, present in the sampled writing and non-overlapping', () => {
  const sample = '회의를 진행한다. 결과를 기록한다.';
  for (const evidence of [undefined, ['회의를 진행한다.', '회의를 진행한다.'], ['회의를 진행한다.', '진행한다.'], ['없는 문장이다.', '결과를 기록한다.']]) {
    assert.deepEqual(parseStyleLearnOutput(rules({ ...ending, evidence }), sample), []);
  }
  assert.deepEqual(parseStyleLearnOutput(rules({ ...ending, evidence: ['회의를 진행한다.', '결과를 기록한다.'] }), sample), [ending]);
});

test('contradictory writing weakens and eventually replaces memory even with a different subject name', async (t) => {
  let oldId;
  const h = learnerHarness(t, { answer: async (prompt) => prompt.includes('"task":"compare_style_findings"')
    ? { ok: true, text: JSON.stringify({ contradictions: [{ finding: 0, ruleId: oldId }] }) }
    : { ok: true, text: rules({ kind: 'style', subject: '말투.어미', text: '해체와 반말 종결 사용', evidence: ['창문을 열었어.', '바람이 들어왔지.'] }) } });
  oldId = (await h.userMemory.escalate({ ...ending, docKeys: [] })).rule.id;
  await h.userMemory.reinforce(oldId);
  for (const [index, expected] of [[1, 1], [2, 0]]) {
    await h.learner.start({ files: [upload(`${index}.txt`, `기록 ${index}. 창문을 열었어. 바람이 들어왔지.`)] }).done;
    const state = await h.userMemory.read();
    assert.equal(state.rules.find((rule) => rule.id === oldId)?.strength ?? 0, expected);
    const result = h.frames.filter((frame) => frame.type === 'style-learn-result').at(-1);
    assert.equal(result.summary.reinforced.length, 0);
    if (index === 1) assert.equal(result.summary.dampened.length, 1);
    else {
      assert.equal(result.summary.retired.length, 1);
      assert.equal(state.rules.find((rule) => rule.subject === ending.subject).text, '해체와 반말 종결 사용');
    }
  }
});

test('comparison preserves unrelated and user-authored memories and rejects invented matches', async (t) => {
  for (const scenario of ['unrelated', 'user', 'invalid']) {
    let oldId;
    const h = learnerHarness(t, { answer: async (prompt) => prompt.includes('"task":"compare_style_findings"')
      ? { ok: true, text: JSON.stringify({ contradictions: scenario === 'unrelated' ? [] : [{ finding: 0, ruleId: scenario === 'invalid' ? 'invented' : oldId }] }) }
      : { ok: true, text: rules({ kind: 'style', subject: '말투.어미', text: '해체 사용', evidence: ['창문을 열었어.', '바람이 들어왔지.'] }) } });
    const old = scenario === 'user'
      ? await h.userMemory.addUserRule(ending)
      : (await h.userMemory.escalate({ ...ending, docKeys: [] })).rule;
    oldId = old.id;
    await h.learner.start({ files: [upload('a.txt', '창문을 열었어. 바람이 들어왔지.')] }).done;
    const state = await h.userMemory.read();
    assert.equal(state.rules.find((rule) => rule.id === oldId).strength, old.strength, scenario);
    const result = h.frames.find((frame) => frame.type === 'style-learn-result');
    if (scenario === 'user') assert.equal(result.summary.conflicts.length, 1);
    if (scenario === 'invalid') assert.deepEqual(result.summary.skippedFiles, ['a.txt']);
    if (scenario === 'unrelated') assert.equal(result.summary.new.length, 1);
  }
});

test('cancelling the comparison leaves existing memory untouched', async (t) => {
  let comparing = false;
  let release;
  const h = learnerHarness(t, { answer: async (prompt) => {
    if (prompt.includes('"task":"compare_style_findings"')) {
      comparing = true;
      return new Promise((resolve) => { release = resolve; });
    }
    return { ok: true, text: rules({ kind: 'style', subject: '말투.어미', text: '해체 사용', evidence: ['창문을 열었어.', '바람이 들어왔지.'] }) };
  } });
  await h.userMemory.escalate({ ...ending, docKeys: [] });
  const before = await h.userMemory.read();
  const { jobId, done } = h.learner.start({ files: [upload('a.txt', '창문을 열었어. 바람이 들어왔지.')] });
  await until(() => comparing, 'comparison started');
  assert.equal(h.learner.cancel(jobId), true);
  await done;
  release({ ok: true, text: '{"contradictions":[]}' });
  assert.deepEqual(await h.userMemory.read(), before);
  assert.equal(h.frames.find((frame) => frame.type === 'style-learn-error').code, 'CANCELLED');
});
