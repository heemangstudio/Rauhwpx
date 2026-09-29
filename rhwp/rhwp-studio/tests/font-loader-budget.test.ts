import assert from 'node:assert/strict';
import test from 'node:test';
import { loadWebFonts } from '../src/core/font-loader.ts';

// CDN 요청이 멈춰도(블랙홀·절전 복귀 뒤 반쯤 열린 연결) 앱 시작과 문서 열기가 멈추면 안 된다.
test('FontFace.load가 응답하지 않아도 loadWebFonts는 제한 시간 안에 끝나고 늦게 온 글꼴로 다시 그린다', { timeout: 5_000 }, async () => {
  const added: string[] = [];
  const constructed: string[] = [];
  const pendingLoads: Array<() => void> = [];
  const previousDocument = (globalThis as { document?: unknown }).document;
  const previousFontFace = (globalThis as { FontFace?: unknown }).FontFace;
  const styles: Array<{ id: string; textContent: string }> = [];

  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: {
      head: { appendChild(element: { id: string; textContent: string }) { styles.push(element); } },
      createElement() { return { id: '', textContent: '' }; },
      getElementById(id: string) { return styles.find(style => style.id === id) ?? null; },
      fonts: {
        check() { return false; },
        add(face: { family: string }) { added.push(face.family); },
      },
    },
  });
  Object.defineProperty(globalThis, 'FontFace', {
    configurable: true,
    value: class {
      family: string;
      constructor(family: string, source: string) {
        this.family = family;
        constructed.push(source);
      }
      load(): Promise<unknown> {
        // 테스트가 풀어 줄 때까지 응답하지 않는 네트워크.
        return new Promise((resolve) => pendingLoads.push(() => resolve(this)));
      }
    },
  });

  try {
    const lateFiles: string[][] = [];
    const progress: number[] = [];
    const started = Date.now();
    await loadWebFonts([], (loaded) => progress.push(loaded), {
      budgetMs: 30,
      onLateLoad: files => lateFiles.push(files),
    });
    assert.ok(Date.now() - started < 500, '응답 없는 글꼴 요청이 시작을 붙잡으면 안 된다');
    assert.ok(pendingLoads.length > 0, '글꼴 요청은 백그라운드에서 계속된다');
    assert.equal(added.length, 0);

    // 같은 파일을 다시 요청해도 새 FontFace 요청을 만들지 않는다.
    const constructedBefore = constructed.length;
    await loadWebFonts([], undefined, { budgetMs: 10 });
    assert.equal(constructed.length, constructedBefore);

    // 늦게 도착한 글꼴은 등록되고, 다시 그리기 알림은 파일마다 한 번이다.
    while (pendingLoads.length > 0) {
      pendingLoads.shift()!();
      await new Promise(resolve => setTimeout(resolve, 0));
    }
    assert.ok(added.length > 0);
    const notified = lateFiles.flat();
    assert.ok(notified.length > 0);
    assert.equal(new Set(notified).size, notified.length, '같은 파일을 두 번 알리지 않는다');
    assert.deepEqual(progress, [], '제한 시간이 지난 뒤에는 로딩 진행률을 덮어쓰지 않는다');

    // 이미 받은 파일은 다시 요청하지 않는다.
    const constructedAfter = constructed.length;
    await loadWebFonts([], undefined, { budgetMs: 10 });
    assert.equal(constructed.length, constructedAfter);
  } finally {
    Object.defineProperty(globalThis, 'document', { configurable: true, value: previousDocument });
    Object.defineProperty(globalThis, 'FontFace', { configurable: true, value: previousFontFace });
  }
});
