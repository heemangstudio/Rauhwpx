//! 문서 트리 경로 타입
//!
//! 문서 트리 내 임의 깊이의 요소를 가리키는 경로를 정의한다.
//! 중첩 표 편집 등 임의 깊이 접근을 지원한다.

/// 문서 트리 경로 세그먼트
#[derive(Debug, Clone, PartialEq)]
pub enum PathSegment {
    /// 본문 문단 인덱스
    Paragraph(usize),
    /// 컨트롤 인덱스 (표, 그림 등)
    Control(usize),
    /// 표 셀 (row, col)
    Cell(u16, u16),
}

/// 문서 트리 내 임의 위치를 가리키는 경로
///
/// 최상위 표 접근 예시:
///   `[Paragraph(5), Control(0)]`
///
/// 중첩 표 접근 예시:
///   `[Paragraph(5), Control(0), Cell(1, 2), Paragraph(0), Control(0)]`
pub type DocumentPath = Vec<PathSegment>;

/// 기존 3-tuple (parent_para_idx, control_idx)에서 DocumentPath를 생성한다.
pub fn path_from_flat(parent_para_idx: usize, control_idx: usize) -> DocumentPath {
    vec![
        PathSegment::Paragraph(parent_para_idx),
        PathSegment::Control(control_idx),
    ]
}

