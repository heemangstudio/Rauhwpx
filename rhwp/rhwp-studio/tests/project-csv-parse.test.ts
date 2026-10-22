import test from 'node:test';
import assert from 'node:assert/strict';

import { cellsInRange, parseCsv, sniffDelimiter } from '../src/ui/agent-sidebar/project/csv-parse.ts';
import { csvDelimiterOf, textFormatOf } from '../src/ui/agent-sidebar/project/text-decode.ts';

const texts = (source: string, options = {}) => parseCsv(source, options).rows.map((row) => row.map((cell) => cell.text));

test('따옴표 안의 쉼표·줄바꿈·겹따옴표를 칸 글자로 두고 줄 끝 종류와 BOM 을 가리지 않는다', () => {
  const source = '﻿이름,금액,비고\r\n서울,"12,480","대기 2주,\n인력 부족"\r부산,5320,"""찾아가는 간호"" 포함"\n\n대구,3870\n';
  assert.deepEqual(texts(source), [
    ['이름', '금액', '비고'],
    ['서울', '12,480', '대기 2주,\n인력 부족'],
    ['부산', '5320', '"찾아가는 간호" 포함'],
    ['대구', '3870', ''],
  ]);
  const table = parseCsv(source);
  assert.equal(table.delimiter, ',');
  assert.equal(table.header, true);
  assert.deepEqual(table.numeric, [false, true, false]);
  assert.equal(table.truncated, false);
  assert.equal(table.tabular, true);
  // 칸 범위가 원문을 가리켜 인용 위치를 칸으로 옮길 수 있다.
  const quoted = table.rows[1][2];
  assert.equal(source.slice(quoted.start, quoted.end), '"대기 2주,\n인력 부족"');
  const at = source.indexOf('인력 부족');
  assert.deepEqual(cellsInRange(table, at, at + 5), [{ row: 1, column: 2 }]);
});

test('구분자는 따옴표를 지키며 칸 수가 가장 고른 쪽을 고른다', () => {
  assert.equal(sniffDelimiter('지역;금액;비고\n서울;"1,5";가, 나\n부산;2,3;다\n'), ';');
  assert.equal(sniffDelimiter('a\tb\tc\n1\t2,5\t3\n'), '\t');
  assert.equal(sniffDelimiter('x|y\n1|2\n'), '|');
  // `;` 파일은 유럽식 소수 쉼표를 숫자로 본다.
  const eu = parseCsv('Produkt;Preis;Menge\nA;1,50;2\nB;1.234,99;3\nC;3,75 €;10\n');
  assert.equal(eu.delimiter, ';');
  assert.deepEqual(eu.numeric, [false, true, true]);
  // 쉼표가 몇 개 섞인 줄글은 표가 아니다.
  const prose = parseCsv('오늘은 맑음, 바람 약함.\n내일은 비가 온다.\n모레는 흐리고, 춥고, 바람이 분다.\n');
  assert.equal(prose.tabular, false);
});

test('닫히지 않은 따옴표는 글자 그대로 읽고, 앞부분만 읽은 입력은 끊긴 행을 버린다', () => {
  assert.deepEqual(texts('a,b\n"열린 칸,끝\nc,d\n'), [['a', 'b'], ['"열린 칸', '끝'], ['c', 'd']]);
  assert.deepEqual(texts('a,b\n"x" y,z\n'), [['a', 'b'], ['"x" y', 'z']]);
  const prefix = parseCsv('a,b\n1,2\n3,"끊긴\n여러 줄', { partial: true });
  assert.deepEqual(prefix.rows.map((row) => row.map((cell) => cell.text)), [['a', 'b'], ['1', '2']]);
  assert.equal(prefix.truncated, true);
  const cutRow = parseCsv('a,b\n1,2\n3,4', { partial: true });
  assert.equal(cutRow.rows.length, 2);
});

test('들쭉날쭉한 행은 채우고, 행·열·글자 상한을 넘으면 잘렸다고 알린다', () => {
  const ragged = parseCsv('a,b,c\n1\n2,3,4,5\n');
  assert.equal(ragged.columns, 4);
  assert(ragged.rows.every((row) => row.length === 4));
  const many = Array.from({ length: 50 }, (_, index) => `${index},${index * 2}`).join('\n');
  const capped = parseCsv(many, { maxRows: 10 });
  assert.equal(capped.rows.length, 10);
  assert.equal(capped.truncated, true);
  assert.equal(parseCsv('a,b,c,d\n1,2,3,4\n', { maxColumns: 2 }).truncated, true);
  const chars = parseCsv(many, { maxChars: 20 });
  assert.equal(chars.truncated, true);
  assert(chars.rows.length < 10);
});

test('따옴표가 흩어진 큰 입력도 한 번 훑고 끝난다', () => {
  const hostile = `${'"a,'.repeat(200_000)}\n${'x,"y""'.repeat(100_000)}`;
  const started = performance.now();
  parseCsv(hostile, { maxRows: 5_000, maxChars: 5_000_000 });
  assert(performance.now() - started < 2_000);
});

test('이름과 MIME 으로 CSV·TSV 를 알아본다', () => {
  assert.equal(textFormatOf({ originalName: '현황.CSV' }), 'csv');
  assert.equal(textFormatOf({ title: '응답', mimeType: 'text/tab-separated-values' }), 'csv');
  assert.equal(textFormatOf({ originalName: 'notes.txt', mimeType: 'text/plain' }), 'plain');
  assert.equal(csvDelimiterOf({ originalName: '응답.tsv' }), '\t');
  assert.equal(csvDelimiterOf({ originalName: '현황.csv' }), undefined);
});
