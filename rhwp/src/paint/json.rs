use std::fmt::Write as _;

use base64::Engine;

use crate::document_core::helpers::{color_ref_to_css, json_escape as raw_json_escape};
use crate::model::control::FormType;
use crate::model::image::ImageEffect;
use crate::model::style::{ImageFillMode, UnderlineType};
use crate::paint::ResourceArena;
use crate::paint::{
    BitmapGlyphPayload, CacheHint, ClipKind, ColorLayerNode, ColorLayersPayload,
    ColorPaintGraphNode, ColorPaintGraphPayload, FontColorGlyphRef, FontResourceTable,
    GlyphCluster, GlyphOutlinePayloadKind, GlyphOutlineStrokeStyle, GlyphRunDiagnostics,
    GlyphTransform, GroupKind, LayerAffineTransform, LayerGlyphOutlinePath, LayerNode,
    LayerNodeKind, LayerPoint, LayerVector, PageLayerTree, PaintOp, PaintTextStyle,
    PaintVariantMeta, PaletteRef, RenderProfile, ResolvedColor, ResolvedImageKind, ShapeKey,
    SvgGlyphPayload, TextDecorationKind, TextSourceAnnotation, TextSourceEntry, TextSourceId,
    TextSourceRange, TextSourceSpan, TextSourceTable, TextV2Diagnostics, LAYER_TREE_SCHEMA,
};
use crate::renderer::composer::expand_pua_display_text;
use crate::renderer::equation::ast::MatrixStyle;
use crate::renderer::equation::layout::{LayoutBox, LayoutKind};
use crate::renderer::equation::symbols::{DecoKind, FontStyleKind};
use crate::renderer::layout::compute_char_positions;
use crate::renderer::render_tree::{
    BoundingBox, FieldMarkerType, RenderLayerInfo, ShapeTransform, TextRunNode,
};
use crate::renderer::{
    clamp_tab_leader_end_x, ArrowStyle, GradientFillInfo, LineRenderType, LineStyle, PathCommand,
    PatternFillInfo, ShadowStyle, ShapeStyle, StrokeDash, TabLeaderInfo, TextStyle,
};

const KNOWN_TEXT_FEATURES: &[&str] = &[
    "fontResources",
    "fontResources.blobFaceSplit",
    "text.variantGroups",
    "text.shapeDiagnostics",
    "text.v2.diagnostics",
    "text.v2.slotDiagnostics",
    "text.v2.validationIssues",
    "text.lineBreakRiskTelemetry",
    "text.fallbackFreeStrictProfile",
    "text.glyphRun",
    "text.outlineGlyph",
    "text.glyphOutline",
    "text.glyphOutline.strictSidecar",
    "text.glyphOutline.monochromeFill",
    "text.glyphOutline.monochromeFillStroke",
    "text.glyphOutline.colorLayers",
    "text.glyphOutline.colorLayers.colrV0",
    "text.glyphOutline.colorLayers.colrV1",
    "text.glyphOutline.bitmapGlyph",
    "text.glyphOutline.svgGlyph",
    "text.glyphOutline.svgGlyph.vectorResourceId",
    "text.glyphOutline.payloadResourceKey",
    "text.glyphOutline.payloadResourceDigestKey",
    "text.specialVisualOps",
    "text.charOverlapOp",
    "text.charOverlapOp.bounded",
    "text.controlMarkOp",
    "text.controlMarkOp.positioned",
    "text.controlMarkOp.bounded",
    "text.tabLeaderOp",
    "text.tabLeaderOp.bounded",
    "text.decorationOp",
    "text.decorationOp.bounded",
    "text.displayText",
    "text.vertical.mixedPerGlyph",
];

impl PageLayerTree {
    pub fn to_json(&self) -> String {
        let mut buf = String::with_capacity(32_768);
        buf.push('{');
        let _ = write!(
            buf,
            "\"schemaVersion\":{},\"schemaMinorVersion\":{},\"schema\":{{\"major\":{},\"minor\":{}}},\"resourceTableVersion\":{},\"resourceTableMinorVersion\":{},\"resourceTable\":{{\"major\":{},\"minor\":{}}},\"unit\":{},\"coordinateSystem\":{},\"profile\":{},\"buildOptions\":{{\"showTransparentBorders\":{},\"clipEnabled\":{}}},\"debugOptions\":{{\"debugOverlay\":{}}},\"outputOptions\":{{\"showParagraphMarks\":{},\"showControlCodes\":{},\"showTransparentBorders\":{},\"clipEnabled\":{},\"debugOverlay\":{}}},\"pageWidth\":{:.3},\"pageHeight\":{:.3},\"root\":",
            LAYER_TREE_SCHEMA.schema_version,
            LAYER_TREE_SCHEMA.schema_minor_version,
            LAYER_TREE_SCHEMA.schema_version,
            LAYER_TREE_SCHEMA.schema_minor_version,
            LAYER_TREE_SCHEMA.resource_table_version,
            LAYER_TREE_SCHEMA.resource_table_minor_version,
            LAYER_TREE_SCHEMA.resource_table_version,
            LAYER_TREE_SCHEMA.resource_table_minor_version,
            json_escape(LAYER_TREE_SCHEMA.unit),
            json_escape(LAYER_TREE_SCHEMA.coordinate_system),
            json_escape(render_profile_str(self.profile)),
            self.output_options.show_transparent_borders,
            self.output_options.clip_enabled,
            self.output_options.debug_overlay,
            self.output_options.show_paragraph_marks,
            self.output_options.show_control_codes,
            self.output_options.show_transparent_borders,
            self.output_options.clip_enabled,
            self.output_options.debug_overlay,
            self.page_width,
            self.page_height
        );
        let mut text_source_state = TextSourceExportState::default();
        self.root
            .write_json(&mut buf, &mut text_source_state, &self.resources);
        buf.push_str(",\"textSources\":");
        write_text_source_entries(&mut buf, &self.text_sources);
        buf.push_str(",\"fontResources\":");
        write_font_resources(&mut buf, self.resources.font_resources());
        buf.push_str(",\"resources\":");
        write_visual_resources(&mut buf, &self.resources);
        write_text_export_metadata(&mut buf, &self.root, &self.resources);
        buf.push_str(",\"textV2\":");
        TextV2Diagnostics::from_layer_tree(self).write_json(&mut buf);
        buf.push('}');
        buf
    }
}

fn write_text_export_metadata(buf: &mut String, root: &LayerNode, resources: &ResourceArena) {
    let externalized_visuals = externalized_text_visuals(root);
    let text_variant_features = collect_text_variant_features(root, resources);
    let has_variant_groups = text_variant_features.has_variant_groups();
    let has_glyph_runs = text_variant_features.has_glyph_runs;
    let has_glyph_outlines = text_variant_features.has_glyph_outlines;
    let has_glyph_outline_color_layers = text_variant_features.has_glyph_outline_color_layers;
    let has_glyph_outline_bitmap = text_variant_features.has_glyph_outline_bitmap;
    let has_glyph_outline_svg = text_variant_features.has_glyph_outline_svg;
    let has_glyph_outline_payload_resource_keys =
        text_variant_features.has_glyph_outline_payload_resource_keys;
    let has_glyph_outline_payload_resource_digest_keys =
        text_variant_features.has_glyph_outline_payload_resource_digest_keys;
    let has_display_text = text_variant_features.has_display_text;
    buf.push_str(",\"usedFeatures\":[\"text.paintStyle\",\"text.sourceTable\",\"text.sourceSpan\",\"text.v2.placement\",\"text.v2.clusters\",\"text.v2.diagnostics\",\"text.projectionKind\",\"text.legacyVisuals\",\"layer.optionMetadata\"");
    if has_display_text {
        buf.push_str(",\"text.displayText\"");
    }
    if has_glyph_runs || has_glyph_outlines {
        buf.push_str(",\"fontResources\"");
    }
    if has_glyph_runs {
        buf.push_str(",\"text.glyphRun\"");
    }
    if has_glyph_outlines {
        buf.push_str(",\"text.glyphOutline\",\"text.glyphOutline.strictSidecar\"");
    }
    if has_glyph_outline_color_layers {
        buf.push_str(",\"text.glyphOutline.colorLayers\"");
    }
    if has_glyph_outline_bitmap {
        buf.push_str(",\"text.glyphOutline.bitmapGlyph\"");
    }
    if has_glyph_outline_svg {
        buf.push_str(",\"text.glyphOutline.svgGlyph\"");
        buf.push_str(",\"text.glyphOutline.svgGlyph.vectorResourceId\"");
    }
    if has_glyph_outline_payload_resource_keys {
        buf.push_str(",\"text.glyphOutline.payloadResourceKey\"");
    }
    if has_glyph_outline_payload_resource_digest_keys {
        buf.push_str(",\"text.glyphOutline.payloadResourceDigestKey\"");
    }
    if has_variant_groups {
        buf.push_str(",\"text.variantGroups\"");
    }
    if externalized_visuals.contains(&"charOverlap") {
        buf.push_str(",\"text.charOverlapOp\",\"text.charOverlapOp.bounded\"");
    }
    if externalized_visuals.contains(&"controlMarks") {
        buf.push_str(",\"text.controlMarkOp\",\"text.controlMarkOp.positioned\",\"text.controlMarkOp.bounded\"");
    }
    if externalized_visuals.contains(&"tabLeaders") {
        buf.push_str(",\"text.tabLeaderOp\",\"text.tabLeaderOp.bounded\"");
    }
    if externalized_visuals.contains(&"decorations") {
        buf.push_str(",\"text.decorationOp\",\"text.decorationOp.bounded\"");
    }
    let mut optional_features = Vec::new();
    if has_glyph_runs || has_glyph_outlines {
        optional_features.push("fontResources");
    }
    if has_glyph_runs {
        optional_features.push("text.glyphRun");
    }
    if has_glyph_outlines {
        optional_features.push("text.glyphOutline");
        optional_features.push("text.glyphOutline.strictSidecar");
    }
    if has_glyph_outline_color_layers {
        optional_features.push("text.glyphOutline.colorLayers");
    }
    if has_glyph_outline_bitmap {
        optional_features.push("text.glyphOutline.bitmapGlyph");
    }
    if has_glyph_outline_svg {
        optional_features.push("text.glyphOutline.svgGlyph");
        optional_features.push("text.glyphOutline.svgGlyph.vectorResourceId");
    }
    if has_glyph_outline_payload_resource_keys {
        optional_features.push("text.glyphOutline.payloadResourceKey");
    }
    if has_glyph_outline_payload_resource_digest_keys {
        optional_features.push("text.glyphOutline.payloadResourceDigestKey");
    }
    buf.push_str("],\"optionalFeatures\":[");
    for (idx, feature) in optional_features.iter().enumerate() {
        if idx > 0 {
            buf.push(',');
        }
        buf.push_str(&json_escape(feature));
    }
    buf.push_str("],\"knownFeatures\":[");
    for (idx, feature) in KNOWN_TEXT_FEATURES.iter().enumerate() {
        if idx > 0 {
            buf.push(',');
        }
        buf.push_str(&json_escape(feature));
    }
    buf.push_str("],\"requiredFeatures\":[],\"text\":{\"defaultVariant\":\"textRun\",\"variants\":[\"textRun\"");
    if has_glyph_runs {
        buf.push_str(",\"glyphRun\"");
    }
    if has_glyph_outlines {
        buf.push_str(",\"glyphOutline\"");
    }
    buf.push_str("],\"variantSelection\":\"exclusiveVariantSet\",\"sourceTextPreserved\":true,\"clusterEncoding\":[\"utf8\",\"utf16\"],\"fallbackRequired\":true,\"placementAuthority\":\"compatibilityProjection\",\"externalizedVisuals\":[");
    for (idx, visual) in externalized_visuals.iter().enumerate() {
        if idx > 0 {
            buf.push(',');
        }
        buf.push_str(&json_escape(visual));
    }
    buf.push_str("]}");
}

#[derive(Debug, Clone, Copy, Default)]
struct TextVariantFeatureFlags {
    has_glyph_runs: bool,
    has_glyph_outlines: bool,
    has_glyph_outline_color_layers: bool,
    has_glyph_outline_bitmap: bool,
    has_glyph_outline_svg: bool,
    has_glyph_outline_payload_resource_keys: bool,
    has_glyph_outline_payload_resource_digest_keys: bool,
    has_display_text: bool,
}

impl TextVariantFeatureFlags {
    fn has_variant_groups(self) -> bool {
        self.has_glyph_runs || self.has_glyph_outlines
    }
}

fn collect_text_variant_features(
    root: &LayerNode,
    resources: &ResourceArena,
) -> TextVariantFeatureFlags {
    let mut features = TextVariantFeatureFlags::default();
    let mut stack = vec![root];
    while let Some(node) = stack.pop() {
        match &node.kind {
            LayerNodeKind::Group { children, .. } => {
                for child in children {
                    stack.push(child);
                }
            }
            LayerNodeKind::ClipRect { child, .. } => stack.push(child),
            LayerNodeKind::Leaf { ops } => {
                for op in ops {
                    match op {
                        PaintOp::TextRun { run, .. } => {
                            features.has_display_text |= display_text_for_text_run(run).is_some()
                        }
                        PaintOp::GlyphRun { .. } => features.has_glyph_runs = true,
                        PaintOp::GlyphOutline { outline, .. } => {
                            features.has_glyph_outlines = true;
                            features.has_glyph_outline_color_layers |= matches!(
                                outline.payload_kind,
                                GlyphOutlinePayloadKind::ColorLayers
                            );
                            features.has_glyph_outline_bitmap |= matches!(
                                outline.payload_kind,
                                GlyphOutlinePayloadKind::BitmapGlyph
                            );
                            features.has_glyph_outline_svg |=
                                matches!(outline.payload_kind, GlyphOutlinePayloadKind::SvgGlyph);
                            features.has_glyph_outline_payload_resource_keys |=
                                outline.has_payload_resource_key();
                            features.has_glyph_outline_payload_resource_digest_keys |=
                                has_payload_resource_digest_key(outline, resources);
                        }
                        _ => {}
                    }
                }
            }
        }
        if features.has_glyph_runs
            && features.has_glyph_outlines
            && features.has_glyph_outline_color_layers
            && features.has_glyph_outline_bitmap
            && features.has_glyph_outline_svg
            && features.has_glyph_outline_payload_resource_keys
            && features.has_glyph_outline_payload_resource_digest_keys
            && features.has_display_text
        {
            return features;
        }
    }
    features
}

fn has_payload_resource_digest_key(
    outline: &crate::paint::LayerGlyphOutlinePaint,
    resources: &ResourceArena,
) -> bool {
    if !outline.has_payload_resource_key() {
        return false;
    }
    match outline.payload_kind {
        GlyphOutlinePayloadKind::BitmapGlyph => outline
            .bitmap_glyph
            .as_ref()
            .is_some_and(|payload| resources.image_bytes(payload.image_ref).is_some()),
        GlyphOutlinePayloadKind::SvgGlyph => outline
            .svg_glyph
            .as_ref()
            .is_some_and(|payload| resources.svg_fragment(payload.svg_ref).is_some()),
        GlyphOutlinePayloadKind::ColorLayers
        | GlyphOutlinePayloadKind::MonochromeFill
        | GlyphOutlinePayloadKind::MonochromeFillStroke => false,
    }
}

fn externalized_text_visuals(root: &LayerNode) -> Vec<&'static str> {
    let mut has_char_overlap = false;
    let mut has_control_marks = false;
    let mut has_tab_leaders = false;
    let mut has_decorations = false;
    let mut stack = vec![root];
    while let Some(node) = stack.pop() {
        match &node.kind {
            LayerNodeKind::Group { children, .. } => {
                for child in children {
                    stack.push(child);
                }
            }
            LayerNodeKind::ClipRect { child, .. } => stack.push(child),
            LayerNodeKind::Leaf { ops } => {
                has_char_overlap |= ops
                    .iter()
                    .any(|op| matches!(op, PaintOp::CharOverlap { .. }));
                has_control_marks |= ops
                    .iter()
                    .any(|op| matches!(op, PaintOp::TextControlMark { .. }));
                has_tab_leaders |= ops.iter().any(|op| matches!(op, PaintOp::TabLeader { .. }));
                has_decorations |= ops
                    .iter()
                    .any(|op| matches!(op, PaintOp::TextDecoration { .. }));
            }
        }
    }
    let mut visuals = Vec::new();
    if has_char_overlap {
        visuals.push("charOverlap");
    }
    if has_control_marks {
        visuals.push("controlMarks");
    }
    if has_tab_leaders {
        visuals.push("tabLeaders");
    }
    if has_decorations {
        visuals.push("decorations");
    }
    visuals
}

impl LayerNode {
    fn write_json(
        &self,
        buf: &mut String,
        text_sources: &mut TextSourceExportState,
        resources: &ResourceArena,
    ) {
        buf.push('{');
        buf.push_str("\"bounds\":");
        write_bbox(buf, self.bounds);
        if let Some(source_node_id) = self.source_node_id {
            let _ = write!(buf, ",\"sourceNodeId\":{}", source_node_id);
        }
        if let Some(layer) = self.layer {
            buf.push_str(",\"layer\":");
            write_render_layer_info(buf, layer);
        }

        match &self.kind {
            LayerNodeKind::Group {
                children,
                cache_hint,
                group_kind,
            } => {
                buf.push_str(",\"kind\":\"group\",\"groupKind\":");
                write_group_kind(buf, group_kind);
                let _ = write!(
                    buf,
                    ",\"cacheHint\":{},\"children\":[",
                    json_escape(cache_hint_str(*cache_hint))
                );
                for (idx, child) in children.iter().enumerate() {
                    if idx > 0 {
                        buf.push(',');
                    }
                    child.write_json(buf, text_sources, resources);
                }
                buf.push(']');
            }
            LayerNodeKind::ClipRect {
                clip,
                child,
                clip_kind,
            } => {
                buf.push_str(",\"kind\":\"clipRect\",\"clip\":");
                write_bbox(buf, *clip);
                let _ = write!(
                    buf,
                    ",\"clipKind\":{}",
                    json_escape(clip_kind_str(*clip_kind))
                );
                buf.push_str(",\"child\":");
                child.write_json(buf, text_sources, resources);
            }
            LayerNodeKind::Leaf { ops } => {
                buf.push_str(",\"kind\":\"leaf\",\"ops\":[");
                let leaf_visuals = LeafTextVisualOps::from_ops(ops);
                for (idx, op) in ops.iter().enumerate() {
                    if idx > 0 {
                        buf.push(',');
                    }
                    op.write_json(buf, text_sources, &leaf_visuals, resources);
                }
                buf.push(']');
            }
        }
        buf.push('}');
    }
}

impl PaintOp {
    fn write_json(
        &self,
        buf: &mut String,
        text_sources: &mut TextSourceExportState,
        leaf_visuals: &LeafTextVisualOps,
        resources: &ResourceArena,
    ) {
        match self {
            PaintOp::PageBackground { bbox, background } => {
                buf.push('{');
                buf.push_str("\"type\":\"pageBackground\",\"bbox\":");
                write_bbox(buf, *bbox);
                if let Some(color) = background.background_color {
                    let _ = write!(
                        buf,
                        ",\"backgroundColor\":{}",
                        json_escape(&color_ref_to_css(color))
                    );
                }
                if let Some(color) = background.border_color {
                    let _ = write!(
                        buf,
                        ",\"borderColor\":{}",
                        json_escape(&color_ref_to_css(color))
                    );
                }
                let _ = write!(buf, ",\"borderWidth\":{:.3}", background.border_width);
                if let Some(gradient) = &background.gradient {
                    buf.push_str(",\"gradient\":");
                    write_gradient(buf, gradient, None);
                }
                if let Some(image) = &background.image {
                    // 밝기·대비는 한컴 방식으로 구운 픽셀을 내보낸다 (Studio 는 효과를 따로
                    // 적용하지 않는다).
                    let baked = crate::renderer::image_resolver::hancom_adjusted_picture_png_bytes(
                        &image.data,
                        image.effect,
                        image.brightness,
                        image.contrast,
                    );
                    let base64_data = base64::engine::general_purpose::STANDARD
                        .encode(baked.as_deref().unwrap_or(&image.data));
                    let _ = write!(
                        buf,
                        ",\"image\":{{\"fillMode\":{},\"base64\":{}}}",
                        json_escape(image_fill_mode_str(image.fill_mode)),
                        json_escape(&base64_data),
                    );
                }
                buf.push('}');
            }
            PaintOp::TextRun { bbox, run } => {
                buf.push('{');
                buf.push_str("\"type\":\"textRun\",\"bbox\":");
                write_bbox(buf, *bbox);
                let source = text_sources.next_text_run_span(run);
                let display_text = display_text_for_text_run(run);
                let _ = write!(
                    buf,
                    ",\"text\":{},\"baseline\":{:.3},\"rotation\":{:.3},\"isVertical\":{},\"orientation\":{},\"projectionKind\":{},\"clusterBasis\":\"legacyPosition\"",
                    json_escape(&run.text),
                    // 글자 위치(%) 기준선 이동 — CanvasKit 재생은 이 baseline 을 그대로 쓴다.
                    run.baseline + explicit_char_offset_dy(&run.style)
                        .unwrap_or(run.style.font_size * run.style.char_offset),
                    run.rotation,
                    run.is_vertical,
                    json_escape(text_orientation_str(run)),
                    json_escape(text_projection_kind_str(run)),
                );
                if let Some(copy) = crate::renderer::hft_vertical_bold_copy(
                    &run.style,
                    run.display_or_text(),
                    run.is_vertical && run.rotation == 0.0 && run.char_overlap.is_none(),
                ) {
                    let _ = write!(
                        buf,
                        ",\"hftVerticalBoldCopy\":{{\"offsetY\":{:.3},\"emboldenX\":{:.3}",
                        copy.offset_y, copy.embolden_x,
                    );
                    if copy.rotation != 0.0 {
                        let _ = write!(
                            buf,
                            ",\"offsetX\":{:.3},\"rotation\":{:.3}",
                            copy.offset_x, copy.rotation,
                        );
                    }
                    buf.push('}');
                }
                if let Some(display_text) = &display_text {
                    let _ = write!(buf, ",\"displayText\":{}", json_escape(display_text));
                }
                buf.push_str(",\"placement\":");
                write_text_run_placement(buf, *bbox, run);
                buf.push_str(",\"clusters\":");
                write_text_clusters(buf, run);
                buf.push_str(",\"source\":");
                write_text_source_span(buf, &source);
                if let Some(equivalence_group) = leaf_visuals.variant_group_for_source(source.id) {
                    buf.push_str(",\"variant\":");
                    write_paint_variant_meta(
                        buf,
                        &PaintVariantMeta::text_run_default(equivalence_group),
                    );
                }
                buf.push_str(",\"style\":");
                write_text_style(buf, &run.style);
                buf.push_str(",\"paintStyle\":");
                write_text_style(buf, &run.style);
                write_text_legacy_visuals(buf, run, leaf_visuals);
                if leaf_visuals.control_marks {
                    buf.push_str(",\"controlMarks\":");
                    let complete = write_text_control_marks(buf, *bbox, run);
                    let _ = write!(buf, ",\"controlMarksComplete\":{complete}");
                }
                buf.push_str(",\"positions\":");
                write_text_positions(buf, run);
                if let Some(display_text) = &display_text {
                    buf.push_str(",\"displayPositions\":");
                    if display_text.is_empty() {
                        buf.push_str("[]");
                    } else {
                        write_text_positions_for_text(buf, display_text, &run.style);
                    }
                }
                write_glyph_offsets(
                    buf,
                    display_text.as_deref().unwrap_or(&run.text),
                    &run.style,
                );
                write_nonprinting_spaces(
                    buf,
                    &run.text,
                    display_text.as_deref().unwrap_or(&run.text),
                    &run.style,
                );
                if !run.style.tab_leaders.is_empty() {
                    buf.push_str(",\"tabLeaders\":");
                    write_tab_leaders(buf, &run.style.tab_leaders);
                }
                let _ = write!(
                    buf,
                    ",\"isParaEnd\":{},\"isLineBreakEnd\":{},\"fieldMarker\":",
                    run.is_para_end, run.is_line_break_end,
                );
                write_field_marker(buf, run.field_marker);
                buf.push_str(",\"charOverlap\":");
                write_char_overlap(buf, run.char_overlap.as_ref());
                buf.push('}');
            }
            PaintOp::GlyphRun { bbox, run } => {
                buf.push('{');
                buf.push_str("\"type\":\"glyphRun\",\"bbox\":");
                write_bbox(buf, *bbox);
                buf.push_str(",\"source\":");
                write_text_source_span(buf, &run.source);
                buf.push_str(",\"variant\":");
                write_paint_variant_meta(buf, &run.variant);
                buf.push_str(",\"paintStyle\":");
                write_paint_text_style(buf, &run.paint_style);
                buf.push_str(",\"shapeKey\":");
                write_shape_key(buf, &run.shape_key);
                buf.push_str(",\"placement\":");
                write_text_run_placement_value(buf, run.placement);
                buf.push_str(",\"glyphIds\":[");
                for (idx, glyph_id) in run.glyph_ids.iter().enumerate() {
                    if idx > 0 {
                        buf.push(',');
                    }
                    let _ = write!(buf, "{}", glyph_id);
                }
                buf.push_str("],\"positions\":");
                write_points(buf, &run.positions);
                if let Some(advances) = &run.advances {
                    buf.push_str(",\"advances\":");
                    write_vectors(buf, advances);
                }
                buf.push_str(",\"clusters\":");
                write_glyph_clusters(buf, &run.clusters);
                let _ = write!(
                    buf,
                    ",\"direction\":{},\"writingMode\":{},\"orientation\":{}",
                    json_escape(run.direction.as_str()),
                    json_escape(run.writing_mode.as_str()),
                    json_escape(run.orientation.as_str()),
                );
                if let Some(bidi_level) = run.bidi_level {
                    let _ = write!(buf, ",\"bidiLevel\":{}", bidi_level);
                }
                if let Some(transforms) = &run.glyph_transforms {
                    buf.push_str(",\"glyphTransforms\":");
                    write_glyph_transforms(buf, transforms);
                }
                buf.push_str(",\"diagnostics\":");
                write_glyph_run_diagnostics(buf, &run.diagnostics);
                buf.push('}');
            }
            PaintOp::GlyphOutline { bbox, outline } => {
                buf.push('{');
                buf.push_str("\"type\":\"glyphOutline\",\"bbox\":");
                write_bbox(buf, *bbox);
                buf.push_str(",\"source\":");
                write_text_source_span(buf, &outline.source);
                buf.push_str(",\"variant\":");
                write_paint_variant_meta(buf, &outline.variant);
                let _ = write!(
                    buf,
                    ",\"payloadKind\":{}",
                    json_escape(outline.payload_kind.as_str())
                );
                if let Some(payload_resource_key) =
                    outline.payload_resource_key_with_resources(Some(resources))
                {
                    let _ = write!(
                        buf,
                        ",\"payloadResourceKey\":{}",
                        json_escape(&payload_resource_key)
                    );
                }
                buf.push_str(",\"paintStyle\":");
                write_paint_text_style(buf, &outline.paint_style);
                buf.push_str(",\"placement\":");
                write_text_run_placement_value(buf, outline.placement);
                buf.push_str(",\"paths\":");
                write_glyph_outline_paths(buf, &outline.paths);
                if let Some(stroke) = &outline.stroke {
                    buf.push_str(",\"stroke\":");
                    write_glyph_outline_stroke(buf, stroke);
                }
                if let Some(color_layers) = &outline.color_layers {
                    buf.push_str(",\"colorLayers\":");
                    write_color_layers_payload(buf, color_layers);
                }
                if let Some(bitmap_glyph) = &outline.bitmap_glyph {
                    buf.push_str(",\"bitmapGlyph\":");
                    write_bitmap_glyph_payload(buf, bitmap_glyph);
                }
                if let Some(svg_glyph) = &outline.svg_glyph {
                    buf.push_str(",\"svgGlyph\":");
                    write_svg_glyph_payload(buf, svg_glyph);
                }
                buf.push_str(",\"diagnostics\":");
                write_glyph_run_diagnostics(buf, &outline.diagnostics);
                buf.push('}');
            }
            PaintOp::CharOverlap { bbox, run } => {
                buf.push('{');
                buf.push_str("\"type\":\"charOverlap\",\"bbox\":");
                write_bbox(buf, *bbox);
                if let Some(source) = text_sources.last_source.as_ref() {
                    buf.push_str(",\"source\":");
                    write_text_source_span(buf, source);
                }
                let _ = write!(
                    buf,
                    ",\"text\":{},\"baseline\":{:.3},\"rotation\":{:.3},\"isVertical\":{},\"orientation\":{}",
                    json_escape(&run.text),
                    run.baseline,
                    run.rotation,
                    run.is_vertical,
                    json_escape(text_orientation_str(run)),
                );
                buf.push_str(",\"style\":");
                write_text_style(buf, &run.style);
                buf.push_str(",\"paintStyle\":");
                write_text_style(buf, &run.style);
                buf.push_str(",\"positions\":");
                let complete = write_bounded_text_positions(buf, &run.text, &run.style);
                let _ = write!(buf, ",\"positionsComplete\":{complete}");
                buf.push_str(",\"charOverlap\":");
                write_char_overlap(buf, run.char_overlap.as_ref());
                buf.push('}');
            }
            PaintOp::TextControlMark { bbox, run } => {
                buf.push('{');
                buf.push_str("\"type\":\"textControlMark\",\"bbox\":");
                write_bbox(buf, *bbox);
                if let Some(source) = text_sources.last_source.as_ref() {
                    buf.push_str(",\"source\":");
                    write_text_source_span(buf, source);
                }
                let _ = write!(
                    buf,
                    ",\"fieldMarker\":{},\"isParaEnd\":{},\"isLineBreakEnd\":{},\"baseline\":{:.3},\"rotation\":{:.3},\"isVertical\":{},\"marks\":",
                    json_escape(field_marker_str(run.field_marker)),
                    run.is_para_end,
                    run.is_line_break_end,
                    run.baseline,
                    run.rotation,
                    run.is_vertical,
                );
                let complete = write_text_control_marks(buf, *bbox, run);
                let _ = write!(buf, ",\"marksComplete\":{complete}");
                if let FieldMarkerType::ShapeMarker(index) = run.field_marker {
                    let _ = write!(buf, ",\"shapeMarkerIndex\":{}", index);
                }
                buf.push('}');
            }
            PaintOp::TabLeader { bbox, run } => {
                buf.push('{');
                buf.push_str("\"type\":\"tabLeader\",\"bbox\":");
                write_bbox(buf, *bbox);
                if let Some(source) = text_sources.last_source.as_ref() {
                    buf.push_str(",\"source\":");
                    write_text_source_span(buf, source);
                }
                buf.push_str(",\"leaders\":");
                let complete = write_clamped_tab_leaders(buf, run);
                let (font_size, baseline) = effective_text_font_size_and_baseline(run);
                let _ = write!(
                    buf,
                    ",\"leadersComplete\":{},\"color\":{},\"fontSize\":{:.3},\"baseline\":{:.3},\"rotation\":{:.3},\"isVertical\":{}}}",
                    complete,
                    json_escape(&color_ref_to_css(run.style.color)),
                    font_size,
                    baseline,
                    run.rotation,
                    run.is_vertical,
                );
            }
            PaintOp::TextDecoration { bbox, run, kind } => {
                buf.push('{');
                buf.push_str("\"type\":\"textDecoration\",\"bbox\":");
                write_bbox(buf, *bbox);
                if let Some(source) = text_sources.last_source.as_ref() {
                    buf.push_str(",\"source\":");
                    write_text_source_span(buf, source);
                }
                buf.push_str(",\"decoration\":");
                write_text_decoration(buf, *kind, run);
                buf.push('}');
            }
            PaintOp::FootnoteMarker { bbox, marker } => {
                buf.push('{');
                buf.push_str("\"type\":\"footnoteMarker\",\"bbox\":");
                write_bbox(buf, *bbox);
                let font_size = (marker.base_font_size * 0.75).max(7.0);
                let baseline = marker.baseline - (marker.base_font_size - font_size) * 0.85;
                let _ = write!(
                    buf,
                    ",\"text\":{},\"fontFamily\":{},\"fontSize\":{:.3},\"baseline\":{:.3},\"bold\":{},\"color\":{}",
                    json_escape(&marker.text),
                    json_escape(&marker.font_family),
                    font_size,
                    baseline,
                    marker.bold,
                    json_escape(&color_ref_to_css(marker.color)),
                );
                buf.push('}');
            }
            PaintOp::Line { bbox, line } => {
                buf.push('{');
                buf.push_str("\"type\":\"line\",\"bbox\":");
                write_bbox(buf, *bbox);
                let _ = write!(
                    buf,
                    ",\"x1\":{:.3},\"y1\":{:.3},\"x2\":{:.3},\"y2\":{:.3},\"style\":",
                    line.x1, line.y1, line.x2, line.y2
                );
                write_line_style(buf, &line.style);
                buf.push_str(",\"transform\":");
                write_transform(buf, line.transform);
                buf.push('}');
            }
            PaintOp::Rectangle { bbox, rect } => {
                buf.push('{');
                buf.push_str("\"type\":\"rectangle\",\"bbox\":");
                write_bbox(buf, *bbox);
                let _ = write!(
                    buf,
                    ",\"cornerRadius\":{:.3},\"style\":",
                    rect.corner_radius
                );
                write_shape_style(buf, &rect.style);
                if let Some(gradient) = &rect.gradient {
                    buf.push_str(",\"gradient\":");
                    write_gradient(buf, gradient, Some((*bbox, rect.corner_radius)));
                }
                buf.push_str(",\"transform\":");
                write_transform(buf, rect.transform);
                buf.push('}');
            }
            PaintOp::Ellipse { bbox, ellipse } => {
                buf.push('{');
                buf.push_str("\"type\":\"ellipse\",\"bbox\":");
                write_bbox(buf, *bbox);
                buf.push_str(",\"style\":");
                write_shape_style(buf, &ellipse.style);
                if let Some(gradient) = &ellipse.gradient {
                    buf.push_str(",\"gradient\":");
                    write_gradient(buf, gradient, None);
                }
                buf.push_str(",\"transform\":");
                write_transform(buf, ellipse.transform);
                buf.push('}');
            }
            PaintOp::Path { bbox, path } => {
                buf.push('{');
                buf.push_str("\"type\":\"path\",\"bbox\":");
                write_bbox(buf, *bbox);
                buf.push_str(",\"commands\":");
                write_path_commands(buf, &path.commands);
                buf.push_str(",\"style\":");
                write_shape_style(buf, &path.style);
                if let Some(gradient) = &path.gradient {
                    buf.push_str(",\"gradient\":");
                    write_gradient(buf, gradient, None);
                }
                if let Some((x1, y1, x2, y2)) = path.connector_endpoints {
                    let _ = write!(
                        buf,
                        ",\"connectorEndpoints\":{{\"x1\":{:.3},\"y1\":{:.3},\"x2\":{:.3},\"y2\":{:.3}}}",
                        x1, y1, x2, y2
                    );
                }
                if let Some(line_style) = &path.line_style {
                    buf.push_str(",\"lineStyle\":");
                    write_line_style(buf, line_style);
                }
                buf.push_str(",\"transform\":");
                write_transform(buf, path.transform);
                buf.push('}');
            }
            PaintOp::Image {
                bbox,
                image,
                resolved,
            } => {
                buf.push('{');
                buf.push_str("\"type\":\"image\",\"bbox\":");
                write_bbox(buf, *bbox);
                if let Some(payload) = resolved.as_deref() {
                    let base64_data =
                        base64::engine::general_purpose::STANDARD.encode(&payload.data);
                    let _ = write!(
                        buf,
                        ",\"mime\":\"{}\",\"base64\":{}",
                        payload.mime,
                        json_escape(&base64_data)
                    );
                    if matches!(payload.kind, ResolvedImageKind::BakedWatermark) {
                        buf.push_str(",\"bakedWatermark\":true");
                    }
                } else if let Some(data) = &image.data {
                    // Task #516 Stage 5.2: overlay layer 의 <img> data URL 생성용 mime 노출.
                    // PCX 등 비표준은 PNG 변환 후 emit (CLI SVG 와 동일 정책 적용).
                    let mime = crate::renderer::svg::detect_image_mime_type(data);
                    let (final_mime, final_data): (&str, std::borrow::Cow<[u8]>) = if mime
                        == "image/x-pcx"
                    {
                        match crate::renderer::svg::pcx_bytes_to_png_bytes(data) {
                            Some(png) => ("image/png", std::borrow::Cow::Owned(png)),
                            None => (mime, std::borrow::Cow::Borrowed(data.as_ref())),
                        }
                    } else if mime == "image/bmp" {
                        match crate::renderer::svg::bmp_bytes_to_png_bytes(data) {
                            Some(png) => ("image/png", std::borrow::Cow::Owned(png)),
                            None => (mime, std::borrow::Cow::Borrowed(data.as_ref())),
                        }
                    } else if mime == "image/tiff" {
                        match crate::renderer::image_resolver::tiff_bytes_to_png_bytes(data) {
                            Some(png) => ("image/png", std::borrow::Cow::Owned(png)),
                            None => (mime, std::borrow::Cow::Borrowed(data.as_ref())),
                        }
                    } else if mime == "image/jpeg" {
                        match crate::renderer::image_resolver::grayscale_jpeg_bytes_to_png_bytes(
                            data,
                        ) {
                            Some(png) => ("image/png", std::borrow::Cow::Owned(png)),
                            None => (mime, std::borrow::Cow::Borrowed(data.as_ref())),
                        }
                    } else {
                        (mime, std::borrow::Cow::Borrowed(data.as_ref()))
                    };
                    let base64_data =
                        base64::engine::general_purpose::STANDARD.encode(&*final_data);
                    let _ = write!(
                        buf,
                        ",\"mime\":\"{}\",\"base64\":{}",
                        final_mime,
                        json_escape(&base64_data)
                    );
                }
                if let Some(fill_mode) = image.fill_mode {
                    let _ = write!(
                        buf,
                        ",\"fillMode\":{}",
                        json_escape(image_fill_mode_str(fill_mode))
                    );
                }
                if let Some((width, height)) = image.original_size {
                    let _ = write!(
                        buf,
                        ",\"originalSize\":{{\"width\":{:.3},\"height\":{:.3}}}",
                        width, height
                    );
                }
                if let Some((left, top, right, bottom)) = image.crop {
                    let _ = write!(
                        buf,
                        ",\"crop\":{{\"left\":{},\"top\":{},\"right\":{},\"bottom\":{}}}",
                        left, top, right, bottom
                    );
                }
                if let Some((width, height)) = image.original_size_hu {
                    let _ = write!(buf, ",\"originalSizeHu\":[{},{}]", width, height);
                }
                let _ = write!(
                    buf,
                    ",\"effect\":{},\"brightness\":{},\"contrast\":{}",
                    json_escape(image_effect_str(image.effect)),
                    image.brightness,
                    image.contrast
                );
                let opacity = image.opacity.clamp(0.0, 1.0);
                if opacity < 1.0 {
                    let _ = write!(buf, ",\"opacity\":{:.6}", opacity);
                }
                if let Some(ref shadow) = image.shadow {
                    buf.push_str(",\"shadow\":");
                    buf.push_str(&serde_json::to_string(shadow).expect("finite image shadow"));
                }
                // 워터마크 메타정보 (Task #516, AI 활용)
                let attr = crate::model::image::ImageAttr {
                    brightness: image.brightness,
                    contrast: image.contrast,
                    effect: image.effect,
                    bin_data_id: image.bin_data_id,
                    transparency: 0,
                    external_path: None,
                };
                if let Some(preset) = attr.watermark_preset() {
                    let _ = write!(buf, ",\"watermark\":{{\"preset\":\"{}\"}}", preset);
                }
                // 텍스트 흐름 wrap 모드 (Task #516, 다층 레이어 분리용).
                // BehindText / InFrontOfText 인 경우 web 측이 별도 overlay layer 로 분리.
                if let Some(wrap) = image.text_wrap {
                    let _ = write!(buf, ",\"wrap\":{}", json_escape(text_wrap_str(wrap)));
                }
                buf.push_str(",\"transform\":");
                write_transform(buf, image.transform);
                buf.push('}');
            }
            PaintOp::Equation { bbox, equation } => {
                buf.push('{');
                buf.push_str("\"type\":\"equation\",\"bbox\":");
                write_bbox(buf, *bbox);
                let _ = write!(
                    buf,
                    ",\"svgContent\":{},\"color\":{},\"fontSize\":{:.6},\"fontName\":{},\"versionInfo\":{},\"layoutBox\":",
                    json_escape(&equation.svg_content),
                    json_escape(&equation.color_str),
                    equation.font_size,
                    json_escape(&equation.font_name),
                    json_escape(&equation.version_info)
                );
                write_equation_layout_box(buf, &equation.layout_box);
                buf.push('}');
            }
            PaintOp::FormObject { bbox, form } => {
                buf.push('{');
                buf.push_str("\"type\":\"formObject\",\"bbox\":");
                write_bbox(buf, *bbox);
                let _ = write!(
                    buf,
                    ",\"formType\":{},\"caption\":{},\"text\":{},\"foreColor\":{},\"backColor\":{},\"value\":{},\"enabled\":{}",
                    json_escape(form_type_str(form.form_type)),
                    json_escape(&form.caption),
                    json_escape(&form.text),
                    json_escape(&form.fore_color),
                    json_escape(&form.back_color),
                    form.value,
                    form.enabled,
                );
                buf.push('}');
            }
            PaintOp::Placeholder { bbox, placeholder } => {
                buf.push('{');
                buf.push_str("\"type\":\"placeholder\",\"bbox\":");
                write_bbox(buf, *bbox);
                let kind = match placeholder.kind {
                    crate::renderer::render_tree::PlaceholderKind::Ole => "ole",
                    crate::renderer::render_tree::PlaceholderKind::MissingPicture => {
                        "missingPicture"
                    }
                };
                let _ = write!(
                    buf,
                    ",\"kind\":\"{}\",\"fillColor\":{},\"strokeColor\":{},\"label\":{}",
                    kind,
                    json_escape(&color_ref_to_css(placeholder.fill_color)),
                    json_escape(&color_ref_to_css(placeholder.stroke_color)),
                    json_escape(&placeholder.label),
                );
                buf.push('}');
            }
            PaintOp::RawSvg { bbox, raw } => {
                buf.push('{');
                buf.push_str("\"type\":\"rawSvg\",\"bbox\":");
                write_bbox(buf, *bbox);
                let _ = write!(buf, ",\"svg\":{}", json_escape(&raw.svg));
                buf.push('}');
            }
        }
    }
}

fn write_bbox(buf: &mut String, bbox: BoundingBox) {
    let _ = write!(
        buf,
        "{{\"x\":{:.3},\"y\":{:.3},\"width\":{:.3},\"height\":{:.3}}}",
        bbox.x, bbox.y, bbox.width, bbox.height
    );
}

#[derive(Default)]
struct TextSourceExportState {
    next_id: u32,
    last_source: Option<TextSourceSpan>,
}

impl TextSourceExportState {
    fn next_text_run_span(&mut self, run: &TextRunNode) -> TextSourceSpan {
        let span = TextSourceSpan {
            id: TextSourceId(self.next_id),
            utf8_range: TextSourceRange::new(0, run.text.len() as u32),
            utf16_range: TextSourceRange::new(0, run.text.encode_utf16().count() as u32),
            stable_source_key: stable_text_source_key(run),
        };
        self.next_id = self.next_id.saturating_add(1);
        self.last_source = Some(span.clone());
        span
    }
}

#[derive(Debug, Clone, Default)]
struct LeafTextVisualOps {
    char_overlap: bool,
    control_marks: bool,
    tab_leaders: bool,
    decorations: bool,
    glyph_variant_groups: Vec<(u32, String)>,
}

impl LeafTextVisualOps {
    fn from_ops(ops: &[PaintOp]) -> Self {
        let mut visuals = Self::default();
        for op in ops {
            match op {
                PaintOp::CharOverlap { .. } => visuals.char_overlap = true,
                PaintOp::TextControlMark { .. } => visuals.control_marks = true,
                PaintOp::TabLeader { .. } => visuals.tab_leaders = true,
                PaintOp::TextDecoration { .. } => visuals.decorations = true,
                PaintOp::GlyphRun { run, .. } => visuals
                    .glyph_variant_groups
                    .push((run.source.id.0, run.variant.equivalence_group.clone())),
                PaintOp::GlyphOutline { outline, .. } => visuals.glyph_variant_groups.push((
                    outline.source.id.0,
                    outline.variant.equivalence_group.clone(),
                )),
                _ => {}
            }
        }
        visuals
    }

    fn variant_group_for_source(&self, source: TextSourceId) -> Option<String> {
        self.glyph_variant_groups
            .iter()
            .find_map(|(id, group)| (*id == source.0).then(|| group.clone()))
    }
}

fn stable_text_source_key(run: &TextRunNode) -> Option<String> {
    let section = run.section_index?;
    let para = run.para_index?;
    let char_start = run.char_start.unwrap_or(0);
    let mut key = format!("section:{section}/para:{para}/char:{char_start}");
    if let Some(cell) = &run.cell_context {
        let path = cell
            .path
            .iter()
            .map(|entry| {
                format!(
                    "{}:{}:{}:{}",
                    entry.control_index,
                    entry.cell_index,
                    entry.cell_para_index,
                    entry.text_direction
                )
            })
            .collect::<Vec<_>>()
            .join(".");
        key.push_str("/cell:");
        key.push_str(&cell.parent_para_index.to_string());
        key.push(':');
        key.push_str(&path);
    }
    Some(key)
}

fn write_text_source_entries(buf: &mut String, table: &TextSourceTable) {
    buf.push('[');
    for (idx, entry) in table.entries.iter().enumerate() {
        if idx > 0 {
            buf.push(',');
        }
        write_text_source_entry(buf, entry);
    }
    buf.push(']');
}

fn write_font_resources(buf: &mut String, table: &FontResourceTable) {
    buf.push_str("{\"blobs\":[");
    for (idx, blob) in table.blobs.iter().enumerate() {
        if idx > 0 {
            buf.push(',');
        }
        let _ = write!(
            buf,
            "{{\"id\":{},\"source\":{},\"portability\":{}",
            json_escape(&blob.id.0),
            json_escape(blob.source.as_str()),
            json_escape(blob.portability.kind().as_str()),
        );
        if let Some(digest) = &blob.digest {
            let _ = write!(
                buf,
                ",\"digest\":{{\"algorithm\":{},\"value\":{}}}",
                json_escape(&digest.algorithm),
                json_escape(&digest.value),
            );
        }
        if let Some(data_ref) = &blob.data_ref {
            let _ = write!(
                buf,
                ",\"dataRef\":{{\"kind\":{},\"id\":{}}}",
                json_escape(data_ref.kind.as_str()),
                json_escape(&data_ref.id),
            );
        }
        buf.push('}');
    }
    buf.push_str("],\"faces\":[");
    for (idx, face) in table.faces.iter().enumerate() {
        if idx > 0 {
            buf.push(',');
        }
        let _ = write!(
            buf,
            "{{\"id\":{},\"blobKey\":{},\"faceIndex\":{}",
            json_escape(&face.id.0),
            json_escape(&face.blob_key.0),
            face.face_index,
        );
        if let Some(postscript_name) = &face.postscript_name {
            let _ = write!(buf, ",\"postscriptName\":{}", json_escape(postscript_name));
        }
        buf.push_str(",\"familyNames\":");
        write_localized_names(buf, &face.family_names);
        buf.push_str(",\"styleNames\":");
        write_localized_names(buf, &face.style_names);
        if let Some(weight_class) = face.weight_class {
            let _ = write!(buf, ",\"weightClass\":{}", weight_class);
        }
        if let Some(width_class) = face.width_class {
            let _ = write!(buf, ",\"widthClass\":{}", width_class);
        }
        if let Some(italic) = face.italic {
            let _ = write!(buf, ",\"italic\":{}", italic);
        }
        buf.push('}');
    }
    buf.push_str("]}");
}

fn write_visual_resources(buf: &mut String, resources: &ResourceArena) {
    let _ = write!(
        buf,
        "{{\"tableId\":{},\"images\":[",
        LAYER_TREE_SCHEMA.resource_table_version
    );
    for (index, (_, bytes)) in resources.image_resources().enumerate() {
        if index > 0 {
            buf.push(',');
        }
        let encoded = base64::engine::general_purpose::STANDARD.encode(bytes);
        buf.push_str(&json_escape(&encoded));
    }
    buf.push_str("],\"imageKeys\":[");
    for index in 0..resources.image_count() {
        if index > 0 {
            buf.push(',');
        }
        let key = resources
            .image_resource_key(crate::paint::ImageResourceId(index))
            .unwrap_or("");
        buf.push_str(&json_escape(key));
    }
    buf.push_str("],\"svgFragments\":[");
    for (index, (_, fragment)) in resources.svg_resources().enumerate() {
        if index > 0 {
            buf.push(',');
        }
        buf.push_str(&json_escape(fragment));
    }
    buf.push_str("],\"svgKeys\":[");
    for index in 0..resources.svg_count() {
        if index > 0 {
            buf.push(',');
        }
        let key = resources
            .svg_resource_key(crate::paint::SvgResourceId(index))
            .unwrap_or("");
        buf.push_str(&json_escape(key));
    }
    buf.push_str("]}");
}

fn write_localized_names(buf: &mut String, names: &[crate::paint::LocalizedName]) {
    buf.push('[');
    for (idx, name) in names.iter().enumerate() {
        if idx > 0 {
            buf.push(',');
        }
        let _ = write!(buf, "{{\"value\":{}", json_escape(&name.value));
        if let Some(locale) = &name.locale {
            let _ = write!(buf, ",\"locale\":{}", json_escape(locale));
        }
        buf.push('}');
    }
    buf.push(']');
}

fn write_text_source_entry(buf: &mut String, entry: &TextSourceEntry) {
    let _ = write!(
        buf,
        "{{\"id\":{},\"text\":{},\"utf8Range\":",
        entry.id.0,
        json_escape(&entry.text),
    );
    write_text_source_range(buf, entry.utf8_range);
    buf.push_str(",\"utf16Range\":");
    write_text_source_range(buf, entry.utf16_range);
    if let Some(stable_source_key) = &entry.stable_source_key {
        let _ = write!(
            buf,
            ",\"stableSourceKey\":{}",
            json_escape(stable_source_key)
        );
    }
    buf.push_str(",\"annotations\":");
    write_text_source_annotations(buf, &entry.annotations);
    buf.push('}');
}

fn write_text_source_span(buf: &mut String, span: &TextSourceSpan) {
    let _ = write!(buf, "{{\"id\":{},\"utf8Range\":", span.id.0);
    write_text_source_range(buf, span.utf8_range);
    buf.push_str(",\"utf16Range\":");
    write_text_source_range(buf, span.utf16_range);
    if let Some(stable_source_key) = &span.stable_source_key {
        let _ = write!(
            buf,
            ",\"stableSourceKey\":{}",
            json_escape(stable_source_key)
        );
    }
    buf.push('}');
}

fn write_text_source_range(buf: &mut String, range: TextSourceRange) {
    let _ = write!(buf, "{{\"start\":{},\"end\":{}}}", range.start, range.end);
}

fn write_text_source_annotations(buf: &mut String, annotations: &[TextSourceAnnotation]) {
    buf.push('[');
    for (idx, annotation) in annotations.iter().enumerate() {
        if idx > 0 {
            buf.push(',');
        }
        match annotation {
            TextSourceAnnotation::FieldMarker {
                marker,
                range_utf8,
                range_utf16,
            } => {
                let _ = write!(
                    buf,
                    "{{\"kind\":\"fieldMarker\",\"marker\":{},\"rangeUtf8\":",
                    json_escape(field_marker_str(*marker))
                );
                write_text_source_range(buf, *range_utf8);
                buf.push_str(",\"rangeUtf16\":");
                write_text_source_range(buf, *range_utf16);
                if let FieldMarkerType::ShapeMarker(index) = marker {
                    let _ = write!(buf, ",\"shapeMarkerIndex\":{}", index);
                }
                buf.push('}');
            }
            TextSourceAnnotation::ParagraphEnd {
                offset_utf8,
                offset_utf16,
            } => {
                let _ = write!(
                    buf,
                    "{{\"kind\":\"paragraphEnd\",\"offsetUtf8\":{},\"offsetUtf16\":{}}}",
                    offset_utf8, offset_utf16
                );
            }
            TextSourceAnnotation::LineBreakEnd {
                offset_utf8,
                offset_utf16,
            } => {
                let _ = write!(
                    buf,
                    "{{\"kind\":\"lineBreakEnd\",\"offsetUtf8\":{},\"offsetUtf16\":{}}}",
                    offset_utf8, offset_utf16
                );
            }
        }
    }
    buf.push(']');
}

fn write_paint_variant_meta(buf: &mut String, variant: &PaintVariantMeta) {
    let _ = write!(
        buf,
        "{{\"equivalenceGroup\":{},\"variantId\":{},\"variantKind\":{},\"partIndex\":{},\"partCount\":{},\"isDefaultFallback\":{}",
        json_escape(&variant.equivalence_group),
        json_escape(&variant.variant_id),
        json_escape(variant.variant_kind.as_str()),
        variant.part_index,
        variant.part_count,
        variant.is_default_fallback,
    );
    if !variant.requires.is_empty() {
        buf.push_str(",\"requires\":[");
        for (idx, feature) in variant.requires.iter().enumerate() {
            if idx > 0 {
                buf.push(',');
            }
            let _ = write!(buf, "{}", json_escape(feature));
        }
        buf.push(']');
    }
    if let Some(quality) = variant.quality {
        let _ = write!(buf, ",\"quality\":{}", json_escape(quality.as_str()));
    }
    if let Some(anchor_op_id) = &variant.anchor_op_id {
        let _ = write!(buf, ",\"anchorOpId\":{}", json_escape(anchor_op_id));
    }
    if let Some(local_paint_order) = variant.local_paint_order {
        let _ = write!(buf, ",\"localPaintOrder\":{}", local_paint_order);
    }
    buf.push('}');
}

fn write_group_kind(buf: &mut String, group_kind: &GroupKind) {
    match group_kind {
        GroupKind::Generic => buf.push_str("{\"kind\":\"generic\"}"),
        GroupKind::MasterPage => buf.push_str("{\"kind\":\"masterPage\"}"),
        GroupKind::Header => buf.push_str("{\"kind\":\"header\"}"),
        GroupKind::Footer => buf.push_str("{\"kind\":\"footer\"}"),
        GroupKind::Body => buf.push_str("{\"kind\":\"body\"}"),
        GroupKind::Column(index) => {
            let _ = write!(buf, "{{\"kind\":\"column\",\"index\":{}}}", index);
        }
        GroupKind::FootnoteArea => buf.push_str("{\"kind\":\"footnoteArea\"}"),
        GroupKind::TextLine(line) => {
            let _ = write!(
                buf,
                "{{\"kind\":\"textLine\",\"lineHeight\":{:.3},\"baseline\":{:.3}}}",
                line.line_height, line.baseline
            );
        }
        GroupKind::Table(table) => {
            let _ = write!(
                buf,
                "{{\"kind\":\"table\",\"rowCount\":{},\"colCount\":{},\"borderFillId\":{}}}",
                table.row_count, table.col_count, table.border_fill_id
            );
        }
        GroupKind::TableCell(cell) => {
            let _ = write!(
                buf,
                "{{\"kind\":\"tableCell\",\"row\":{},\"col\":{},\"rowSpan\":{},\"colSpan\":{},\"borderFillId\":{},\"textDirection\":{},\"clip\":{}",
                cell.row,
                cell.col,
                cell.row_span,
                cell.col_span,
                cell.border_fill_id,
                cell.text_direction,
                cell.clip
            );
            if let Some(index) = cell.model_cell_index {
                let _ = write!(buf, ",\"modelCellIndex\":{}", index);
            }
            buf.push('}');
        }
        GroupKind::TextBox => buf.push_str("{\"kind\":\"textBox\"}"),
        GroupKind::Group(group) => {
            buf.push_str("{\"kind\":\"group\"");
            if let Some(section_index) = group.section_index {
                let _ = write!(buf, ",\"sectionIndex\":{}", section_index);
            }
            if let Some(para_index) = group.para_index {
                let _ = write!(buf, ",\"paraIndex\":{}", para_index);
            }
            if let Some(control_index) = group.control_index {
                let _ = write!(buf, ",\"controlIndex\":{}", control_index);
            }
            buf.push('}');
        }
    }
}

fn cache_hint_str(value: CacheHint) -> &'static str {
    match value {
        CacheHint::None => "none",
        CacheHint::StaticSubtree => "staticSubtree",
        CacheHint::PreferRaster => "preferRaster",
        CacheHint::PreferVectorRecording => "preferVectorRecording",
    }
}

fn clip_kind_str(value: ClipKind) -> &'static str {
    match value {
        ClipKind::Body => "body",
        ClipKind::TableCell => "tableCell",
        ClipKind::TextBox => "textBox",
        ClipKind::Generic => "generic",
    }
}

/// 원본 scalar가 있는 run만 절대 위치를 싣는다. legacy JSON의 비율/기준선 계약은 유지한다.
fn explicit_char_offset_dy(style: &TextStyle) -> Option<f64> {
    (style.font_metrics_policy == crate::model::provenance::FontMetricsPolicy::HcrDeclared
        && style.native_char_position.is_some())
    .then(|| crate::renderer::char_offset_dy(style))
}

fn write_text_style(buf: &mut String, style: &TextStyle) {
    buf.push('{');
    let _ = write!(
        buf,
        "\"fontFamily\":{},\"fontSize\":{:.3},\"color\":{},\"bold\":{},\"italic\":{},\"ratio\":{:.6},\"underline\":{},\"underlineShape\":{},\"strikethrough\":{},\"strikeShape\":{},\"outlineType\":{},\"shadowType\":{},\"shadowColor\":{},\"shadowOffsetX\":{:.3},\"shadowOffsetY\":{:.3},\"emboss\":{},\"engrave\":{},\"superscript\":{},\"subscript\":{},\"underlineColor\":{},\"strikeColor\":{},\"shadeColor\":{},\"emphasisDot\":{}",
        json_escape(&style.font_family),
        style.font_size,
        json_escape(&color_ref_to_css(style.color)),
        style.paint_bold(),
        style.italic,
        style.ratio,
        json_escape(underline_type_str(style.underline)),
        style.underline_shape,
        style.strikethrough,
        style.strike_shape,
        style.outline_type,
        style.shadow_type,
        json_escape(&color_ref_to_css(style.shadow_color)),
        style.shadow_offset_x,
        style.shadow_offset_y,
        style.emboss,
        style.engrave,
        style.superscript,
        style.subscript,
        json_escape(&color_ref_to_css(style.underline_color)),
        json_escape(&color_ref_to_css(style.strike_color)),
        json_escape(&color_ref_to_css(style.shade_color)),
        style.emphasis_dot,
    );
    if let Some(width) = crate::renderer::faux_bold_stroke_width(
        style,
        if style.font_size > 0.0 {
            style.font_size
        } else {
            12.0
        },
    ) {
        let _ = write!(buf, ",\"fauxBoldStrokeWidth\":{width:.6}");
    }
    // 기본값이 아닐 때만 싣는다 (기존 직렬화 결과 불변).
    if !style.hft_family.is_empty() {
        let _ = write!(buf, ",\"hftFamily\":{}", json_escape(&style.hft_family));
    }
    if style.char_offset != 0.0 {
        let _ = write!(buf, ",\"charOffset\":{:.4}", style.char_offset);
    }
    if let Some(offset_dy) = explicit_char_offset_dy(style) {
        // Display는 고정 소수 자리수로 자르지 않아 f64가 그대로 왕복한다. 0도 유효하다.
        let _ = write!(buf, ",\"charOffsetDy\":{offset_dy}");
    }
    if !style.effective_font_subst().is_empty() {
        let _ = write!(
            buf,
            ",\"fontSubst\":{}",
            json_escape(style.effective_font_subst())
        );
    }
    buf.push('}');
}

fn write_paint_text_style(buf: &mut String, style: &PaintTextStyle) {
    buf.push('{');
    let _ = write!(
        buf,
        "\"fontFamily\":{},\"fontSize\":{:.3},\"color\":{},\"bold\":{},\"italic\":{},\"ratio\":{:.6},\"underline\":{},\"underlineShape\":{},\"strikethrough\":{},\"strikeShape\":{},\"outlineType\":{},\"shadowType\":{},\"shadowColor\":{},\"shadowOffsetX\":{:.3},\"shadowOffsetY\":{:.3},\"emboss\":{},\"engrave\":{},\"superscript\":{},\"subscript\":{},\"underlineColor\":{},\"strikeColor\":{},\"shadeColor\":{},\"emphasisDot\":{}",
        json_escape(&style.font_family),
        style.font_size,
        json_escape(&color_ref_to_css(style.color)),
        style.bold,
        style.italic,
        style.ratio,
        json_escape(underline_type_str(style.underline)),
        style.underline_shape,
        style.strikethrough,
        style.strike_shape,
        style.outline_type,
        style.shadow_type,
        json_escape(&color_ref_to_css(style.shadow_color)),
        style.shadow_offset_x,
        style.shadow_offset_y,
        style.emboss,
        style.engrave,
        style.superscript,
        style.subscript,
        json_escape(&color_ref_to_css(style.underline_color)),
        json_escape(&color_ref_to_css(style.strike_color)),
        json_escape(&color_ref_to_css(style.shade_color)),
        style.emphasis_dot,
    );
    if let Some(width) = style.faux_bold_stroke_width {
        let _ = write!(buf, ",\"fauxBoldStrokeWidth\":{width:.6}");
    }
    if !style.font_subst.is_empty() {
        let _ = write!(buf, ",\"fontSubst\":{}", json_escape(&style.font_subst));
    }
    buf.push('}');
}

fn write_text_positions(buf: &mut String, run: &TextRunNode) {
    write_text_positions_for_text(buf, &run.text, &run.style);
}

fn write_text_positions_for_text(buf: &mut String, text: &str, style: &TextStyle) {
    let positions = compute_char_positions(text, style);
    write_position_values(buf, &positions);
}

/// 원본은 그대로 내보내고, replay scalar의 비인쇄 제어자만 전달한다.
fn write_nonprinting_spaces(buf: &mut String, source: &str, replay: &str, style: &TextStyle) {
    let indices = style.nonprinting_control_space_indices(source, replay);
    if indices.is_empty() {
        return;
    }
    buf.push_str(",\"nonprintingSpaces\":[");
    for (i, index) in indices.iter().enumerate() {
        if i > 0 {
            buf.push(',');
        }
        let _ = write!(buf, "{index}");
    }
    buf.push(']');
}

/// 반각 칸에 전각 glyph 를 그리는 구두점의 glyph x 오프셋 (`[[글자 index, dx], ...]`).
/// replay 글자(`displayText` 가 있으면 그것) 기준이며 해당 글자가 없으면 생략한다.
fn write_glyph_offsets(buf: &mut String, text: &str, style: &TextStyle) {
    let offsets = crate::renderer::halfwidth_punct_glyph_offsets(text, style);
    if offsets.is_empty() {
        return;
    }
    buf.push_str(",\"glyphOffsets\":[");
    for (idx, (char_idx, dx)) in offsets.iter().enumerate() {
        if idx > 0 {
            buf.push(',');
        }
        let _ = write!(buf, "[{char_idx},{dx:.3}]");
    }
    buf.push(']');
}

fn write_position_values(buf: &mut String, positions: &[f64]) {
    buf.push('[');
    for (idx, position) in positions.iter().enumerate() {
        if idx > 0 {
            buf.push(',');
        }
        let _ = write!(buf, "{:.3}", position);
    }
    buf.push(']');
}

fn bounded_text_prefix(text: &str) -> (String, bool) {
    let mut chars = text.chars();
    let prefix = chars
        .by_ref()
        .take(crate::paint::MAX_POSITIONED_CONTROL_MARKS_PER_RUN)
        .collect();
    (prefix, chars.next().is_none())
}

fn bounded_display_text_for_run(run: &TextRunNode) -> (String, bool) {
    let (source_prefix, source_complete) = bounded_text_prefix(run.display_or_text());
    let display_text = if run.display_text.is_some() {
        source_prefix
    } else {
        expand_pua_display_text(&source_prefix)
    };
    let (display_prefix, display_complete) = bounded_text_prefix(&display_text);
    (display_prefix, source_complete && display_complete)
}

fn write_bounded_text_positions(buf: &mut String, text: &str, style: &TextStyle) -> bool {
    let (prefix, complete) = bounded_text_prefix(text);
    let positions = compute_char_positions(&prefix, style);
    write_position_values(buf, &positions);
    complete
}

fn display_text_for_text_run(run: &TextRunNode) -> Option<String> {
    if let Some(display_text) = &run.display_text {
        return Some(display_text.clone());
    }
    let display_text = expand_pua_display_text(&run.text);
    (display_text != run.text.as_str()).then_some(display_text)
}

fn effective_text_font_size_and_baseline(run: &TextRunNode) -> (f64, f64) {
    let base_font_size = if run.style.font_size > 0.0 {
        run.style.font_size
    } else {
        12.0
    };
    if run.style.superscript {
        (base_font_size * 0.7, run.baseline - base_font_size * 0.3)
    } else if run.style.subscript {
        (base_font_size * 0.7, run.baseline + base_font_size * 0.15)
    } else {
        (base_font_size, run.baseline)
    }
}

fn write_tab_leaders(buf: &mut String, leaders: &[TabLeaderInfo]) {
    buf.push('[');
    for (idx, leader) in leaders.iter().enumerate() {
        if idx > 0 {
            buf.push(',');
        }
        let _ = write!(
            buf,
            "{{\"startX\":{:.3},\"endX\":{:.3},\"fillType\":{}}}",
            leader.start_x, leader.end_x, leader.fill_type
        );
    }
    buf.push(']');
}

fn write_clamped_tab_leaders(buf: &mut String, run: &TextRunNode) -> bool {
    let (display_text, text_complete) = bounded_display_text_for_run(run);
    let positions = compute_char_positions(&display_text, &run.style);
    let (font_size, _) = effective_text_font_size_and_baseline(run);
    let leaders_complete =
        run.style.tab_leaders.len() <= crate::paint::MAX_POSITIONED_CONTROL_MARKS_PER_RUN;
    buf.push('[');
    for (idx, leader) in run
        .style
        .tab_leaders
        .iter()
        .take(crate::paint::MAX_POSITIONED_CONTROL_MARKS_PER_RUN)
        .enumerate()
    {
        if idx > 0 {
            buf.push(',');
        }
        let end_x = clamp_tab_leader_end_x(&display_text, &positions, leader, font_size);
        let _ = write!(
            buf,
            "{{\"startX\":{:.3},\"endX\":{:.3},\"fillType\":{}}}",
            leader.start_x, end_x, leader.fill_type
        );
    }
    buf.push(']');
    text_complete && leaders_complete
}

fn write_text_control_marks(buf: &mut String, bbox: BoundingBox, run: &TextRunNode) -> bool {
    let (bounded_text, mut complete) = bounded_text_prefix(&run.text);
    let positions = compute_char_positions(&bounded_text, &run.style);
    let font_size = if run.style.font_size > 0.0 {
        run.style.font_size
    } else {
        12.0
    };
    let mark_font_size = (font_size * 0.5).max(1.0);
    let has_end_mark = run.is_para_end || run.is_line_break_end;
    let inline_limit =
        crate::paint::MAX_POSITIONED_CONTROL_MARKS_PER_RUN.saturating_sub(has_end_mark as usize);
    let mut inline_count = 0usize;
    let mut wrote = false;
    buf.push('[');

    if run.field_marker == FieldMarkerType::None {
        for (index, ch) in bounded_text.chars().enumerate() {
            let (kind, glyph, x, size) = match ch {
                ' ' => {
                    let current_x = positions
                        .get(index)
                        .copied()
                        .unwrap_or_else(|| positions.last().copied().unwrap_or(0.0));
                    let next_x = positions.get(index + 1).copied().unwrap_or(bbox.width);
                    (
                        "space",
                        "\u{2228}",
                        (current_x + next_x) / 2.0 - mark_font_size * 0.25,
                        mark_font_size,
                    )
                }
                '\t' => (
                    "tab",
                    "\u{2192}",
                    positions
                        .get(index)
                        .copied()
                        .unwrap_or_else(|| positions.last().copied().unwrap_or(0.0)),
                    mark_font_size,
                ),
                _ => continue,
            };
            if inline_count >= inline_limit {
                complete = false;
                continue;
            }
            if wrote {
                buf.push(',');
            }
            let _ = write!(
                buf,
                "{{\"kind\":{},\"text\":{},\"x\":{:.3},\"y\":0.000,\"fontSize\":{:.3}}}",
                json_escape(kind),
                json_escape(glyph),
                x,
                size,
            );
            wrote = true;
            inline_count += 1;
        }
    }

    if run.is_para_end || run.is_line_break_end {
        if wrote {
            buf.push(',');
        }
        let (kind, glyph) = if run.is_line_break_end {
            ("lineBreakEnd", "\u{2193}")
        } else {
            ("paragraphEnd", "\u{21B5}")
        };
        let x = if run.text.is_empty() { 0.0 } else { bbox.width };
        let _ = write!(
            buf,
            "{{\"kind\":{},\"text\":{},\"x\":{:.3},\"y\":0.000,\"fontSize\":{:.3}}}",
            json_escape(kind),
            json_escape(glyph),
            x,
            font_size,
        );
    }
    buf.push(']');
    complete
}

fn write_field_marker(buf: &mut String, marker: FieldMarkerType) {
    match marker {
        FieldMarkerType::None => buf.push_str("{\"kind\":\"none\"}"),
        FieldMarkerType::FieldBegin => buf.push_str("{\"kind\":\"fieldBegin\"}"),
        FieldMarkerType::FieldEnd => buf.push_str("{\"kind\":\"fieldEnd\"}"),
        FieldMarkerType::FieldBeginEnd => buf.push_str("{\"kind\":\"fieldBeginEnd\"}"),
        FieldMarkerType::ShapeMarker(index) => {
            let _ = write!(
                buf,
                "{{\"kind\":\"shapeMarker\",\"controlIndex\":{}}}",
                index
            );
        }
    }
}

fn field_marker_str(value: FieldMarkerType) -> &'static str {
    match value {
        FieldMarkerType::None => "none",
        FieldMarkerType::FieldBegin => "fieldBegin",
        FieldMarkerType::FieldEnd => "fieldEnd",
        FieldMarkerType::FieldBeginEnd => "fieldBeginEnd",
        FieldMarkerType::ShapeMarker(_) => "shapeMarker",
    }
}

fn write_char_overlap(
    buf: &mut String,
    overlap: Option<&crate::renderer::composer::CharOverlapInfo>,
) {
    if let Some(overlap) = overlap {
        let _ = write!(
            buf,
            "{{\"borderType\":{},\"innerCharSize\":{}}}",
            overlap.border_type, overlap.inner_char_size
        );
    } else {
        buf.push_str("null");
    }
}

fn text_orientation_str(run: &TextRunNode) -> &'static str {
    if !run.is_vertical {
        "horizontal"
    } else if run.rotation.abs() > f64::EPSILON {
        "vertical-sideways"
    } else {
        "vertical-upright"
    }
}

fn text_projection_kind_str(run: &TextRunNode) -> &'static str {
    if run.char_overlap.is_some() {
        "syntheticVisual"
    } else if run.field_marker != FieldMarkerType::None {
        "fieldProjection"
    } else if run.text.is_empty() && (run.is_para_end || run.is_line_break_end) {
        "controlProjection"
    } else {
        "verbatim"
    }
}

fn write_text_legacy_visuals(
    buf: &mut String,
    run: &TextRunNode,
    leaf_visuals: &LeafTextVisualOps,
) {
    let has_decorations = run.style.underline != UnderlineType::None
        || run.style.strikethrough
        || run.style.emphasis_dot > 0;
    if run.char_overlap.is_none()
        && !leaf_visuals.control_marks
        && run.style.tab_leaders.is_empty()
        && !has_decorations
    {
        return;
    }

    buf.push_str(",\"legacyVisuals\":{");
    let mut wrote = false;
    if run.char_overlap.is_some() {
        let state = if leaf_visuals.char_overlap {
            "mirror"
        } else {
            "canonical"
        };
        let _ = write!(buf, "\"charOverlap\":{}", json_escape(state));
        wrote = true;
    }
    if leaf_visuals.control_marks {
        if wrote {
            buf.push(',');
        }
        buf.push_str("\"controlMarks\":\"mirror\"");
        wrote = true;
    }
    if !run.style.tab_leaders.is_empty() {
        if wrote {
            buf.push(',');
        }
        let state = if leaf_visuals.tab_leaders {
            "mirror"
        } else {
            "canonical"
        };
        let _ = write!(buf, "\"tabLeaders\":{}", json_escape(state));
        wrote = true;
    }
    if has_decorations {
        if wrote {
            buf.push(',');
        }
        let state = if leaf_visuals.decorations {
            "mirror"
        } else {
            "canonical"
        };
        let _ = write!(buf, "\"decorations\":{}", json_escape(state));
    }
    buf.push('}');
}

fn write_text_run_placement(buf: &mut String, bbox: BoundingBox, run: &TextRunNode) {
    let radians = run.rotation.to_radians();
    let (sin, cos) = radians.sin_cos();
    let local_origin_x = -bbox.width / 2.0;
    let local_origin_y = -bbox.height / 2.0 + run.baseline;
    let center_x = bbox.x + bbox.width / 2.0;
    let center_y = bbox.y + bbox.height / 2.0;
    let _ = write!(
        buf,
        "{{\"runToPage\":{{\"a\":{:.6},\"b\":{:.6},\"c\":{:.6},\"d\":{:.6},\"e\":{:.6},\"f\":{:.6}}},\"baselineY\":0.000000}}",
        cos,
        sin,
        -sin,
        cos,
        center_x + cos * local_origin_x - sin * local_origin_y,
        center_y + sin * local_origin_x + cos * local_origin_y,
    );
}

fn write_text_run_placement_value(buf: &mut String, placement: crate::paint::TextRunPlacement) {
    buf.push_str("{\"runToPage\":");
    write_affine_transform(buf, placement.run_to_page);
    let _ = write!(buf, ",\"baselineY\":{:.6}}}", placement.baseline_y);
}

fn write_affine_transform(buf: &mut String, transform: LayerAffineTransform) {
    let _ = write!(
        buf,
        "{{\"a\":{:.6},\"b\":{:.6},\"c\":{:.6},\"d\":{:.6},\"e\":{:.6},\"f\":{:.6}}}",
        transform.a, transform.b, transform.c, transform.d, transform.e, transform.f,
    );
}

fn write_text_clusters(buf: &mut String, run: &TextRunNode) {
    let positions = compute_char_positions(&run.text, &run.style);
    let mut utf16_start = 0_u32;
    let chars = run
        .text
        .char_indices()
        .map(|(offset, ch)| (offset as u32, ch))
        .collect::<Vec<_>>();

    buf.push('[');
    for (idx, (utf8_start, ch)) in chars.iter().enumerate() {
        if idx > 0 {
            buf.push(',');
        }
        let utf8_end = chars
            .get(idx + 1)
            .map_or(run.text.len() as u32, |(next, _)| *next);
        let utf16_end = utf16_start + ch.len_utf16() as u32;
        let origin_x = positions.get(idx).copied().unwrap_or_default();
        let projection = text_projection_kind_str(run);
        buf.push_str("{\"sourceRangeUtf8\":");
        write_text_source_range(buf, TextSourceRange::new(*utf8_start, utf8_end));
        buf.push_str(",\"textRangeUtf8\":");
        write_text_source_range(buf, TextSourceRange::new(*utf8_start, utf8_end));
        buf.push_str(",\"textRangeUtf16\":");
        write_text_source_range(buf, TextSourceRange::new(utf16_start, utf16_end));
        let _ = write!(
            buf,
            ",\"projection\":{},\"origin\":{{\"x\":{:.6},\"y\":0.000000}}",
            json_escape(projection),
            origin_x
        );
        if let Some(next_x) = positions.get(idx + 1) {
            let _ = write!(
                buf,
                ",\"advance\":{{\"dx\":{:.6},\"dy\":0.000000}}",
                next_x - origin_x
            );
        }
        if run.char_overlap.is_some() {
            buf.push_str(",\"flags\":[\"specialVisual\",\"notShapingCandidate\"]");
        }
        buf.push('}');
        utf16_start = utf16_end;
    }
    buf.push(']');
}

fn write_shape_key(buf: &mut String, shape_key: &ShapeKey) {
    buf.push_str("{\"fontInstance\":{");
    let instance = &shape_key.font_instance;
    let _ = write!(
        buf,
        "\"faceKey\":{},\"sizePx\":{:.6},\"syntheticBold\":{},\"syntheticItalic\":{}",
        json_escape(&instance.face_key.0),
        instance.size_px,
        instance.synthetic_bold,
        instance.synthetic_italic,
    );
    buf.push_str(",\"variations\":[");
    for (idx, axis) in instance.variations.iter().enumerate() {
        if idx > 0 {
            buf.push(',');
        }
        let _ = write!(
            buf,
            "{{\"tag\":{},\"value\":{:.6}}}",
            json_escape(&axis.tag),
            axis.value
        );
    }
    buf.push_str("]}");
    let _ = write!(
        buf,
        ",\"direction\":{},\"writingMode\":{},\"shapingEngine\":{},\"fallbackPolicy\":{}",
        json_escape(shape_key.direction.as_str()),
        json_escape(shape_key.writing_mode.as_str()),
        json_escape(&shape_key.shaping_engine.0),
        json_escape(&shape_key.fallback_policy.0),
    );
    if let Some(script) = &shape_key.script {
        let _ = write!(buf, ",\"script\":{}", json_escape(&script.0));
    }
    if let Some(language) = &shape_key.language {
        let _ = write!(buf, ",\"language\":{}", json_escape(&language.0));
    }
    buf.push_str(",\"features\":[");
    for (idx, feature) in shape_key.features.iter().enumerate() {
        if idx > 0 {
            buf.push(',');
        }
        let _ = write!(
            buf,
            "{{\"tag\":{},\"enabled\":{}",
            json_escape(&feature.tag),
            feature.enabled
        );
        if let Some(value) = feature.value {
            let _ = write!(buf, ",\"value\":{}", value);
        }
        buf.push('}');
    }
    buf.push_str("]}");
}

fn write_points(buf: &mut String, points: &[LayerPoint]) {
    buf.push('[');
    for (idx, point) in points.iter().enumerate() {
        if idx > 0 {
            buf.push(',');
        }
        let _ = write!(buf, "{{\"x\":{:.6},\"y\":{:.6}}}", point.x, point.y);
    }
    buf.push(']');
}

fn write_vectors(buf: &mut String, vectors: &[LayerVector]) {
    buf.push('[');
    for (idx, vector) in vectors.iter().enumerate() {
        if idx > 0 {
            buf.push(',');
        }
        let _ = write!(buf, "{{\"dx\":{:.6},\"dy\":{:.6}}}", vector.dx, vector.dy);
    }
    buf.push(']');
}

fn write_glyph_clusters(buf: &mut String, clusters: &[GlyphCluster]) {
    buf.push('[');
    for (idx, cluster) in clusters.iter().enumerate() {
        if idx > 0 {
            buf.push(',');
        }
        buf.push('{');
        buf.push_str("\"sourceRangeUtf8\":");
        write_text_source_range(buf, cluster.source_range_utf8);
        if let Some(range) = cluster.source_range_utf16 {
            buf.push_str(",\"sourceRangeUtf16\":");
            write_text_source_range(buf, range);
        }
        if let Some(range) = cluster.text_range_utf8 {
            buf.push_str(",\"textRangeUtf8\":");
            write_text_source_range(buf, range);
        }
        let _ = write!(
            buf,
            ",\"glyphRange\":{{\"start\":{},\"end\":{}}}",
            cluster.glyph_range.start, cluster.glyph_range.end
        );
        if !cluster.flags.is_empty() {
            buf.push_str(",\"flags\":[");
            for (flag_idx, flag) in cluster.flags.iter().enumerate() {
                if flag_idx > 0 {
                    buf.push(',');
                }
                let _ = write!(buf, "{}", json_escape(flag.as_str()));
            }
            buf.push(']');
        }
        buf.push('}');
    }
    buf.push(']');
}

fn write_glyph_outline_paths(buf: &mut String, paths: &[LayerGlyphOutlinePath]) {
    buf.push('[');
    for (idx, path) in paths.iter().enumerate() {
        if idx > 0 {
            buf.push(',');
        }
        let _ = write!(buf, "{{\"glyphId\":{},\"sourceRangeUtf8\":", path.glyph_id);
        write_text_source_range(buf, path.source_range_utf8);
        let _ = write!(
            buf,
            ",\"glyphRange\":{{\"start\":{},\"end\":{}}},\"fillRule\":{}",
            path.glyph_range.start,
            path.glyph_range.end,
            json_escape(path.fill_rule.as_str())
        );
        buf.push_str(",\"commands\":");
        write_path_commands(buf, &path.commands);
        buf.push('}');
    }
    buf.push(']');
}

fn write_glyph_outline_stroke(buf: &mut String, stroke: &GlyphOutlineStrokeStyle) {
    let _ = write!(
        buf,
        "{{\"color\":{},\"width\":{:.6},\"join\":{},\"cap\":{},\"miterLimit\":{:.6},\"paintOrder\":{},\"strictSubset\":{}}}",
        json_escape(&color_ref_to_css(stroke.color)),
        stroke.width,
        json_escape(stroke.join.as_str()),
        json_escape(stroke.cap.as_str()),
        stroke.miter_limit,
        json_escape(stroke.paint_order.as_str()),
        stroke.is_strict_subset()
    );
}

fn write_color_layers_payload(buf: &mut String, payload: &ColorLayersPayload) {
    let _ = write!(
        buf,
        "{{\"colorFormat\":{}",
        json_escape(payload.color_format.as_str())
    );
    if let Some(source_font_ref) = &payload.source_font_ref {
        buf.push_str(",\"sourceFontRef\":");
        write_font_color_glyph_ref(buf, source_font_ref);
    }
    if let Some(palette_ref) = &payload.palette_ref {
        buf.push_str(",\"paletteRef\":");
        write_palette_ref(buf, palette_ref);
    }
    buf.push_str(",\"layers\":");
    write_color_layer_nodes(buf, &payload.layers);
    if let Some(graph) = &payload.paint_graph {
        buf.push_str(",\"paintGraph\":");
        write_color_paint_graph(buf, graph);
    }
    if let Some(range) = payload.source_range_utf8 {
        buf.push_str(",\"sourceRangeUtf8\":");
        write_text_source_range(buf, range);
    }
    if let Some(range) = payload.glyph_range {
        let _ = write!(
            buf,
            ",\"glyphRange\":{{\"start\":{},\"end\":{}}}",
            range.start, range.end
        );
    }
    let _ = write!(
        buf,
        ",\"colrv0ResolvedLayerContract\":{},\"colrv1Stage1GraphContract\":{},\"colrv1SupportedGraphContract\":{}",
        payload.has_colrv0_resolved_layer_contract(),
        payload.has_colrv1_supported_graph_contract(),
        payload.has_colrv1_supported_graph_contract()
    );
    buf.push('}');
}

fn write_color_layer_nodes(buf: &mut String, layers: &[ColorLayerNode]) {
    buf.push('[');
    for (idx, layer) in layers.iter().enumerate() {
        if idx > 0 {
            buf.push(',');
        }
        buf.push('{');
        if let Some(layer_index) = layer.layer_index {
            let _ = write!(buf, "\"layerIndex\":{}", layer_index);
        } else {
            buf.push_str("\"layerIndex\":null");
        }
        if let Some(glyph_id) = layer.glyph_id {
            let _ = write!(buf, ",\"glyphId\":{}", glyph_id);
        }
        if let Some(range) = layer.glyph_range {
            let _ = write!(
                buf,
                ",\"glyphRange\":{{\"start\":{},\"end\":{}}}",
                range.start, range.end
            );
        }
        if let Some(range) = layer.source_range_utf8 {
            buf.push_str(",\"sourceRangeUtf8\":");
            write_text_source_range(buf, range);
        }
        if let Some(source_font_ref) = &layer.source_font_ref {
            buf.push_str(",\"sourceFontRef\":");
            write_font_color_glyph_ref(buf, source_font_ref);
        }
        if let Some(commands) = &layer.commands {
            buf.push_str(",\"commands\":");
            write_path_commands(buf, commands);
        }
        if let Some(fill) = &layer.fill {
            buf.push_str(",\"fill\":");
            write_resolved_color(buf, fill);
        }
        if let Some(fill_rule) = layer.fill_rule {
            let _ = write!(buf, ",\"fillRule\":{}", json_escape(fill_rule.as_str()));
        }
        if let Some(palette_index) = layer.palette_index {
            let _ = write!(buf, ",\"paletteIndex\":{}", palette_index);
        }
        if let Some(color) = layer.color {
            let _ = write!(buf, ",\"color\":{}", json_escape(&color_ref_to_css(color)));
        }
        if let Some(opacity) = layer.opacity {
            let _ = write!(buf, ",\"opacity\":{:.6}", opacity);
        }
        if let Some(transform) = layer.transform_to_run {
            buf.push_str(",\"transformToRun\":");
            write_affine_transform(buf, transform);
        }
        buf.push('}');
    }
    buf.push(']');
}

fn write_color_paint_graph(buf: &mut String, graph: &ColorPaintGraphPayload) {
    let _ = write!(buf, "{{\"rootNodeId\":{},\"nodes\":[", graph.root_node_id);
    for (idx, node) in graph.nodes.iter().enumerate() {
        if idx > 0 {
            buf.push(',');
        }
        write_color_paint_graph_node(buf, node);
    }
    buf.push_str("]}");
}

fn write_color_paint_graph_node(buf: &mut String, node: &ColorPaintGraphNode) {
    let _ = write!(
        buf,
        "{{\"nodeId\":{},\"kind\":{}",
        node.node_id,
        json_escape(node.kind.as_str())
    );
    if let Some(solid) = &node.solid_path {
        buf.push_str(",\"solidPath\":");
        write_color_paint_solid_path_node(buf, solid);
    }
    if let Some(gradient_path) = &node.linear_gradient_path {
        buf.push_str(",\"linearGradientPath\":");
        write_color_paint_linear_gradient_path_node(buf, gradient_path);
    }
    if let Some(gradient_path) = &node.radial_gradient_path {
        buf.push_str(",\"radialGradientPath\":");
        write_color_paint_radial_gradient_path_node(buf, gradient_path);
    }
    if let Some(gradient_path) = &node.sweep_gradient_path {
        buf.push_str(",\"sweepGradientPath\":");
        write_color_paint_sweep_gradient_path_node(buf, gradient_path);
    }
    if let Some(transform) = &node.transform {
        buf.push_str(",\"transform\":");
        write_color_paint_transform_node(buf, transform);
    }
    if let Some(range) = node.source_range_utf8 {
        buf.push_str(",\"sourceRangeUtf8\":");
        write_text_source_range(buf, range);
    }
    if let Some(range) = node.glyph_range {
        let _ = write!(
            buf,
            ",\"glyphRange\":{{\"start\":{},\"end\":{}}}",
            range.start, range.end
        );
    }
    if let Some(source_font_ref) = &node.source_font_ref {
        buf.push_str(",\"sourceFontRef\":");
        write_font_color_glyph_ref(buf, source_font_ref);
    }
    buf.push('}');
}

fn write_color_paint_solid_path_node(
    buf: &mut String,
    solid: &crate::paint::ColorPaintSolidPathNode,
) {
    buf.push_str("{\"commands\":");
    write_path_commands(buf, &solid.commands);
    buf.push_str(",\"fill\":");
    write_resolved_color(buf, &solid.fill);
    let _ = write!(
        buf,
        ",\"fillRule\":{}",
        json_escape(solid.fill_rule.as_str())
    );
    if let Some(source_glyph_id) = solid.source_glyph_id {
        let _ = write!(buf, ",\"sourceGlyphId\":{}", source_glyph_id);
    }
    if let Some(palette_index) = solid.palette_index {
        let _ = write!(buf, ",\"paletteIndex\":{}", palette_index);
    }
    buf.push('}');
}

fn write_color_gradient_stops(buf: &mut String, stops: &[crate::paint::ColorGradientStop]) {
    buf.push('[');
    for (idx, stop) in stops.iter().enumerate() {
        if idx > 0 {
            buf.push(',');
        }
        let _ = write!(buf, "{{\"offset\":{:.6}", stop.offset);
        buf.push_str(",\"color\":");
        write_resolved_color(buf, &stop.color);
        buf.push('}');
    }
    buf.push(']');
}

fn write_color_paint_linear_gradient_path_node(
    buf: &mut String,
    gradient_path: &crate::paint::ColorPaintLinearGradientPathNode,
) {
    buf.push_str("{\"commands\":");
    write_path_commands(buf, &gradient_path.commands);
    let _ = write!(
        buf,
        ",\"gradient\":{{\"x0\":{:.6},\"y0\":{:.6},\"x1\":{:.6},\"y1\":{:.6},\"stops\":",
        gradient_path.gradient.x0,
        gradient_path.gradient.y0,
        gradient_path.gradient.x1,
        gradient_path.gradient.y1
    );
    write_color_gradient_stops(buf, &gradient_path.gradient.stops);
    let _ = write!(
        buf,
        "}},\"fillRule\":{}",
        json_escape(gradient_path.fill_rule.as_str())
    );
    if let Some(source_glyph_id) = gradient_path.source_glyph_id {
        let _ = write!(buf, ",\"sourceGlyphId\":{}", source_glyph_id);
    }
    if let Some(palette_index) = gradient_path.palette_index {
        let _ = write!(buf, ",\"paletteIndex\":{}", palette_index);
    }
    buf.push('}');
}

fn write_color_paint_radial_gradient_path_node(
    buf: &mut String,
    gradient_path: &crate::paint::ColorPaintRadialGradientPathNode,
) {
    buf.push_str("{\"commands\":");
    write_path_commands(buf, &gradient_path.commands);
    let _ = write!(
        buf,
        ",\"gradient\":{{\"cx\":{:.6},\"cy\":{:.6},\"radius\":{:.6},\"stops\":",
        gradient_path.gradient.cx, gradient_path.gradient.cy, gradient_path.gradient.radius
    );
    write_color_gradient_stops(buf, &gradient_path.gradient.stops);
    let _ = write!(
        buf,
        "}},\"fillRule\":{}",
        json_escape(gradient_path.fill_rule.as_str())
    );
    if let Some(source_glyph_id) = gradient_path.source_glyph_id {
        let _ = write!(buf, ",\"sourceGlyphId\":{}", source_glyph_id);
    }
    if let Some(palette_index) = gradient_path.palette_index {
        let _ = write!(buf, ",\"paletteIndex\":{}", palette_index);
    }
    buf.push('}');
}

fn write_color_paint_sweep_gradient_path_node(
    buf: &mut String,
    gradient_path: &crate::paint::ColorPaintSweepGradientPathNode,
) {
    buf.push_str("{\"commands\":");
    write_path_commands(buf, &gradient_path.commands);
    let _ = write!(
        buf,
        ",\"gradient\":{{\"cx\":{:.6},\"cy\":{:.6},\"startAngleDegrees\":{:.6},\"endAngleDegrees\":{:.6},\"stops\":",
        gradient_path.gradient.cx,
        gradient_path.gradient.cy,
        gradient_path.gradient.start_angle_degrees,
        gradient_path.gradient.end_angle_degrees
    );
    write_color_gradient_stops(buf, &gradient_path.gradient.stops);
    let _ = write!(
        buf,
        "}},\"fillRule\":{}",
        json_escape(gradient_path.fill_rule.as_str())
    );
    if let Some(source_glyph_id) = gradient_path.source_glyph_id {
        let _ = write!(buf, ",\"sourceGlyphId\":{}", source_glyph_id);
    }
    if let Some(palette_index) = gradient_path.palette_index {
        let _ = write!(buf, ",\"paletteIndex\":{}", palette_index);
    }
    buf.push('}');
}

fn write_color_paint_transform_node(
    buf: &mut String,
    transform: &crate::paint::ColorPaintTransformNode,
) {
    let _ = write!(buf, "{{\"childNodeId\":{}", transform.child_node_id);
    buf.push_str(",\"transform\":");
    write_affine_transform(buf, transform.transform);
    buf.push('}');
}

fn write_bitmap_glyph_payload(buf: &mut String, payload: &BitmapGlyphPayload) {
    let _ = write!(
        buf,
        "{{\"imageRef\":{},\"sourceRangeUtf8\":",
        payload.image_ref.0
    );
    write_text_source_range(buf, payload.source_range_utf8);
    let _ = write!(
        buf,
        ",\"glyphRange\":{{\"start\":{},\"end\":{}}},\"placement\":",
        payload.glyph_range.start, payload.glyph_range.end
    );
    write_bbox(buf, payload.placement);
    let _ = write!(
        buf,
        ",\"alphaPremultiplied\":{},\"scalingPolicy\":{},\"filtering\":{},\"strictVisualContract\":{}",
        payload.alpha_premultiplied,
        json_escape(payload.scaling_policy.as_str()),
        json_escape(payload.filtering.as_str()),
        payload.has_strict_visual_contract()
    );
    if let Some(transform) = payload.transform_to_run {
        buf.push_str(",\"transformToRun\":");
        write_affine_transform(buf, transform);
    }
    buf.push('}');
}

fn write_svg_glyph_payload(buf: &mut String, payload: &SvgGlyphPayload) {
    let _ = write!(
        buf,
        "{{\"svgRef\":{},\"vectorResourceId\":{},\"sourceRangeUtf8\":",
        payload.svg_ref.0, payload.svg_ref.0
    );
    write_text_source_range(buf, payload.source_range_utf8);
    let _ = write!(
        buf,
        ",\"glyphRange\":{{\"start\":{},\"end\":{}}},\"viewBox\":",
        payload.glyph_range.start, payload.glyph_range.end
    );
    write_bbox(buf, payload.view_box);
    if let Some(size) = payload.intrinsic_size {
        let _ = write!(
            buf,
            ",\"intrinsicSize\":{{\"width\":{:.6},\"height\":{:.6}}}",
            size.dx, size.dy
        );
    }
    let _ = write!(
        buf,
        ",\"staticSanitized\":{},\"scriptAllowed\":{},\"animationAllowed\":{},\"externalResourcesAllowed\":{},\"interactivityAllowed\":{},\"staticSanitizedContract\":{}",
        payload.static_sanitized,
        payload.script_allowed,
        payload.animation_allowed,
        payload.external_resources_allowed,
        payload.interactivity_allowed,
        payload.has_static_sanitized_contract()
    );
    if let Some(transform) = payload.transform_to_run {
        buf.push_str(",\"transformToRun\":");
        write_affine_transform(buf, transform);
    }
    buf.push('}');
}

fn write_font_color_glyph_ref(buf: &mut String, value: &FontColorGlyphRef) {
    buf.push('{');
    let mut wrote = false;
    if let Some(face_key) = &value.face_key {
        let _ = write!(buf, "\"faceKey\":{}", json_escape(face_key));
        wrote = true;
    }
    if let Some(glyph_id) = value.glyph_id {
        if wrote {
            buf.push(',');
        }
        let _ = write!(buf, "\"glyphId\":{}", glyph_id);
        wrote = true;
    }
    if let Some(palette_index) = value.palette_index {
        if wrote {
            buf.push(',');
        }
        let _ = write!(buf, "\"paletteIndex\":{}", palette_index);
        wrote = true;
    }
    if let Some(color_format) = value.color_format {
        if wrote {
            buf.push(',');
        }
        let _ = write!(
            buf,
            "\"colorFormat\":{}",
            json_escape(color_format.as_str())
        );
    }
    buf.push('}');
}

fn write_palette_ref(buf: &mut String, value: &PaletteRef) {
    buf.push('{');
    let mut wrote = false;
    if let Some(id) = &value.id {
        let _ = write!(buf, "\"id\":{}", json_escape(id));
        wrote = true;
    }
    if let Some(index) = value.index {
        if wrote {
            buf.push(',');
        }
        let _ = write!(buf, "\"index\":{}", index);
        wrote = true;
    }
    if let Some(cpal_digest) = &value.cpal_digest {
        if wrote {
            buf.push(',');
        }
        let _ = write!(buf, "\"cpalDigest\":{}", json_escape(cpal_digest));
    }
    buf.push('}');
}

fn write_resolved_color(buf: &mut String, color: &ResolvedColor) {
    buf.push('{');
    if let Some(color_space) = &color.color_space {
        let _ = write!(buf, "\"colorSpace\":{},", json_escape(color_space));
    }
    let _ = write!(
        buf,
        "\"rgba\":[{:.6},{:.6},{:.6},{:.6}]}}",
        color.rgba[0], color.rgba[1], color.rgba[2], color.rgba[3]
    );
}

fn write_glyph_transforms(buf: &mut String, transforms: &[GlyphTransform]) {
    buf.push('[');
    for (idx, transform) in transforms.iter().enumerate() {
        if idx > 0 {
            buf.push(',');
        }
        let _ = write!(
            buf,
            "{{\"xx\":{:.6},\"xy\":{:.6},\"yx\":{:.6},\"yy\":{:.6},\"tx\":{:.6},\"ty\":{:.6}}}",
            transform.xx, transform.xy, transform.yx, transform.yy, transform.tx, transform.ty
        );
    }
    buf.push(']');
}

fn write_glyph_run_diagnostics(buf: &mut String, diagnostics: &GlyphRunDiagnostics) {
    let _ = write!(
        buf,
        "{{\"quality\":{},\"replayEligibility\":{},\"strictVisualEligible\":{},\"maxOriginDeltaPx\":{:.6},\"maxAdvanceDeltaPx\":{:.6},\"maxResidualAfterAdjustmentPx\":{:.6},\"clusterMismatchCount\":{},\"missingGlyphCount\":{},\"usedFallbackFontCount\":{}",
        json_escape(diagnostics.quality.as_str()),
        json_escape(diagnostics.replay_eligibility.as_str()),
        diagnostics.strict_visual_eligible,
        diagnostics.max_origin_delta_px,
        diagnostics.max_advance_delta_px,
        diagnostics.max_residual_after_adjustment_px,
        diagnostics.cluster_mismatch_count,
        diagnostics.missing_glyph_count,
        diagnostics.used_fallback_font_count,
    );
    if let Some(reason) = &diagnostics.reason {
        let _ = write!(buf, ",\"reason\":{}", json_escape(reason));
    }
    buf.push('}');
}

fn write_text_decoration(buf: &mut String, kind: TextDecorationKind, run: &TextRunNode) {
    let (color, shape, underline, emphasis_dot) = match kind {
        TextDecorationKind::Underline => (
            // 밑줄 색은 글자 색과 별개다 — 0(검정)도 지정값이다.
            run.style.underline_color,
            run.style.underline_shape,
            run.style.underline,
            0,
        ),
        TextDecorationKind::Strikethrough => (
            if run.style.strike_color != 0 {
                run.style.strike_color
            } else {
                run.style.color
            },
            run.style.strike_shape,
            UnderlineType::None,
            0,
        ),
        TextDecorationKind::EmphasisDot => (
            run.style.color,
            0,
            UnderlineType::None,
            run.style.emphasis_dot,
        ),
    };
    let (font_size, baseline) = effective_text_font_size_and_baseline(run);
    let (bounded_text, complete) = bounded_display_text_for_run(run);
    let positions = compute_char_positions(&bounded_text, &run.style);
    let _ = write!(
        buf,
        "{{\"kind\":{},\"baseline\":{:.3},\"rotation\":{:.3},\"isVertical\":{},\"fontSize\":{:.3},\"ratio\":{:.6},\"color\":{},\"shape\":{},\"underline\":{},\"emphasisDot\":{},\"positions\":[",
        json_escape(kind.as_str()),
        baseline,
        run.rotation,
        run.is_vertical,
        font_size,
        run.style.ratio,
        json_escape(&color_ref_to_css(color)),
        shape,
        json_escape(underline_type_str(underline)),
        emphasis_dot,
    );
    for (idx, position) in positions.iter().enumerate() {
        if idx > 0 {
            buf.push(',');
        }
        let _ = write!(buf, "{:.3}", position);
    }
    let _ = write!(buf, "],\"positionsComplete\":{complete}}}");
}

fn write_shape_style(buf: &mut String, style: &ShapeStyle) {
    buf.push('{');
    if let Some(color) = style.fill_color {
        let _ = write!(
            buf,
            "\"fillColor\":{}",
            json_escape(&color_ref_to_css(color))
        );
    } else {
        buf.push_str("\"fillColor\":null");
    }
    if let Some(pattern) = &style.pattern {
        buf.push_str(",\"pattern\":");
        write_pattern_fill(buf, pattern);
    }
    if let Some(color) = style.stroke_color {
        let _ = write!(
            buf,
            ",\"strokeColor\":{}",
            json_escape(&color_ref_to_css(color))
        );
    } else {
        buf.push_str(",\"strokeColor\":null");
    }
    let _ = write!(
        buf,
        ",\"strokeWidth\":{:.3},\"strokeDash\":{},\"opacity\":{:.3}",
        style.stroke_width,
        json_escape(stroke_dash_str(style.stroke_dash)),
        style.opacity,
    );
    if let Some(shadow) = &style.shadow {
        buf.push_str(",\"shadow\":");
        write_shadow_style(buf, shadow);
    }
    buf.push('}');
}

fn write_pattern_fill(buf: &mut String, pattern: &PatternFillInfo) {
    let _ = write!(
        buf,
        "{{\"patternType\":{},\"patternColor\":{},\"backgroundColor\":{}}}",
        pattern.pattern_type,
        json_escape(&color_ref_to_css(pattern.pattern_color)),
        json_escape(&color_ref_to_css(pattern.background_color)),
    );
}

fn write_shadow_style(buf: &mut String, shadow: &ShadowStyle) {
    let _ = write!(
        buf,
        "{{\"shadowType\":{},\"color\":{},\"offsetX\":{:.3},\"offsetY\":{:.3},\"alpha\":{}}}",
        shadow.shadow_type,
        json_escape(&color_ref_to_css(shadow.color)),
        shadow.offset_x,
        shadow.offset_y,
        shadow.alpha,
    );
}

fn write_gradient(
    buf: &mut String,
    gradient: &GradientFillInfo,
    rectangle: Option<(BoundingBox, f64)>,
) {
    buf.push('{');
    let _ = write!(
        buf,
        "\"gradientType\":{},\"angle\":{},\"centerX\":{},\"centerY\":{},\"step\":{},\"stepCenter\":{},\"colors\":[",
        gradient.gradient_type, gradient.angle, gradient.center_x, gradient.center_y,
        gradient.step, gradient.step_center,
    );
    for (idx, color) in gradient.colors.iter().enumerate() {
        if idx > 0 {
            buf.push(',');
        }
        let css = color_ref_to_css(*color);
        buf.push_str(&json_escape(&css));
    }
    buf.push_str("],\"positions\":[");
    for (idx, position) in gradient.positions.iter().enumerate() {
        if idx > 0 {
            buf.push(',');
        }
        let _ = write!(buf, "{:.3}", position);
    }
    buf.push(']');
    if let Some((bbox, radius)) = rectangle {
        if let Some(polygons) = crate::renderer::gradient_fill::conical_polygons(gradient, bbox) {
            let _ = write!(
                buf,
                ",\"conicalClipRadius\":{},\"conicalPolygons\":[",
                radius
            );
            for (index, polygon) in polygons.iter().enumerate() {
                if index > 0 {
                    buf.push(',');
                }
                let _ = write!(
                    buf,
                    "{{\"color\":{},\"points\":[",
                    json_escape(&color_ref_to_css(polygon.color))
                );
                for (index, (x, y)) in polygon.points.iter().enumerate() {
                    if index > 0 {
                        buf.push(',');
                    }
                    let _ = write!(buf, "[{},{}]", x, y);
                }
                buf.push_str("]}");
            }
            buf.push(']');
        }
    }
    buf.push('}');
}

fn write_line_style(buf: &mut String, style: &LineStyle) {
    let _ = write!(
        buf,
        "{{\"color\":{},\"width\":{:.3},\"dash\":{},\"lineType\":{},\"startArrow\":{},\"endArrow\":{},\"startArrowSize\":{},\"endArrowSize\":{}}}",
        json_escape(&color_ref_to_css(style.color)),
        style.width,
        json_escape(stroke_dash_str(style.dash)),
        json_escape(line_render_type_str(style.line_type)),
        json_escape(arrow_style_str(style.start_arrow)),
        json_escape(arrow_style_str(style.end_arrow)),
        style.start_arrow_size,
        style.end_arrow_size,
    );
}

fn write_transform(buf: &mut String, transform: ShapeTransform) {
    let _ = write!(
        buf,
        "{{\"rotation\":{:.3},\"horzFlip\":{},\"vertFlip\":{}}}",
        transform.rotation, transform.horz_flip, transform.vert_flip
    );
}

fn write_path_commands(buf: &mut String, commands: &[PathCommand]) {
    buf.push('[');
    for (idx, command) in commands.iter().enumerate() {
        if idx > 0 {
            buf.push(',');
        }
        match command {
            PathCommand::MoveTo(x, y) => {
                let _ = write!(buf, "{{\"type\":\"moveTo\",\"x\":{:.3},\"y\":{:.3}}}", x, y);
            }
            PathCommand::LineTo(x, y) => {
                let _ = write!(buf, "{{\"type\":\"lineTo\",\"x\":{:.3},\"y\":{:.3}}}", x, y);
            }
            PathCommand::CurveTo(x1, y1, x2, y2, x3, y3) => {
                let _ = write!(
                    buf,
                    "{{\"type\":\"curveTo\",\"x1\":{:.3},\"y1\":{:.3},\"x2\":{:.3},\"y2\":{:.3},\"x3\":{:.3},\"y3\":{:.3}}}",
                    x1, y1, x2, y2, x3, y3
                );
            }
            PathCommand::ArcTo(rx, ry, rotation, large_arc, sweep, x, y) => {
                let _ = write!(
                    buf,
                    "{{\"type\":\"arcTo\",\"rx\":{:.3},\"ry\":{:.3},\"rotation\":{:.3},\"largeArc\":{},\"sweep\":{},\"x\":{:.3},\"y\":{:.3}}}",
                    rx, ry, rotation, large_arc, sweep, x, y
                );
            }
            PathCommand::ClosePath => buf.push_str("{\"type\":\"closePath\"}"),
        }
    }
    buf.push(']');
}

fn write_equation_layout_box(buf: &mut String, layout: &LayoutBox) {
    let _ = write!(
        buf,
        "{{\"x\":{:.6},\"y\":{:.6},\"width\":{:.6},\"height\":{:.6},\"baseline\":{:.6},\"kind\":",
        layout.x, layout.y, layout.width, layout.height, layout.baseline,
    );
    write_equation_layout_kind(buf, &layout.kind);
    if let Some(advances) = &layout.glyph_advances {
        buf.push_str(",\"glyphAdvances\":[");
        for (index, advance) in advances.iter().enumerate() {
            if index > 0 {
                buf.push(',');
            }
            let _ = write!(buf, "{advance:.6}");
        }
        buf.push(']');
    }
    buf.push('}');
}

fn write_equation_layout_kind(buf: &mut String, kind: &LayoutKind) {
    match kind {
        LayoutKind::Row(children) => {
            buf.push_str("{\"type\":\"row\",\"children\":[");
            for (index, child) in children.iter().enumerate() {
                if index > 0 {
                    buf.push(',');
                }
                write_equation_layout_box(buf, child);
            }
            buf.push_str("]}");
        }
        LayoutKind::Text(text) => write_equation_text_kind(buf, "text", text),
        LayoutKind::Number(text) => write_equation_text_kind(buf, "number", text),
        LayoutKind::Symbol(text) => write_equation_text_kind(buf, "symbol", text),
        LayoutKind::MathSymbol(text) => write_equation_text_kind(buf, "mathSymbol", text),
        LayoutKind::Function(name) => {
            let _ = write!(
                buf,
                "{{\"type\":\"function\",\"name\":{}}}",
                json_escape(name)
            );
        }
        LayoutKind::Fraction {
            numer,
            denom,
            bar_inset,
        } => {
            let _ = write!(
                buf,
                "{{\"type\":\"fraction\",\"barInset\":{:.6},\"numer\":",
                bar_inset
            );
            write_equation_layout_box(buf, numer);
            buf.push_str(",\"denom\":");
            write_equation_layout_box(buf, denom);
            buf.push('}');
        }
        LayoutKind::Atop { top, bottom } => {
            buf.push_str("{\"type\":\"atop\",\"top\":");
            write_equation_layout_box(buf, top);
            buf.push_str(",\"bottom\":");
            write_equation_layout_box(buf, bottom);
            buf.push('}');
        }
        LayoutKind::Sqrt { index, body } => {
            buf.push_str("{\"type\":\"sqrt\"");
            if let Some(index) = index {
                buf.push_str(",\"index\":");
                write_equation_layout_box(buf, index);
            }
            buf.push_str(",\"body\":");
            write_equation_layout_box(buf, body);
            buf.push('}');
        }
        LayoutKind::Superscript { base, sup } => {
            write_equation_binary_kind(buf, "superscript", "base", base, "sup", sup);
        }
        LayoutKind::Subscript { base, sub } => {
            write_equation_binary_kind(buf, "subscript", "base", base, "sub", sub);
        }
        LayoutKind::SubSup { base, sub, sup } => {
            buf.push_str("{\"type\":\"subSup\",\"base\":");
            write_equation_layout_box(buf, base);
            buf.push_str(",\"sub\":");
            write_equation_layout_box(buf, sub);
            buf.push_str(",\"sup\":");
            write_equation_layout_box(buf, sup);
            buf.push('}');
        }
        LayoutKind::BigOp { symbol, sub, sup } => {
            let _ = write!(
                buf,
                "{{\"type\":\"bigOp\",\"symbol\":{}",
                json_escape(symbol)
            );
            write_optional_equation_box(buf, "sub", sub.as_deref());
            write_optional_equation_box(buf, "sup", sup.as_deref());
            buf.push('}');
        }
        LayoutKind::Limit {
            is_upper,
            sub,
            name_x,
            name_y,
        } => {
            let _ = write!(
                buf,
                "{{\"type\":\"limit\",\"isUpper\":{},\"nameX\":{},\"nameY\":{}",
                is_upper, name_x, name_y
            );
            write_optional_equation_box(buf, "sub", sub.as_deref());
            buf.push('}');
        }
        LayoutKind::Matrix { cells, style } => {
            let _ = write!(
                buf,
                "{{\"type\":\"matrix\",\"style\":{},\"cells\":[",
                json_escape(equation_matrix_style(*style))
            );
            for (row_index, row) in cells.iter().enumerate() {
                if row_index > 0 {
                    buf.push(',');
                }
                buf.push('[');
                for (cell_index, cell) in row.iter().enumerate() {
                    if cell_index > 0 {
                        buf.push(',');
                    }
                    write_equation_layout_box(buf, cell);
                }
                buf.push(']');
            }
            buf.push_str("]}");
        }
        LayoutKind::Rel { arrow, over, under } => {
            buf.push_str("{\"type\":\"rel\",\"arrow\":");
            write_equation_layout_box(buf, arrow);
            buf.push_str(",\"over\":");
            write_equation_layout_box(buf, over);
            write_optional_equation_box(buf, "under", under.as_deref());
            buf.push('}');
        }
        LayoutKind::EqAlign { rows } => {
            buf.push_str("{\"type\":\"eqAlign\",\"rows\":[");
            for (index, (left, right)) in rows.iter().enumerate() {
                if index > 0 {
                    buf.push(',');
                }
                buf.push_str("{\"left\":");
                write_equation_layout_box(buf, left);
                buf.push_str(",\"right\":");
                write_equation_layout_box(buf, right);
                buf.push('}');
            }
            buf.push_str("]}");
        }
        LayoutKind::Paren {
            left,
            right,
            body,
            modern_extent,
        } => {
            let _ = write!(
                buf,
                "{{\"type\":\"paren\",\"left\":{},\"right\":{},\"body\":",
                json_escape(left),
                json_escape(right),
            );
            write_equation_layout_box(buf, body);
            if let Some((top, height)) = modern_extent {
                let _ = write!(buf, ",\"modernExtent\":[{},{}]", top, height);
            }
            buf.push('}');
        }
        LayoutKind::Decoration { kind, body } => {
            let _ = write!(
                buf,
                "{{\"type\":\"decoration\",\"decoration\":{},\"body\":",
                json_escape(equation_decoration(*kind))
            );
            write_equation_layout_box(buf, body);
            buf.push('}');
        }
        LayoutKind::FontStyle { style, body } => {
            let _ = write!(
                buf,
                "{{\"type\":\"fontStyle\",\"fontStyle\":{},\"body\":",
                json_escape(equation_font_style(*style))
            );
            write_equation_layout_box(buf, body);
            buf.push('}');
        }
        LayoutKind::Space(width) => {
            let _ = write!(buf, "{{\"type\":\"space\",\"width\":{width:.6}}}");
        }
        LayoutKind::Newline => buf.push_str("{\"type\":\"newline\"}"),
        LayoutKind::Empty => buf.push_str("{\"type\":\"empty\"}"),
    }
}

fn write_equation_text_kind(buf: &mut String, kind: &str, text: &str) {
    let _ = write!(
        buf,
        "{{\"type\":{},\"text\":{}}}",
        json_escape(kind),
        json_escape(text)
    );
}

fn write_equation_binary_kind(
    buf: &mut String,
    kind: &str,
    left_name: &str,
    left: &LayoutBox,
    right_name: &str,
    right: &LayoutBox,
) {
    let _ = write!(
        buf,
        "{{\"type\":{},{}:",
        json_escape(kind),
        json_escape(left_name)
    );
    write_equation_layout_box(buf, left);
    let _ = write!(buf, ",{}:", json_escape(right_name));
    write_equation_layout_box(buf, right);
    buf.push('}');
}

fn write_optional_equation_box(buf: &mut String, name: &str, layout: Option<&LayoutBox>) {
    if let Some(layout) = layout {
        let _ = write!(buf, ",{}:", json_escape(name));
        write_equation_layout_box(buf, layout);
    }
}

fn equation_matrix_style(style: MatrixStyle) -> &'static str {
    match style {
        MatrixStyle::Plain => "plain",
        MatrixStyle::Paren => "paren",
        MatrixStyle::Bracket => "bracket",
        MatrixStyle::Vert => "vert",
    }
}

fn equation_decoration(kind: DecoKind) -> &'static str {
    match kind {
        DecoKind::Hat => "hat",
        DecoKind::Check => "check",
        DecoKind::Tilde => "tilde",
        DecoKind::Acute => "acute",
        DecoKind::Grave => "grave",
        DecoKind::Dot => "dot",
        DecoKind::DDot => "dDot",
        DecoKind::Bar => "bar",
        DecoKind::Vec => "vec",
        DecoKind::Dyad => "dyad",
        DecoKind::Under => "under",
        DecoKind::Arch => "arch",
        DecoKind::Underline => "underline",
        DecoKind::Overline => "overline",
        DecoKind::StrikeThrough => "strikeThrough",
    }
}

fn equation_font_style(style: FontStyleKind) -> &'static str {
    match style {
        FontStyleKind::Roman => "roman",
        FontStyleKind::Italic => "italic",
        FontStyleKind::Bold => "bold",
        FontStyleKind::Blackboard => "blackboard",
        FontStyleKind::Calligraphy => "calligraphy",
        FontStyleKind::Fraktur => "fraktur",
        FontStyleKind::SansSerif => "sansSerif",
        FontStyleKind::Monospace => "monospace",
    }
}

fn underline_type_str(value: UnderlineType) -> &'static str {
    match value {
        UnderlineType::None => "none",
        UnderlineType::Bottom => "bottom",
        UnderlineType::Top => "top",
    }
}

fn stroke_dash_str(value: StrokeDash) -> &'static str {
    match value {
        StrokeDash::Solid => "solid",
        StrokeDash::Dash => "dash",
        StrokeDash::LongDash => "longDash",
        StrokeDash::Dot => "dot",
        StrokeDash::Circle => "circle",
        StrokeDash::DashDot => "dashDot",
        StrokeDash::DashDotDot => "dashDotDot",
    }
}

fn line_render_type_str(value: LineRenderType) -> &'static str {
    match value {
        LineRenderType::Single => "single",
        LineRenderType::Double => "double",
        LineRenderType::ThinThickDouble => "thinThickDouble",
        LineRenderType::ThickThinDouble => "thickThinDouble",
        LineRenderType::ThinThickThinTriple => "thinThickThinTriple",
    }
}

fn arrow_style_str(value: ArrowStyle) -> &'static str {
    match value {
        ArrowStyle::None => "none",
        ArrowStyle::Arrow => "arrow",
        ArrowStyle::ConcaveArrow => "concaveArrow",
        ArrowStyle::OpenDiamond => "openDiamond",
        ArrowStyle::OpenCircle => "openCircle",
        ArrowStyle::OpenSquare => "openSquare",
        ArrowStyle::Diamond => "diamond",
        ArrowStyle::Circle => "circle",
        ArrowStyle::Square => "square",
    }
}

fn image_fill_mode_str(value: ImageFillMode) -> &'static str {
    match value {
        ImageFillMode::TileAll => "tileAll",
        ImageFillMode::TileHorzTop => "tileHorzTop",
        ImageFillMode::TileHorzBottom => "tileHorzBottom",
        ImageFillMode::TileVertLeft => "tileVertLeft",
        ImageFillMode::TileVertRight => "tileVertRight",
        ImageFillMode::FitToSize => "fitToSize",
        ImageFillMode::Zoom => "zoom",
        ImageFillMode::Total => "total",
        ImageFillMode::Center => "center",
        ImageFillMode::CenterTop => "centerTop",
        ImageFillMode::CenterBottom => "centerBottom",
        ImageFillMode::LeftCenter => "leftCenter",
        ImageFillMode::LeftTop => "leftTop",
        ImageFillMode::LeftBottom => "leftBottom",
        ImageFillMode::RightCenter => "rightCenter",
        ImageFillMode::RightTop => "rightTop",
        ImageFillMode::RightBottom => "rightBottom",
        ImageFillMode::None => "none",
    }
}

fn image_effect_str(value: ImageEffect) -> &'static str {
    match value {
        ImageEffect::RealPic => "realPic",
        ImageEffect::GrayScale => "grayScale",
        ImageEffect::BlackWhite => "blackWhite",
        ImageEffect::Pattern8x8 => "pattern8x8",
    }
}

fn text_wrap_str(value: crate::model::shape::TextWrap) -> &'static str {
    use crate::model::shape::TextWrap;
    match value {
        TextWrap::Square => "square",
        TextWrap::Tight => "tight",
        TextWrap::Through => "through",
        TextWrap::TopAndBottom => "topAndBottom",
        TextWrap::BehindText => "behindText",
        TextWrap::InFrontOfText => "inFrontOfText",
    }
}

fn write_render_layer_info(buf: &mut String, layer: RenderLayerInfo) {
    buf.push('{');
    if let Some(text_wrap) = layer.text_wrap {
        let _ = write!(
            buf,
            "\"textWrap\":{}",
            json_escape(text_wrap_str(text_wrap))
        );
    } else {
        buf.push_str("\"textWrap\":null");
    }
    let _ = write!(
        buf,
        ",\"zOrder\":{},\"stableIndex\":{}",
        layer.z_order, layer.stable_index
    );
    if layer.master_page {
        buf.push_str(",\"masterPage\":true");
    }
    if layer.local_to_parent {
        buf.push_str(",\"localToParent\":true");
    }
    buf.push('}');
}

fn render_profile_str(value: RenderProfile) -> &'static str {
    match value {
        RenderProfile::FastPreview => "fastPreview",
        RenderProfile::Screen => "screen",
        RenderProfile::Print => "print",
        RenderProfile::HighQuality => "highQuality",
    }
}

fn form_type_str(value: FormType) -> &'static str {
    match value {
        FormType::PushButton => "pushButton",
        FormType::CheckBox => "checkBox",
        FormType::RadioButton => "radioButton",
        FormType::ComboBox => "comboBox",
        FormType::Edit => "edit",
    }
}

fn json_escape(value: &str) -> String {
    format!("\"{}\"", raw_json_escape(value))
}

