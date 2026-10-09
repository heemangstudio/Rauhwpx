/**
 * 긴 답변의 Markdown 파싱·DOM 갱신 비용을 프로덕션 사이드바에서 계측한다.
 * 모델 호출 없이 샘플 답변을 64자씩 재생하며, 레이아웃·페인트 시간은 포함하지 않는다.
 *
 * 먼저 npm run dev:sidebar를 실행한다.
 * 실행: node bench/chat-stream-bench.mjs [--url=http://127.0.0.1:7715] [--json=out.json]
 */
import { writeFileSync } from 'node:fs';
import puppeteer from 'puppeteer-core';
import { browserExecutable, browserLaunchArgs } from '../tests/browser-support.ts';

const options = new Map(process.argv.slice(2).map(argument => {
  const separator = argument.indexOf('=');
  return [argument.slice(2, separator), argument.slice(separator + 1)];
}));
const url = options.get('url') ?? 'http://127.0.0.1:7715';
const paragraph = '문서 내용을 검토하고 표와 본문의 연결을 확인합니다. **중요한 내용**과 [참고 링크](https://example.com)를 표시합니다. ';
const workloads = {
  korean: `${paragraph.repeat(4)}\n\n`.repeat(100),
  mixed: Array.from({ length: 100 }, (_, index) => [
    `## 검토 ${index + 1}\n\n${paragraph.repeat(3)}\n\n`,
    index % 8 === 0 ? '```typescript\nconst message = "한글 문서 검토";\nconsole.log(message);\n```\n\n' : '',
    index % 10 === 0 ? '| 항목 | 결과 |\n| --- | --- |\n| 문단 | 확인 |\n| 표 | 확인 |\n\n' : '',
  ].join('')).join(''),
};
const browser = await puppeteer.launch({
  executablePath: browserExecutable(), headless: true, args: browserLaunchArgs(),
});
try {
  const page = await browser.newPage();
  await page.goto(url, { waitUntil: 'networkidle0' });
  await page.waitForFunction(() => window.sidebarPreview);
  const results = [];
  for (const [name, source] of Object.entries(workloads)) {
    const samples = await page.evaluate(async source => {
      const { renderChatMarkdown } = await import('/src/ui/agent-sidebar/chat-markdown.ts');
      const samples = [];
      for (let run = 0; run < 7; run++) {
        const target = document.createElement('div');
        target.className = 'ag-msg ag-msg-assistant';
        document.querySelector('.ag-messages').append(target);
        let scriptingMs = 0;
        let worstUpdateMs = 0;
        let updates = 0;
        for (let end = 64; end < source.length; end += 64) {
          const started = performance.now();
          renderChatMarkdown(target, source.slice(0, end), { streaming: true });
          const elapsed = performance.now() - started;
          scriptingMs += elapsed;
          worstUpdateMs = Math.max(worstUpdateMs, elapsed);
          updates++;
        }
        const started = performance.now();
        renderChatMarkdown(target, source);
        scriptingMs += performance.now() - started;
        target.remove();
        if (run > 0) samples.push({ scriptingMs, worstUpdateMs, updates });
      }
      return samples;
    }, source);
    const sorted = samples.map(sample => sample.scriptingMs).sort((a, b) => a - b);
    results.push({ name, characters: source.length,
      medianScriptingMs: (sorted[2] + sorted[3]) / 2, samples });
  }
  const report = { url, chunkCharacters: 64, results };
  if (options.has('json')) writeFileSync(options.get('json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser.close();
}
