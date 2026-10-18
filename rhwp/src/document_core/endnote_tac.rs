//! 미주 수식의 로드 출처와 현재 pagination 출처. 문서/파일에는 기록하지 않는다.
use super::DocumentCore;
use crate::model::control::Control;
use crate::model::document::Document;
use crate::model::paragraph::{
    LeadingColumnInputs, LeadingParaStyleInputs, LeadingSectionGeometryInputs, Paragraph,
};
use crate::renderer::composer::compose_paragraph_with_styles;
use crate::renderer::pagination::{
    authored_endnote_source_is_current, endnote_tac_projection_matches,
};
use crate::renderer::style_resolver::{ResolvedCharStyle, ResolvedStyleSet};
use std::collections::{HashMap, HashSet};
use std::sync::Arc;

pub(crate) type Address = (usize, usize, usize, usize);
pub(crate) type PreparedSources = HashMap<Address, Arc<SourceProof>>;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum RowOrigin {
    Loaded,
    Reflowed,
}

/// 지원하는 수식 문단 한 개만 보관한다. 중첩 문서나 Debug/JSON 지문은 없다.
pub(crate) struct SourceProof {
    source: Paragraph,
    host: HostInputs,
    context: Context,
    pub(crate) origin: RowOrigin,
}

#[derive(PartialEq)]
struct HostInputs {
    text: String,
    count: u32,
    offsets: Vec<u32>,
    shapes: Vec<(u32, u32)>,
    ids: (u16, u8),
    breaks: (u8, u8),
    controls: Vec<std::mem::Discriminant<Control>>,
    note: (u16, u16, u16, u32, u32, u32, usize),
}

#[derive(PartialEq)]
struct Context {
    section: LeadingSectionGeometryInputs,
    source_section: LeadingSectionGeometryInputs,
    render_section: usize,
    columns: Vec<(usize, LeadingColumnInputs)>,
    note_shape: Vec<i64>,
    para_style: LeadingParaStyleInputs,
    char_styles: Vec<(u32, ResolvedCharStyle)>,
    head_values: Vec<i64>,
    head_formats: Vec<String>,
    metrics: Vec<u64>,
    width: f64,
    uniform_width: bool,
    dpi: f64,
    profile: [bool; 4],
}

#[derive(Default)]
pub(crate) struct EndnoteTacSources {
    loaded: HashMap<Address, Arc<SourceProof>>,
    // 과거에 접힌 경계를 가졌다는 작업 목록이다. 기하/소유권을 인증하지 않는다.
    tracked: HashSet<Address>,
    pub(crate) current: PreparedSources,
}

fn needs_exact_owners(para: &Paragraph, styles: &ResolvedStyleSet) -> bool {
    let composed = compose_paragraph_with_styles(para, styles);
    let Some(owners) = current_owners(para, &composed) else {
        return false;
    };
    composed
        .tac_controls
        .iter()
        .zip(owners)
        .any(|((position, _, _), (_, row))| {
            composed
                .lines
                .get(row + 1)
                .is_some_and(|next| *position >= next.char_start)
        })
}

fn source_at(
    doc: &Document,
    a: Address,
) -> Option<(&Paragraph, &crate::model::footnote::Endnote, &Paragraph)> {
    let host = doc.sections.get(a.0)?.paragraphs.get(a.1)?;
    let Control::Endnote(note) = host.controls.get(a.2)? else {
        return None;
    };
    Some((host, note, note.paragraphs.get(a.3)?))
}

fn host_inputs(doc: &Document, a: Address) -> Option<HostInputs> {
    let (host, note, _) = source_at(doc, a)?;
    Some(HostInputs {
        text: host.text.clone(),
        count: host.char_count,
        offsets: host.char_offsets.clone(),
        shapes: host
            .char_shapes
            .iter()
            .map(|s| (s.start_pos, s.char_shape_id))
            .collect(),
        ids: (host.para_shape_id, host.style_id),
        breaks: (host.column_type as u8, host.raw_break_type),
        controls: host.controls.iter().map(std::mem::discriminant).collect(),
        note: (
            note.number,
            note.before_decoration_letter,
            note.after_decoration_letter,
            note.number_shape,
            note.instance_id,
            note.list_header_property,
            note.paragraphs.len(),
        ),
    })
}

fn supported(para: &Paragraph) -> bool {
    !para.controls.is_empty()
        && para.controls.iter().all(|c| matches!(c, Control::Equation(eq) if eq.common.treat_as_char && eq.attr & 1 == 0 && eq.eqedit & 1 == 0))
        && para.field_ranges.is_empty() && para.orphan_field_ends.is_empty()
        && raw_markers(para).is_some()
}

/// 빈 raw 구간 전체가 8-unit 수식 제어일 때에만 복원한다. 가시 위치 추측은 없다.
pub(crate) fn raw_markers(para: &Paragraph) -> Option<Vec<u32>> {
    if para.char_offsets.len() != para.text.chars().count() {
        return None;
    }
    let mut cursor = 0u32;
    let mut result = Vec::new();
    for (ch, &offset) in para.text.chars().zip(&para.char_offsets) {
        let gap = offset.checked_sub(cursor)?;
        if gap % 8 != 0 || result.len().checked_add((gap / 8) as usize)? > para.controls.len() {
            return None;
        }
        result.extend((cursor..offset).step_by(8));
        cursor = offset.checked_add(ch.len_utf16() as u32)?;
    }
    let terminal = para.char_count.checked_sub(1)?;
    let gap = terminal.checked_sub(cursor)?;
    if gap % 8 != 0 || result.len().checked_add((gap / 8) as usize)? != para.controls.len() {
        return None;
    }
    result.extend((cursor..terminal).step_by(8));
    Some(result)
}

fn context(doc: &Document, styles: &ResolvedStyleSet, dpi: f64, a: Address) -> Option<Context> {
    let section = doc.sections.get(a.0)?;
    let (_, _, para) = source_at(doc, a)?;
    if !supported(para) {
        return None;
    }
    let ps = styles.para_styles.get(para.para_shape_id as usize)?;
    let mut ids: Vec<_> = para.char_shapes.iter().map(|s| s.char_shape_id).collect();
    let mut head_values = Vec::new();
    let mut head_formats = Vec::new();
    let index = ps.numbering_id.saturating_sub(1) as usize;
    match ps.head_type {
        crate::model::style::HeadType::None => {}
        crate::model::style::HeadType::Bullet => {
            if let Some(bullet) = styles.bullets.get(index) {
                head_values.extend([
                    bullet.attr as i64,
                    bullet.width_adjust as i64,
                    bullet.text_distance as i64,
                    bullet.char_shape_id as i64,
                    bullet.bullet_char as i64,
                    bullet.image_bullet as i64,
                    bullet.check_bullet_char as i64,
                ]);
                head_values.extend(bullet.image_data.map(i64::from));
                if styles
                    .char_styles
                    .get(bullet.char_shape_id as usize)
                    .is_some()
                {
                    ids.push(bullet.char_shape_id);
                }
            }
        }
        _ => {
            if let Some(numbering) = styles.numberings.get(index) {
                head_values.push(numbering.start_number as i64);
                head_values.extend(numbering.level_start_numbers.map(i64::from));
                for head in &numbering.heads {
                    head_values.extend([
                        head.attr as i64,
                        head.width_adjust as i64,
                        head.text_distance as i64,
                        head.char_shape_id as i64,
                        head.number_format as i64,
                    ]);
                    if styles
                        .char_styles
                        .get(head.char_shape_id as usize)
                        .is_some()
                    {
                        ids.push(head.char_shape_id);
                    }
                }
                head_formats.extend(numbering.level_formats.iter().cloned());
            }
        }
    }
    ids.sort_unstable();
    ids.dedup();
    let char_styles = ids
        .into_iter()
        .map(|id| Some((id, styles.char_styles.get(id as usize)?.clone())))
        .collect::<Option<Vec<_>>>()?;
    if char_styles.is_empty() {
        return None;
    }
    let render_section = if section.section_def.endnote_shape.placement
        == crate::model::footnote::FootnotePlacement::EachColumn
    {
        doc.sections.len().checked_sub(1)?
    } else {
        a.0
    };
    let destination = doc.sections.get(render_section)?;
    let columns = destination
        .paragraphs
        .iter()
        .enumerate()
        .flat_map(|(pi, p)| {
            p.controls.iter().filter_map(move |c| match c {
                Control::ColumnDef(c) => {
                    Some((pi, crate::renderer::float_placement::column_inputs(c)))
                }
                _ => None,
            })
        })
        .collect();
    let column = DocumentCore::find_initial_column_def(&destination.paragraphs);
    let layout = crate::renderer::page_layout::PageLayoutInfo::from_page_def(
        &destination.section_def.page_def,
        &column,
        dpi,
    );
    // 단 선택 전의 fallback은 모든 단에서 들어가는 폭으로 reflow한다.
    // 비균등 단의 저장 기하 자체는 로드 출처로 인증하지 않는다.
    let mut widths = layout
        .column_areas
        .iter()
        .map(|c| c.width)
        .collect::<Vec<_>>();
    for paragraph in &destination.paragraphs {
        for control in &paragraph.controls {
            if let Control::ColumnDef(columns) = control {
                let frame = crate::renderer::page_layout::PageLayoutInfo::from_page_def(
                    &destination.section_def.page_def,
                    columns,
                    dpi,
                );
                widths.extend(frame.column_areas.iter().map(|area| area.width));
            }
        }
    }
    let width = widths
        .iter()
        .copied()
        .reduce(f64::min)
        .unwrap_or(layout.body_area.width);
    if !width.is_finite()
        || width <= 0.0
        || widths
            .iter()
            .any(|width| !width.is_finite() || *width <= 0.0)
    {
        return None;
    }
    let inner = DocumentCore::column_line_width_px(width, para.para_shape_id, styles, dpi);
    if !inner.is_finite() || inner <= 0.0 {
        return None;
    }
    let composed = compose_paragraph_with_styles(para, styles);
    let mut metrics = Vec::new();
    for (_, style) in &char_styles {
        for family in &style.font_families {
            metrics.push(
                crate::renderer::runtime_font_metrics::line_height_ratio(
                    family,
                    style.bold,
                    style.italic,
                )
                .map(f64::to_bits)
                .unwrap_or(u64::MAX),
            );
        }
    }
    for run in composed.lines.iter().flat_map(|l| &l.runs) {
        let style = run.text_style(styles);
        let positions = crate::renderer::layout::compute_char_positions(&run.text, &style);
        if positions.iter().any(|v| !v.is_finite()) {
            return None;
        }
        metrics.push(positions.len() as u64);
        metrics.extend(positions.into_iter().map(f64::to_bits));
    }
    for ctrl in &para.controls {
        let Control::Equation(eq) = ctrl else {
            return None;
        };
        metrics.push(crate::renderer::equation::occupied_width_hwp_with_policy(
            eq,
            styles.font_metrics_policy,
        ) as u64);
        let intrinsic = crate::renderer::equation::intrinsic_metrics_px_with_version_with_policy(
            &eq.script,
            eq.font_size,
            dpi,
            &eq.font_name,
            &eq.version_info,
            styles.font_metrics_policy,
        );
        let values = [intrinsic.width, intrinsic.height, intrinsic.baseline];
        if values.iter().any(|v| !v.is_finite()) {
            return None;
        }
        metrics.extend(values.into_iter().map(f64::to_bits));
    }
    let shape = &section.section_def.endnote_shape;
    let note_shape = vec![
        shape.attr as i64,
        shape.number_format as i64,
        shape.user_char as i64,
        shape.prefix_char as i64,
        shape.suffix_char as i64,
        shape.start_number as i64,
        shape.separator_length as i64,
        shape.separator_margin_top as i64,
        shape.separator_margin_bottom as i64,
        shape.note_spacing as i64,
        shape.separator_line_type as i64,
        shape.separator_line_width as i64,
        shape.separator_color as i64,
        shape.numbering as i64,
        shape.placement as i64,
        shape.number_code_superscript as i64,
        shape.print_inline_after_text as i64,
        shape.raw_unknown as i64,
        shape.deco_chars_from_source as i64,
    ];
    let profile = doc.layout_profile();
    Some(Context {
        section: crate::renderer::float_placement::section_geometry_inputs(
            &destination.section_def,
        ),
        source_section: crate::renderer::float_placement::section_geometry_inputs(
            &section.section_def,
        ),
        render_section,
        columns,
        note_shape,
        para_style: crate::renderer::float_placement::para_style_inputs(ps),
        char_styles,
        head_values,
        head_formats,
        metrics,
        width: inner,
        uniform_width: widths.iter().all(|current| (*current - width).abs() < 1e-6),
        dpi,
        profile: [
            profile.own_line_layout(),
            profile.hwp3_layout(),
            profile.native_hwp5_layout(),
            profile.hwp5_origin_hwpx(),
        ],
    })
}

impl SourceProof {
    fn capture(
        doc: &Document,
        styles: &ResolvedStyleSet,
        dpi: f64,
        a: Address,
        origin: RowOrigin,
    ) -> Option<Self> {
        let (_, _, para) = source_at(doc, a)?;
        if !supported(para) {
            return None;
        }
        let context = context(doc, styles, dpi, a)?;
        if origin == RowOrigin::Loaded && !context.uniform_width {
            return None;
        }
        Some(Self {
            source: Paragraph {
                text: para.text.clone(),
                char_count: para.char_count,
                char_offsets: para.char_offsets.clone(),
                char_shapes: para.char_shapes.clone(),
                control_mask: para.control_mask,
                para_shape_id: para.para_shape_id,
                style_id: para.style_id,
                column_type: para.column_type,
                raw_break_type: para.raw_break_type,
                special_space_origins: para.special_space_origins.clone(),
                tab_extended: para.tab_extended.clone(),
                range_tags: para.range_tags.clone(),
                numbering_restart: para.numbering_restart,
                markpen_marks: para.markpen_marks.clone(),
                controls: para.controls.clone(),
                ctrl_data_records: para.ctrl_data_records.clone(),
                line_segs: para.line_segs.clone(),
                ..Default::default()
            },
            host: host_inputs(doc, a)?,
            context,
            origin,
        })
    }

    pub(crate) fn matches(
        &self,
        doc: &Document,
        styles: &ResolvedStyleSet,
        dpi: f64,
        a: Address,
    ) -> bool {
        let Some((_, _, para)) = source_at(doc, a) else {
            return false;
        };
        self.host
            == match host_inputs(doc, a) {
                Some(h) => h,
                None => return false,
            }
            && Some(&self.context) == context(doc, styles, dpi, a).as_ref()
            && endnote_tac_projection_matches(&self.source, para)
            && self.source.special_space_origins == para.special_space_origins
            && self.source.column_type == para.column_type
            && self.source.raw_break_type == para.raw_break_type
            && self.source.tab_extended == para.tab_extended
    }

    pub(crate) fn matches_paragraph(&self, source: &Paragraph) -> bool {
        endnote_tac_projection_matches(&self.source, source)
    }

    fn loaded_rows_are_current(&self, styles: &ResolvedStyleSet) -> bool {
        let composed = compose_paragraph_with_styles(&self.source, styles);
        current_owners(&self.source, &composed).is_some()
            && !crate::renderer::composer::stored_lines_stale_for_body(
                &composed,
                &self.source,
                self.context.width,
                styles,
            )
    }

    pub(crate) fn matches_width(
        &self,
        width: f64,
        styles: &ResolvedStyleSet,
        para: &Paragraph,
        dpi: f64,
    ) -> bool {
        let current = DocumentCore::column_line_width_px(width, para.para_shape_id, styles, dpi);
        current.is_finite()
            && match self.origin {
                RowOrigin::Loaded => (self.context.width - current).abs() < 1e-6,
                RowOrigin::Reflowed => current + 1e-6 >= self.context.width,
            }
    }
}

impl EndnoteTacSources {
    pub(crate) fn has_tracked(&self) -> bool {
        !self.tracked.is_empty()
    }

    pub(crate) fn invalidate_loaded(&mut self) {
        self.loaded.clear();
    }

    /// 파서 직후, 0 높이 보완이나 reflow 전에만 호출한다. 이후 추가하지 않는다.
    pub(crate) fn capture(doc: &Document, styles: &ResolvedStyleSet, dpi: f64) -> Self {
        let mut result = Self::default();
        for (si, s) in doc.sections.iter().enumerate() {
            if !authored_endnote_source_is_current(doc, si) {
                continue;
            }
            for (pi, p) in s.paragraphs.iter().enumerate() {
                for (ci, c) in p.controls.iter().enumerate() {
                    let Control::Endnote(note) = c else {
                        continue;
                    };
                    for ep in 1..note.paragraphs.len() {
                        let a = (si, pi, ci, ep);
                        if !needs_exact_owners(&note.paragraphs[ep], styles) {
                            continue;
                        }
                        result.tracked.insert(a);
                        if !crate::renderer::pagination::authored_endnote_tac_projection_matches(
                            &note.paragraphs[ep],
                            &note.paragraphs[ep],
                        ) {
                            continue;
                        }
                        if let Some(proof) =
                            SourceProof::capture(doc, styles, dpi, a, RowOrigin::Loaded)
                        {
                            result.loaded.insert(a, Arc::new(proof));
                        }
                    }
                }
            }
        }
        result
    }

    pub(crate) fn invalidate_host(&mut self, si: usize, pi: usize) {
        self.loaded.retain(|a, _| (a.0, a.1) != (si, pi));
        self.current.retain(|a, _| (a.0, a.1) != (si, pi));
    }
}

impl DocumentCore {
    /// 매번 현재 입력을 확인한다. 만료된 원본을 태그나 clean 상태로 재인증하지 않는다.
    pub(crate) fn prepare_endnote_tac_sources(&mut self) {
        self.endnote_tac_sources.current.clear();
        self.endnote_tac_sources
            .loaded
            .retain(|address, _| source_at(&self.document, *address).is_some());
        self.endnote_tac_sources
            .tracked
            .retain(|address| source_at(&self.document, *address).is_some());
        let profile = self.document.layout_profile();
        if profile.own_line_layout()
            || !(self.document.provenance.format == crate::model::provenance::SourceFormat::Hwp5
                || profile.hwp5_origin_hwpx())
        {
            return;
        }
        let addresses: Vec<_> = self
            .document
            .sections
            .iter()
            .enumerate()
            .flat_map(|(si, s)| {
                s.paragraphs.iter().enumerate().flat_map(move |(pi, p)| {
                    p.controls.iter().enumerate().flat_map(move |(ci, c)| {
                        let count = match c {
                            Control::Endnote(n) => n.paragraphs.len(),
                            _ => 0,
                        };
                        (1..count).map(move |ep| (si, pi, ci, ep))
                    })
                })
            })
            .collect();
        for a in addresses {
            if !self.endnote_tac_sources.tracked.contains(&a) {
                if !source_at(&self.document, a)
                    .is_some_and(|(_, _, para)| needs_exact_owners(para, &self.styles))
                {
                    continue;
                }
                self.endnote_tac_sources.tracked.insert(a);
            }
            if let Some(proof) = self.endnote_tac_sources.loaded.get(&a) {
                if proof.matches(&self.document, &self.styles, self.dpi, a)
                    && proof.loaded_rows_are_current(&self.styles)
                {
                    self.endnote_tac_sources
                        .current
                        .insert(a, Arc::clone(proof));
                    continue;
                }
            }
            self.endnote_tac_sources.loaded.remove(&a);
            let Some(ctx) = context(&self.document, &self.styles, self.dpi, a) else {
                continue;
            };
            let Control::Endnote(note) =
                &mut self.document.sections[a.0].paragraphs[a.1].controls[a.2]
            else {
                continue;
            };
            let para = &mut note.paragraphs[a.3];
            // 이전 사다리를 템플릿으로 쓰지 않는다. 현재 스타일/실폭으로 다시 계산한다.
            let origin = para.line_segs.first().map_or(0, |line| line.vertical_pos);
            para.line_segs.clear();
            crate::renderer::composer::reflow_line_segs(para, ctx.width, &self.styles, self.dpi);
            for seg in &mut para.line_segs {
                seg.vertical_pos = seg.vertical_pos.saturating_add(origin);
            }
            self.document.sections[a.0].raw_stream = None;
            // 입력 편집이 아닌 이 문단의 layout 갱신이다. 같은 host에서 앞서
            // 준비한 다른 미주 문단의 증명까지 폐기하지 않는다.
            self.event_log.mark_paragraph_changed(a.0, a.1);
            self.mark_section_dirty(a.0);
            self.mark_paragraph_dirty(a.0, a.1);
            self.recompose_paragraph(a.0, a.1);
            if let Some(proof) = SourceProof::capture(
                &self.document,
                &self.styles,
                self.dpi,
                a,
                RowOrigin::Reflowed,
            ) {
                self.endnote_tac_sources.current.insert(a, Arc::new(proof));
            }
        }
    }
}

/// 현재 원본의 완전한 raw 슬롯과 실제 구성 줄이 대응할 때만 줄 소속을 계산한다.
/// 로드 출처/실제 reflow 여부는 호출자가 별도로 증명해야 한다.
pub(crate) fn current_owners(
    para: &Paragraph,
    composed: &crate::renderer::composer::ComposedParagraph,
) -> Option<Vec<(usize, usize)>> {
    if !supported(para)
        || para.line_segs.is_empty()
        || para.line_segs.len() != composed.lines.len()
        || para.line_segs[0].text_start != 0
        || para
            .line_segs
            .windows(2)
            .any(|r| r[0].text_start >= r[1].text_start)
        || composed.tac_controls.len() != para.controls.len()
        || composed
            .tac_controls
            .iter()
            .enumerate()
            .any(|(i, (_, _, ci))| i != *ci)
        || composed
            .lines
            .iter()
            .flat_map(|l| &l.runs)
            .map(|r| r.text.as_str())
            .collect::<String>()
            != para.text
        || composed
            .lines
            .iter()
            .zip(&para.line_segs)
            .any(|(line, seg)| {
                seg.text_start >= para.char_count
                    || seg.line_height <= 0
                    || seg.text_height <= 0
                    || seg.segment_width <= 0
                    || line.line_height != seg.line_height
                    || line.line_spacing != seg.line_spacing
                    || line.baseline_distance != seg.baseline_distance
                    || line.column_start != seg.column_start
                    || line.segment_width != seg.segment_width
                    || line.char_start != para.char_offsets.partition_point(|o| *o < seg.text_start)
            })
    {
        return None;
    }
    raw_markers(para)?
        .into_iter()
        .enumerate()
        .map(|(ci, raw)| {
            Some((
                ci,
                para.line_segs
                    .partition_point(|row| row.text_start <= raw)
                    .checked_sub(1)?,
            ))
        })
        .collect()
}
