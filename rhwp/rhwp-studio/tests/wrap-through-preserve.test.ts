import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

import {
  readHwp16Input,
  readHwpunitInput,
} from '../src/ui/table-property-units.ts';
import { createTestModuleServer } from './support/module-server.ts';

// 속성 대화상자의 배치 버튼에는 core TextWrap 의 일부('Through', 표의 'Tight' 등)가 없다.
// 그런 개체의 속성창을 열고 아무것도 바꾸지 않은 채 확인만 눌러도 배치가 'Square' 로
// 조용히 바뀌어 저장되면 안 된다. 실제 대화상자 클래스로 채우기→확인을 돌려 본다.

const rootDir = fileURLToPath(new URL('..', import.meta.url));
let vite: Awaited<ReturnType<typeof createTestModuleServer>>;

before(async () => {
  vite = await createTestModuleServer(rootDir);
});

after(async () => {
  await vite?.close();
});

/** 대화상자가 build 단계에서 만드는 입력 요소 대용. 값과 class 상태만 기억한다. */
function field(): any {
  const classes = new Set<string>();
  return {
    value: '',
    checked: false,
    disabled: false,
    hidden: false,
    textContent: '',
    dataset: {},
    style: {},
    classList: {
      add: (name: string) => classes.add(name),
      remove: (name: string) => classes.delete(name),
      contains: (name: string) => classes.has(name),
      toggle: (name: string, force?: boolean) => {
        const on = force ?? !classes.has(name);
        if (on) classes.add(name); else classes.delete(name);
        return on;
      },
    },
    querySelector: () => null,
    querySelectorAll: () => [],
    appendChild: (child: unknown) => child,
    setAttribute() {},
    removeAttribute() {},
    focus() {},
    closest: () => null,
  };
}

/** 빌드되지 않은 대화상자. 비어 있는 DOM 요소 칸을 처음 읽을 때 field() 로 채운다. */
function withFakeDom<T extends object>(dialog: T): T {
  const target = dialog as Record<string | symbol, unknown>;
  return new Proxy(target, {
    get(obj, key, receiver) {
      const value = Reflect.get(obj, key, receiver);
      if (value !== undefined || typeof key !== 'string') return value;
      if (key.endsWith('Btns')) return (obj[key] = []);
      if (key.endsWith('Inputs')) return (obj[key] = new Proxy({}, { get: (map: any, name) => (map[name] ??= field()) }));
      return (obj[key] = field());
    },
  }) as T;
}

test('그림 속성창을 그대로 확인하면 Through 배치와 위치 오프셋을 바꾸지 않는다', async () => {
  const { PicturePropsDialog } = await vite.ssrLoadModule('/src/ui/picture-props-dialog.ts');
  const { buildPicturePropsPatch } = await vite.ssrLoadModule('/src/ui/picture-props-apply-model.ts');
  const dialog: any = withFakeDom(new PicturePropsDialog({}, { emit() {} }));
  dialog.wrapBtns = [field(), field(), field(), field(), field()];
  dialog.objectType = 'image';
  dialog.shapeProps = null;
  // group-box.hwp 의 가로선 실측 오프셋(표시 정밀도에서 반올림되는 값).
  dialog.props = {
    width: 2835, height: 5669, treatAsChar: false,
    vertRelTo: 'Page', vertAlign: 'Top', horzRelTo: 'Column', horzAlign: 'Left',
    vertOffset: 16620, horzOffset: 8554, textWrap: 'Through',
    restrictInPage: true, allowOverlap: false, sizeProtect: false, description: '',
  };

  dialog.populateFromProps();
  const patch = buildPicturePropsPatch('image', dialog.props, null, dialog.captureApplyForm());

  assert.equal('textWrap' in patch, false, `배치가 바뀌었다: ${patch.textWrap}`);
  assert.equal('horzOffset' in patch, false);
  assert.equal('vertOffset' in patch, false);
});

test('표 속성창을 그대로 확인하면 Tight 배치를 Square 로 덮어쓰지 않는다', async () => {
  const { TableCellPropsDialog } = await vite.ssrLoadModule('/src/ui/table-cell-props-dialog.ts');
  const sent: Array<Record<string, unknown>> = [];
  const wasm = {
    setCellProperties() {},
    setTableProperties: (_s: number, _p: number, _c: number, props: Record<string, unknown>) => sent.push(props),
  };
  const dialog: any = withFakeDom(new TableCellPropsDialog(
    wasm, { emit() {} }, { sec: 0, ppi: 0, ci: 0 }, 0, 'cell',
  ));
  dialog.wrapBtns = [field(), field(), field(), field()];
  // 셀 모드에는 테두리·배경 탭이 없다.
  dialog.borderCellSpacingInput = null;
  dialog.bgNoneRadio = null;
  dialog.bgColorRadio = null;
  dialog.services = null;
  dialog.cellProps = {
    width: 7200, height: 1000, paddingLeft: 141, paddingRight: 141, paddingTop: 141, paddingBottom: 141,
    verticalAlign: 'Center', textDirection: 0, protect: false,
  };
  dialog.tableProps = {
    textWrap: 'Tight', treatAsChar: false, vertRelTo: 'Para', vertAlign: 'Top', vertOffset: 0,
    horzRelTo: 'Column', horzAlign: 'Left', horzOffset: 0, restrictInPage: true, allowOverlap: false,
    keepWithAnchor: false, pageBreak: 0, repeatHeader: false, cellSpacing: 0,
    paddingLeft: 141, paddingRight: 141, paddingTop: 141, paddingBottom: 141,
    outerLeft: 0, outerRight: 0, outerTop: 0, outerBottom: 0, hasCaption: false,
  };

  dialog.populateFields();
  dialog.onConfirm();

  assert.equal(sent.length, 1);
  assert.equal(sent[0].textWrap, 'Tight');
});

test('0.1mm 표시값을 수정하지 않으면 표와 셀의 원본 HU를 보존한다', () => {
  assert.equal(readHwpunitInput({ value: '0.4' }, 123), 123);
  assert.equal(readHwp16Input({ value: '0.4' }, 123), 123);
  assert.equal(readHwpunitInput({ value: '0.5' }, 123), 142);
  assert.equal(readHwp16Input({ value: '0.5' }, 123), 142);
});
