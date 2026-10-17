import type { FontIndexSourceKind } from './font-index-core.mjs';

export interface FontRootEntry {
  os: 'darwin' | 'win32' | 'linux';
  kind: FontIndexSourceKind;
  label: string;
  path?: string;
  glob?: string;
  sniff?: boolean;
  maxDepth?: number;
}

export interface ExpandedFontRoot {
  path: string;
  kind: Exclude<FontIndexSourceKind, 'hancom'>;
  label: string;
  sniff?: boolean;
  maxDepth?: number;
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
