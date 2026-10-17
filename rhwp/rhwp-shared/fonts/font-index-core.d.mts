export type FontIndexSourceKind = 'system' | 'user' | 'hancom' | 'app';
export type FontIndexFormat = 'ttf' | 'otf' | 'ttc' | 'otc' | 'woff' | 'woff2' | 'hft';

/** WOFF 표(zlib)와 WOFF2 스트림(brotli) 압축 해제기. outLength 를 넘게 풀지 않아야 한다. */
export interface WebFontDecoders {
  zlib?(data: Uint8Array, outLength: number): Uint8Array | Promise<Uint8Array>;
  brotli?(data: Uint8Array, outLength: number): Uint8Array | Promise<Uint8Array>;
}

/** 임의 위치를 읽을 수 있는 글꼴 원본 */
export interface FontByteSource {
  size: number;
  read(offset: number, length: number): Promise<Uint8Array>;
}

export interface RawFontFace {
  faceIndex: number;
  /** 가변 글꼴의 fvar 인스턴스 번호. 기본 좌표 face 에는 없다. */
  instanceIndex?: number;
  /** 인스턴스 좌표 (축 태그 → 값) */
  instance?: Record<string, number>;
  format: Exclude<FontIndexFormat, 'hft'>;
  families: string[];
  fullNames: string[];
  postscriptNames: string[];
  styles: string[];
  typographicFamilies: string[];
  typographicStyles: string[];
  koreanNames: string[];
  weight: number;
  italic: boolean;
  bold: boolean;
  hangul: boolean;
  latin: boolean;
}

export interface IndexedFontFace extends Omit<RawFontFace, 'format'> {
  id: string;
  path: string;
  format: FontIndexFormat;
  source: FontIndexSourceKind;
  size: number;
  /** 다른 앱이 자기용으로 둔 글꼴: 문서가 이름으로 부를 때만 쓰고 글꼴 메뉴에는 넣지 않는다. */
  unlisted?: boolean;
}

export interface FontIndexFile {
  path: string;
  realPath: string;
  size: number;
  mtimeMs: number;
  kind: FontIndexSourceKind;
  unlisted?: boolean;
}

export interface ParsedFontFileResult {
  size: number;
  mtimeMs: number;
  type: 'hft' | 'sfnt' | 'invalid';
  faces: RawFontFace[];
  error?: string;
}

export interface HancomFaceMapEntry {
  name: string;
  file: string;
  script: string;
  faceId: string | null;
}

export interface PathApi {
  basename(target: string, ext?: string): string;
  dirname(target: string): string;
  extname(target: string): string;
  join(...parts: string[]): string;
}

export const SYSTEM_FONT_INDEX_VERSION: 1;
export const FONT_EXTENSIONS: ReadonlySet<string>;
export const FONT_SCAN_LIMITS: Readonly<{ maxDepth: number; maxFiles: number; maxDirs: number }>;
export const MAX_FACE_BYTES: number;
export const MAX_TABLE_READ: number;
export const HEAD_CHUNK: number;
export const HANCOM_MAP_FILE: RegExp;
export const HANGUL: RegExp;
export const KIND_ORDER: Readonly<Record<FontIndexSourceKind, number>>;
export const MAX_NAMED_INSTANCES: number;
export function isFontSignature(bytes: Uint8Array): boolean;
export const posixPath: PathApi;

export class BytesSource implements FontByteSource {
  constructor(bytes: Uint8Array | ArrayBuffer);
  bytes: Uint8Array;
  size: number;
  read(offset: number, length: number): Promise<Uint8Array>;
}

export function createReadSource(
  size: number,
  readAt: (offset: number, length: number) => Promise<Uint8Array>,
): FontByteSource;
export function blobSource(blob: Blob): FontByteSource;

export function decodeNameRecord(platformId: number, encodingId: number, bytes: Uint8Array): string | null;
export function parseNameTable(bytes: Uint8Array, extraIds?: ReadonlySet<number>): {
  records: Array<{ platformId: number; encodingId: number; languageId: number; nameId: number; text: string }>;
  undecodable: number;
};
export function uniqueStrings(values: readonly unknown[]): string[];
export function parseSfntFaces(input: Uint8Array | FontByteSource): Promise<{
  collection: boolean;
  faces: RawFontFace[];
  undecodable: number;
}>;
export function webFontKind(bytes: Uint8Array): 'woff' | 'woff2' | null;
export function decodeWebFont(input: Uint8Array | FontByteSource, options: {
  decompress?: WebFontDecoders;
  tables?: Iterable<string> | null;
  maxBytes: number;
}): Promise<Uint8Array>;
export function streamWebFontDecoders(): WebFontDecoders;
export function standaloneFaceBytes(
  input: Uint8Array | FontByteSource,
  face: { format: string; faceIndex: number },
  options?: { decompress?: WebFontDecoders; maxBytes?: number },
): Promise<Uint8Array | null>;
export function parseFontSource(input: Uint8Array | FontByteSource, fileName?: string, options?: {
  decompress?: WebFontDecoders;
}): Promise<{
  type: 'hft' | 'sfnt';
  faces: RawFontFace[];
  undecodable?: number;
}>;
export function faceOffsets(source: FontByteSource): Promise<{ collection: boolean; offsets: number[] }>;
export function readTableDirectory(source: FontByteSource, faceOffset: number): Promise<{
  sfntVersion: number;
  tables: Map<string, { tag: string; checksum: number; offset: number; length: number }>;
}>;
export function extractCollectionFace(
  input: Uint8Array | FontByteSource,
  faceIndex: number,
  options?: { maxBytes?: number },
): Promise<Uint8Array>;
export function decodeHancomText(input: Uint8Array | ArrayBuffer): string;
export function parseHancomFontList(text: string): Array<{ name: string; file: string; script: string }>;
export function pathKey(target: string, platform: string): string;
export function commonPrefixLength(a: string, b: string): number;
export function sortFaces<T extends { source: FontIndexSourceKind; path: string; faceIndex: number; instanceIndex?: number }>(faces: T[]): T[];
export function assembleFontIndex<F extends FontIndexFile>(input: {
  parsedFiles: Array<{ file: F; result: Pick<ParsedFontFileResult, 'type' | 'faces' | 'error'> }>;
  mapFiles: string[];
  readMapFile(path: string): Promise<Uint8Array>;
  faceId(file: F, faceIndex: number, instanceIndex?: number): string;
  pathApi: PathApi;
  platform: string;
  errors: Array<{ path: string; message: string }>;
}): Promise<{
  faces: IndexedFontFace[];
  byId: Map<string, { face: IndexedFontFace; file: F }>;
  hancomFaceMap: HancomFaceMapEntry[];
  hftFiles: F[];
  mapStats: { files: number; entries: number; resolved: number; unresolved: number };
}>;
