/**
 * 업데이트 하마의 그림. 채팅 하마(agent-sidebar/hama-art.ts)의 서 있는 자세를 그대로 쓰고,
 * 화면 안쪽(왼쪽)을 보도록 좌우만 뒤집는다. 다리는 창 아래 끝을 딛는다.
 *
 * 팻말 막대는 주둥이 뒤로 지나가 턱 밑으로 한 칸 나온다 — 막대를 문 모습이다.
 * 한 칸은 채팅 하마의 두 배(PX)라 칸이 모두 정사각형이다.
 */
import { COLORS, EAR, LIGHT_COLORS, OX, OY, SCALE, STAND, drawLayers, type Layer } from '../agent-sidebar/hama-art.ts';

/** 그림 한 칸의 CSS 픽셀. 팻말 옆에서 읽히도록 채팅 하마의 두 배다. */
export const PX = SCALE * 2;
export const COLS = 14;
/** 귀 위로 막대만 있는 줄. 맨 위 두 줄은 팻말이 덮는다. */
export const STICK_ROWS = 5;
/** 하마 자세에서 쓰는 줄: 귀를 세우는 1행부터 다리인 7행까지. */
const FIRST_ROW = 1;
const LAST_ROW = 7;
export const ROWS = STICK_ROWS + LAST_ROW - FIRST_ROW + 1;
/** 막대 열(뒤집은 뒤). 주둥이 끝에서 한 칸 안쪽이다. */
export const STICK_COL = 2;
/** 막대 아래 끝: 턱 밑으로 한 칸 나온 줄. */
const STICK_END = STICK_ROWS + 5 - FIRST_ROW;
/** 숨었을 때 가장자리 위에 남는 줄: 귀와 머리 두 줄. */
export const EAR_ROW = STICK_ROWS + 2 - FIRST_ROW;
export const PEEK_ROWS = 3;

const mirror = (rows: readonly string[]): string[] => rows.map((row) => [...row].reverse().join(''));
const body = (pose: readonly string[]): string[] => mirror(pose.slice(FIRST_ROW, LAST_ROW + 1));

// 내려갈 때는 귀를 접는다(귀 한 칸을 지운다).
const FLAT = [...STAND.slice(0, 2), '.'.repeat(COLS), ...STAND.slice(3)];

const ART = {
  idle: body(STAND),
  ear: body(EAR),
  dip: body(FLAT),
  peek: body(STAND),
};
export type UpdateHippoFrame = keyof typeof ART;

const STICK: Layer = { art: Array.from({ length: STICK_END + 1 }, () => 'm'), x: STICK_COL + OX, y: -OY };

/** 캔버스(COLS×ROWS, 1칸=1px)에 한 장면을 그린다. 막대를 먼저 그려 주둥이가 덮게 한다. */
export function drawUpdateHippo(ctx: CanvasRenderingContext2D, frame: UpdateHippoFrame): void {
  const light = document.documentElement.dataset.themeEffective === 'light';
  const hippo: Layer = { art: ART[frame], x: OX, y: STICK_ROWS - OY };
  drawLayers(ctx, frame === 'peek' ? [hippo] : [STICK, hippo], light ? LIGHT_COLORS : COLORS);
}
