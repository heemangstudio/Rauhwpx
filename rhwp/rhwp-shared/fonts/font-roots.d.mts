import type { FontIndexSourceKind } from './font-index-core.mjs';

export interface FontRootEntry {
  os: 'darwin' | 'win32' | 'linux';
  kind: FontIndexSourceKind;
  label: string;
  path?: string;
  glob?: string;
  /** macOS: 이 폴더의 .app 마다 Contents/Resources/fonts 만 본다. */
  bundles?: string;
  /** Windows: 이 폴더의 프로그램 폴더마다 바로 아래 Fonts 만 본다. */
  programs?: string;
  sniff?: boolean;
  maxDepth?: number;
  /** 글꼴 메뉴에 넣을지. app 은 기본 false, 나머지는 기본 true. */
  menu?: boolean;
}

export interface ExpandedFontRoot {
  path: string;
  kind: Exclude<FontIndexSourceKind, 'hancom'>;
  label: string;
  sniff?: boolean;
  maxDepth?: number;
  unlisted?: boolean;
}

export const FONT_ROOT_CATALOG: ReadonlyArray<FontRootEntry>;

export function expandRootPath(
  target: string,
  options: { platform: string; env?: Record<string, string | undefined>; home?: string },
): string | null;

export function expandGlob(
  pattern: string,
  pathApi: typeof import('node:path').posix,
  listDir?: (dir: string) => Promise<string[]>,
): Promise<string[]>;

export function expandFontRootCatalog(options: {
  platform: string;
  env?: Record<string, string | undefined>;
  home?: string;
  catalog?: ReadonlyArray<FontRootEntry>;
  listDir?: (dir: string) => Promise<string[]>;
}): Promise<{ roots: ExpandedFontRoot[]; installs: Array<{ path: string; label: string }> }>;
