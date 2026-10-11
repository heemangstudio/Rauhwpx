//! LINE_SEG 일치율 측정 통합 테스트
//!
//! HWP 파일을 로드하여 원본 LINE_SEG와 reflow_line_segs() 결과를 비교한다.

#[cfg(test)]
mod tests {
    use crate::model::paragraph::LineSeg;
    use crate::renderer::composer::lineseg_compare::*;
    use crate::renderer::composer::reflow_line_segs;
    use crate::renderer::page_layout::PageLayoutInfo;

    /// HWP 파일을 파싱하여 Document + ResolvedStyleSet 반환
    fn load_raw(
        path: &str,
    ) -> (
        crate::model::document::Document,
        crate::renderer::style_resolver::ResolvedStyleSet,
    ) {
        let data = std::fs::read(path).unwrap_or_else(|e| panic!("{path} 읽기 실패: {e}"));
        let document = crate::parser::parse_document(&data)
            .unwrap_or_else(|e| panic!("{path} 파싱 실패: {e:?}"));
        let styles = crate::renderer::style_resolver::resolve_styles(
            &document.doc_info,
            96.0, // DEFAULT_DPI
        );
        (document, styles)
    }

    /// 섹션의 모든 본문 문단에 대해 LINE_SEG 비교 수행
    fn compare_section(
        document: &mut crate::model::document::Document,
        styles: &crate::renderer::style_resolver::ResolvedStyleSet,
        section_idx: usize,
        dpi: f64,
    ) -> SectionLineSegReport {
        let section = &document.sections[section_idx];
        let page_def = &section.section_def.page_def;

        let total_paragraphs = section.paragraphs.len();
        let mut paragraph_diffs = Vec::new();
        let mut compared = 0usize;
        let mut line_count_match = 0usize;
        let mut line_break_match = 0usize;
        let mut all_match = 0usize;

        for para_idx in 0..total_paragraphs {
            let para = &section.paragraphs[para_idx];

            // 빈 문단이나 LINE_SEG가 없는 문단은 건너뜀
            if para.line_segs.is_empty() || para.text.is_empty() {
                continue;
            }

            // line_height가 0인 문단은 원본 LINE_SEG가 없는 것 (HWPX 등)
            if para.line_segs[0].line_height == 0 {
                continue;
            }

            // 원본 LINE_SEG 복사
            let original_line_segs: Vec<LineSeg> = para.line_segs.clone();

            // ColumnDef 조회
            let column_def = find_column_def_for_paragraph(&section.paragraphs, para_idx);
            let layout = PageLayoutInfo::from_page_def(page_def, &column_def, dpi);
            let col_area = &layout.column_areas[0]; // 기본 단

            // 문단 여백 계산
            let para_style = styles.para_styles.get(para.para_shape_id as usize);
            let margin_left = para_style.map(|s| s.margin_left).unwrap_or(0.0);
            let margin_right = para_style.map(|s| s.margin_right).unwrap_or(0.0);
            let available_width = col_area.width - margin_left - margin_right;

            // reflow 실행 (문단을 임시 clone하여 원본 보존)
            let mut para_clone = para.clone();
            reflow_line_segs(&mut para_clone, available_width, styles, dpi);

            // 비교
            let diff = compare_line_segs(para_idx, &original_line_segs, &para_clone.line_segs);

            compared += 1;
            if diff.line_count_match {
                line_count_match += 1;
            }
            if diff.line_breaks_match() {
                line_break_match += 1;
            }
            if diff.all_match() {
                all_match += 1;
            }

            paragraph_diffs.push(diff);
        }

        SectionLineSegReport {
            section_idx,
            total_paragraphs,
            compared_paragraphs: compared,
            line_count_match_count: line_count_match,
            line_break_match_count: line_break_match,
            all_match_count: all_match,
            paragraph_diffs,
        }
    }

    /// 문단에 적용되는 ColumnDef 찾기 (DocumentCore::find_column_def_for_paragraph와 동일 로직)
    fn find_column_def_for_paragraph(
        paragraphs: &[crate::model::paragraph::Paragraph],
        para_idx: usize,
    ) -> crate::model::page::ColumnDef {
        use crate::model::control::Control;
        use crate::model::page::ColumnDef;
        let mut last_cd = ColumnDef::default();
        for (i, para) in paragraphs.iter().enumerate() {
            if i > para_idx {
                break;
            }
            for ctrl in &para.controls {
                if let Control::ColumnDef(cd) = ctrl {
                    last_cd = cd.clone();
                }
            }
        }
        last_cd
    }

    /// 단일 HWP 파일에 대해 전체 섹션 LINE_SEG 비교 리포트 생성
    fn run_comparison(path: &str) -> Vec<SectionLineSegReport> {
        let (mut document, styles) = load_raw(path);
        let dpi = 96.0;
        let sec_count = document.sections.len();

        let mut reports = Vec::new();
        for sec_idx in 0..sec_count {
            let report = compare_section(&mut document, &styles, sec_idx, dpi);
            reports.push(report);
        }
        reports
    }

    // ─── 일치율 측정 테스트 ───

    #[test]
    fn test_lineseg_compare_table_test() {
        let reports = run_comparison("samples/hwp_table_test.hwp");
        let report_text = format_report(&reports);
        eprintln!("\n=== hwp_table_test.hwp ===\n{}", report_text);

        let total_compared: usize = reports.iter().map(|r| r.compared_paragraphs).sum();
        assert!(total_compared > 0, "비교 대상 문단이 0개");
    }

    #[test]
    fn test_lineseg_compare_hongbo() {
        let reports = run_comparison("samples/20250130-hongbo.hwp");
        let report_text = format_report(&reports);
        eprintln!("\n=== 20250130-hongbo.hwp ===\n{}", report_text);

        let total_compared: usize = reports.iter().map(|r| r.compared_paragraphs).sum();
        assert!(total_compared > 0, "비교 대상 문단이 0개");
    }
}
