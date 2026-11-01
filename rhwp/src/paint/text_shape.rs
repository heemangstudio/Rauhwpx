use crate::paint::{
    FontPortabilityKind, GlyphCluster, GlyphRunDiagnostics, GlyphRunOrientation,
    GlyphRunReplayEligibility, LayerAffineTransform, LayerGlyphRunPaint, LayerNode, LayerNodeKind,
    LayerPoint, LayerVector, PaintOp, PaintTextStyle, ShapeKey, TextRunPlacement, TextVariantKind,
    TextVariantQuality,
};
use crate::renderer::render_tree::{BoundingBox, TextRunNode};
use std::collections::HashSet;

use super::EmbeddedFontFace;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FontRequest {
    pub family: String,
    pub bold: bool,
    pub italic: bool,
}

impl From<&TextRunNode> for FontRequest {
    fn from(run: &TextRunNode) -> Self {
        Self {
            family: run.style.font_family.clone(),
            bold: run.style.paint_bold(),
            italic: run.style.italic,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedFontFace {
    pub portability: FontPortabilityKind,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ResolvedGlyphRun {
    pub shape_key: ShapeKey,
    pub glyph_ids: Vec<u32>,
    pub positions: Vec<LayerPoint>,
    pub advances: Option<Vec<LayerVector>>,
    pub clusters: Vec<GlyphCluster>,
    pub diagnostics: GlyphRunDiagnostics,
}

pub trait FontResolver {
    fn resolve_font(&self, request: &FontRequest) -> ResolvedFontFace;

    fn shape_glyph_run(
        &self,
        _request: &FontRequest,
        _run: &TextRunNode,
        _resolved: &ResolvedFontFace,
    ) -> Option<ResolvedGlyphRun> {
        None
    }
}

#[derive(Debug, Default)]
pub struct NoopFontResolver;

impl FontResolver for NoopFontResolver {
    fn resolve_font(&self, _request: &FontRequest) -> ResolvedFontFace {
        ResolvedFontFace {
            portability: FontPortabilityKind::UnresolvedFallback,
        }
    }
}

pub struct EmbeddedFontResolver<'a> {
    fonts: &'a [EmbeddedFontFace<'a>],
}

impl<'a> EmbeddedFontResolver<'a> {
    pub fn new(fonts: &'a [EmbeddedFontFace<'a>]) -> Self {
        Self { fonts }
    }

    fn font_for_run(
        &self,
        request: &FontRequest,
        run: &TextRunNode,
    ) -> Option<&EmbeddedFontFace<'a>> {
        let language_index = run
            .text
            .chars()
            .next()
            .map(crate::renderer::style_resolver::detect_lang_category);
        self.fonts
            .iter()
            .find(|font| {
                run.char_shape_id == Some(font.char_shape_id)
                    && language_index == Some(font.language_index)
            })
            .or_else(|| {
                self.fonts.iter().find(|font| {
                    font.family.eq_ignore_ascii_case(&request.family)
                        || font
                            .alternate_family
                            .is_some_and(|family| family.eq_ignore_ascii_case(&request.family))
                })
            })
    }
}

impl FontResolver for EmbeddedFontResolver<'_> {
    fn resolve_font(&self, request: &FontRequest) -> ResolvedFontFace {
        let resolved = self.fonts.iter().any(|font| {
            font.family.eq_ignore_ascii_case(&request.family)
                || font
                    .alternate_family
                    .is_some_and(|family| family.eq_ignore_ascii_case(&request.family))
        });
        ResolvedFontFace {
            portability: if resolved {
                FontPortabilityKind::PortableBlob
            } else {
                FontPortabilityKind::UnresolvedFallback
            },
        }
    }

    fn shape_glyph_run(
        &self,
        request: &FontRequest,
        run: &TextRunNode,
        _resolved: &ResolvedFontFace,
    ) -> Option<ResolvedGlyphRun> {
        if run.style.letter_spacing.abs() > f64::EPSILON
            || run.style.extra_char_spacing.abs() > f64::EPSILON
            || run.style.extra_word_spacing.abs() > f64::EPSILON
            || run.style.extra_dash_advance.abs() > f64::EPSILON
        {
            return None;
        }
        let font = self.font_for_run(request, run)?;
        let face = rustybuzz::Face::from_slice(font.bytes, font.face_index)?;
        let units_per_em = f64::from(face.units_per_em());
        if units_per_em <= 0.0 {
            return None;
        }
        let mut buffer = rustybuzz::UnicodeBuffer::new();
        buffer.push_str(&run.text);
        buffer.guess_segment_properties();
        let features = if run.style.kerning {
            Vec::new()
        } else {
            vec!["kern=0".parse().ok()?]
        };
        let glyphs = rustybuzz::shape(&face, &features, buffer);
        let scale = run.style.font_size.max(0.0) / units_per_em;
        let mut pen_x = 0.0;
        let mut pen_y = 0.0;
        let mut positions = Vec::with_capacity(glyphs.len());
        let mut advances = Vec::with_capacity(glyphs.len());
        for position in glyphs.glyph_positions() {
            positions.push(LayerPoint {
                x: pen_x + f64::from(position.x_offset) * scale,
                y: pen_y - f64::from(position.y_offset) * scale,
            });
            let advance = LayerVector {
                dx: f64::from(position.x_advance) * scale,
                dy: -f64::from(position.y_advance) * scale,
            };
            pen_x += advance.dx;
            pen_y += advance.dy;
            advances.push(advance);
        }

        let infos = glyphs.glyph_infos();
        let mut clusters = Vec::new();
        let mut glyph_start = 0usize;
        while glyph_start < infos.len() {
            let byte_start = infos[glyph_start].cluster as usize;
            let mut glyph_end = glyph_start + 1;
            while glyph_end < infos.len() && infos[glyph_end].cluster == infos[glyph_start].cluster
            {
                glyph_end += 1;
            }
            let byte_end = infos[glyph_end..]
                .iter()
                .map(|info| info.cluster as usize)
                .filter(|next| *next > byte_start)
                .min()
                .unwrap_or(run.text.len());
            clusters.push(GlyphCluster {
                source_range_utf8: crate::paint::TextSourceRange::new(
                    byte_start as u32,
                    byte_end as u32,
                ),
                source_range_utf16: Some(crate::paint::TextSourceRange::new(
                    run.text[..byte_start].encode_utf16().count() as u32,
                    run.text[..byte_end].encode_utf16().count() as u32,
                )),
                text_range_utf8: Some(crate::paint::TextSourceRange::new(
                    byte_start as u32,
                    byte_end as u32,
                )),
                glyph_range: crate::paint::GlyphRange::new(glyph_start as u32, glyph_end as u32),
                flags: Vec::new(),
            });
            glyph_start = glyph_end;
        }

        let digest = crate::paint::resource_digest_hex(font.bytes);
        Some(ResolvedGlyphRun {
            shape_key: ShapeKey {
                font_instance: crate::paint::FontInstanceKey {
                    face_key: crate::paint::FontFaceKey(format!(
                        "font-face-{digest}-{}",
                        font.face_index
                    )),
                    size_px: run.style.font_size,
                    variations: Vec::new(),
                    synthetic_bold: run.style.paint_bold(),
                    synthetic_italic: run.style.italic,
                },
                direction: crate::paint::TextDirection::Ltr,
                writing_mode: crate::paint::WritingMode::HorizontalTb,
                script: None,
                language: None,
                features: Vec::new(),
                shaping_engine: crate::paint::ShapingEngineId("rustybuzz-0.20".to_string()),
                fallback_policy: crate::paint::FontFallbackPolicyId("embedded-exact".to_string()),
            },
            glyph_ids: infos.iter().map(|info| info.glyph_id).collect(),
            positions,
            advances: Some(advances),
            clusters,
            diagnostics: GlyphRunDiagnostics {
                quality: TextVariantQuality::Exact,
                replay_eligibility: GlyphRunReplayEligibility::Portable,
                strict_visual_eligible: true,
                max_origin_delta_px: 0.0,
                max_advance_delta_px: 0.0,
                max_residual_after_adjustment_px: 0.0,
                cluster_mismatch_count: 0,
                missing_glyph_count: infos.iter().filter(|info| info.glyph_id == 0).count() as u32,
                used_fallback_font_count: 0,
                reason: None,
            },
        })
    }
}

pub fn register_embedded_font_resources(
    resources: &mut crate::paint::ResourceArena,
    fonts: &[EmbeddedFontFace<'_>],
) {
    for font in fonts {
        let digest_value = crate::paint::resource_digest_hex(font.bytes);
        let blob_key = crate::paint::FontBlobKey(format!("font-blob-{digest_value}"));
        let face_key =
            crate::paint::FontFaceKey(format!("font-face-{digest_value}-{}", font.face_index));
        if !resources
            .font_resources()
            .blobs
            .iter()
            .any(|blob| blob.id == blob_key)
        {
            resources.intern_font_blob_bytes(font.bytes);
            let digest = crate::paint::FontDigest {
                algorithm: "blake3".to_string(),
                value: digest_value.clone(),
            };
            let data_ref = crate::paint::BinaryResourceRef {
                kind: crate::paint::BinaryResourceKind::FontBlob,
                id: crate::paint::font_blob_resource_key(font.bytes.len(), &digest_value),
            };
            resources
                .font_resources_mut()
                .blobs
                .push(crate::paint::FontBlobResource {
                    id: blob_key.clone(),
                    digest: Some(digest.clone()),
                    source: crate::paint::FontResourceSource::Embedded,
                    data_ref: Some(data_ref.clone()),
                    portability: crate::paint::FontPortability::PortableBlob { digest, data_ref },
                });
        }
        if !resources
            .font_resources()
            .faces
            .iter()
            .any(|face| face.id == face_key)
        {
            resources
                .font_resources_mut()
                .faces
                .push(crate::paint::FontFaceResource {
                    id: face_key,
                    blob_key,
                    face_index: font.face_index,
                    postscript_name: None,
                    family_names: vec![crate::paint::LocalizedName {
                        locale: None,
                        value: font.family.to_string(),
                    }],
                    style_names: Vec::new(),
                    weight_class: None,
                    width_class: None,
                    italic: None,
                });
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GlyphRunQuality {
    Exact,
    PositionAdjusted,
    Approximate,
    DiagnosticOnly,
    Omitted,
}

impl GlyphRunQuality {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Exact => "exact",
            Self::PositionAdjusted => "positionAdjusted",
            Self::Approximate => "approximate",
            Self::DiagnosticOnly => "diagnosticOnly",
            Self::Omitted => "omitted",
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct TextShapeDiagnostic {
    pub text: String,
    pub attempted: bool,
    pub public_glyph_run_emitted: bool,
    pub quality: GlyphRunQuality,
    pub replay_eligibility: GlyphRunReplayEligibility,
    pub strict_visual_eligible: bool,
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct TextShapeReport {
    pub diagnostics: Vec<TextShapeDiagnostic>,
}

impl TextShapeReport {
    pub fn public_glyph_run_count(&self) -> usize {
        self.diagnostics
            .iter()
            .filter(|diagnostic| diagnostic.public_glyph_run_emitted)
            .count()
    }
}

pub struct TextShapeLowerer<'a> {
    resolver: &'a dyn FontResolver,
}

impl<'a> TextShapeLowerer<'a> {
    pub fn new(resolver: &'a dyn FontResolver) -> Self {
        Self { resolver }
    }

    pub fn diagnostics_only(resolver: &'a dyn FontResolver) -> Self {
        Self::new(resolver)
    }

    pub fn analyze_root(&self, root: &LayerNode) -> TextShapeReport {
        let mut report = TextShapeReport::default();
        self.collect_node(root, &mut report);
        report
    }

    pub fn lower_root(&self, root: &mut LayerNode) -> TextShapeReport {
        let mut report = TextShapeReport::default();
        let mut next_text_source_id = 0_u32;
        self.lower_node(root, &mut report, &mut next_text_source_id);
        report
    }

    fn collect_node(&self, node: &LayerNode, report: &mut TextShapeReport) {
        match &node.kind {
            LayerNodeKind::Group { children, .. } => {
                for child in children {
                    self.collect_node(child, report);
                }
            }
            LayerNodeKind::ClipRect { child, .. } => self.collect_node(child, report),
            LayerNodeKind::Leaf { ops } => {
                for op in ops {
                    if let PaintOp::TextRun { run, .. } = op {
                        report.diagnostics.push(self.analyze_text_run(run));
                    }
                }
            }
        }
    }

    fn lower_node(
        &self,
        node: &mut LayerNode,
        report: &mut TextShapeReport,
        next_text_source_id: &mut u32,
    ) {
        match &mut node.kind {
            LayerNodeKind::Group { children, .. } => {
                for child in children {
                    self.lower_node(child, report, next_text_source_id);
                }
            }
            LayerNodeKind::ClipRect { child, .. } => {
                self.lower_node(child, report, next_text_source_id);
            }
            LayerNodeKind::Leaf { ops } => {
                let existing_glyph_groups = ops
                    .iter()
                    .filter_map(|op| match op {
                        PaintOp::GlyphRun { run, .. } => {
                            Some(run.variant.equivalence_group.clone())
                        }
                        _ => None,
                    })
                    .collect::<HashSet<_>>();
                let mut lowered = Vec::with_capacity(ops.len());
                for op in ops.drain(..) {
                    if let PaintOp::TextRun { bbox, run } = op {
                        let text_source_id = *next_text_source_id;
                        let equivalence_group = format!("text-{text_source_id}");
                        if existing_glyph_groups.contains(&equivalence_group) {
                            lowered.push(PaintOp::TextRun { bbox, run });
                            *next_text_source_id = (*next_text_source_id).saturating_add(1);
                            continue;
                        }
                        let (diagnostic, glyph_run) =
                            self.lower_text_run(bbox, &run, text_source_id);
                        report.diagnostics.push(diagnostic);
                        lowered.push(PaintOp::TextRun { bbox, run });
                        if let Some(glyph_run) = glyph_run {
                            lowered.push(PaintOp::GlyphRun {
                                bbox,
                                run: Box::new(glyph_run),
                            });
                        }
                        *next_text_source_id = (*next_text_source_id).saturating_add(1);
                    } else {
                        lowered.push(op);
                    }
                }
                *ops = lowered;
            }
        }
    }

    fn analyze_text_run(&self, run: &TextRunNode) -> TextShapeDiagnostic {
        self.evaluate_text_run(None, run, 0).0
    }

    fn lower_text_run(
        &self,
        bbox: BoundingBox,
        run: &TextRunNode,
        text_source_id: u32,
    ) -> (TextShapeDiagnostic, Option<LayerGlyphRunPaint>) {
        self.evaluate_text_run(Some(bbox), run, text_source_id)
    }

    fn evaluate_text_run(
        &self,
        bbox: Option<BoundingBox>,
        run: &TextRunNode,
        text_source_id: u32,
    ) -> (TextShapeDiagnostic, Option<LayerGlyphRunPaint>) {
        if run.char_overlap.is_some()
            || run.text.is_empty()
            || !run
                .style
                .nonprinting_control_space_indices(&run.text, &run.text)
                .is_empty()
        {
            return (
                TextShapeDiagnostic {
                    text: run.text.clone(),
                    attempted: false,
                    public_glyph_run_emitted: false,
                    quality: GlyphRunQuality::Omitted,
                    replay_eligibility: GlyphRunReplayEligibility::NotReplayable,
                    strict_visual_eligible: false,
                    reason: Some("notShapingCandidate".to_string()),
                },
                None,
            );
        }

        let request = FontRequest::from(run);
        let resolved = self.resolver.resolve_font(&request);
        let replay_eligibility = GlyphRunReplayEligibility::from(resolved.portability);
        let attempted = matches!(
            replay_eligibility,
            GlyphRunReplayEligibility::Portable
                | GlyphRunReplayEligibility::ConditionalExternalFont
                | GlyphRunReplayEligibility::LocalDiagnosticOnly
        );
        let mut diagnostic_quality = if attempted {
            GlyphRunQuality::DiagnosticOnly
        } else {
            GlyphRunQuality::Omitted
        };
        let mut reason = match replay_eligibility {
            GlyphRunReplayEligibility::Portable => Some("diagnosticsOnlySkeleton".to_string()),
            GlyphRunReplayEligibility::ConditionalExternalFont => {
                Some("externalFontRequiresConsumerVerification".to_string())
            }
            GlyphRunReplayEligibility::LocalDiagnosticOnly => {
                Some("localDiagnosticOnly".to_string())
            }
            GlyphRunReplayEligibility::NotReplayable => Some("fontResourceUnavailable".to_string()),
        };

        let mut public_glyph_run = None;
        let mut public_glyph_run_emitted = false;
        let mut strict_visual_eligible = false;
        let paint_style = PaintTextStyle::from(&run.style);

        if matches!(
            replay_eligibility,
            GlyphRunReplayEligibility::Portable
                | GlyphRunReplayEligibility::ConditionalExternalFont
        ) {
            if let Some(bbox) = bbox {
                if let Some(shaped) = self.resolver.shape_glyph_run(&request, run, &resolved) {
                    if !paint_style.is_fill_only_glyph_replay() {
                        reason = Some("unsupportedGlyphRunPaintEffect".to_string());
                    } else if glyph_run_is_exportable(&shaped) {
                        let equivalence_group = format!("text-{text_source_id}");
                        let mut glyph_variant =
                            crate::paint::PaintVariantMeta::text_run_default(equivalence_group);
                        glyph_variant.variant_id = "glyphRun".to_string();
                        glyph_variant.variant_kind = TextVariantKind::GlyphRun;
                        glyph_variant.is_default_fallback = false;
                        glyph_variant.requires =
                            vec!["fontResources".to_string(), "text.glyphRun".to_string()];
                        glyph_variant.quality = Some(shaped.diagnostics.quality);
                        diagnostic_quality = glyph_quality_from_variant(shaped.diagnostics.quality);
                        strict_visual_eligible = shaped.diagnostics.strict_visual_eligible;
                        reason = shaped.diagnostics.reason.clone();
                        public_glyph_run_emitted = true;
                        public_glyph_run = Some(LayerGlyphRunPaint {
                            source: crate::paint::TextSourceSpan {
                                id: crate::paint::TextSourceId(text_source_id),
                                utf8_range: crate::paint::TextSourceRange::new(
                                    0,
                                    run.text.len() as u32,
                                ),
                                utf16_range: crate::paint::TextSourceRange::new(
                                    0,
                                    run.text.encode_utf16().count() as u32,
                                ),
                                stable_source_key: None,
                            },
                            variant: glyph_variant,
                            paint_style: paint_style.clone(),
                            shape_key: shaped.shape_key.clone(),
                            placement: text_run_placement(bbox, run),
                            glyph_ids: shaped.glyph_ids,
                            positions: shaped.positions,
                            advances: shaped.advances,
                            clusters: shaped.clusters,
                            direction: shaped.shape_key.direction,
                            bidi_level: None,
                            writing_mode: shaped.shape_key.writing_mode,
                            orientation: GlyphRunOrientation::from_text_run(run),
                            glyph_transforms: None,
                            diagnostics: shaped.diagnostics,
                        });
                    } else {
                        reason = Some("glyphRunDiagnosticsNotExportable".to_string());
                    }
                }
            }
        }

        (
            TextShapeDiagnostic {
                text: run.text.clone(),
                attempted,
                public_glyph_run_emitted,
                quality: diagnostic_quality,
                replay_eligibility,
                strict_visual_eligible,
                reason,
            },
            public_glyph_run,
        )
    }
}

pub(crate) fn text_run_placement(bbox: BoundingBox, run: &TextRunNode) -> TextRunPlacement {
    let radians = run.rotation.to_radians();
    let (sin, cos) = radians.sin_cos();
    let local_origin_x = -bbox.width / 2.0;
    let local_origin_y = -bbox.height / 2.0 + run.baseline;
    let center_x = bbox.x + bbox.width / 2.0;
    let center_y = bbox.y + bbox.height / 2.0;
    TextRunPlacement {
        run_to_page: LayerAffineTransform {
            a: cos,
            b: sin,
            c: -sin,
            d: cos,
            e: center_x + cos * local_origin_x - sin * local_origin_y,
            f: center_y + sin * local_origin_x + cos * local_origin_y,
        },
        baseline_y: 0.0,
    }
}

fn glyph_run_is_exportable(shaped: &ResolvedGlyphRun) -> bool {
    !shaped.glyph_ids.is_empty()
        && shaped.glyph_ids.len() == shaped.positions.len()
        && shaped
            .advances
            .as_ref()
            .map_or(true, |advances| advances.len() == shaped.glyph_ids.len())
        && !shaped.clusters.is_empty()
        && matches!(
            shaped.diagnostics.replay_eligibility,
            GlyphRunReplayEligibility::Portable
                | GlyphRunReplayEligibility::ConditionalExternalFont
        )
        && matches!(
            shaped.diagnostics.quality,
            TextVariantQuality::Exact | TextVariantQuality::PositionAdjusted
        )
        && shaped.diagnostics.missing_glyph_count == 0
        && shaped.diagnostics.cluster_mismatch_count == 0
}

fn glyph_quality_from_variant(quality: TextVariantQuality) -> GlyphRunQuality {
    match quality {
        TextVariantQuality::Exact => GlyphRunQuality::Exact,
        TextVariantQuality::PositionAdjusted => GlyphRunQuality::PositionAdjusted,
        TextVariantQuality::Approximate => GlyphRunQuality::Approximate,
        TextVariantQuality::DiagnosticOnly => GlyphRunQuality::DiagnosticOnly,
        TextVariantQuality::Omitted => GlyphRunQuality::Omitted,
    }
}

