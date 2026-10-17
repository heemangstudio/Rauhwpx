/**
 * 데스크톱 앱의 글꼴 출처와 사용자가 더한 글꼴 폴더.
 *
 * 출처 목록은 main 색인의 루트 보고서(roots)를 이름별로 묶은 것이다. 폴더를 더하거나 빼면 main 이
 * 색인을 다시 만들고 모든 창에 알린다 (main.ts 가 받아 문서 글꼴을 다시 잇는다).
 */
import { getDesktopFontHostApi, isDesktopFontsSupported, type SystemFontIndex } from './desktop-fonts.ts';

/** desktop/system-fonts.mjs 의 ADDED_FOLDER_LABEL */
export const ADDED_FOLDER_LABEL = 'added folder';

export interface DesktopFontSourceSummary {
  label: string;
  faces: number;
  paths: string[];
}

// macOS 가 함께 싣는 폴더는 사용자에게 하나의 출처라 한 줄로 묶는다.
const SOURCE_NAMES: Readonly<Record<string, string>> = {
  'macOS supplemental': 'macOS',
  'Apple app fonts': 'macOS',
  'macOS downloadable fonts': 'macOS',
  'macOS preinstalled fonts': 'macOS',
  'macOS font services': 'macOS',
  'Library fonts': '모든 사용자 글꼴',
  'user fonts': '사용자 글꼴',
  'system fonts': '시스템 글꼴',
  'local fonts': '로컬 글꼴',
  'Windows registry': 'Windows 레지스트리',
  'Microsoft Office cloud fonts': 'Microsoft Office 클라우드 글꼴',
  'Hancom Office': '한컴오피스',
};

const KIND_NAMES: Readonly<Record<string, string>> = {
  hancom: '한컴오피스',
  user: '사용자 글꼴',
  system: '시스템 글꼴',
  app: '다른 앱 글꼴',
};

/** 루트 이름을 화면에 쓸 이름으로 바꾼다. 제품 이름은 그대로 둔다. */
export function desktopFontSourceName(label: string | undefined, kind: string): string {
  if (!label) return KIND_NAMES[kind] ?? kind;
  return SOURCE_NAMES[label] ?? label;
}

/** 있는 폴더 가운데 face 가 하나라도 나온 출처만 이름별로 묶는다. 더한 폴더는 따로 보여 주므로 뺀다. */
export function summarizeDesktopFontSources(index: SystemFontIndex | null): DesktopFontSourceSummary[] {
  const byName = new Map<string, DesktopFontSourceSummary>();
  for (const root of index?.roots ?? []) {
    if (!root.exists || root.label === ADDED_FOLDER_LABEL) continue;
    const faces = root.faceCount ?? root.fileCount;
    if (!(faces > 0)) continue;
    const label = desktopFontSourceName(root.label, root.kind);
    const summary = byName.get(label) ?? { label, faces: 0, paths: [] };
    summary.faces += faces;
    summary.paths.push(root.path);
    byName.set(label, summary);
  }
  return [...byName.values()];
}

function samePath(a: string, b: string, platform: string | undefined): boolean {
  return platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/** 더한 폴더에서 색인한 face 수. 이미 다른 출처로 훑는 폴더면 그 루트의 수를 쓴다. */
export function addedFolderFaceCount(index: SystemFontIndex | null, folder: string): number | null {
  if (!index) return null;
  let faces: number | null = null;
  for (const root of index.roots ?? []) {
    if (!samePath(root.path, folder, index.platform)) continue;
    faces = (faces ?? 0) + (root.faceCount ?? root.fileCount);
  }
  return faces;
}

function folderApi() {
  return isDesktopFontsSupported() ? getDesktopFontHostApi()?.fontFolders ?? null : null;
}

export function isDesktopFontFoldersSupported(): boolean {
  const api = folderApi();
  return !!api && typeof api.list === 'function' && typeof api.add === 'function' && typeof api.remove === 'function';
}

export async function listDesktopFontFolders(): Promise<string[]> {
  return (await folderApi()?.list()) ?? [];
}

/** 폴더 선택 창을 연다. 취소하면 null. */
export async function addDesktopFontFolder(): Promise<string[] | null> {
  const api = folderApi();
  if (!api) throw new Error('desktop font folders unavailable');
  return api.add();
}

export async function removeDesktopFontFolder(folder: string): Promise<string[]> {
  const api = folderApi();
  if (!api) throw new Error('desktop font folders unavailable');
  return api.remove(folder);
}
