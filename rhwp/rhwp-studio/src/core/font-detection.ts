/**
 * "로컬 글꼴 감지": 쓸 수 있는 글꼴 출처를 한 번에 모두 돌려 문서 글꼴을 최대한 연결한다.
 *
 *   1. 브라우저 설치 글꼴 (queryLocalFonts, 권한 필요) — 클릭 처리 안에서 가장 먼저 부른다.
 *   2. 데스크톱 앱·로컬 에이전트 허브·연결한 글꼴 폴더의 색인을 새로 받는다.
 *   3. 문서 글꼴을 처음부터 다시 연결하고 레이아웃 메트릭을 등록한다.
 * 한 출처가 실패해도 나머지는 계속한다.
 */
import { analyzeDocumentFonts } from './document-font-status.ts';
import {
  forgetAttemptedFonts,
  hasSystemFontHost,
  loadDesktopFontIndex,
  prepareSystemFontsForDocument,
  type DesktopFontReport,
} from './desktop-fonts.ts';
import {
  detectLocalFonts,
  isFontPresenceProbeSupported,
  isLocalFontAccessSupported,
} from './local-fonts.ts';

export interface FontDetectionResult {
  /** 브라우저가 알려 준 설치 글꼴 수 (감지하지 않았으면 null) */
  installed: number | null;
  /** 합친 색인의 face 수 (색인 출처가 없으면 null) */
  indexedFaces: number | null;
  /** 문서 글꼴 수와 감지 전후에 실제 글꼴로 보이는 수 */
  total: number;
  availableBefore: number;
  availableAfter: number;
  reports: DesktopFontReport[];
  errors: string[];
}

interface FontDetectionConfig {
  documentFonts?: () => string[] | undefined;
  /** 새로 등록된 글꼴을 레이아웃·화면에 반영한다. */
  applyReports?: (reports: DesktopFontReport[]) => void;
}

let config: FontDetectionConfig = {};

export function configureFontDetection(next: FontDetectionConfig): void {
  config = { ...config, ...next };
}

/** 감지할 수 있는 출처가 하나라도 있는지 */
export function canDetectFonts(): boolean {
  return isLocalFontAccessSupported() || hasSystemFontHost() || isFontPresenceProbeSupported();
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function detectAllFonts(): Promise<FontDetectionResult> {
  const fontsUsed = config.documentFonts?.() ?? [];
  const errors: string[] = [];
  const availableBefore = fontsUsed.length ? analyzeDocumentFonts(fontsUsed).summary.available : 0;

  // 권한 창은 사용자 클릭의 활성 상태가 필요하므로 다른 await보다 먼저 시작한다.
  const installed = isLocalFontAccessSupported() || (isFontPresenceProbeSupported() && fontsUsed.length)
    ? detectLocalFonts({ force: true, includeRegistered: true, candidateFamilies: fontsUsed })
      .then(fonts => fonts.length)
      .catch((error: unknown) => {
        errors.push(`설치 글꼴: ${errorText(error)}`);
        return null;
      })
    : Promise.resolve(null);

  const indexedFaces = hasSystemFontHost()
    ? loadDesktopFontIndex({ refresh: true })
      .then(index => index.faces.length)
      .catch((error: unknown) => {
        errors.push(`글꼴 색인: ${errorText(error)}`);
        return null;
      })
    : Promise.resolve(null);

  const [installedCount, faceCount] = await Promise.all([installed, indexedFaces]);

  let reports: DesktopFontReport[] = [];
  if (fontsUsed.length) {
    forgetAttemptedFonts(fontsUsed);
    try {
      reports = await prepareSystemFontsForDocument(fontsUsed);
      config.applyReports?.(reports);
    } catch (error) {
      errors.push(`문서 글꼴: ${errorText(error)}`);
    }
  }
  const availableAfter = fontsUsed.length ? analyzeDocumentFonts(fontsUsed).summary.available : 0;
  const result: FontDetectionResult = {
    installed: installedCount,
    indexedFaces: faceCount,
    total: fontsUsed.length ? analyzeDocumentFonts(fontsUsed).total : 0,
    availableBefore,
    availableAfter,
    reports,
    errors,
  };
  console.info('[FontDetection] 전체 감지', result);
  return result;
}

/** 감지 결과를 한 줄로 알린다. */
export function fontDetectionMessage(result: FontDetectionResult): string {
  const gained = result.availableAfter - result.availableBefore;
  const substituted = result.total - result.availableAfter;
  if (result.total === 0) {
    return result.installed !== null || result.indexedFaces !== null ? '글꼴을 감지했습니다.' : '감지할 글꼴 출처가 없습니다.';
  }
  if (gained > 0) {
    return substituted > 0
      ? `글꼴 ${gained}개를 더 연결했습니다. ${substituted}개는 대체 글꼴로 표시합니다.`
      : `글꼴 ${gained}개를 더 연결했습니다.`;
  }
  return substituted > 0
    ? `새로 연결한 글꼴이 없습니다. ${substituted}개는 대체 글꼴로 표시합니다.`
    : '문서 글꼴이 모두 연결돼 있습니다.';
}
