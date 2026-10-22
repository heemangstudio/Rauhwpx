/**
 * 프로젝트 항목(자료 카드·자료 탭·PDF 영역)을 입력창으로 끌어 멘션으로 넣는 끌기 자료.
 * 파일 끌어 놓기와 섞이지 않도록 전용 MIME 에 projectId·itemId·title 을 싣는다.
 */

export const PROJECT_ITEM_MIME = 'application/x-rauhwpx-project-item';

export interface ProjectItemDrag {
  projectId: string;
  itemId: string;
  title: string;
}

/** CSV·TSV 읽기 보기에서 고른 칸 범위. 입력창에 놓으면 그 범위만 담은 파일로 첨부한다. */
export const CSV_RANGE_MIME = 'application/x-rauhwpx-csv-range';

export interface CsvRangeDrag {
  /** 첨부 파일 이름 (확장자 포함). */
  name: string;
  /** 머리글을 포함한 범위 원문. */
  text: string;
  delimiter: ',' | '\t';
}

export function transferHasCsvRange(data: DataTransfer | null): boolean {
  return Boolean(data && Array.from(data.types).includes(CSV_RANGE_MIME));
}

export function readCsvRangeDrag(data: DataTransfer | null): CsvRangeDrag | null {
  const raw = data?.getData(CSV_RANGE_MIME);
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<CsvRangeDrag>;
    if (typeof value.name !== 'string' || !value.name || typeof value.text !== 'string') return null;
    return { name: value.name, text: value.text, delimiter: value.delimiter === '\t' ? '\t' : ',' };
  } catch {
    return null;
  }
}

/** 놓인 범위를 입력창 첨부로 올릴 파일로 바꾼다. */
export function csvRangeFile(range: CsvRangeDrag): File {
  const type = range.delimiter === '\t' ? 'text/tab-separated-values' : 'text/csv';
  return new File([range.text], range.name, { type });
}

export function transferHasProjectItem(data: DataTransfer | null): boolean {
  return Boolean(data && Array.from(data.types).includes(PROJECT_ITEM_MIME));
}

export function readProjectItemDrag(data: DataTransfer | null): ProjectItemDrag | null {
  const raw = data?.getData(PROJECT_ITEM_MIME);
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<ProjectItemDrag>;
    if (typeof value.projectId !== 'string' || typeof value.itemId !== 'string' || !value.itemId) return null;
    return { projectId: value.projectId, itemId: value.itemId, title: typeof value.title === 'string' ? value.title : '' };
  } catch {
    return null;
  }
}

/**
 * 요소를 끌 수 있게 하고 끌기 시작할 때 자료를 싣는다. payload 가 null 이면 끌기를 막는다.
 * 안쪽 표지 이미지의 기본 끌기(파일로 보임)는 끄고 이 요소가 끌기를 맡는다.
 */
export function makeProjectItemDraggable(element: HTMLElement, payload: () => ProjectItemDrag | null): void {
  element.draggable = true;
  element.addEventListener('dragstart', (event) => {
    const data = event.dataTransfer;
    const item = payload();
    if (!data || !item) {
      event.preventDefault();
      return;
    }
    event.stopPropagation();
    data.clearData();
    data.setData(PROJECT_ITEM_MIME, JSON.stringify(item));
    data.setData('text/plain', item.title);
    data.effectAllowed = 'copy';
  });
}
