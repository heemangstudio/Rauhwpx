import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  createSystemFontService,
  decodeHancomText,
  extractCollectionFace,
  parseHancomFontList,
  parseSfntFaces,
} from '../desktop/system-fonts.mjs';
import {
  blobSource,
  extractCollectionFace as extractCollectionFaceCore,
  parseFontSource,
} from '../rhwp/rhwp-shared/fonts/font-index-core.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NOTO = path.join(repoRoot, 'rhwp/ttfs/opensource/NotoSansKR-Regular.ttf');

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

  const bytes = await service.readFace(korean.id);
  const reparsed = await parseSfntFaces(Buffer.from(bytes));
  assert.deepEqual(reparsed.faces[0].koreanNames, korean.koreanNames);
  await assert.rejects(service.readFace('0123456789abcdef'), /unknown font id/);
  await assert.rejects(service.readFace('../../etc/passwd'), /invalid font id/);

  const warm = await createSystemFontService({ ...options, log: () => {} }).list();
  assert.equal(warm.fromCache, true);
  assert.deepEqual(warm.faces.map((face) => face.id), first.faces.map((face) => face.id));

  await utimes(path.join(userFonts, 'Rau.ttc'), new Date(), new Date(Date.now() + 5_000));
  await assert.rejects(service.readFace(korean.id), /stale/);
  const refreshed = await service.list({ refresh: true });
  assert.equal(refreshed.stats.parsed, 1);
  assert.ok(!refreshed.faces.some((face) => face.id === korean.id));
});
