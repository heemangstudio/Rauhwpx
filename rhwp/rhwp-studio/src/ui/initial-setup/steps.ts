/**
 * 첫 실행 설정의 단계, 하마 대사, 한컴 글꼴 찾기.
 *
 * 화면에는 고를 것만 두고, 설명은 하마가 한 줄로 한다. 글꼴 단계는 한컴 글꼴을 스스로 찾지
 * 못했을 때만 넣는다. 마지막에는 요금제를 안내한다.
 *   - 데스크톱: 설치 글꼴 색인이 이미 있다. 한컴 글꼴이 없으면 다시 찾기와 한컴오피스 받기만 둔다.
 *   - 브라우저: 허브 색인과 이미 허락된 설치 글꼴 목록으로 먼저 조용히 찾는다. 못 찾으면 한 번
 *     눌러 찾기(설치 글꼴 권한)와 한컴오피스 받기를 두고, 그래도 없을 때만 글꼴 폴더를 권한다.
 * 찾은 글꼴은 문서 글꼴 연결이 그대로 쓴다(같은 색인·감지 캐시).
 */
import {
  exactFontKey,
  getSystemFontHost,
  isDesktopFontsSupported,
  loadDesktopFontIndex,
  type SystemFontIndex,
} from '../../core/desktop-fonts.ts';
import { canPersistFontFolder } from '../../core/font-folder.ts';
import type { PlanTier } from '../plan/plan-types.ts';
import {
  detectLocalFonts,
  getDetectedLocalFonts,
  isLocalFontAccessSupported,
} from '../../core/local-fonts.ts';

export type SetupStep = 'intro' | 'theme' | 'fonts' | 'welcome' | 'free' | 'account' | 'plans' | 'models' | 'assistants' | 'rau';
/** missing: 데스크톱에서 색인에 한컴 글꼴이 없다. discover: 브라우저에서 아직 못 찾았다. */
export type FontStepKind = 'missing' | 'discover';

export const HANCOM_OFFICE_URL = 'https://www.hancom.com/product/office/officeViewer';

export const HIPPO_LINES = {
  intro: '반가워요!',
  theme: '화면은 어떤 게 편해요?',
  welcome: '어떻게 시작할까요?',
  plans: '나에게 맞는 요금제를 골라 주세요.',
  models: '쓰고 있는 AI가 있으면 연결해 주세요.',
  assistants: 'ChatGPT나 Claude를 웹에서 쓰고 있으면 연결해 주세요. 메모리와 대화 기록을 물어볼 수 있어요.',
  assistantSignIn: '열린 창에서 로그인해 주세요.',
  assistantVerifying: '잘 되는지 질문을 하나 보내 볼게요.',
  assistantVerified: '잘 작동해요!',
  assistantFailed: '확인하지 못했어요. 다시 시도해 주세요.',
  assistantSignedOut: '로그인을 마치지 않았어요. 카드를 다시 눌러 주세요.',
  rau: 'Rau도 함께할 준비가 됐어요!',
  hamaReady: 'Hama를 쓸 수 있어요! 쓰고 있는 AI를 연결해 주세요.',
  modelConnected: '연결됐어요!',
  discover: '문서 글꼴을 찾아볼게요.',
  searching: '찾는 중이에요…',
  found: '한컴 글꼴을 찾았어요!',
  missing: '한컴 글꼴이 안 보여요. 한컴오피스를 설치하면 알아서 찾아요.',
  missingWithFolder: '한컴 글꼴이 안 보여요. 한컴오피스를 설치하거나 글꼴 폴더를 알려 주세요.',
  done: '설정이 완료되었어요!',
  account: '계속하려면 로그인이 필요해요',
  signedIn: '로그인했어요!',
} as const;

/**
 * 한컴오피스와 함께 설치되고 운영체제에는 없는 글꼴. 하나라도 보이면 한컴 글꼴이 있다고 본다.
 * 한글·영문 이름을 같이 둔다(desktop-fonts.ts 의 같은 face 별칭과 같은 이름).
 */
const HANCOM_ONLY_FAMILIES = [
  '한컴바탕', 'Haansoft Batang',
  '한컴돋움', 'Haansoft Dotum',
  'HY헤드라인M', 'HYHeadLine-Medium', 'HYHeadLine Medium',
  'HY견고딕', 'HYGothic-Extra', 'HYGothic Extra',
  'HY신명조', 'HYSinMyeongJo-Medium', 'HYSinMyeongJo Medium',
  '휴먼명조', 'HumanMyeongJo',
];
const HANCOM_ONLY_KEYS = new Set(HANCOM_ONLY_FAMILIES.map(exactFontKey));

export function isHancomFamily(name: string): boolean {
  return HANCOM_ONLY_KEYS.has(exactFontKey(name));
}

/** 색인에 한컴 설치 폴더의 글꼴이나 한컴 전용 글꼴이 있는지. */
export function indexHasHancomFonts(index: Pick<SystemFontIndex, 'faces'>): boolean {
  return index.faces.some((face) => face.source === 'hancom'
    || [...face.families, ...face.koreanNames, ...face.fullNames].some(isHancomFamily));
}

export interface FontEnvironment {
  desktop: boolean;
  /** 찾아본 출처 가운데 한컴 글꼴이 있었는지. 찾아볼 출처가 없었으면 null. */
  hancomFonts: boolean | null;
  /** 브라우저가 한 번 눌러 설치 글꼴을 찾거나 글꼴 폴더를 보관할 수 있는지 */
  canDiscover: boolean;
}

export function planFontStep(env: FontEnvironment): FontStepKind | null {
  if (env.hancomFonts === true) return null;
  if (env.desktop) return env.hancomFonts === false ? 'missing' : null;
  return env.canDiscover ? 'discover' : null;
}

/**
 * 무료 경로는 홈으로, AI 경로는 계정과 실제 유료 등급을 확인한 뒤 연결 단계로 간다.
 * 웹 ChatGPT·Claude 장은 프로바이더 연결 뒤에, 데스크톱 앱 안 브라우저가 있을 때만(assistants) 둔다.
 */
export function planSteps(
  fontStep: FontStepKind | null,
  options: { ai?: boolean; account?: boolean; signedIn?: boolean; tier?: PlanTier; assistants?: boolean } = {},
): SetupStep[] {
  const steps: SetupStep[] = ['intro', 'theme'];
  if (fontStep) steps.push('fonts');
  steps.push('welcome');
  if (!options.ai) return [...steps, 'free'];
  if (options.account) steps.push('account');
  if (!options.signedIn) return steps;
  if (!options.tier || options.tier === 'free') return [...steps, 'plans'];
  // Rau 는 시작을 먼저 축하하고 나서 쓰던 AI 를 연결한다.
  if (options.tier === 'rau') steps.push('rau');
  steps.push('models');
  if (options.assistants) steps.push('assistants');
  return steps;
}

/** 브라우저가 묻지 않고 설치 글꼴 목록을 줄 수 있는지(이미 허락됨). */
async function localFontsGranted(): Promise<boolean> {
  if (!isLocalFontAccessSupported()) return false;
  try {
    const status = await navigator.permissions.query({ name: 'local-fonts' as PermissionName });
    return status.state === 'granted';
  } catch {
    return false;
  }
}

/**
 * 한컴 글꼴을 찾는다. ask 가 true 면 설치 글꼴 권한을 물을 수 있으므로 클릭 처리 안에서 불러야 한다.
 * 출처를 하나도 보지 못했으면 null.
 */
export async function findHancomFonts(options: { ask?: boolean; refresh?: boolean } = {}): Promise<boolean | null> {
  // 권한 창은 사용자 클릭의 활성 상태가 필요하므로 다른 await 보다 먼저 시작한다.
  const local = options.ask && isLocalFontAccessSupported()
    ? detectLocalFonts({ force: true, includeRegistered: true }).then(() => true, () => false)
    : localFontsGranted().then((granted) => granted
      ? detectLocalFonts({ includeRegistered: true }).then(() => true, () => false)
      : false);
  const indexed = getSystemFontHost()
    ? loadDesktopFontIndex(options.refresh ? { refresh: true } : {})
      .then(indexHasHancomFonts, () => null)
    : Promise.resolve(null);
  const [checkedLocal, inIndex] = await Promise.all([local, indexed]);
  if (inIndex === true) return true;
  if (checkedLocal && getDetectedLocalFonts().some(isHancomFamily)) return true;
  return inIndex === false || checkedLocal ? false : null;
}

/** 지금 실행 환경에서 글꼴 단계가 필요한지, 묻지 않고 찾을 수 있는 만큼 찾아 본다. */
export async function detectFontStep(): Promise<FontStepKind | null> {
  const hancomFonts = await findHancomFonts().catch(() => null);
  return planFontStep({
    desktop: isDesktopFontsSupported(),
    hancomFonts,
    canDiscover: isLocalFontAccessSupported() || canPersistFontFolder(),
  });
}

/** 글꼴 폴더를 마지막 수단으로 권할 수 있는지(브라우저, 핸들 보관 가능). */
export function canOfferFontFolder(): boolean {
  return !isDesktopFontsSupported() && canPersistFontFolder();
}
