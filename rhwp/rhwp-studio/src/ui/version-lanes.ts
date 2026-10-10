/** 버전 그래프의 가지 줄 색. 그래프와 작업 트리 표시가 같은 색을 쓴다. */
export const VERSION_LANE_COLORS = ['#379cff', '#e7ae45', '#cb79d7', '#53bdab', '#8e9dff', '#ed8592'];

export function laneColor(lane: number): string {
  return VERSION_LANE_COLORS[lane % VERSION_LANE_COLORS.length];
}
