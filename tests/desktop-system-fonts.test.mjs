import assert from 'node:assert/strict';
import { promises as fsPromises } from 'node:fs';
import { chmod, mkdtemp, mkdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  NODE_WEB_FONT_DECODERS,
  createSystemFontService,
  decodeHancomText,
  defaultFontRoots,
  extractCollectionFace,
  parseHancomFontList,
  parseSfntFaces,
} from '../desktop/system-fonts.mjs';
import {
  blobSource,
  compactSfntFace,
  decodeWebFont,
  extractCollectionFace as extractCollectionFaceCore,
  parseFontSource,
} from '../rhwp/rhwp-shared/fonts/font-index-core.mjs';
import { brotliCompressSync, deflateSync } from 'node:zlib';
import { expandFontRootCatalog } from '../rhwp/rhwp-shared/fonts/font-roots.mjs';
import { serveSystemFont, systemFontBaseUrl } from '../desktop/studio-protocol.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NOTO = path.join(repoRoot, 'rhwp/ttfs/opensource/NotoSansKR-Regular.ttf');
const VARIABLE = path.join(repoRoot, 'rhwp/tests/fixtures/fonts/RHWPVariableWeightFixture.ttf');
// rhwp/scripts/generate_web_font_fixtures.py 로 만든다. WOFF2 는 glyf·loca·hmtx 변환을 쓴다.
const WEB_FIXTURES = path.join(repoRoot, 'tests/fixtures/fonts');
const WEB_TTF = path.join(WEB_FIXTURES, 'NotoSansKRWebFixture.ttf');

function readTables(font) {
  const numTables = font.readUInt16BE(4);
  const tables = new Map();
  for (let i = 0; i < numTables; i += 1) {
    const base = 12 + i * 16;
    const tag = font.toString('latin1', base, base + 4);
    const offset = font.readUInt32BE(base + 8);
    const length = font.readUInt32BE(base + 12);
    tables.set(tag, font.subarray(offset, offset + length));
  }
  return tables;
}

function checksum(bytes) {
  const padded = Buffer.alloc((bytes.length + 3) & ~3);
  bytes.copy(padded);
  let sum = 0;
  for (let i = 0; i < padded.length; i += 4) sum = (sum + padded.readUInt32BE(i)) >>> 0;
  return sum;
}

function nameTable(records) {
  const strings = [];
  let stringLength = 0;
  const header = Buffer.alloc(6 + records.length * 12);
  header.writeUInt16BE(0, 0);
  header.writeUInt16BE(records.length, 2);
  header.writeUInt16BE(header.length, 4);
  records.forEach(([platformId, encodingId, languageId, nameId, bytes], i) => {
    const base = 6 + i * 12;
    header.writeUInt16BE(platformId, base);
    header.writeUInt16BE(encodingId, base + 2);
    header.writeUInt16BE(languageId, base + 4);
    header.writeUInt16BE(nameId, base + 6);
    header.writeUInt16BE(bytes.length, base + 8);
    header.writeUInt16BE(stringLength, base + 10);
    strings.push(bytes);
    stringLength += bytes.length;
  });
  return Buffer.concat([header, ...strings]);
}

function utf16be(text) {
  const bytes = Buffer.from(text, 'utf16le');
  for (let i = 0; i < bytes.length; i += 2) [bytes[i], bytes[i + 1]] = [bytes[i + 1], bytes[i]];
  return bytes;
}

/** 두 면이 name 외 모든 테이블을 공유하는 TTC 를 만든다. */
function buildCollection(sfntVersion, faceTables) {
  const blobs = new Map();
  const chunks = [];
  const headerLength = 12 + faceTables.length * 4;
  const directoryLengths = faceTables.map((tables) => 12 + tables.size * 16);
  let cursor = headerLength + directoryLengths.reduce((a, b) => a + b, 0);
  for (const tables of faceTables) {
    for (const data of tables.values()) {
      if (blobs.has(data)) continue;
      blobs.set(data, cursor);
      const padded = Buffer.alloc((data.length + 3) & ~3);
      data.copy(padded);
      chunks.push(padded);
      cursor += padded.length;
    }
  }
  const header = Buffer.alloc(headerLength);
  header.write('ttcf', 0, 'latin1');
  header.writeUInt32BE(0x00010000, 4);
  header.writeUInt32BE(faceTables.length, 8);
  const directories = [];
  let directoryAt = headerLength;
  faceTables.forEach((tables, faceIndex) => {
    header.writeUInt32BE(directoryAt, 12 + faceIndex * 4);
    const directory = Buffer.alloc(directoryLengths[faceIndex]);
    directory.writeUInt32BE(sfntVersion, 0);
    directory.writeUInt16BE(tables.size, 4);
    [...tables.keys()].sort().forEach((tag, i) => {
      const data = tables.get(tag);
      const base = 12 + i * 16;
      directory.write(tag, base, 'latin1');
      directory.writeUInt32BE(checksum(data), base + 4);
      directory.writeUInt32BE(blobs.get(data), base + 8);
      directory.writeUInt32BE(data.length, base + 12);
    });
    directories.push(directory);
    directoryAt += directory.length;
  });
  return Buffer.concat([header, ...directories, ...chunks]);
}

async function koreanCollection() {
  const noto = await readFile(NOTO);
  const tables = readTables(noto);
  const koreanTables = new Map(tables);
  koreanTables.set('name', nameTable([
    [1, 3, 23, 1, Buffer.from([0xc7, 0xd1, 0xb1, 0xdb])], // Mac 한국어 EUC-KR "한글"
    [3, 1, 0x409, 1, utf16be('Rau Batang')],
    [3, 1, 0x409, 2, utf16be('Regular')],
    [3, 1, 0x409, 4, utf16be('Rau Batang Regular')],
    [3, 1, 0x409, 6, utf16be('RauBatang-Regular')],
    [3, 1, 0x412, 1, utf16be('라우바탕')],
    [3, 1, 0x412, 4, utf16be('라우바탕 보통')],
  ]));
  return { noto, collection: buildCollection(noto.readUInt32BE(0), [tables, koreanTables]) };
}

test('parses family, weight and coverage from a real TrueType font', async () => {
  const { collection, faces } = await parseSfntFaces(await readFile(NOTO));
  assert.equal(collection, false);
  assert.equal(faces.length, 1);
  const [face] = faces;
  assert.equal(face.format, 'ttf');
  assert.deepEqual(face.families, ['Noto Sans KR']);
  assert.ok(face.postscriptNames.includes('NotoSansKR-Regular'));
  assert.equal(face.weight, 400);
  assert.equal(face.hangul, true);
  assert.equal(face.latin, true);
  assert.equal(face.italic, false);
});

test('keeps Korean names from Windows and Mac name records in a collection', async () => {
  const { collection } = await koreanCollection();
  const { collection: isCollection, faces } = await parseSfntFaces(collection);
  assert.equal(isCollection, true);
  assert.equal(faces.length, 2);
  assert.deepEqual(faces[0].families, ['Noto Sans KR']);
  assert.deepEqual(faces[1].families, ['Rau Batang', '한글', '라우바탕']);
  assert.deepEqual(faces[1].koreanNames, ['한글', '라우바탕', '라우바탕 보통']);
  assert.equal(faces[1].hangul, true);
});

test('extracts a collection face into a standalone font with valid checksums', async () => {
  const { noto, collection } = await koreanCollection();
  const extracted = await extractCollectionFace(collection, 1);
  assert.equal(extracted.readUInt32BE(0), noto.readUInt32BE(0));
  const { collection: isCollection, faces } = await parseSfntFaces(extracted);
  assert.equal(isCollection, false);
  assert.deepEqual(faces[0].families, ['Rau Batang', '한글', '라우바탕']);
  assert.equal(checksum(extracted), 0xb1b0afba);
  const numTables = extracted.readUInt16BE(4);
  for (let i = 0; i < numTables; i += 1) {
    const base = 12 + i * 16;
    const tag = extracted.toString('latin1', base, base + 4);
    const offset = extracted.readUInt32BE(base + 8);
    const data = Buffer.from(extracted.subarray(offset, offset + extracted.readUInt32BE(base + 12)));
    if (tag === 'head') data.writeUInt32BE(0, 8);
    assert.equal(offset % 4, 0, `${tag} offset is aligned`);
    assert.equal(extracted.readUInt32BE(base + 4), checksum(data), `${tag} checksum`);
  }
  await assert.rejects(extractCollectionFace(collection, 2), /out of range/);
});

test('browser blob sources parse and extract the same as in-memory bytes', async () => {
  const { collection } = await koreanCollection();
  const fromBlob = await parseFontSource(blobSource(new Blob([collection])), 'Rau.ttc');
  const fromBytes = await parseSfntFaces(collection);
  assert.equal(fromBlob.type, 'sfnt');
  assert.deepEqual(fromBlob.faces, fromBytes.faces);
  const extracted = await extractCollectionFaceCore(blobSource(new Blob([collection])), 1);
  assert.deepEqual(Buffer.from(extracted), await extractCollectionFace(collection, 1));
  const hft = Buffer.from('Han Unified Font File 1.0\x1a\x04\x03', 'latin1');
  assert.equal((await parseFontSource(blobSource(new Blob([hft])), 'HGSMJ.HFT')).type, 'hft');
});

test('name tables match the standalone face a browser blob would copy', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'rhwp-font-names-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const { noto, collection } = await koreanCollection();
  await writeFile(path.join(dir, 'Rau.ttc'), collection);
  await writeFile(path.join(dir, 'Noto.ttf'), noto);
  const service = createSystemFontService({ roots: [{ path: dir, kind: 'user' }], blobIsWholeFile: false });
  const { faces } = await service.list();
  const batang = faces.find((face) => face.koreanNames.includes('라우바탕'));
  const single = faces.find((face) => face.path.endsWith('Noto.ttf'));
  const [fromCollection, fromFile, missing] = await service.nameTables([batang.id, single.id, '0000000000000000']);

  const standalone = await extractCollectionFace(collection, 1);
  const tables = readTables(standalone);
  assert.equal(fromCollection.size, standalone.length);
  assert.deepEqual(Buffer.from(fromCollection.name), tables.get('name'));
  assert.deepEqual(Buffer.from(fromCollection.os2), tables.get('OS/2').subarray(0, 64));
  // 단독 SFNT 는 head 의 checksumAdjustment 만 다시 계산한다.
  const withoutAdjustment = (head) => Buffer.concat([head.subarray(0, 8), head.subarray(12, 46)]);
  assert.deepEqual(withoutAdjustment(Buffer.from(fromCollection.head)), withoutAdjustment(tables.get('head')));
  assert.equal(fromCollection.name.byteLength, fromCollection.name.buffer.byteLength, 'IPC copies only the table bytes');
  assert.equal(fromFile.size, noto.length);
  assert.deepEqual(Buffer.from(fromFile.name), readTables(noto).get('name'));
  assert.equal(missing, null);

  // Windows·Linux 의 blob 은 컬렉션 파일 그대로라 Studio 가 첫 face 를 읽는다.
  const wholeFile = createSystemFontService({ roots: [{ path: dir, kind: 'user' }], blobIsWholeFile: true });
  await wholeFile.list();
  const [asFile] = await wholeFile.nameTables([batang.id]);
  assert.equal(asFile.size, collection.length);
  assert.deepEqual(Buffer.from(asFile.name), readTables(await extractCollectionFace(collection, 0)).get('name'));
});

test('parses Hancom font list files', () => {
  const fixture = [
    '; HWP HFT Information Data V5.00',
    '',
    '[Font Definition - Hangul]',
    '한양신명조=HGSMJ.HFT,,,,한글과컴퓨터,1033,HY Sinmyeongjo',
    '[Family Category - Hangul]',
    '한양신명조=FCAT_MYUNGJO',
    '[Font List]',
    '한양견고딕=hgggt.hft,Hangul',
    '[All]',
    'HY헤드라인M=H2HDRM.TTF',
  ].join('\r\n');
  const bytes = Buffer.concat([Buffer.from([0xff, 0xff]), Buffer.from(fixture, 'utf16le')]);
  assert.deepEqual(parseHancomFontList(decodeHancomText(bytes)), [
    { name: '한양신명조', file: 'HGSMJ.HFT', script: 'Hangul' },
    { name: 'HY Sinmyeongjo', file: 'HGSMJ.HFT', script: 'Hangul' },
    { name: '한양견고딕', file: 'hgggt.hft', script: 'Hangul' },
    { name: 'HY헤드라인M', file: 'H2HDRM.TTF', script: 'All' },
  ]);
});

test('indexes roots, caches parses, maps Hancom names and guards reads', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'rhwp-system-fonts-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const { noto, collection } = await koreanCollection();
  const userFonts = path.join(dir, 'user');
  const hancomFonts = path.join(dir, 'Hnc', 'Shared', 'Fonts');
  await mkdir(userFonts, { recursive: true });
  await mkdir(hancomFonts, { recursive: true });
  await writeFile(path.join(userFonts, 'Rau.ttc'), collection);
  await writeFile(path.join(hancomFonts, 'NOTO.TTF'), noto);
  await writeFile(path.join(hancomFonts, 'HGSMJ.HFT'), Buffer.from('Han Unified Font File 1.0\x1a\x04\x03', 'latin1'));
  await writeFile(path.join(hancomFonts, 'HGSMJB.HFT'), Buffer.from('Han Unified Font File 1.0\x1a\x04\x03', 'latin1'));
  const list = '[Font Definition - Hangul]\r\n한양신명조=HGSMJ.HFT,,,,한글과컴퓨터,1033,HY Sinmyeongjo\r\n[All]\r\n노토산스=NOTO.TTF\r\n';
  await writeFile(path.join(hancomFonts, 'hftinfo.dat'), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(list, 'utf16le')]));

  const logs = [];
  const options = {
    cacheDir: path.join(dir, 'cache'),
    roots: [{ path: userFonts, kind: 'user' }, { path: path.join(dir, 'missing'), kind: 'system' }],
    hancomInstalls: [path.join(dir, 'Hnc')],
    log: (line) => logs.push(line),
  };
  const service = createSystemFontService(options);
  const [first, concurrent] = await Promise.all([service.list(), service.list()]);
  assert.equal(first, concurrent);
  assert.equal(first.fromCache, false);
  assert.ok(logs[0].startsWith('scan '));
  assert.deepEqual(first.roots.map(({ kind, exists, fileCount }) => [kind, exists, fileCount]), [
    ['hancom', true, 3],
    ['user', true, 1],
    ['system', false, 0],
  ]);

  const korean = first.faces.find((face) => face.koreanNames.includes('라우바탕'));
  assert.equal(korean.format, 'ttc');
  assert.equal(korean.faceIndex, 1);
  assert.equal(korean.source, 'user');
  const hancomTtf = first.faces.find((face) => face.path.endsWith('NOTO.TTF'));
  assert.deepEqual(hancomTtf.families, ['Noto Sans KR', '노토산스']);
  const hft = first.faces.find((face) => face.path.endsWith('HGSMJ.HFT'));
  assert.deepEqual(hft.families, ['한양신명조', 'HY Sinmyeongjo']);
  assert.equal(hft.hangul, true);
  const boldHft = first.faces.find((face) => face.path.endsWith('HGSMJB.HFT'));
  assert.deepEqual([boldHft.families[0], boldHft.bold, boldHft.weight], ['한양신명조', true, 700]);
  assert.deepEqual(
    first.hancomFaceMap.map((entry) => [entry.name, entry.faceId]),
    [['한양신명조', hft.id], ['HY Sinmyeongjo', hft.id], ['노토산스', hancomTtf.id]],
  );

  // 렌더러는 앱 프로토콜로 face 를 받는다. key 가 맞을 때만 색인의 face 를 흘려보낸다.
  const key = 'a'.repeat(64);
  const serve = (id, withKey = key) => serveSystemFont(
    new Request(`${systemFontBaseUrl(withKey)}${id}`),
    { fonts: service, key },
  );
  const response = await serve(korean.id);
  assert.equal(response.status, 200);
  const bytes = new Uint8Array(await response.arrayBuffer());
  assert.equal(Number(response.headers.get('content-length')), bytes.length);
  assert.deepEqual(Buffer.from(bytes), await extractCollectionFace(collection, 1));
  assert.equal((await serve(korean.id, 'b'.repeat(64))).status, 404);
  assert.equal(await serveSystemFont(new Request('rauhwpx://app/index.html'), { fonts: service, key }), null);
  const reparsed = await parseSfntFaces(Buffer.from(bytes));
  assert.deepEqual(reparsed.faces[0].koreanNames, korean.koreanNames);
  const streamed = await service.openFace(hancomTtf.id);
  const parts = [];
  for await (const chunk of streamed.chunks()) parts.push(chunk);
  assert.equal(streamed.size, noto.length);
  assert.deepEqual(Buffer.concat(parts), noto);
  assert.equal((await serve('0123456789abcdef')).status, 404);
  assert.equal((await serve('..%2F..%2Fetc%2Fpasswd')).status, 400);
  await assert.rejects(service.openFace('../../etc/passwd'), /invalid font id/);

  const warm = await createSystemFontService({ ...options, log: () => {} }).list();
  assert.equal(warm.fromCache, true);
  assert.deepEqual(warm.faces.map((face) => face.id), first.faces.map((face) => face.id));

  await utimes(path.join(userFonts, 'Rau.ttc'), new Date(), new Date(Date.now() + 5_000));
  assert.equal((await serve(korean.id)).status, 409);
  const refreshed = await service.list({ refresh: true });
  assert.equal(refreshed.stats.parsed, 1);
  assert.ok(!refreshed.faces.some((face) => face.id === korean.id));
});

/** fs.promises 의 함수 호출 수를 센다. system-fonts.mjs 는 같은 객체를 부른다. */
function countFsCalls(t, names) {
  const counts = Object.fromEntries(names.map((name) => [name, 0]));
  for (const name of names) {
    const original = fsPromises[name];
    fsPromises[name] = function counted(...args) {
      counts[name] += 1;
      return original.apply(this, args);
    };
    t.after(() => { fsPromises[name] = original; });
  }
  return counts;
}

async function drain(service, id) {
  const parts = [];
  for await (const chunk of (await service.openFace(id)).chunks()) parts.push(chunk);
  return Buffer.concat(parts);
}

test('collection faces are planned once and later reads stream the same bytes', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'rhwp-collection-plan-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const { collection } = await koreanCollection();
  await writeFile(path.join(dir, 'Rau.ttc'), collection);
  const service = createSystemFontService({ roots: [{ path: dir, kind: 'user' }] });
  const index = await service.list();
  const face = index.faces.find((entry) => entry.faceIndex === 1);
  const expected = await extractCollectionFace(collection, 1);

  assert.deepEqual(await drain(service, face.id), expected);
  const counts = countFsCalls(t, ['open']);
  const [second, third] = await Promise.all([drain(service, face.id), drain(service, face.id)]);
  assert.deepEqual(second, expected);
  assert.deepEqual(third, expected);
  // 다시 읽을 때는 체크섬을 다시 훑지 않고 face 를 흘려보내는 열기만 한다.
  assert.equal(counts.open, 2);

  // 파일이 바뀌면 계획을 쓰지 않고 stale 로 거절한다.
  await utimes(path.join(dir, 'Rau.ttc'), new Date(), new Date(Date.now() + 5_000));
  await assert.rejects(service.openFace(face.id), /stale/);
});

// 백그라운드 재검색 타이머는 unref 라 앱 종료를 막지 않는다. 테스트가 그 결과만 기다리는 동안에는
// 이벤트 루프가 비어 Node 가 테스트를 끝내 버리므로, 기다리는 동안만 루프를 붙잡아 둔다.
function whileAlive(promise) {
  const keep = setInterval(() => {}, 1_000);
  return promise.finally(() => clearInterval(keep));
}

test('a later launch opens with the saved index and rescans in the background', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'rhwp-saved-index-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const fonts = path.join(dir, 'fonts');
  await mkdir(fonts);
  const { noto, collection } = await koreanCollection();
  await writeFile(path.join(fonts, 'Rau.ttc'), collection);
  const options = { cacheDir: path.join(dir, 'cache'), roots: [{ path: fonts, kind: 'user' }], log: () => {} };

  const first = await createSystemFontService({ ...options, revalidateAfterMs: 60_000 }).list();
  assert.equal(first.fromCache, false);

  // 다음 실행 전에 글꼴이 하나 설치됐다.
  await writeFile(path.join(fonts, 'Noto.ttf'), noto);
  let changed;
  const indexChanged = new Promise((resolve) => { changed = resolve; });
  const logs = [];
  const counts = countFsCalls(t, ['readdir', 'stat']);
  const service = createSystemFontService({
    ...options,
    log: (line) => logs.push(line),
    revalidateAfterMs: 0,
    onIndexChanged: () => changed(),
  });
  const [restored, concurrent] = await Promise.all([service.list(), service.list()]);
  assert.equal(restored, concurrent);
  assert.equal(restored.fromCache, true);
  assert.deepEqual(restored.faces.map((face) => face.id), first.faces.map((face) => face.id));
  assert.deepEqual([counts.readdir, counts.stat], [0, 0], 'the saved index does not walk or stat font roots');
  assert.ok(logs[0].startsWith('restored '));
  // 되살린 색인의 face 도 바로 읽힌다.
  const korean = restored.faces.find((face) => face.faceIndex === 1);
  assert.deepEqual(await drain(service, korean.id), await extractCollectionFace(collection, 1));

  await whileAlive(indexChanged);
  const rescanned = await service.list();
  assert.ok(rescanned.faces.some((face) => face.path.endsWith('Noto.ttf')));
  assert.equal(rescanned.faces.length, first.faces.length + 1);

  // 바뀐 것이 없으면 다시 훑어도 알리지 않는다.
  let notified = 0;
  let rescannedQuietly;
  const quietScan = new Promise((resolve) => { rescannedQuietly = resolve; });
  const quiet = createSystemFontService({
    ...options,
    log: (line) => { if (line.startsWith('scan ')) rescannedQuietly(); },
    revalidateAfterMs: 0,
    onIndexChanged: () => { notified += 1; },
  });
  const again = await quiet.list();
  assert.deepEqual(again.faces.map((face) => face.id), rescanned.faces.map((face) => face.id));
  await whileAlive(quietScan);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(notified, 0);

  // 저장된 색인 뒤에 바뀐 파일은 stale 로 거절하고, 예약한 시간을 기다리지 않고 바로 다시 훑어 알린다.
  let lateChanged;
  const lateIndexChanged = new Promise((resolve) => { lateChanged = resolve; });
  const late = createSystemFontService({ ...options, revalidateAfterMs: 60_000, onIndexChanged: () => lateChanged() });
  const lateIndex = await late.list();
  assert.equal(lateIndex.fromCache, true);
  await utimes(path.join(fonts, 'Noto.ttf'), new Date(), new Date(Date.now() + 5_000));
  const noto2 = lateIndex.faces.find((face) => face.path.endsWith('Noto.ttf'));
  await assert.rejects(late.openFace(noto2.id), /stale/);
  let waited;
  await Promise.race([
    lateIndexChanged,
    new Promise((_, reject) => {
      waited = setTimeout(() => reject(new Error('stale read did not start the rescan')), 10_000);
    }),
  ]).finally(() => clearTimeout(waited));
  const fresh = (await late.list()).faces.find((face) => face.path.endsWith('Noto.ttf'));
  assert.notEqual(fresh.id, noto2.id);
  assert.ok((await drain(late, fresh.id)).length > 0);
});

test('an index saved by another app version is rescanned, not restored', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'rhwp-saved-index-key-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const fonts = path.join(dir, 'fonts');
  await mkdir(fonts);
  const { collection } = await koreanCollection();
  await writeFile(path.join(fonts, 'Rau.ttc'), collection);
  const options = { cacheDir: path.join(dir, 'cache'), roots: [{ path: fonts, kind: 'user' }], revalidateAfterMs: 60_000 };
  const launch = async (savedIndexKey) => {
    const logs = [];
    await createSystemFontService({ ...options, savedIndexKey, log: (line) => logs.push(line) }).list();
    return logs.find((line) => line.startsWith('restored ') || line.startsWith('scan '))?.split(' ')[0];
  };

  assert.equal(await launch('1.0.0'), 'scan');
  assert.equal(await launch('1.0.0'), 'restored');
  // 업데이트 뒤 첫 실행은 글꼴이 그대로여도 새로 훑고, 그 색인을 다음 실행이 되살린다.
  assert.equal(await launch('1.1.0'), 'scan');
  assert.equal(await launch('1.1.0'), 'restored');
});

test('expands catalog roots with home, Windows variables and wildcard folders', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'rhwp-font-roots-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  for (const name of ['Font7', 'Font8', 'Other']) await mkdir(path.join(dir, 'assets', `com_apple_MobileAsset_${name}`), { recursive: true });
  await writeFile(path.join(dir, 'assets', 'com_apple_MobileAsset_FontFile'), '');
  const catalog = [
    { os: 'darwin', kind: 'user', label: 'home', path: '~/Library/Fonts' },
    { os: 'darwin', kind: 'app', label: 'cache', path: '~/cache', sniff: true, maxDepth: 2 },
    { os: 'darwin', kind: 'hancom', label: 'Hancom', path: '/opt/hnc' },
    { os: 'win32', kind: 'app', label: 'Office', path: '%ProgramFiles(x86)%\\Microsoft Office\\root\\vfs\\Fonts\\private' },
    { os: 'win32', kind: 'app', label: 'missing', path: '%NOT_SET%\\Fonts' },
    { os: 'linux', kind: 'app', label: 'LibreOffice', path: '/usr/lib/libreoffice/share/fonts' },
  ];
  const mac = await expandFontRootCatalog({ platform: 'darwin', home: '/Users/rau', catalog });
  // 와일드카드는 실제 폴더를 읽으므로 이 테스트를 돌리는 플랫폼의 경로 규칙으로 확인한다.
  const hostOs = process.platform === 'win32' || process.platform === 'darwin' ? process.platform : 'linux';
  const host = await expandFontRootCatalog({
    platform: process.platform,
    catalog: [{ os: hostOs, kind: 'system', label: 'assets', glob: path.join(dir, 'assets', 'com_apple_MobileAsset_Font*') }],
  });
  assert.deepEqual(host.roots, [
    { path: path.join(dir, 'assets', 'com_apple_MobileAsset_Font7'), kind: 'system', label: 'assets' },
    { path: path.join(dir, 'assets', 'com_apple_MobileAsset_Font8'), kind: 'system', label: 'assets' },
  ]);
  assert.deepEqual(mac.roots, [
    { path: '/Users/rau/Library/Fonts', kind: 'user', label: 'home' },
    { path: '/Users/rau/cache', kind: 'app', label: 'cache', sniff: true, maxDepth: 2, unlisted: true },
  ]);
  assert.deepEqual(mac.installs, [{ path: '/opt/hnc', label: 'Hancom' }]);
  // Windows 환경 변수는 대소문자를 가리지 않고, 없는 변수를 쓰는 항목은 건너뛴다.
  const win = await expandFontRootCatalog({ platform: 'win32', env: { 'PROGRAMFILES(X86)': 'C:\\PF86' }, catalog });
  assert.deepEqual(win.roots.map((root) => root.path), ['C:\\PF86\\Microsoft Office\\root\\vfs\\Fonts\\private']);
  const linux = await expandFontRootCatalog({ platform: 'freebsd', home: '/home/rau', catalog });
  assert.deepEqual(linux.roots.map((root) => root.path), ['/usr/lib/libreoffice/share/fonts']);
});

test('default roots walk Hancom, user, system, then other-app fonts', async () => {
  const { roots, hancomInstalls } = await defaultFontRoots({
    platform: 'win32',
    env: { WINDIR: 'C:\\Windows', SystemRoot: 'c:\\windows', LOCALAPPDATA: 'C:\\Users\\rau\\AppData\\Local', ProgramFiles: 'C:\\PF' },
  });
  const ranks = roots.map((root) => ['user', 'system', 'app'].indexOf(root.kind));
  assert.ok(!ranks.includes(-1));
  assert.deepEqual(ranks, [...ranks].sort((a, b) => a - b));
  assert.equal(roots.filter((root) => root.path.toLowerCase() === 'c:\\windows\\fonts').length, 1);
  assert.ok(roots.some((root) => root.kind === 'app' && root.label === 'Microsoft Office cloud fonts' && root.sniff));
  assert.ok(hancomInstalls.includes('C:\\PF\\Hnc'));
});

test('other-app fonts are indexed last and sniffed caches accept only real font signatures', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'rhwp-app-fonts-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const noto = await readFile(NOTO);
  const appCache = path.join(dir, 'livetype', '.r');
  const plain = path.join(dir, 'plain');
  const system = path.join(dir, 'system');
  await mkdir(appCache, { recursive: true });
  await mkdir(plain, { recursive: true });
  await mkdir(system, { recursive: true });
  await writeFile(path.join(appCache, '.31250'), noto);
  await writeFile(path.join(appCache, '.31251'), Buffer.from('{"not":"a font"}'));
  await writeFile(path.join(appCache, '.31252'), Buffer.alloc(2));
  await writeFile(path.join(plain, 'noext'), noto);
  await writeFile(path.join(system, 'NotoSansKR-Regular.ttf'), noto);
  // 읽을 권한이 없는 보호 폴더는 오류 없이 건너뛴다.
  const denied = path.join(dir, 'denied');
  await mkdir(denied);
  await chmod(denied, 0o000);
  const index = await createSystemFontService({
    roots: [
      { path: path.join(dir, 'livetype'), kind: 'app', label: 'Adobe Fonts', sniff: true },
      { path: plain, kind: 'user' },
      { path: system, kind: 'system' },
      { path: denied, kind: 'app' },
    ],
  }).list();
  assert.deepEqual(index.roots.map(({ kind, label, exists, fileCount, error }) => [kind, label, exists, fileCount, error]), [
    ['user', undefined, true, 0, undefined],
    ['system', undefined, true, 1, undefined],
    ['app', 'Adobe Fonts', true, 1, undefined],
    ['app', undefined, true, 0, undefined],
  ]);
  assert.deepEqual(index.faces.map((face) => [face.source, path.basename(face.path)]), [
    ['system', 'NotoSansKR-Regular.ttf'],
    ['app', '.31250'],
  ]);
  assert.deepEqual(index.errors, []);
});

test('variable fonts expose named instances as separate faces with stable ids', async (t) => {
  const { faces } = await parseSfntFaces(await readFile(VARIABLE));
  assert.deepEqual(faces.map((face) => [face.families[0], face.weight, face.bold, face.instance ?? null]), [
    ['RHWP Variable Fixture', 400, false, null],
    ['RHWP Variable Fixture Thin', 100, false, { wght: 100 }],
    ['RHWP Variable Fixture SemiBold', 600, false, { wght: 600 }],
    ['RHWP Variable Fixture', 700, true, { wght: 700 }],
    ['RHWP Variable Fixture Black', 900, false, { wght: 900 }],
  ]);
  const semibold = faces[2];
  assert.deepEqual(semibold.postscriptNames, ['RHWPVariableFixture-SemiBold']);
  assert.deepEqual(semibold.typographicFamilies, ['RHWP Variable Fixture']);
  assert.deepEqual(semibold.typographicStyles, ['SemiBold']);

  const dir = await mkdtemp(path.join(os.tmpdir(), 'rhwp-variable-fonts-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(path.join(dir, 'Variable.ttf'), await readFile(VARIABLE));
  const options = { cacheDir: path.join(dir, 'cache'), roots: [{ path: dir, kind: 'user' }] };
  const service = createSystemFontService(options);
  const index = await service.list();
  const ids = index.faces.map((face) => face.id);
  assert.equal(new Set(ids).size, 5);
  const warm = await createSystemFontService(options).list();
  assert.equal(warm.fromCache, true);
  assert.deepEqual(warm.faces.map((face) => face.id), ids);
  // 인스턴스 face 도 같은 파일 바이트를 내준다.
  const instance = index.faces.find((face) => face.instance?.wght === 600);
  const parts = [];
  for await (const chunk of (await service.openFace(instance.id)).chunks()) parts.push(chunk);
  assert.deepEqual(Buffer.concat(parts), await readFile(VARIABLE));
});

/** glyf 의 글리프별 머리말(윤곽 수·bbox)과 hmtx·cmap 은 웹 글꼴을 풀어도 원본과 같아야 한다. */
function glyphHeaders(font) {
  const tables = readTables(font);
  const head = tables.get('head');
  const longLoca = head.readInt16BE(50) === 1;
  const loca = tables.get('loca');
  const glyf = tables.get('glyf');
  const count = tables.get('maxp').readUInt16BE(4);
  const headers = [];
  for (let glyph = 0; glyph < count; glyph += 1) {
    const at = longLoca ? loca.readUInt32BE(glyph * 4) : loca.readUInt16BE(glyph * 2) * 2;
    const end = longLoca ? loca.readUInt32BE(glyph * 4 + 4) : loca.readUInt16BE(glyph * 2 + 2) * 2;
    headers.push(end > at ? glyf.subarray(at, at + 10).toString('hex') : '');
  }
  return headers;
}

test('WOFF and WOFF2 index like their source font and decode back to an equivalent SFNT', async () => {
  const ttf = await readFile(WEB_TTF);
  const source = (await parseFontSource(ttf, 'NotoSansKRWebFixture.ttf')).faces;
  for (const flavor of ['woff', 'woff2']) {
    const bytes = await readFile(path.join(WEB_FIXTURES, `NotoSansKRWebFixture.${flavor}`));
    const parsed = await parseFontSource(bytes, `x.${flavor}`, { decompress: NODE_WEB_FONT_DECODERS });
    assert.deepEqual(parsed.faces, source.map((face) => ({ ...face, format: flavor })), flavor);
    // 압축 해제기가 없으면 조용히 틀린 색인을 만들지 않고 실패한다.
    await assert.rejects(parseFontSource(bytes, `x.${flavor}`), /unsupported/);

    const decoded = Buffer.from(await decodeWebFont(bytes, { decompress: NODE_WEB_FONT_DECODERS, maxBytes: 1 << 20 }));
    const original = readTables(ttf);
    const tables = readTables(decoded);
    assert.deepEqual([...tables.keys()].sort(), [...original.keys()].sort(), flavor);
    for (const tag of ['hmtx', 'cmap', 'name', 'OS/2', 'hhea', 'maxp']) {
      assert.deepEqual(tables.get(tag), original.get(tag), `${flavor} ${tag}`);
    }
    assert.deepEqual(glyphHeaders(decoded), glyphHeaders(ttf), flavor);
    assert.equal(decoded.readUInt32BE(0), 0x00010000);
  }

  const variable = await parseSfntFaces(await readFile(VARIABLE));
  const woff2 = await parseFontSource(
    await readFile(path.join(WEB_FIXTURES, 'RHWPVariableWeightFixture.woff2')),
    'v.woff2',
    { decompress: NODE_WEB_FONT_DECODERS },
  );
  assert.deepEqual(woff2.faces, variable.faces.map((face) => ({ ...face, format: 'woff2' })));
});

function woffWithTable(tag, compressed, origLength) {
  const header = Buffer.alloc(44 + 20);
  header.write('wOFF', 0, 'latin1');
  header.writeUInt32BE(0x00010000, 4);
  header.writeUInt32BE(header.length + compressed.length, 8);
  header.writeUInt16BE(1, 12);
  header.write(tag, 44, 'latin1');
  header.writeUInt32BE(header.length, 48);
  header.writeUInt32BE(compressed.length, 52);
  header.writeUInt32BE(origLength, 56);
  return Buffer.concat([header, compressed]);
}

function woff2WithStream(origLength, stream) {
  const directory = Buffer.from([0x05, ...base128(origLength)]); // name, 변환 없음
  const header = Buffer.alloc(48);
  header.write('wOF2', 0, 'latin1');
  header.writeUInt32BE(0x00010000, 4);
  header.writeUInt32BE(48 + directory.length + stream.length, 8);
  header.writeUInt16BE(1, 12);
  header.writeUInt32BE(stream.length, 20);
  return Buffer.concat([header, directory, stream]);
}

function base128(value) {
  const bytes = [value & 0x7f];
  for (let rest = value >>> 7; rest > 0; rest >>>= 7) bytes.unshift(0x80 | (rest & 0x7f));
  return bytes;
}

test('web font decoding refuses decompression bombs and oversized declared output', async () => {
  const bomb = Buffer.alloc(4 * 1024 * 1024);
  // 표가 64KiB 라고 적고 4MiB 로 풀리는 zlib·brotli 스트림
  const woff = woffWithTable('name', deflateSync(bomb), 64 * 1024);
  await assert.rejects(decodeWebFont(woff, { decompress: NODE_WEB_FONT_DECODERS, maxBytes: 1 << 20 }), /buffer|length/i);
  const woff2 = woff2WithStream(64 * 1024, brotliCompressSync(bomb));
  await assert.rejects(decodeWebFont(woff2, { decompress: NODE_WEB_FONT_DECODERS, maxBytes: 1 << 20 }), /buffer|length/i);
  // 적힌 크기가 상한을 넘으면 풀기 전에 거부한다.
  let called = false;
  const decompress = { brotli: () => { called = true; return new Uint8Array(0); } };
  await assert.rejects(
    decodeWebFont(woff2WithStream(64 * 1024 * 1024, Buffer.alloc(16)), { decompress, maxBytes: 1 << 20 }),
    /too-large/,
  );
  assert.equal(called, false);
});

test('app-bundled WOFF2 fonts are indexed unlisted and served as SFNT', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'rhwp-web-fonts-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const bundle = path.join(dir, 'Tool.app', 'Contents', 'Resources', 'fonts');
  await mkdir(bundle, { recursive: true });
  await writeFile(path.join(bundle, 'Web.woff2'), await readFile(path.join(WEB_FIXTURES, 'NotoSansKRWebFixture.woff2')));
  // 번들 탐색이 붙이는 루트 모양 그대로 준다. 카탈로그 탐색은 아래 macOS 테스트가 본다.
  const service = createSystemFontService({
    roots: [{ path: bundle, kind: 'app', label: 'app bundles: Tool', maxDepth: 1, unlisted: true }],
  });
  const index = await service.list();
  assert.deepEqual(index.faces.map((face) => [face.format, face.source, face.unlisted, face.families[0]]), [
    ['woff2', 'app', true, 'Noto Sans KR'],
  ]);
  const key = 'c'.repeat(64);
  const response = await serveSystemFont(new Request(`${systemFontBaseUrl(key)}${index.faces[0].id}`), { fonts: service, key });
  assert.equal(response.status, 200);
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.equal(Number(response.headers.get('content-length')), bytes.length);
  assert.deepEqual(readTables(bytes).get('hmtx'), readTables(await readFile(WEB_TTF)).get('hmtx'));
});

// 실제 폴더를 macOS 경로 규칙으로 읽는다. 이 항목들은 macOS 에서만 쓰인다.
test('catalog probes app bundles, Homebrew casks and TeX trees at fixed depths', { skip: process.platform === 'win32' }, async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'rhwp-font-probe-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const folders = [
    'Apps/Viewer.app/Contents/Resources/Fonts',
    'Apps/Suite.app/Contents/Library/Suite Editor.app/Contents/Resources/fonts',
    'Apps/Vendor/Tool.app/Contents/Resources/fonts',
    // Electron 내부 자원과 Frameworks 는 고정 자리에 없어 보지 않는다.
    'Apps/Chat.app/Contents/Resources/app/out/media/fonts',
    'Apps/Chat.app/Contents/Frameworks/Kit.framework/Resources/Fonts',
    // 전용 항목이 있는 앱은 건너뛴다.
    'Apps/Microsoft Word.app/Contents/Resources/Fonts',
    'Caskroom/font-nerd/3.5.1',
    'Caskroom/ripgrep/14.0',
    'texlive/2025/texmf-dist/fonts/opentype',
    'texlive/2024/texmf-dist/fonts/truetype',
  ];
  for (const folder of folders) await mkdir(path.join(dir, folder), { recursive: true });
  const { roots } = await expandFontRootCatalog({
    platform: 'darwin',
    catalog: [
      { os: 'darwin', kind: 'user', label: 'Homebrew casks', glob: `${dir}/Caskroom/font-*`, maxDepth: 3 },
      { os: 'darwin', kind: 'app', label: 'app bundles', bundles: `${dir}/Apps` },
      { os: 'darwin', kind: 'app', label: 'TeX Live', glob: `${dir}/texlive/*/texmf-dist/fonts/opentype`, maxDepth: 4 },
    ],
  });
  assert.deepEqual(roots.map((root) => [path.relative(dir, root.path), root.kind, root.label, root.maxDepth, root.unlisted]), [
    ['Caskroom/font-nerd', 'user', 'Homebrew casks', 3, undefined],
    ['Apps/Suite.app/Contents/Library/Suite Editor.app/Contents/Resources/fonts', 'app', 'app bundles: Suite Editor', 1, true],
    ['Apps/Vendor/Tool.app/Contents/Resources/fonts', 'app', 'app bundles: Tool', 1, true],
    ['Apps/Viewer.app/Contents/Resources/Fonts', 'app', 'app bundles: Viewer', 1, true],
    // 와일드카드 뒤 고정 경로는 여기서 확인하지 않는다. 없는 루트는 탐색 때 조용히 건너뛴다.
    ['texlive/2024/texmf-dist/fonts/opentype', 'app', 'TeX Live', 4, true],
    ['texlive/2025/texmf-dist/fonts/opentype', 'app', 'TeX Live', 4, true],
  ]);
});

test('catalog probes only the Fonts folder directly under each Windows program folder', async () => {
  // 폴더 목록은 주입하므로 어느 플랫폼에서나 돈다.
  const tree = {
    'C:\\PF': ['Microsoft Office', 'Hnc', 'Vendor', 'Plain'],
    'C:\\PF\\Vendor': ['Fonts', 'bin'],
    'C:\\PF\\Plain': ['bin'],
    'C:\\PF\\Hnc': ['Fonts'],
  };
  const win = await expandFontRootCatalog({
    platform: 'win32',
    env: { ProgramFiles: 'C:\\PF' },
    catalog: [{ os: 'win32', kind: 'app', label: 'program fonts', programs: '%ProgramFiles%' }],
    listDir: async (target) => tree[target] ?? [],
  });
  assert.deepEqual(win.roots.map((root) => [root.path, root.label]), [['C:\\PF\\Vendor\\Fonts', 'program fonts: Vendor']]);
});


test('compact SFNT transfer preserves source bytes, metrics, glyph IDs and composite records', async () => {
  const source = await readFile(WEB_TTF), before = Buffer.from(source), original = readTables(source);
  for (const text of ['A', 'é']) {
    const subset = await compactSfntFace(source, {format:'ttf',faceIndex:0}, text);
    assert.ok(subset && subset.length < source.length);
    assert.deepEqual(source, before, 'Buffer-backed source headers must not be mutated');
    const tables = readTables(Buffer.from(subset));
    for (const tag of ['cmap','hmtx','hhea','maxp','name']) assert.deepEqual(tables.get(tag), original.get(tag));
    const mask = tables.get('HMGC'); assert.equal(mask.toString('ascii',0,4),'HM01');
    const count = original.get('maxp').readUInt16BE(4); assert.equal(mask.readUInt32BE(4),count);
    const long = original.get('head').readInt16BE(50) === 1;
    const offset = id => long ? original.get('loca').readUInt32BE(id*4) : original.get('loca').readUInt16BE(id*2)*2;
    let kept = 0;
    for (let glyph=0;glyph<count;glyph++) {
      const a=tables.get('loca').readUInt32BE(glyph*4), b=tables.get('loca').readUInt32BE(glyph*4+4);
      if (!(mask[8+(glyph>>3)]&(1<<(glyph&7)))) { assert.equal(a,b); continue; }
      kept++;
      const bytes=original.get('glyf').subarray(offset(glyph),offset(glyph+1));
      assert.deepEqual(tables.get('glyf').subarray(a,a+bytes.length),bytes);
      assert.ok(tables.get('glyf').subarray(a+bytes.length,b).every(byte=>byte===0));
    }
    assert.ok(kept>1);
  }
  for (const format of ['otf','otc','hft','woff2']) assert.equal(await compactSfntFace(source,{format,faceIndex:0},'A'),null);
});
