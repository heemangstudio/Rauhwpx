//! Mixed endnote control identity. No serialized proof or model flag.

use crate::model::control::Control;
pub(crate) fn controls_match(a: &Control, b: &Control) -> bool {
    match (a, b) {
        (Control::Equation(a), Control::Equation(b)) => same_equation(a, b),
        (Control::Table(a), Control::Table(b)) => same_table(a, b),
        (Control::Picture(a), Control::Picture(b)) => same_picture(a, b),
        _ => false,
    }
}

pub(crate) fn same_table(a: &crate::model::table::Table, b: &crate::model::table::Table) -> bool {
    let crate::model::table::Table { attr: _, row_count: _, col_count: _, cell_spacing: _, padding: _, row_sizes: _, border_fill_id: _, zones: _, cells: _, cell_grid: _, page_break: _, repeat_header: _, caption: _, common: _, outer_margin_left: _, outer_margin_right: _, outer_margin_top: _, outer_margin_bottom: _, raw_ctrl_data: _, raw_table_record_attr: _, raw_table_record_extra: _, dirty: _, local_resize_rows: _, local_resize_cols: _, local_resize_cell_widths: _, local_resize_cell_heights: _ } = a;
    (a.attr == b.attr)
        && (a.row_count == b.row_count)
        && (a.col_count == b.col_count)
        && (a.cell_spacing == b.cell_spacing)
        && (same_padding(&a.padding, &b.padding))
        && (a.row_sizes.len() == b.row_sizes.len() && a.row_sizes.iter().zip((b.row_sizes).iter()).all(|(x, y)| x == y))
        && (a.border_fill_id == b.border_fill_id)
        && (a.zones.len() == b.zones.len() && a.zones.iter().zip((b.zones).iter()).all(|(x, y)| same_table_zone(&x, &y)))
        && (a.cells.len() == b.cells.len() && a.cells.iter().zip((b.cells).iter()).all(|(x, y)| same_cell(&x, &y)))
        && (a.cell_grid.len() == b.cell_grid.len() && a.cell_grid.iter().zip((b.cell_grid).iter()).all(|(x, y)| match (&x, &y) { (Some(x), Some(y)) => x == y, (None, None) => true, _ => false }))
        && (a.page_break == b.page_break)
        && (a.repeat_header == b.repeat_header)
        && (match (&a.caption, &b.caption) { (Some(x), Some(y)) => same_caption(&x, &y), (None, None) => true, _ => false })
        && (same_common_obj_attr(&a.common, &b.common))
        && (a.outer_margin_left == b.outer_margin_left)
        && (a.outer_margin_right == b.outer_margin_right)
        && (a.outer_margin_top == b.outer_margin_top)
        && (a.outer_margin_bottom == b.outer_margin_bottom)
        && (a.raw_ctrl_data.len() == b.raw_ctrl_data.len() && a.raw_ctrl_data.iter().zip((b.raw_ctrl_data).iter()).all(|(x, y)| x == y))
        && (a.raw_table_record_attr == b.raw_table_record_attr)
        && (a.raw_table_record_extra.len() == b.raw_table_record_extra.len() && a.raw_table_record_extra.iter().zip((b.raw_table_record_extra).iter()).all(|(x, y)| x == y))
        && (a.dirty == b.dirty)
        && (a.local_resize_rows.len() == b.local_resize_rows.len() && a.local_resize_rows.iter().zip((b.local_resize_rows).iter()).all(|(x, y)| x == y))
        && (a.local_resize_cols.len() == b.local_resize_cols.len() && a.local_resize_cols.iter().zip((b.local_resize_cols).iter()).all(|(x, y)| x == y))
        && (a.local_resize_cell_widths.len() == b.local_resize_cell_widths.len() && a.local_resize_cell_widths.iter().zip((b.local_resize_cell_widths).iter()).all(|(x, y)| x == y))
        && (a.local_resize_cell_heights.len() == b.local_resize_cell_heights.len() && a.local_resize_cell_heights.iter().zip((b.local_resize_cell_heights).iter()).all(|(x, y)| x == y))
}

pub(crate) fn same_picture(a: &crate::model::image::Picture, b: &crate::model::image::Picture) -> bool {
    let crate::model::image::Picture { common: _, shape_attr: _, border_color: _, border_width: _, border_attr: _, border_x: _, border_y: _, crop: _, padding: _, image_attr: _, href: _, border_opacity: _, instance_id: _, raw_picture_extra: _, effects: _, caption: _, img_dim: _, reverse: _, lock: _ } = a;
    (same_common_obj_attr(&a.common, &b.common))
        && (same_shape_component_attr(&a.shape_attr, &b.shape_attr))
        && (a.border_color == b.border_color)
        && (a.border_width == b.border_width)
        && (same_shape_border_line(&a.border_attr, &b.border_attr))
        && (a.border_x == b.border_x)
        && (a.border_y == b.border_y)
        && (same_crop_info(&a.crop, &b.crop))
        && (same_padding(&a.padding, &b.padding))
        && (same_image_attr(&a.image_attr, &b.image_attr))
        && (match (&a.href, &b.href) { (Some(x), Some(y)) => x == y, (None, None) => true, _ => false })
        && (a.border_opacity == b.border_opacity)
        && (a.instance_id == b.instance_id)
        && (a.raw_picture_extra.len() == b.raw_picture_extra.len() && a.raw_picture_extra.iter().zip((b.raw_picture_extra).iter()).all(|(x, y)| x == y))
        && (same_picture_effects(&a.effects, &b.effects))
        && (match (&a.caption, &b.caption) { (Some(x), Some(y)) => same_caption(&x, &y), (None, None) => true, _ => false })
        && (a.img_dim == b.img_dim)
        && (a.reverse == b.reverse)
        && (a.lock == b.lock)
}

pub(crate) fn same_equation(a: &crate::model::control::Equation, b: &crate::model::control::Equation) -> bool {
    let crate::model::control::Equation { common: _, attr: _, script: _, font_size: _, color: _, baseline: _, unknown: _, eqedit: _, version_info: _, font_name: _, raw_ctrl_data: _ } = a;
    (same_common_obj_attr(&a.common, &b.common))
        && (a.attr == b.attr)
        && (a.script == b.script)
        && (a.font_size == b.font_size)
        && (a.color == b.color)
        && (a.baseline == b.baseline)
        && (a.unknown == b.unknown)
        && (a.eqedit == b.eqedit)
        && (a.version_info == b.version_info)
        && (a.font_name == b.font_name)
        && (a.raw_ctrl_data.len() == b.raw_ctrl_data.len() && a.raw_ctrl_data.iter().zip((b.raw_ctrl_data).iter()).all(|(x, y)| x == y))
}

pub(crate) fn same_paragraph(a: &crate::model::paragraph::Paragraph, b: &crate::model::paragraph::Paragraph) -> bool {
    let crate::model::paragraph::Paragraph { char_count: _, control_mask: _, para_shape_id: _, style_id: _, column_type: _, raw_break_type: _, text: _, special_space_origins: _, char_offsets: _, char_shapes: _, line_segs: _, leading_block_host_layout: _, leading_host_rollback_bound: _, tac_line_origin: _, cached_equation_line_origin: _, range_tags: _, field_ranges: _, orphan_field_ends: _, controls: _, ctrl_data_records: _, char_count_msb: _, raw_header_extra: _, has_para_text: _, para_text_terminal: _, authored_text_runs: _, tab_extended: _, markpen_marks: _, numbering_restart: _ } = a;
    (a.char_count == b.char_count)
        && (a.control_mask == b.control_mask)
        && (a.para_shape_id == b.para_shape_id)
        && (a.style_id == b.style_id)
        && (a.column_type == b.column_type)
        && (a.raw_break_type == b.raw_break_type)
        && (a.text == b.text)
        && (a.special_space_origins.len() == b.special_space_origins.len() && a.special_space_origins.iter().zip((b.special_space_origins).iter()).all(|(x, y)| x == y))
        && (a.char_offsets.len() == b.char_offsets.len() && a.char_offsets.iter().zip((b.char_offsets).iter()).all(|(x, y)| x == y))
        && (a.char_shapes.len() == b.char_shapes.len() && a.char_shapes.iter().zip((b.char_shapes).iter()).all(|(x, y)| same_char_shape_ref(&x, &y)))
        && (a.line_segs.len() == b.line_segs.len() && a.line_segs.iter().zip((b.line_segs).iter()).all(|(x, y)| same_line_seg(&x, &y)))
        && (match (&a.leading_block_host_layout, &b.leading_block_host_layout) { (Some(x), Some(y)) => x == y, (None, None) => true, _ => false })
        && (match (&a.leading_host_rollback_bound, &b.leading_host_rollback_bound) { (Some(x), Some(y)) => x == y, (None, None) => true, _ => false })
        && (match (&a.tac_line_origin, &b.tac_line_origin) { (Some(x), Some(y)) => x == y, (None, None) => true, _ => false })
        && (match (&a.cached_equation_line_origin, &b.cached_equation_line_origin) { (Some(x), Some(y)) => same_cached_equation_line_origin(&x, &y), (None, None) => true, _ => false })
        && (a.range_tags.len() == b.range_tags.len() && a.range_tags.iter().zip((b.range_tags).iter()).all(|(x, y)| same_range_tag(&x, &y)))
        && a.field_ranges.is_empty() && b.field_ranges.is_empty()
        && a.orphan_field_ends.is_empty() && b.orphan_field_ends.is_empty()
        && (a.controls.len() == b.controls.len() && a.controls.iter().zip((b.controls).iter()).all(|(x, y)| controls_match(&x, &y)))
        && (a.ctrl_data_records.len() == b.ctrl_data_records.len() && a.ctrl_data_records.iter().zip((b.ctrl_data_records).iter()).all(|(x, y)| match (&x, &y) { (Some(x), Some(y)) => x.len() == y.len() && x.iter().zip((y).iter()).all(|(x, y)| x == y), (None, None) => true, _ => false }))
        && (a.char_count_msb == b.char_count_msb)
        && (a.raw_header_extra.len() == b.raw_header_extra.len() && a.raw_header_extra.iter().zip((b.raw_header_extra).iter()).all(|(x, y)| x == y))
        && (a.has_para_text == b.has_para_text)
        && (match (&a.para_text_terminal, &b.para_text_terminal) { (Some(x), Some(y)) => x == y, (None, None) => true, _ => false })
        && (match (&a.authored_text_runs, &b.authored_text_runs) { (Some(x), Some(y)) => x.len() == y.len() && x.iter().zip((y).iter()).all(|(x, y)| x == y), (None, None) => true, _ => false })
        && (a.tab_extended.len() == b.tab_extended.len() && a.tab_extended.iter().zip((b.tab_extended).iter()).all(|(x, y)| x == y))
        && (a.markpen_marks.len() == b.markpen_marks.len() && a.markpen_marks.iter().zip((b.markpen_marks).iter()).all(|(x, y)| x == y))
        && (match (&a.numbering_restart, &b.numbering_restart) { (Some(x), Some(y)) => x == y, (None, None) => true, _ => false })
}

pub(crate) fn same_padding(a: &crate::model::Padding, b: &crate::model::Padding) -> bool {
    let crate::model::Padding { left: _, right: _, top: _, bottom: _ } = a;
    (a.left == b.left)
        && (a.right == b.right)
        && (a.top == b.top)
        && (a.bottom == b.bottom)
}

pub(crate) fn same_table_zone(a: &crate::model::table::TableZone, b: &crate::model::table::TableZone) -> bool {
    let crate::model::table::TableZone { start_col: _, start_row: _, end_col: _, end_row: _, border_fill_id: _ } = a;
    (a.start_col == b.start_col)
        && (a.start_row == b.start_row)
        && (a.end_col == b.end_col)
        && (a.end_row == b.end_row)
        && (a.border_fill_id == b.border_fill_id)
}

pub(crate) fn same_cell(a: &crate::model::table::Cell, b: &crate::model::table::Cell) -> bool {
    let crate::model::table::Cell { col: _, row: _, col_span: _, row_span: _, width: _, height: _, padding: _, border_fill_id: _, paragraphs: _, list_header_width_ref: _, text_direction: _, vertical_align: _, line_wrap: _, apply_inner_margin: _, is_header: _, raw_list_extra: _, field_name: _, dirty_flag: _ } = a;
    (a.col == b.col)
        && (a.row == b.row)
        && (a.col_span == b.col_span)
        && (a.row_span == b.row_span)
        && (a.width == b.width)
        && (a.height == b.height)
        && (same_padding(&a.padding, &b.padding))
        && (a.border_fill_id == b.border_fill_id)
        && (a.paragraphs.len() == b.paragraphs.len() && a.paragraphs.iter().zip((b.paragraphs).iter()).all(|(x, y)| same_paragraph(&x, &y)))
        && (a.list_header_width_ref == b.list_header_width_ref)
        && (a.text_direction == b.text_direction)
        && (a.vertical_align == b.vertical_align)
        && (a.line_wrap == b.line_wrap)
        && (a.apply_inner_margin == b.apply_inner_margin)
        && (a.is_header == b.is_header)
        && (a.raw_list_extra.len() == b.raw_list_extra.len() && a.raw_list_extra.iter().zip((b.raw_list_extra).iter()).all(|(x, y)| x == y))
        && (match (&a.field_name, &b.field_name) { (Some(x), Some(y)) => x == y, (None, None) => true, _ => false })
        && (a.dirty_flag == b.dirty_flag)
}

pub(crate) fn same_caption(a: &crate::model::shape::Caption, b: &crate::model::shape::Caption) -> bool {
    let crate::model::shape::Caption { direction: _, vert_align: _, width: _, spacing: _, max_width: _, include_margin: _, paragraphs: _ } = a;
    (a.direction == b.direction)
        && (a.vert_align == b.vert_align)
        && (a.width == b.width)
        && (a.spacing == b.spacing)
        && (a.max_width == b.max_width)
        && (a.include_margin == b.include_margin)
        && (a.paragraphs.len() == b.paragraphs.len() && a.paragraphs.iter().zip((b.paragraphs).iter()).all(|(x, y)| same_paragraph(&x, &y)))
}

pub(crate) fn same_common_obj_attr(a: &crate::model::shape::CommonObjAttr, b: &crate::model::shape::CommonObjAttr) -> bool {
    let crate::model::shape::CommonObjAttr { ctrl_id: _, attr: _, vertical_offset: _, horizontal_offset: _, width: _, height: _, z_order: _, margin: _, instance_id: _, prevent_page_break: _, treat_as_char: _, flow_with_text: _, allow_overlap: _, affect_line_spacing: _, hwp5_gen_shape_attr_bit26: _, size_protect: _, hwp5_gen_shape_attr_bit28: _, vert_rel_to: _, vert_align: _, horz_rel_to: _, horz_align: _, text_wrap: _, text_flow: _, width_criterion: _, height_criterion: _, description: _, numbering_type: _, drop_cap_style: _, raw_extra: _, locked: _ } = a;
    (a.ctrl_id == b.ctrl_id)
        && (a.attr == b.attr)
        && (a.vertical_offset == b.vertical_offset)
        && (a.horizontal_offset == b.horizontal_offset)
        && (a.width == b.width)
        && (a.height == b.height)
        && (a.z_order == b.z_order)
        && (same_padding(&a.margin, &b.margin))
        && (a.instance_id == b.instance_id)
        && (a.prevent_page_break == b.prevent_page_break)
        && (a.treat_as_char == b.treat_as_char)
        && (a.flow_with_text == b.flow_with_text)
        && (a.allow_overlap == b.allow_overlap)
        && (a.affect_line_spacing == b.affect_line_spacing)
        && (a.hwp5_gen_shape_attr_bit26 == b.hwp5_gen_shape_attr_bit26)
        && (a.size_protect == b.size_protect)
        && (a.hwp5_gen_shape_attr_bit28 == b.hwp5_gen_shape_attr_bit28)
        && (a.vert_rel_to == b.vert_rel_to)
        && (a.vert_align == b.vert_align)
        && (a.horz_rel_to == b.horz_rel_to)
        && (a.horz_align == b.horz_align)
        && (a.text_wrap == b.text_wrap)
        && (a.text_flow == b.text_flow)
        && (a.width_criterion == b.width_criterion)
        && (a.height_criterion == b.height_criterion)
        && (a.description == b.description)
        && (a.numbering_type == b.numbering_type)
        && (a.drop_cap_style == b.drop_cap_style)
        && (a.raw_extra.len() == b.raw_extra.len() && a.raw_extra.iter().zip((b.raw_extra).iter()).all(|(x, y)| x == y))
        && (a.locked == b.locked)
}

pub(crate) fn same_shape_component_attr(a: &crate::model::shape::ShapeComponentAttr, b: &crate::model::shape::ShapeComponentAttr) -> bool {
    let crate::model::shape::ShapeComponentAttr { ctrl_id: _, is_two_ctrl_id: _, offset_x: _, offset_y: _, group_level: _, local_file_version: _, original_width: _, original_height: _, current_width: _, current_height: _, current_width_was_zero: _, current_height_was_zero: _, flip: _, horz_flip: _, vert_flip: _, rotation_angle: _, rotate_image: _, rotation_center: _, raw_rendering: _, render_tx: _, render_ty: _, render_sx: _, render_sy: _, render_b: _, render_c: _ } = a;
    (a.ctrl_id == b.ctrl_id)
        && (a.is_two_ctrl_id == b.is_two_ctrl_id)
        && (a.offset_x == b.offset_x)
        && (a.offset_y == b.offset_y)
        && (a.group_level == b.group_level)
        && (a.local_file_version == b.local_file_version)
        && (a.original_width == b.original_width)
        && (a.original_height == b.original_height)
        && (a.current_width == b.current_width)
        && (a.current_height == b.current_height)
        && (a.current_width_was_zero == b.current_width_was_zero)
        && (a.current_height_was_zero == b.current_height_was_zero)
        && (a.flip == b.flip)
        && (a.horz_flip == b.horz_flip)
        && (a.vert_flip == b.vert_flip)
        && (a.rotation_angle == b.rotation_angle)
        && (a.rotate_image == b.rotate_image)
        && (same_point(&a.rotation_center, &b.rotation_center))
        && (a.raw_rendering.len() == b.raw_rendering.len() && a.raw_rendering.iter().zip((b.raw_rendering).iter()).all(|(x, y)| x == y))
        && (a.render_tx == b.render_tx)
        && (a.render_ty == b.render_ty)
        && (a.render_sx == b.render_sx)
        && (a.render_sy == b.render_sy)
        && (a.render_b == b.render_b)
        && (a.render_c == b.render_c)
}

pub(crate) fn same_shape_border_line(a: &crate::model::style::ShapeBorderLine, b: &crate::model::style::ShapeBorderLine) -> bool {
    let crate::model::style::ShapeBorderLine { color: _, width: _, attr: _, outline_style: _ } = a;
    (a.color == b.color)
        && (a.width == b.width)
        && (a.attr == b.attr)
        && (a.outline_style == b.outline_style)
}

pub(crate) fn same_crop_info(a: &crate::model::image::CropInfo, b: &crate::model::image::CropInfo) -> bool {
    let crate::model::image::CropInfo { left: _, top: _, right: _, bottom: _ } = a;
    (a.left == b.left)
        && (a.top == b.top)
        && (a.right == b.right)
        && (a.bottom == b.bottom)
}

pub(crate) fn same_image_attr(a: &crate::model::image::ImageAttr, b: &crate::model::image::ImageAttr) -> bool {
    let crate::model::image::ImageAttr { brightness: _, contrast: _, effect: _, bin_data_id: _, transparency: _, external_path: _ } = a;
    (a.brightness == b.brightness)
        && (a.contrast == b.contrast)
        && (a.effect == b.effect)
        && (a.bin_data_id == b.bin_data_id)
        && (a.transparency == b.transparency)
        && (match (&a.external_path, &b.external_path) { (Some(x), Some(y)) => x == y, (None, None) => true, _ => false })
}

pub(crate) fn same_picture_effects(a: &crate::model::image::PictureEffects, b: &crate::model::image::PictureEffects) -> bool {
    let crate::model::image::PictureEffects { shadow: _ } = a;
    (match (&a.shadow, &b.shadow) { (Some(x), Some(y)) => same_picture_shadow(&x, &y), (None, None) => true, _ => false })
}

pub(crate) fn same_char_shape_ref(a: &crate::model::paragraph::CharShapeRef, b: &crate::model::paragraph::CharShapeRef) -> bool {
    let crate::model::paragraph::CharShapeRef { start_pos: _, char_shape_id: _ } = a;
    (a.start_pos == b.start_pos)
        && (a.char_shape_id == b.char_shape_id)
}

pub(crate) fn same_line_seg(a: &crate::model::paragraph::LineSeg, b: &crate::model::paragraph::LineSeg) -> bool {
    let crate::model::paragraph::LineSeg { text_start: _, vertical_pos: _, line_height: _, text_height: _, baseline_distance: _, line_spacing: _, column_start: _, segment_width: _, tag: _ } = a;
    (a.text_start == b.text_start)
        && (a.vertical_pos == b.vertical_pos)
        && (a.line_height == b.line_height)
        && (a.text_height == b.text_height)
        && (a.baseline_distance == b.baseline_distance)
        && (a.line_spacing == b.line_spacing)
        && (a.column_start == b.column_start)
        && (a.segment_width == b.segment_width)
        && (a.tag == b.tag)
}

pub(crate) fn same_cached_equation_line_origin(a: &crate::model::paragraph::CachedEquationLineOrigin, b: &crate::model::paragraph::CachedEquationLineOrigin) -> bool {
    let crate::model::paragraph::CachedEquationLineOrigin { source_bytes: _, source_lines: _, installed_starts: _ } = a;
    (a.source_bytes.len() == b.source_bytes.len() && a.source_bytes.iter().zip((b.source_bytes).iter()).all(|(x, y)| x == y))
        && (a.source_lines.len() == b.source_lines.len() && a.source_lines.iter().zip((b.source_lines).iter()).all(|(x, y)| same_line_seg(&x, &y)))
        && (a.installed_starts.len() == b.installed_starts.len() && a.installed_starts.iter().zip((b.installed_starts).iter()).all(|(x, y)| x == y))
}

pub(crate) fn same_range_tag(a: &crate::model::paragraph::RangeTag, b: &crate::model::paragraph::RangeTag) -> bool {
    let crate::model::paragraph::RangeTag { start: _, end: _, tag: _ } = a;
    (a.start == b.start)
        && (a.end == b.end)
        && (a.tag == b.tag)
}

pub(crate) fn same_point(a: &crate::model::Point, b: &crate::model::Point) -> bool {
    let crate::model::Point { x: _, y: _ } = a;
    (a.x == b.x)
        && (a.y == b.y)
}

pub(crate) fn same_picture_shadow(a: &crate::model::image::PictureShadow, b: &crate::model::image::PictureShadow) -> bool {
    let crate::model::image::PictureShadow { style: _, alpha: _, radius: _, direction: _, distance: _, align_style: _, rotation_style: _, skew: _, scale: _, color: _ } = a;
    (match (&a.style, &b.style) { (Some(x), Some(y)) => x == y, (None, None) => true, _ => false })
        && (match (&a.alpha, &b.alpha) { (Some(x), Some(y)) => x == y, (None, None) => true, _ => false })
        && (match (&a.radius, &b.radius) { (Some(x), Some(y)) => x == y, (None, None) => true, _ => false })
        && (match (&a.direction, &b.direction) { (Some(x), Some(y)) => x == y, (None, None) => true, _ => false })
        && (match (&a.distance, &b.distance) { (Some(x), Some(y)) => x == y, (None, None) => true, _ => false })
        && (match (&a.align_style, &b.align_style) { (Some(x), Some(y)) => x == y, (None, None) => true, _ => false })
        && (match (&a.rotation_style, &b.rotation_style) { (Some(x), Some(y)) => x == y, (None, None) => true, _ => false })
        && (match (&a.skew, &b.skew) { (Some(x), Some(y)) => same_effect_point(&x, &y), (None, None) => true, _ => false })
        && (match (&a.scale, &b.scale) { (Some(x), Some(y)) => same_effect_point(&x, &y), (None, None) => true, _ => false })
        && (match (&a.color, &b.color) { (Some(x), Some(y)) => same_effect_color(&x, &y), (None, None) => true, _ => false })
}

pub(crate) fn same_effect_point(a: &crate::model::image::EffectPoint, b: &crate::model::image::EffectPoint) -> bool {
    let crate::model::image::EffectPoint { x: _, y: _ } = a;
    (match (&a.x, &b.x) { (Some(x), Some(y)) => x == y, (None, None) => true, _ => false })
        && (match (&a.y, &b.y) { (Some(x), Some(y)) => x == y, (None, None) => true, _ => false })
}

pub(crate) fn same_effect_color(a: &crate::model::image::EffectColor, b: &crate::model::image::EffectColor) -> bool {
    let crate::model::image::EffectColor { color_type: _, scheme_idx: _, system_idx: _, preset_idx: _, rgb: _ } = a;
    (match (&a.color_type, &b.color_type) { (Some(x), Some(y)) => x == y, (None, None) => true, _ => false })
        && (match (&a.scheme_idx, &b.scheme_idx) { (Some(x), Some(y)) => x == y, (None, None) => true, _ => false })
        && (match (&a.system_idx, &b.system_idx) { (Some(x), Some(y)) => x == y, (None, None) => true, _ => false })
        && (match (&a.preset_idx, &b.preset_idx) { (Some(x), Some(y)) => x == y, (None, None) => true, _ => false })
        && (match (&a.rgb, &b.rgb) { (Some(x), Some(y)) => same_effect_rgb(&x, &y), (None, None) => true, _ => false })
}

pub(crate) fn same_effect_rgb(a: &crate::model::image::EffectRgb, b: &crate::model::image::EffectRgb) -> bool {
    let crate::model::image::EffectRgb { r: _, g: _, b: _ } = a;
    (match (&a.r, &b.r) { (Some(x), Some(y)) => x == y, (None, None) => true, _ => false })
        && (match (&a.g, &b.g) { (Some(x), Some(y)) => x == y, (None, None) => true, _ => false })
        && (match (&a.b, &b.b) { (Some(x), Some(y)) => x == y, (None, None) => true, _ => false })
}

pub(crate) fn same_resolved_border_style(a: &crate::renderer::style_resolver::ResolvedBorderStyle, b: &crate::renderer::style_resolver::ResolvedBorderStyle) -> bool {
    let crate::renderer::style_resolver::ResolvedBorderStyle { borders: _, fill_color: _, pattern: _, gradient: _, image_fill: _, diagonal_attr: _, diagonal: _, center_line: _ } = a;
    (a.borders.iter().zip((b.borders).iter()).all(|(x,y)| same_border_line(&x, &y)))
        && (match (&a.fill_color, &b.fill_color) { (Some(x),Some(y)) => x == y, (None,None) => true, _ => false })
        && (match (&a.pattern, &b.pattern) { (Some(x),Some(y)) => same_pattern_fill_info(&x, &y), (None,None) => true, _ => false })
        && (match (&a.gradient, &b.gradient) { (Some(x),Some(y)) => same_gradient_fill_info(&x, &y), (None,None) => true, _ => false })
        && (match (&a.image_fill, &b.image_fill) { (Some(x),Some(y)) => same_resolved_image_fill(&x, &y), (None,None) => true, _ => false })
        && (a.diagonal_attr == b.diagonal_attr)
        && (same_diagonal_line(&a.diagonal, &b.diagonal))
        && (a.center_line == b.center_line)
}

pub(crate) fn same_resolved_para_style(a: &crate::renderer::style_resolver::ResolvedParaStyle, b: &crate::renderer::style_resolver::ResolvedParaStyle) -> bool {
    let crate::renderer::style_resolver::ResolvedParaStyle { alignment: _, line_spacing: _, line_spacing_type: _, margin_left: _, margin_right: _, indent: _, spacing_before: _, spacing_after: _, head_type: _, para_level: _, numbering_id: _, border_fill_id: _, border_spacing: _, border_ignore_margin: _, default_tab_width: _, tab_stops: _, auto_tab_right: _, condense_min_space: _, line_wrap_squeeze: _, english_break_unit: _, korean_break_unit: _, widow_orphan: _, keep_with_next: _, keep_lines: _, page_break_before: _, vertical_align: _, font_line_height: _, auto_spacing_eng: _, auto_spacing_num: _ } = a;
    (a.alignment == b.alignment)
        && (a.line_spacing == b.line_spacing)
        && (a.line_spacing_type == b.line_spacing_type)
        && (a.margin_left == b.margin_left)
        && (a.margin_right == b.margin_right)
        && (a.indent == b.indent)
        && (a.spacing_before == b.spacing_before)
        && (a.spacing_after == b.spacing_after)
        && (a.head_type == b.head_type)
        && (a.para_level == b.para_level)
        && (a.numbering_id == b.numbering_id)
        && (a.border_fill_id == b.border_fill_id)
        && (a.border_spacing.iter().zip((b.border_spacing).iter()).all(|(x,y)| x == y))
        && (a.border_ignore_margin == b.border_ignore_margin)
        && (a.default_tab_width == b.default_tab_width)
        && (a.tab_stops.len() == b.tab_stops.len() && a.tab_stops.iter().zip((b.tab_stops).iter()).all(|(x,y)| same_tab_stop(&x, &y)))
        && (a.auto_tab_right == b.auto_tab_right)
        && (a.condense_min_space == b.condense_min_space)
        && (a.line_wrap_squeeze == b.line_wrap_squeeze)
        && (a.english_break_unit == b.english_break_unit)
        && (a.korean_break_unit == b.korean_break_unit)
        && (a.widow_orphan == b.widow_orphan)
        && (a.keep_with_next == b.keep_with_next)
        && (a.keep_lines == b.keep_lines)
        && (a.page_break_before == b.page_break_before)
        && (a.vertical_align == b.vertical_align)
        && (a.font_line_height == b.font_line_height)
        && (a.auto_spacing_eng == b.auto_spacing_eng)
        && (a.auto_spacing_num == b.auto_spacing_num)
}

pub(crate) fn same_border_line(a: &crate::model::style::BorderLine, b: &crate::model::style::BorderLine) -> bool {
    let crate::model::style::BorderLine { line_type: _, width: _, color: _ } = a;
    (a.line_type == b.line_type)
        && (a.width == b.width)
        && (a.color == b.color)
}

pub(crate) fn same_pattern_fill_info(a: &crate::renderer::PatternFillInfo, b: &crate::renderer::PatternFillInfo) -> bool {
    let crate::renderer::PatternFillInfo { pattern_type: _, pattern_color: _, background_color: _ } = a;
    (a.pattern_type == b.pattern_type)
        && (a.pattern_color == b.pattern_color)
        && (a.background_color == b.background_color)
}

pub(crate) fn same_gradient_fill_info(a: &crate::renderer::GradientFillInfo, b: &crate::renderer::GradientFillInfo) -> bool {
    let crate::renderer::GradientFillInfo { gradient_type: _, angle: _, center_x: _, center_y: _, step: _, step_center: _, colors: _, positions: _ } = a;
    (a.gradient_type == b.gradient_type)
        && (a.angle == b.angle)
        && (a.center_x == b.center_x)
        && (a.center_y == b.center_y)
        && (a.step == b.step)
        && (a.step_center == b.step_center)
        && (a.colors.len() == b.colors.len() && a.colors.iter().zip((b.colors).iter()).all(|(x,y)| x == y))
        && (a.positions.len() == b.positions.len() && a.positions.iter().zip((b.positions).iter()).all(|(x,y)| x == y))
}

pub(crate) fn same_resolved_image_fill(a: &crate::renderer::style_resolver::ResolvedImageFill, b: &crate::renderer::style_resolver::ResolvedImageFill) -> bool {
    let crate::renderer::style_resolver::ResolvedImageFill { bin_data_id: _, fill_mode: _, brightness: _, contrast: _, effect: _ } = a;
    (a.bin_data_id == b.bin_data_id)
        && (a.fill_mode == b.fill_mode)
        && (a.brightness == b.brightness)
        && (a.contrast == b.contrast)
        && (a.effect == b.effect)
}

pub(crate) fn same_diagonal_line(a: &crate::model::style::DiagonalLine, b: &crate::model::style::DiagonalLine) -> bool {
    let crate::model::style::DiagonalLine { diagonal_type: _, width: _, color: _ } = a;
    (a.diagonal_type == b.diagonal_type)
        && (a.width == b.width)
        && (a.color == b.color)
}

pub(crate) fn same_tab_stop(a: &crate::renderer::TabStop, b: &crate::renderer::TabStop) -> bool {
    let crate::renderer::TabStop { position: _, tab_type: _, fill_type: _ } = a;
    (a.position == b.position)
        && (a.tab_type == b.tab_type)
        && (a.fill_type == b.fill_type)
}

pub(crate) fn same_numbering_head(a: &crate::model::style::NumberingHead, b: &crate::model::style::NumberingHead) -> bool {
    let crate::model::style::NumberingHead { attr: _, width_adjust: _, text_distance: _, char_shape_id: _, number_format: _ } = a;
    a.attr == b.attr
        && a.width_adjust == b.width_adjust
        && a.text_distance == b.text_distance
        && a.char_shape_id == b.char_shape_id
        && a.number_format == b.number_format
}

pub(crate) fn same_numbering(a: &crate::model::style::Numbering, b: &crate::model::style::Numbering) -> bool {
    let crate::model::style::Numbering { raw_data: _, heads: _, level_formats: _, start_number: _, level_start_numbers: _, raw_para_heads: _ } = a;
    a.raw_data == b.raw_data
        && a.heads.iter().zip(&b.heads).all(|(a,b)| same_numbering_head(a,b))
        && a.level_formats == b.level_formats
        && a.start_number == b.start_number
        && a.level_start_numbers == b.level_start_numbers
        && a.raw_para_heads == b.raw_para_heads
}

pub(crate) fn same_bullet(a: &crate::model::style::Bullet, b: &crate::model::style::Bullet) -> bool {
    let crate::model::style::Bullet { raw_data: _, attr: _, width_adjust: _, text_distance: _, char_shape_id: _, bullet_char: _, image_bullet: _, image_data: _, check_bullet_char: _, raw_para_head: _ } = a;
    a.raw_data == b.raw_data
        && a.attr == b.attr
        && a.width_adjust == b.width_adjust
        && a.text_distance == b.text_distance
        && a.char_shape_id == b.char_shape_id
        && a.bullet_char == b.bullet_char
        && a.image_bullet == b.image_bullet
        && a.image_data == b.image_data
        && a.check_bullet_char == b.check_bullet_char
        && a.raw_para_head == b.raw_para_head
}


/// 현재 source/formatter 검증 뒤에만 생성하는 비직렬화 mixed 압축 원점.
/// 저장 vpos는 원본 비교에 남기고, 조각의 진행 좌표는 별도로 운반한다.
#[derive(Debug, Clone)]
pub(crate) struct CompactMixedRows {
    rows: Vec<crate::model::paragraph::LineSeg>,
    owners: Vec<(usize, usize)>,
    origin: crate::document_core::endnote_tac::RowOrigin,
    line_width: f64,
    dpi: f64,
    origins: Vec<f64>,
    advances: Vec<f64>,
}

impl CompactMixedRows {
    pub(crate) fn new(
        original: &crate::model::paragraph::Paragraph,
        projected: &crate::model::paragraph::Paragraph,
        composed: &crate::renderer::composer::ComposedParagraph,
        heights: &[f64], spacings: &[f64],
        origin: crate::document_core::endnote_tac::RowOrigin,
        line_width: f64, dpi: f64,
    ) -> Option<Self> {
        if !crate::document_core::endnote_tac::mixed_supported(projected)
            || !dpi.is_finite() || dpi <= 0.0 || !line_width.is_finite() || line_width <= 0.0
            || original.line_segs.len() != projected.line_segs.len()
            || !original.line_segs.iter().zip(&projected.line_segs)
                .any(|(a, b)| a.line_spacing != b.line_spacing)
            || heights.len() != projected.line_segs.len()
            || spacings.len() != heights.len() || composed.lines.len() != heights.len()
        { return None; }
        let owners = crate::document_core::endnote_tac::current_owners(projected, composed)?;
        let mut origins = Vec::new(); let mut advances = Vec::new(); let mut y = 0.0;
        for (((seg, line), &height), &spacing) in projected.line_segs.iter()
            .zip(&composed.lines).zip(heights).zip(spacings) {
            let h = crate::renderer::hwpunit_to_px(seg.line_height, dpi);
            let s = crate::renderer::hwpunit_to_px(seg.line_spacing, dpi);
            if seg.line_height <= 0 || seg.line_spacing != -(seg.line_height / 10)
                || line.line_height != seg.line_height || line.line_spacing != seg.line_spacing
                || !height.is_finite() || !spacing.is_finite()
                || (height - h).abs() > 1e-6 || (spacing - s).abs() > 1e-6
            { return None; }
            let advance = height + spacing;
            if !advance.is_finite() || advance <= 0.0 { return None; }
            origins.push(y); advances.push(advance); y += advance;
            if !y.is_finite() { return None; }
        }
        Some(Self { rows: projected.line_segs.clone(), owners, origin, line_width, dpi,
            origins, advances })
    }

    pub(crate) fn matches(
        &self, para: &crate::model::paragraph::Paragraph,
        composed: &crate::renderer::composer::ComposedParagraph,
        owners: &[(usize, usize)], origin: crate::document_core::endnote_tac::RowOrigin,
        styles: &crate::renderer::style_resolver::ResolvedStyleSet,
        width: f64, dpi: f64,
    ) -> bool {
        let width = crate::document_core::DocumentCore::column_line_width_px(
            width, para.para_shape_id, styles, dpi);
        dpi == self.dpi && origin == self.origin && width.is_finite()
            && (match origin {
                crate::document_core::endnote_tac::RowOrigin::Loaded => (width - self.line_width).abs() < 1e-6,
                crate::document_core::endnote_tac::RowOrigin::Reflowed => width + 1e-6 >= self.line_width,
            })
            && owners == self.owners.as_slice()
            && composed.projected_tac_line_owners.as_deref() == Some(owners)
            && para.line_segs.len() == self.rows.len() && composed.lines.len() == self.rows.len()
            && para.line_segs.iter().zip(&self.rows).all(|(a,b)| {
                let delta = i64::from(a.vertical_pos) - i64::from(b.vertical_pos);
                let first_delta = i64::from(para.line_segs[0].vertical_pos)
                    - i64::from(self.rows[0].vertical_pos);
                let mut row = a.clone(); row.vertical_pos = b.vertical_pos;
                delta == first_delta && same_line_seg(&row,b)
            })
            && composed.lines.iter().zip(&self.rows).all(|(a,b)|
                a.line_height == b.line_height && a.line_spacing == b.line_spacing)
    }

    pub(crate) fn origin(&self, row: usize) -> f64 { self.origins[row] }
    pub(crate) fn advance(&self, row: usize) -> f64 { self.advances[row] }
    pub(crate) fn advances(&self) -> &[f64] { &self.advances }
}
