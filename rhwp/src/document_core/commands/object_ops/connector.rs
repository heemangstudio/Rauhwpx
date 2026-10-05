//! 커넥터 라우팅 native 명령 (object_ops 분할, #1904).

use super::MIN_SHAPE_SIZE;
use crate::document_core::helpers::{get_textbox_from_shape, get_textbox_from_shape_mut};
use crate::document_core::DocumentCore;
use crate::error::HwpError;
use crate::model::control::Control;
use crate::model::event::DocumentEvent;
use crate::model::paragraph::Paragraph;
use crate::model::shape::{common_obj_offsets, ShapeObject};

impl DocumentCore {
    /// 연결선의 SubjectID를 갱신한다 (연결선 생성 후 호출)
    pub fn update_connector_subject_ids(
        &mut self,
        section_idx: usize,
        para_idx: usize,
        control_idx: usize,
        start_subject_id: u32,
        start_subject_index: u32,
        end_subject_id: u32,
        end_subject_index: u32,
    ) {
        let mut mutated = false;
        if let Some(section) = self.document.sections.get_mut(section_idx) {
            if let Some(para) = section.paragraphs.get_mut(para_idx) {
                if let Some(Control::Shape(ref mut shape)) = para.controls.get_mut(control_idx) {
                    if let ShapeObject::Line(ref mut line) = shape.as_mut() {
                        if let Some(ref mut conn) = line.connector {
                            conn.start_subject_id = start_subject_id;
                            conn.start_subject_index = start_subject_index;
                            conn.end_subject_id = end_subject_id;
                            conn.end_subject_index = end_subject_index;
                            mutated = true;
                        }
                    }
                }
            }
            // [#2698] IR을 실제로 바꾼 경우에만 구역 패스스루를 무효화한다.
            // 무효화하지 않으면 serialize_section 이 원본 raw_stream 을 그대로
            // 반환해(body_text.rs:26-30) 이 편집이 저장 결과에서 사라진다.
            // 인덱스가 빗나가 아무것도 바꾸지 않은 경로에서는 라운드트립을
            // 깨뜨리지 않기 위해 조건부로 둔다.
            if mutated {
                section.raw_stream = None;
            }
        }
        // 이벤트를 쌓지 않는 편집이라 연결선 문단 revision 을 직접 올린다 — 올리지
        // 않으면 스냅샷 복원이 바뀐 연결선 문단을 그대로 재사용한다.
        if mutated {
            self.event_log.mark_paragraph_changed(section_idx, para_idx);
        }
    }
    /// 연결선 제어점을 연결점 방향에 따라 재계산한다.
    /// start_idx/end_idx: 0=상, 1=우, 2=하, 3=좌
    pub fn recalculate_connector_routing(
        &mut self,
        section_idx: usize,
        para_idx: usize,
        control_idx: usize,
        start_idx: u32,
        end_idx: u32,
    ) {
        use crate::model::shape::ConnectorControlPoint;

        let mut routed = false;
        let section = match self.document.sections.get_mut(section_idx) {
            Some(s) => s,
            None => return,
        };
        let para = match section.paragraphs.get_mut(para_idx) {
            Some(p) => p,
            None => return,
        };
        let ctrl = match para.controls.get_mut(control_idx) {
            Some(c) => c,
            None => return,
        };

        let line = match ctrl {
            Control::Shape(ref mut s) => match s.as_mut() {
                ShapeObject::Line(ref mut l) => l,
                _ => return,
            },
            _ => return,
        };

        let conn = match &mut line.connector {
            Some(c) => c,
            None => return,
        };

        let sx = line.start.x;
        let sy = line.start.y;
        let ex = line.end.x;
        let ey = line.end.y;
        let w = line.common.width as i32;
        let h = line.common.height as i32;

        // 직선 연결선: 제어점 불필요
        if !conn.link_type.is_stroke() && !conn.link_type.is_arc() {
            conn.control_points.clear();
            // [#2698] 이 조기 반환 경로도 제어점 목록을 비우는 실제 IR 변경이므로
            // 아래 공통 무효화를 타지 못하는 만큼 여기서 직접 무효화한다.
            section.raw_stream = None;
            self.event_log.mark_paragraph_changed(section_idx, para_idx);
            return;
        }

        // 연결점 방향: 0=상, 1=우, 2=하, 3=좌
        if conn.link_type.is_arc() {
            // ─── 곡선 연결선: 파워포인트 스타일 S곡선 ───
            // ctrl1: 시작점에서 시작 방향으로 중간지점까지 뻗음
            // ctrl2: 끝점에서 끝 방향으로 중간지점까지 뻗음
            // → 중간지점에서 위아래(또는 좌우)가 반전되는 S자
            // 한컴 공식: 수평 연결(우/좌)은 midX 기준, 수직 연결(상/하)은 midY 기준
            // ctrl1 = (midX, startY) / (startX, midY), ctrl2 = (midX, endY) / (endX, midY)
            let mid_x = (sx + ex) / 2;
            let mid_y = (sy + ey) / 2;
            let start_is_horz = start_idx == 1 || start_idx == 3; // 우/좌
            let end_is_horz = end_idx == 1 || end_idx == 3;

            let (c1x, c1y, c2x, c2y) = if start_is_horz && end_is_horz {
                // 우↔좌: midX 기준 S곡선
                (mid_x, sy, mid_x, ey)
            } else if !start_is_horz && !end_is_horz {
                // 상↔하: midY 기준 S곡선
                (sx, mid_y, ex, mid_y)
            } else if start_is_horz {
                // 우/좌 → 상/하: 수평 출발 → midX까지, 수직 진입 → midY까지
                (mid_x, sy, ex, mid_y)
            } else {
                // 상/하 → 우/좌: 수직 출발 → midY까지, 수평 진입 → midX까지
                (sx, mid_y, mid_x, ey)
            };

            conn.control_points = vec![
                ConnectorControlPoint {
                    x: sx,
                    y: sy,
                    point_type: 3,
                }, // 시작 앵커
                ConnectorControlPoint {
                    x: c1x,
                    y: c1y,
                    point_type: 2,
                }, // 베지어 ctrl1
                ConnectorControlPoint {
                    x: c2x,
                    y: c2y,
                    point_type: 2,
                }, // 베지어 ctrl2
                ConnectorControlPoint {
                    x: ex,
                    y: ey,
                    point_type: 26,
                }, // 끝 앵커
            ];
            routed = true;
        } else {
            // ─── 꺽인 연결선: 직각 꺾임점 ───
            let mut pts = Vec::new();
            pts.push(ConnectorControlPoint {
                x: sx,
                y: sy,
                point_type: 3,
            });

            match (start_idx, end_idx) {
                (1, 3) | (3, 1) => {
                    let mid_x = (sx + ex) / 2;
                    pts.push(ConnectorControlPoint {
                        x: mid_x,
                        y: sy,
                        point_type: 2,
                    });
                    pts.push(ConnectorControlPoint {
                        x: mid_x,
                        y: ey,
                        point_type: 2,
                    });
                }
                (2, 0) | (0, 2) => {
                    let mid_y = (sy + ey) / 2;
                    pts.push(ConnectorControlPoint {
                        x: sx,
                        y: mid_y,
                        point_type: 2,
                    });
                    pts.push(ConnectorControlPoint {
                        x: ex,
                        y: mid_y,
                        point_type: 2,
                    });
                }
                (1, 0) | (1, 2) | (3, 0) | (3, 2) => {
                    pts.push(ConnectorControlPoint {
                        x: ex,
                        y: sy,
                        point_type: 2,
                    });
                }
                (0, 1) | (0, 3) | (2, 1) | (2, 3) => {
                    pts.push(ConnectorControlPoint {
                        x: sx,
                        y: ey,
                        point_type: 2,
                    });
                }
                _ => {
                    let mid_x = (sx + ex) / 2;
                    pts.push(ConnectorControlPoint {
                        x: mid_x,
                        y: sy,
                        point_type: 2,
                    });
                    pts.push(ConnectorControlPoint {
                        x: mid_x,
                        y: ey,
                        point_type: 2,
                    });
                }
            }

            pts.push(ConnectorControlPoint {
                x: ex,
                y: ey,
                point_type: 26,
            });
            conn.control_points = pts;
            routed = true;
        }
        // [#2698] 제어점을 실제로 재구성한 경우에만 구역 패스스루를 무효화한다.
        if routed {
            section.raw_stream = None;
            self.event_log.mark_paragraph_changed(section_idx, para_idx);
        }
    }
    /// 구역 내 모든 연결선을 스캔하여 연결된 도형의 현재 위치에 맞게 갱신한다.
    pub fn update_connectors_in_section(&mut self, section_idx: usize) {
        let section = match self.document.sections.get(section_idx) {
            Some(s) => s,
            None => return,
        };

        // 1) SC inst_id → 연결점 좌표 맵 구축 (SubjectID = drawing.inst_id)
        let mut conn_points: std::collections::HashMap<u32, [(i32, i32); 4]> =
            std::collections::HashMap::new();
        for para in &section.paragraphs {
            for ctrl in &para.controls {
                let (common, inst_id, _is_line) = match ctrl {
                    Control::Shape(s) => {
                        let sc_inst = s.drawing().map(|d| d.inst_id).unwrap_or(0);
                        (
                            s.common(),
                            sc_inst,
                            matches!(s.as_ref(), ShapeObject::Line(_)),
                        )
                    }
                    Control::Picture(p) => (&p.common, 0u32, false),
                    _ => continue,
                };
                if _is_line {
                    continue;
                }
                let x = common.horizontal_offset as i32;
                let y = common.vertical_offset as i32;
                let w = common.width as i32;
                let h = common.height as i32;
                let cx = x + w / 2;
                let cy = y + h / 2;
                let pts = [(cx, y), (x + w, cy), (cx, y + h), (x, cy)];
                // SC inst_id (= SubjectID) 등록
                if inst_id != 0 {
                    conn_points.insert(inst_id, pts);
                }
                // CTRL_HEADER instance_id로도 등록 (폴백)
                if common.instance_id != 0 {
                    conn_points.insert(common.instance_id, pts);
                    conn_points.insert((common.instance_id & 0x3FFFFFFF) + 1, pts);
                }
            }
        }

        // 2) 커넥터 찾기 및 좌표 갱신 — 연결된 도형이 실제로 움직여 기하가 바뀐 연결선만
        // 고친다. 그대로인 연결선까지 다시 쓰면 원본 패스스루를 괜히 버리고, 원본의
        // 제어점을 이 엔진의 라우팅으로 덮는다.
        let mut moved: Vec<(usize, usize, u32, u32, bool)> = Vec::new();
        let section = match self.document.sections.get_mut(section_idx) {
            Some(s) => s,
            None => return,
        };
        for (pi, para) in section.paragraphs.iter_mut().enumerate() {
            for (ci, ctrl) in para.controls.iter_mut().enumerate() {
                let line = match ctrl {
                    Control::Shape(ref mut s) => match s.as_mut() {
                        ShapeObject::Line(ref mut l) if l.connector.is_some() => l,
                        _ => continue,
                    },
                    _ => continue,
                };

                let conn = line.connector.as_ref().unwrap();
                let start_pts = conn_points.get(&conn.start_subject_id);
                let end_pts = conn_points.get(&conn.end_subject_id);

                // 연결된 도형을 찾지 못하면 건너뜀 (연결 끊어진 상태)
                let (Some(start_pts), Some(end_pts)) = (start_pts, end_pts) else {
                    continue;
                };

                let si = conn.start_subject_index;
                let ei = conn.end_subject_index;
                let routes = conn.link_type.is_stroke() || conn.link_type.is_arc();
                let (gsx, gsy) = start_pts[(si as usize).min(3)];
                let (gex, gey) = end_pts[(ei as usize).min(3)];

                // 커넥터 bbox 재계산
                let min_x = gsx.min(gex);
                let min_y = gsy.min(gey);
                let max_x = gsx.max(gex);
                let max_y = gsy.max(gey);
                let new_w = (max_x - min_x).max(1) as u32;
                let new_h = (max_y - min_y).max(1) as u32;

                let unchanged = line.common.horizontal_offset == min_x as u32
                    && line.common.vertical_offset == min_y as u32
                    && line.common.width == new_w
                    && line.common.height == new_h
                    && line.start.x == gsx - min_x
                    && line.start.y == gsy - min_y
                    && line.end.x == gex - min_x
                    && line.end.y == gey - min_y;
                if unchanged {
                    continue;
                }

                line.common.horizontal_offset = min_x as u32;
                line.common.vertical_offset = min_y as u32;
                line.common.width = new_w;
                line.common.height = new_h;

                // 로컬 시작/끝 좌표
                line.start.x = gsx - min_x;
                line.start.y = gsy - min_y;
                line.end.x = gex - min_x;
                line.end.y = gey - min_y;

                // shape_attr 동기화
                line.drawing.shape_attr.current_width = new_w;
                line.drawing.shape_attr.original_width = new_w;
                line.drawing.shape_attr.current_height = new_h;
                line.drawing.shape_attr.original_height = new_h;
                line.drawing.shape_attr.rotation_center.x = new_w as i32 / 2;
                line.drawing.shape_attr.rotation_center.y = new_h as i32 / 2;
                line.drawing.shape_attr.raw_rendering = Vec::new();
                moved.push((pi, ci, si, ei, routes));
            }
        }
        if moved.is_empty() {
            return;
        }
        // [#2698] bbox/로컬좌표를 실제로 갱신한 경우에만 구역 패스스루를 무효화한다.
        // 움직인 연결선은 다른 문단에 있을 수 있다 — 호출자는 옮긴 도형의 문단만
        // 표시하므로, 연결선 문단 revision 을 여기서 올려야 스냅샷 복원(undo·에이전트
        // 롤백)이 연결선을 도형과 함께 되돌린다.
        section.raw_stream = None;
        let mut moved_paras: Vec<usize> = moved.iter().map(|&(pi, ..)| pi).collect();
        moved_paras.dedup();
        for pi in moved_paras {
            self.event_log.mark_paragraph_changed(section_idx, pi);
        }

        // 3) 움직인 꺾인·곡선 연결선의 제어점 재계산
        for (pi, ci, si, ei, routes) in moved {
            if routes {
                self.recalculate_connector_routing(section_idx, pi, ci, si, ei);
            }
        }
        self.invalidate_page_tree_cache_from_section(section_idx);
    }
}

/// [#2698] 커넥터 뮤테이터의 구역 패스스루 무효화 계약.
///
/// `serialize_section` 은 `Section::raw_stream` 이 `Some` 이면 구역 전체를 원본
/// 그대로 반환한다(`serializer/body_text.rs:26-30`). 따라서 IR 을 고친 뮤테이터가
/// 그 층을 무효화하지 않으면 편집이 저장 결과에서 사라진다. 이 모듈의 다른
/// 형제(`picture.rs`/`shape.rs`/`table.rs` 등)는 전부 뮤테이션 지점에서
/// 무효화하지만 `connector.rs` 만 누락되어 있었다.
#[cfg(test)]
mod connector_passthrough_invalidation_tests {
    use crate::document_core::DocumentCore;
    use crate::model::control::Control;
    use crate::model::shape::{ConnectorData, LineShape, LinkLineType, ShapeObject};

    /// 방금 로드한 원본 문서를 모사한다 — 커넥터 1개가 있고, 구역 패스스루가
    /// 아직 살아 있어 저장 시 원본 바이트가 그대로 반환될 상태.
    ///
    /// 반환값의 `usize` 는 삽입한 커넥터의 `control_idx` 다. 빈 문서의 첫 문단은
    /// 이미 SectionDef/ColumnDef 컨트롤을 갖고 있어 0 이 아니므로, 하드코딩하지
    /// 않고 실제 인덱스를 돌려준다.
    fn core_with_live_passthrough() -> (DocumentCore, usize) {
        core_with_connector_of(LinkLineType::StrokeBoth)
    }

    fn core_with_connector_of(link_type: LinkLineType) -> (DocumentCore, usize) {
        let mut core = DocumentCore::new_empty();
        core.create_blank_document_native().unwrap();

        let line = LineShape {
            connector: Some(ConnectorData {
                link_type,
                ..Default::default()
            }),
            ..Default::default()
        };
        let controls = &mut core.document.sections[0].paragraphs[0].controls;
        let ctrl_idx = controls.len();
        controls.push(Control::Shape(Box::new(ShapeObject::Line(line))));

        core.document.sections[0].raw_stream = Some(vec![0xAB; 16]);
        (core, ctrl_idx)
    }

    #[test]
    fn update_connector_subject_ids_invalidates_section_passthrough() {
        let (mut core, ctrl_idx) = core_with_live_passthrough();
        assert!(
            core.document.sections[0].raw_stream.is_some(),
            "전제 성립 확인: 뮤테이션 전에는 패스스루가 살아 있어야 한다"
        );

        core.update_connector_subject_ids(0, 0, ctrl_idx, 3, 1, 4, 2);

        assert!(
            core.document.sections[0].raw_stream.is_none(),
            "[#2698] SubjectID 를 바꿨으면 구역 패스스루가 무효화되어야 한다 — \
             그렇지 않으면 저장 시 원본 바이트가 그대로 나가 편집이 사라진다"
        );
    }

    #[test]
    fn recalculate_connector_routing_invalidates_section_passthrough() {
        let (mut core, ctrl_idx) = core_with_live_passthrough();
        assert!(core.document.sections[0].raw_stream.is_some());

        core.recalculate_connector_routing(0, 0, ctrl_idx, 1, 3);

        assert!(
            core.document.sections[0].raw_stream.is_none(),
            "[#2698] 제어점을 재구성했으면 구역 패스스루가 무효화되어야 한다"
        );
    }

    /// `recalculate_connector_routing` 은 링크 타입에 따라 세 갈래로 갈라지고,
    /// 세 갈래 모두 `control_points` 를 바꾼다(꺾인=재구성, 곡선=재구성,
    /// 직선=clear 후 조기 반환). 한 갈래만 무효화하면 나머지 둘에서 편집이
    /// 조용히 사라지므로 갈래별로 계약을 고정한다.
    #[test]
    fn every_routing_branch_invalidates_section_passthrough() {
        for link_type in [
            LinkLineType::StrokeBoth,      // 꺾인 — 공통 경로
            LinkLineType::ArcBoth,         // 곡선 — 별도 분기
            LinkLineType::StraightNoArrow, // 직선 — clear 후 조기 반환
        ] {
            let (mut core, ctrl_idx) = core_with_connector_of(link_type);
            core.recalculate_connector_routing(0, 0, ctrl_idx, 1, 3);
            assert!(
                core.document.sections[0].raw_stream.is_none(),
                "[#2698] {link_type:?} 갈래에서 구역 패스스루가 무효화되지 않았다"
            );
        }
    }

    type ConnectorGeometry = (u32, u32, u32, u32, (i32, i32), (i32, i32), Vec<(i32, i32)>);

    fn connector_geometry(core: &DocumentCore) -> ConnectorGeometry {
        core.document.sections[0]
            .paragraphs
            .iter()
            .flat_map(|p| p.controls.iter())
            .find_map(|c| match c {
                Control::Shape(shape) => match shape.as_ref() {
                    ShapeObject::Line(line) if line.connector.is_some() => Some((
                        line.common.horizontal_offset,
                        line.common.vertical_offset,
                        line.common.width,
                        line.common.height,
                        (line.start.x, line.start.y),
                        (line.end.x, line.end.y),
                        line.connector
                            .as_ref()
                            .unwrap()
                            .control_points
                            .iter()
                            .map(|p| (p.x, p.y))
                            .collect(),
                    )),
                    _ => None,
                },
                _ => None,
            })
            .unwrap()
    }

    /// 사각형 둘을 0번 문단에, 둘을 잇는 꺾인 연결선을 1번 문단에 둔다.
    /// 반환값은 두 번째 사각형의 컨트롤 인덱스다.
    fn core_with_connected_rectangles() -> (DocumentCore, usize) {
        let mut core = DocumentCore::new_empty();
        core.create_blank_document_native().unwrap();
        core.insert_text_native(0, 0, 0, "AB").unwrap();
        core.split_paragraph_native(0, 0, 2, None).unwrap();
        for x in [1000, 20000] {
            core.create_shape_control_native(
                0,
                0,
                0,
                4000,
                3000,
                x,
                1000,
                false,
                "Square",
                "rectangle",
                false,
                false,
                &[],
            )
            .unwrap();
        }
        let rects: Vec<(usize, u32)> = core.document.sections[0].paragraphs[0]
            .controls
            .iter()
            .enumerate()
            .filter_map(|(ci, c)| match c {
                Control::Shape(shape) if !matches!(shape.as_ref(), ShapeObject::Line(_)) => {
                    Some((ci, shape.common().instance_id))
                }
                _ => None,
            })
            .collect();
        assert_eq!(rects.len(), 2);
        assert!(rects.iter().all(|&(_, id)| id != 0));

        let line = LineShape {
            connector: Some(ConnectorData {
                link_type: LinkLineType::StrokeBoth,
                start_subject_id: rects[0].1,
                start_subject_index: 1,
                end_subject_id: rects[1].1,
                end_subject_index: 3,
                ..Default::default()
            }),
            ..Default::default()
        };
        let para = &mut core.document.sections[0].paragraphs[1];
        para.controls
            .push(Control::Shape(Box::new(ShapeObject::Line(line))));
        para.ctrl_data_records.resize(para.controls.len(), None);
        core.update_connectors_in_section(0);
        (core, rects[1].0)
    }

    /// 도형을 옮기면 다른 문단의 연결선도 따라 바뀐다. 그 문단 revision 을 올리지 않으면
    /// 스냅샷 복원(undo·에이전트 롤백)이 옮긴 뒤의 연결선을 그대로 남겨 도형과 떨어진다.
    #[test]
    fn connector_follows_shape_through_snapshot_restore() {
        let (mut core, moved_rect) = core_with_connected_rectangles();
        let before = connector_geometry(&core);
        let s_before = core.save_snapshot_native();

        // 도형 이동 경로: 옮긴 도형의 문단은 이동 명령이 직접 표시한다.
        match &mut core.document.sections[0].paragraphs[0].controls[moved_rect] {
            Control::Shape(shape) => shape.common_mut().vertical_offset += 6000,
            _ => unreachable!(),
        }
        core.event_log.mark_paragraph_changed(0, 0);
        core.update_connectors_in_section(0);
        let after = connector_geometry(&core);
        assert_ne!(after, before);
        let s_after = core.save_snapshot_native();

        core.restore_snapshot_native(s_before).unwrap();
        assert_eq!(connector_geometry(&core), before);
        core.restore_snapshot_native(s_after).unwrap();
        assert_eq!(connector_geometry(&core), after);
    }

    /// 움직이지 않은 연결선은 다시 쓰지 않는다 — 패스스루와 revision 을 그대로 둔다.
    #[test]
    fn unchanged_connectors_keep_passthrough_and_revisions() {
        let (mut core, _) = core_with_connected_rectangles();
        core.document.sections[0].raw_stream = Some(vec![0xAB; 16]);
        let para_count = core.document.sections[0].paragraphs.len();
        let revisions = core.event_log.paragraph_revisions(0, para_count);

        core.update_connectors_in_section(0);

        assert!(core.document.sections[0].raw_stream.is_some());
        assert_eq!(core.event_log.paragraph_revisions(0, para_count), revisions);
    }

    /// 무효화를 무조건 하지 않고 조건부로 둔 설계를 고정한다. 인덱스가 빗나가
    /// 아무것도 바꾸지 않은 호출은 완전 라운드트립을 깨뜨리지 않아야 한다.
    #[test]
    fn no_op_call_keeps_passthrough_intact() {
        let (mut core, _) = core_with_live_passthrough();

        core.update_connector_subject_ids(0, 0, 99, 3, 1, 4, 2);
        core.recalculate_connector_routing(0, 0, 99, 1, 3);

        assert!(
            core.document.sections[0].raw_stream.is_some(),
            "[#2698] IR 을 바꾸지 않은 호출은 패스스루를 유지해야 한다"
        );
    }
}
