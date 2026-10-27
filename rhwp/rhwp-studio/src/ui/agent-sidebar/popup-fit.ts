/** 창 위 가장자리와 띄우는 여백 */
const TOP_GAP_PX = 8;
/** 이보다 작게는 줄이지 않는다 — 한두 줄은 보여야 스크롤로 고를 수 있다. */
const MIN_HEIGHT_PX = 64;

/**
 * 입력기 위로 뜨는 팝업(멘션·슬래시 메뉴, 모델 설정)을 창 안에 맞춘다.
 * 아래 가장자리가 입력기에 붙어 있으므로, 참고 칩이나 긴 초안으로 입력기가 높아지면
 * 팝업 위쪽이 창 밖으로 나가 첫 줄을 고를 수 없다. 남은 높이만큼 줄이고 안에서 스크롤한다.
 */
export function fitPopupAboveViewportTop(popup: HTMLElement): void {
  popup.style.maxHeight = '';
  if (popup.hidden) return;
  // 펼치는 전환 중에는 높이가 아직 작다. 아래 가장자리(입력기에 붙은 기준점)에서 창 위까지의
  // 자리로 CSS 최대 높이를 줄인다.
  const room = Math.floor(popup.getBoundingClientRect().bottom - TOP_GAP_PX);
  const cssMax = parseFloat(getComputedStyle(popup).maxHeight);
  if (Number.isFinite(cssMax) && cssMax <= room) return;
  popup.style.maxHeight = `${Math.max(MIN_HEIGHT_PX, room)}px`;
}
