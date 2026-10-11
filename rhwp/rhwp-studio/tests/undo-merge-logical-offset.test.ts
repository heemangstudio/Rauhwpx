import test from 'node:test';
import assert from 'node:assert/strict';

// 수식처럼 글자로 취급하는 개체가 있으면 텍스트 길이와 논리 길이가 다르다. 병합 캐럿과
// undo 분할은 논리 길이를 써야 개체를 빠뜨리지 않는다. 중첩 표 축 왕복은
// edit-history-commands.test.ts 가 실제 엔진으로 검증한다.

// 실제 명령에 서로 다른 텍스트/논리 길이를 주어 캐럿과 역연산을 함께 확인한다.
await import('./support/ts-transform-hooks.mjs');
const { registerHooks } = await import('node:module');
const resolver = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (/^\.{1,2}\//.test(specifier) && !/\.[a-z]+$/.test(specifier)) {
      return nextResolve(`${specifier}.ts`, context);
    }
    return nextResolve(specifier, context);
  },
});
const { MergeParagraphCommand, MergeParagraphInCellCommand } = await import('../src/engine/command.ts');
resolver.deregister();

test('본문 수식 뒤 병합 캐럿과 undo 분할은 같은 논리 경계를 쓴다', () => {
  const splits: unknown[][] = [];
  const wasm = {
    getParagraphLength: () => 3,
    getLogicalLength: () => 5,
    mergeParagraph: () => '{}',
    splitParagraph: (...args: unknown[]) => splits.push(args),
  };
  const command = new MergeParagraphCommand({ sectionIndex: 0, paragraphIndex: 1, charOffset: 0 });
  assert.equal(command.execute(wasm as any).charOffset, 5);
  command.undo(wasm as any);
  assert.equal(splits[0][2], 5);
});

for (const nested of [false, true]) {
  test(`${nested ? '중첩' : '일반'} 셀 수식 뒤 병합은 개체를 빠뜨리지 않고 복원한다`, () => {
    const path = [
      ...(nested ? [{ controlIndex: 2, cellIndex: 4, cellParaIndex: 7 }] : []),
      { controlIndex: 1, cellIndex: 3, cellParaIndex: 1 },
    ];
    const pos = { sectionIndex: 0, parentParaIndex: 5, paragraphIndex: 1, charOffset: 0,
      controlIndex: path[0].controlIndex, cellIndex: path[0].cellIndex,
      cellParaIndex: path[0].cellParaIndex, cellPath: path };
    let splitOffset: number | undefined;
    const wasm = {
      getCellParagraphLength: () => 3,
      getCellParagraphLengthByPath: () => 3,
      getCellLogicalLengthByPath: (_sec: number, _para: number, json: string) => {
        assert.equal(JSON.parse(json).at(-1).cellParaIndex, 0);
        return 5;
      },
      mergeParagraphInCell: () => '{}',
      mergeParagraphInCellByPath: () => '{}',
      splitParagraphInCell: (...args: any[]) => { splitOffset = args[5]; },
      splitParagraphInCellByPath: (...args: any[]) => { splitOffset = args[3]; },
    };
    const command = new MergeParagraphInCellCommand(pos);
    assert.equal(command.execute(wasm as any).charOffset, 5);
    assert.deepEqual(command.undo(wasm as any), pos);
    assert.equal(splitOffset, 5);
  });
}
