use crate::error::HwpError;
use crate::model::ColorRef;
use crate::paint::{
    GlyphOutlinePayloadKind, GlyphRunOrientation, GlyphRunReplayEligibility,
    LayerGlyphOutlinePaint, LayerGlyphRunPaint, LayerNode, LayerNodeKind, PageLayerTree, PaintOp,
    ResourceArena, TextVariantKind, TextVariantQuality,
};
use crate::renderer::static_svg::static_svg_fragment_has_path_layer;
use image::{ImageReader, Limits};
use std::collections::{BTreeMap, BTreeSet};
use std::io::Cursor;

const MAX_CANVASKIT_BITMAP_RESOURCE_BYTES: usize = 4 * 1024 * 1024;
const MAX_CANVASKIT_BITMAP_DIMENSION: u32 = 8192;
const MAX_CANVASKIT_BITMAP_PIXELS: u64 = 32 * 1024 * 1024;

pub type LayerRenderResult<T> = Result<T, HwpError>;

/// visual layer tree를 backend 출력으로 재생한다.
pub trait LayerRenderer {
    fn render_page(&mut self, tree: &PageLayerTree) -> LayerRenderResult<()>;
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct RasterRenderOptions {
    pub max_dimension: i32,
    pub max_pixels: u64,
    pub scale: f64,
    pub dpi: Option<f64>,
    pub transparent: bool,
    pub background_color: Option<ColorRef>,
    pub color_space: RasterColorSpace,
    pub format: RasterOutputFormat,
}

impl Default for RasterRenderOptions {
    fn default() -> Self {
        Self {
            max_dimension: 16_384,
            max_pixels: 67_108_864,
            scale: 1.0,
            dpi: None,
            transparent: true,
            background_color: None,
            color_space: RasterColorSpace::Srgb,
            format: RasterOutputFormat::Png,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RasterColorSpace {
    Srgb,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RasterOutputFormat {
    Png,
}

#[derive(Debug, Clone, PartialEq)]
pub struct RasterRenderOutput {
    pub bytes: Vec<u8>,
    pub format: RasterOutputFormat,
    pub width: i32,
    pub height: i32,
    pub dpi: Option<f64>,
    pub color_space: RasterColorSpace,
}

/// visual layer tree를 raster 결과로 직접 내보내는 backend 계약.
pub trait LayerRasterRenderer {
    fn render_png(&self, tree: &PageLayerTree) -> LayerRenderResult<Vec<u8>> {
        self.render_png_with_options(tree, RasterRenderOptions::default())
    }

    fn render_png_with_options(
        &self,
        tree: &PageLayerTree,
        options: RasterRenderOptions,
    ) -> LayerRenderResult<Vec<u8>> {
        let mut png_options = options;
        png_options.format = RasterOutputFormat::Png;
        self.render_raster(tree, png_options)
            .map(|output| output.bytes)
    }

    fn render_raster(
        &self,
        tree: &PageLayerTree,
        options: RasterRenderOptions,
    ) -> LayerRenderResult<RasterRenderOutput>;
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VariantSelectionBackend {
    NativeSkia,
    CanvasKit,
    /// JSON LayerTree replayed by the browser CanvasKit implementation.
    CanvasKitBrowser,
    Canvas2D,
    Svg,
}

impl VariantSelectionBackend {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::NativeSkia => "nativeSkia",
            Self::CanvasKit => "canvasKit",
            Self::CanvasKitBrowser => "canvasKitBrowser",
            Self::Canvas2D => "canvas2d",
            Self::Svg => "svg",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VariantSelectedReason {
    GlyphRunStrictEligible,
    GlyphOutlineStrictProfile,
    DefaultTextRunFallback,
    NoSupportedVariant,
}

impl VariantSelectedReason {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::GlyphRunStrictEligible => "glyphRunStrictEligible",
            Self::GlyphOutlineStrictProfile => "glyphOutlineStrictProfile",
            Self::DefaultTextRunFallback => "defaultTextRunFallback",
            Self::NoSupportedVariant => "noSupportedVariant",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum VariantRejectReason {
    BackendDoesNotSupportVariant,
    FontNotPortable,
    ExternalFontNotVerified,
    FontFaceMissing,
    FontBlobMissing,
    FontBlobNotPortable,
    FontBlobBytesMissing,
    FontBlobDataRefMismatch,
    FontBlobDigestMismatch,
    FaceIndexUnsupported,
    VariationUnsupported,
    GlyphIdOutOfRange,
    MissingGlyph,
    ClusterMismatch,
    UnsupportedPaintEffect,
    IncompleteVariantSet,
    VariantPartCountMismatch,
    VariantDuplicatePart,
    VariantPartsIncomplete,
    GlyphOutlineUnsupported,
    UnsupportedOutlinePayload,
    MixedGlyphOutlinePayload,
    EmptyGlyphOutlinePayload,
    GlyphOutlineStrokeStyleUnsupported,
    UnsupportedColorGlyph,
    UnsupportedBitmapGlyph,
    UnsupportedSvgGlyph,
    MissingGlyphPayloadResource,
    MixedPerGlyphAuthorityPending,
    GlyphTransformAuthorityPending,
    VerticalGlyphOrientationAuthorityPending,
    PositionAdjustedNotAllowed,
    PositionAdjustedResidualTooLarge,
}

impl VariantRejectReason {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::BackendDoesNotSupportVariant => "backendDoesNotSupportVariant",
            Self::FontNotPortable => "fontNotPortable",
            Self::ExternalFontNotVerified => "externalFontNotVerified",
            Self::FontFaceMissing => "fontFaceMissing",
            Self::FontBlobMissing => "fontBlobMissing",
            Self::FontBlobNotPortable => "fontBlobNotPortable",
            Self::FontBlobBytesMissing => "fontBlobBytesMissing",
            Self::FontBlobDataRefMismatch => "fontBlobDataRefMismatch",
            Self::FontBlobDigestMismatch => "fontBlobDigestMismatch",
            Self::FaceIndexUnsupported => "faceIndexUnsupported",
            Self::VariationUnsupported => "variationUnsupported",
            Self::GlyphIdOutOfRange => "glyphIdOutOfRange",
            Self::MissingGlyph => "missingGlyph",
            Self::ClusterMismatch => "clusterMismatch",
            Self::UnsupportedPaintEffect => "unsupportedPaintEffect",
            Self::IncompleteVariantSet => "incompleteVariantSet",
            Self::VariantPartCountMismatch => "variantPartCountMismatch",
            Self::VariantDuplicatePart => "variantDuplicatePart",
            Self::VariantPartsIncomplete => "variantPartsIncomplete",
            Self::GlyphOutlineUnsupported => "glyphOutlineUnsupported",
            Self::UnsupportedOutlinePayload => "unsupportedOutlinePayload",
            Self::MixedGlyphOutlinePayload => "mixedGlyphOutlinePayload",
            Self::EmptyGlyphOutlinePayload => "emptyGlyphOutlinePayload",
            Self::GlyphOutlineStrokeStyleUnsupported => "glyphOutlineStrokeStyleUnsupported",
            Self::UnsupportedColorGlyph => "unsupportedColorGlyph",
            Self::UnsupportedBitmapGlyph => "unsupportedBitmapGlyph",
            Self::UnsupportedSvgGlyph => "unsupportedSvgGlyph",
            Self::MissingGlyphPayloadResource => "missingGlyphPayloadResource",
            Self::MixedPerGlyphAuthorityPending => "mixedPerGlyphAuthorityPending",
            Self::GlyphTransformAuthorityPending => "glyphTransformAuthorityPending",
            Self::VerticalGlyphOrientationAuthorityPending => {
                "verticalGlyphOrientationAuthorityPending"
            }
            Self::PositionAdjustedNotAllowed => "positionAdjustedNotAllowed",
            Self::PositionAdjustedResidualTooLarge => "positionAdjustedResidualTooLarge",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct TextVariantSelectionOptions {
    pub backend: VariantSelectionBackend,
    pub prefer_strict_outline: bool,
    pub allow_position_adjusted: bool,
    pub max_position_adjusted_residual_px: f64,
    pub max_canvas_glyph_id: u32,
    pub allow_colrv0_color_layers: bool,
    /// Compatibility name for the first P19-supported COLRv1 graph subset:
    /// solid paths, single linear/radial/full-circle sweep gradient paths, and
    /// transform chains ending in one supported leaf.
    pub allow_colrv1_stage1_color_graph: bool,
    pub allow_bitmap_glyph: bool,
    pub allow_svg_glyph: bool,
}

impl Default for TextVariantSelectionOptions {
    fn default() -> Self {
        Self::canvaskit()
    }
}

impl TextVariantSelectionOptions {
    pub fn canvaskit() -> Self {
        Self {
            backend: VariantSelectionBackend::CanvasKit,
            prefer_strict_outline: false,
            allow_position_adjusted: true,
            max_position_adjusted_residual_px: 0.25,
            max_canvas_glyph_id: u16::MAX as u32,
            allow_colrv0_color_layers: false,
            allow_colrv1_stage1_color_graph: false,
            allow_bitmap_glyph: false,
            allow_svg_glyph: false,
        }
    }

    pub fn canvaskit_strict_outline() -> Self {
        Self {
            prefer_strict_outline: true,
            ..Self::canvaskit()
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct TextVariantSelectionReport {
    pub backend: VariantSelectionBackend,
    pub equivalence_group: String,
    pub selected_variant_id: Option<String>,
    pub selected_variant_kind: Option<TextVariantKind>,
    pub selected_reason: VariantSelectedReason,
    pub fallback_required: bool,
    pub rejected_variants: Vec<TextVariantRejectReport>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct TextVariantRejectReport {
    pub variant_id: String,
    pub variant_kind: TextVariantKind,
    pub reasons: Vec<VariantRejectReason>,
}

pub fn analyze_text_variant_selection(
    tree: &PageLayerTree,
    options: TextVariantSelectionOptions,
) -> Vec<TextVariantSelectionReport> {
    let mut groups = BTreeMap::<String, TextVariantGroupState>::new();
    let mut next_order = 0usize;
    collect_text_variant_groups(&tree.root, &mut groups, &mut next_order);
    groups
        .into_iter()
        .map(|(equivalence_group, group)| group.finish(equivalence_group, options, &tree.resources))
        .collect()
}

#[derive(Debug, Default)]
struct TextVariantGroupState {
    fallback_present: bool,
    variants: BTreeMap<String, TextVariantCandidate>,
}

impl TextVariantGroupState {
    fn finish(
        self,
        equivalence_group: String,
        options: TextVariantSelectionOptions,
        resources: &ResourceArena,
    ) -> TextVariantSelectionReport {
        let mut evaluated = self
            .variants
            .into_values()
            .map(|candidate| {
                let reasons = candidate.reject_reasons(options, resources);
                EvaluatedTextVariantCandidate { candidate, reasons }
            })
            .collect::<Vec<_>>();
        evaluated.sort_by_key(|evaluated| evaluated.candidate.order);
        let rejected_variants = evaluated
            .iter()
            .filter(|evaluated| !evaluated.reasons.is_empty())
            .map(|evaluated| TextVariantRejectReport {
                variant_id: evaluated.candidate.variant_id.clone(),
                variant_kind: evaluated.candidate.variant_kind,
                reasons: evaluated.reasons.clone(),
            })
            .collect::<Vec<_>>();
        let outline_selection = options
            .prefer_strict_outline
            .then(|| {
                evaluated.iter().find(|evaluated| {
                    evaluated.candidate.variant_kind == TextVariantKind::GlyphOutline
                        && evaluated.reasons.is_empty()
                })
            })
            .flatten();
        let glyph_selection = evaluated.iter().find(|evaluated| {
            evaluated.candidate.variant_kind == TextVariantKind::GlyphRun
                && evaluated.reasons.is_empty()
        });
        let fallback_outline_selection = (!options.prefer_strict_outline)
            .then(|| {
                evaluated.iter().find(|evaluated| {
                    evaluated.candidate.variant_kind == TextVariantKind::GlyphOutline
                        && evaluated.reasons.is_empty()
                })
            })
            .flatten();
        let selected = outline_selection
            .or(glyph_selection)
            .or(fallback_outline_selection);
        if let Some(selected) = selected {
            return TextVariantSelectionReport {
                backend: options.backend,
                equivalence_group,
                selected_variant_id: Some(selected.candidate.variant_id.clone()),
                selected_variant_kind: Some(selected.candidate.variant_kind),
                selected_reason: selected_reason_for_variant(selected.candidate.variant_kind),
                fallback_required: false,
                rejected_variants,
            };
        }
        TextVariantSelectionReport {
            backend: options.backend,
            equivalence_group,
            selected_variant_id: self.fallback_present.then(|| "textRun".to_string()),
            selected_variant_kind: self.fallback_present.then_some(TextVariantKind::TextRun),
            selected_reason: if self.fallback_present {
                VariantSelectedReason::DefaultTextRunFallback
            } else {
                VariantSelectedReason::NoSupportedVariant
            },
            fallback_required: true,
            rejected_variants,
        }
    }
}

#[derive(Debug)]
struct EvaluatedTextVariantCandidate {
    candidate: TextVariantCandidate,
    reasons: Vec<VariantRejectReason>,
}

fn selected_reason_for_variant(variant_kind: TextVariantKind) -> VariantSelectedReason {
    match variant_kind {
        TextVariantKind::GlyphRun => VariantSelectedReason::GlyphRunStrictEligible,
        TextVariantKind::GlyphOutline => VariantSelectedReason::GlyphOutlineStrictProfile,
        TextVariantKind::TextRun => {
            unreachable!("TextRun fallback is tracked through fallback_present, not candidates")
        }
    }
}

#[derive(Debug)]
struct TextVariantCandidate {
    order: usize,
    variant_id: String,
    variant_kind: TextVariantKind,
    part_counts: BTreeSet<u32>,
    present_parts: BTreeSet<u32>,
    duplicate_part: bool,
    glyph_runs: Vec<LayerGlyphRunPaint>,
    glyph_outlines: Vec<LayerGlyphOutlinePaint>,
}

impl TextVariantCandidate {
    fn new(order: usize, variant_id: String, variant_kind: TextVariantKind) -> Self {
        Self {
            order,
            variant_id,
            variant_kind,
            part_counts: BTreeSet::new(),
            present_parts: BTreeSet::new(),
            duplicate_part: false,
            glyph_runs: Vec::new(),
            glyph_outlines: Vec::new(),
        }
    }

    fn add_glyph_run(&mut self, run: &LayerGlyphRunPaint) {
        self.part_counts.insert(run.variant.part_count);
        self.duplicate_part |= !self.present_parts.insert(run.variant.part_index);
        self.glyph_runs.push(run.clone());
    }

    fn add_glyph_outline(&mut self, outline: &LayerGlyphOutlinePaint) {
        self.part_counts.insert(outline.variant.part_count);
        self.duplicate_part |= !self.present_parts.insert(outline.variant.part_index);
        self.glyph_outlines.push(outline.clone());
    }

    fn reject_reasons(
        &self,
        options: TextVariantSelectionOptions,
        resources: &ResourceArena,
    ) -> Vec<VariantRejectReason> {
        let mut reasons = BTreeSet::<VariantRejectReason>::new();
        self.collect_structure_reasons(&mut reasons);
        match self.variant_kind {
            TextVariantKind::TextRun => {
                unreachable!("TextRun fallback is tracked through fallback_present, not candidates")
            }
            TextVariantKind::GlyphRun => {
                if !matches!(
                    options.backend,
                    VariantSelectionBackend::CanvasKit | VariantSelectionBackend::NativeSkia
                ) {
                    reasons.insert(VariantRejectReason::BackendDoesNotSupportVariant);
                }
                for run in &self.glyph_runs {
                    collect_glyph_run_reject_reasons(run, options, resources, &mut reasons);
                }
            }
            TextVariantKind::GlyphOutline => {
                if matches!(options.backend, VariantSelectionBackend::Canvas2D) {
                    reasons.insert(VariantRejectReason::BackendDoesNotSupportVariant);
                }
                for outline in &self.glyph_outlines {
                    collect_glyph_outline_reject_reasons(outline, options, resources, &mut reasons);
                }
            }
        }
        reasons.into_iter().collect()
    }

    fn collect_structure_reasons(&self, reasons: &mut BTreeSet<VariantRejectReason>) {
        if self.part_counts.is_empty() || self.part_counts.contains(&0) {
            reasons.insert(VariantRejectReason::IncompleteVariantSet);
        }
        if self.part_counts.len() > 1 {
            reasons.insert(VariantRejectReason::VariantPartCountMismatch);
        }
        if self.duplicate_part {
            reasons.insert(VariantRejectReason::VariantDuplicatePart);
        }
        let expected = self.part_counts.iter().next().copied().unwrap_or_default();
        if expected == 0
            || self.present_parts.len() as u32 != expected
            || !(0..expected).all(|index| self.present_parts.contains(&index))
        {
            reasons.insert(VariantRejectReason::VariantPartsIncomplete);
        }
    }
}

fn collect_text_variant_groups(
    node: &LayerNode,
    groups: &mut BTreeMap<String, TextVariantGroupState>,
    next_order: &mut usize,
) {
    match &node.kind {
        LayerNodeKind::Group { children, .. } => {
            for child in children {
                collect_text_variant_groups(child, groups, next_order);
            }
        }
        LayerNodeKind::ClipRect { child, .. } => {
            collect_text_variant_groups(child, groups, next_order);
        }
        LayerNodeKind::Leaf { ops } => {
            let fallback_present = ops.iter().any(|op| matches!(op, PaintOp::TextRun { .. }));
            for op in ops {
                match op {
                    PaintOp::GlyphRun { run, .. } => {
                        let group = groups
                            .entry(run.variant.equivalence_group.clone())
                            .or_default();
                        group.fallback_present |= fallback_present;
                        let candidate = group
                            .variants
                            .entry(run.variant.variant_id.clone())
                            .or_insert_with(|| {
                                let order = *next_order;
                                *next_order = (*next_order).saturating_add(1);
                                TextVariantCandidate::new(
                                    order,
                                    run.variant.variant_id.clone(),
                                    run.variant.variant_kind,
                                )
                            });
                        candidate.add_glyph_run(run);
                    }
                    PaintOp::GlyphOutline { outline, .. } => {
                        let group = groups
                            .entry(outline.variant.equivalence_group.clone())
                            .or_default();
                        group.fallback_present |= fallback_present;
                        let candidate = group
                            .variants
                            .entry(outline.variant.variant_id.clone())
                            .or_insert_with(|| {
                                let order = *next_order;
                                *next_order = (*next_order).saturating_add(1);
                                TextVariantCandidate::new(
                                    order,
                                    outline.variant.variant_id.clone(),
                                    outline.variant.variant_kind,
                                )
                            });
                        candidate.add_glyph_outline(outline);
                    }
                    _ => {}
                }
            }
        }
    }
}

fn collect_glyph_run_reject_reasons(
    run: &LayerGlyphRunPaint,
    options: TextVariantSelectionOptions,
    resources: &ResourceArena,
    reasons: &mut BTreeSet<VariantRejectReason>,
) {
    if !run.paint_style.is_fill_only_glyph_replay() {
        reasons.insert(VariantRejectReason::UnsupportedPaintEffect);
    }
    if run.glyph_transforms.is_some() {
        reasons.insert(VariantRejectReason::GlyphTransformAuthorityPending);
    }
    match run.orientation {
        GlyphRunOrientation::Horizontal => {}
        GlyphRunOrientation::MixedPerGlyph => {
            reasons.insert(VariantRejectReason::MixedPerGlyphAuthorityPending);
        }
        GlyphRunOrientation::VerticalUpright | GlyphRunOrientation::VerticalSideways => {
            reasons.insert(VariantRejectReason::VerticalGlyphOrientationAuthorityPending);
        }
    }
    if matches!(
        options.backend,
        VariantSelectionBackend::CanvasKit | VariantSelectionBackend::NativeSkia
    ) {
        if !run.shape_key.font_instance.variations.is_empty() {
            reasons.insert(VariantRejectReason::VariationUnsupported);
        }
        if matches!(
            run.diagnostics.replay_eligibility,
            GlyphRunReplayEligibility::Portable
        ) {
            collect_glyph_run_font_resource_reject_reasons(run, resources, reasons);
        }
    }
    collect_text_variant_diagnostics_reject_reasons(&run.diagnostics, options, reasons);
    if run
        .glyph_ids
        .iter()
        .any(|glyph_id| *glyph_id > options.max_canvas_glyph_id)
    {
        reasons.insert(VariantRejectReason::GlyphIdOutOfRange);
    }
}

fn collect_glyph_run_font_resource_reject_reasons(
    run: &LayerGlyphRunPaint,
    resources: &ResourceArena,
    reasons: &mut BTreeSet<VariantRejectReason>,
) {
    let font_resources = resources.font_resources();
    let Some(face) = font_resources
        .faces
        .iter()
        .find(|face| face.id == run.shape_key.font_instance.face_key)
    else {
        reasons.insert(VariantRejectReason::FontFaceMissing);
        return;
    };

    if face.face_index != 0 {
        reasons.insert(VariantRejectReason::FaceIndexUnsupported);
    }

    let Some(blob) = font_resources
        .blobs
        .iter()
        .find(|blob| blob.id == face.blob_key)
    else {
        reasons.insert(VariantRejectReason::FontBlobMissing);
        return;
    };

    let crate::paint::FontPortability::PortableBlob { digest, data_ref } = &blob.portability else {
        reasons.insert(VariantRejectReason::FontBlobNotPortable);
        return;
    };

    if blob.data_ref.as_ref() != Some(data_ref) {
        reasons.insert(VariantRejectReason::FontBlobDataRefMismatch);
    }

    match resources.font_blob_bytes_for_ref(data_ref) {
        Some(bytes) => {
            let actual_digest = crate::paint::resource_digest_hex(bytes);
            if !font_digest_matches_resource_digest(digest, &actual_digest)
                || !blob.digest.as_ref().is_none_or(|digest| {
                    font_digest_matches_resource_digest(digest, &actual_digest)
                })
            {
                reasons.insert(VariantRejectReason::FontBlobDigestMismatch);
            }
        }
        None => {
            reasons.insert(VariantRejectReason::FontBlobBytesMissing);
        }
    }
}

fn font_digest_matches_resource_digest(digest: &crate::paint::FontDigest, actual: &str) -> bool {
    digest.algorithm == crate::paint::RESOURCE_KEY_ALGORITHM && digest.value == actual
}

fn collect_glyph_outline_reject_reasons(
    outline: &LayerGlyphOutlinePaint,
    options: TextVariantSelectionOptions,
    resources: &ResourceArena,
    reasons: &mut BTreeSet<VariantRejectReason>,
) {
    if !outline.has_exclusive_payload_family() {
        reasons.insert(VariantRejectReason::MixedGlyphOutlinePayload);
    }
    if matches!(
        outline.payload_kind,
        GlyphOutlinePayloadKind::MonochromeFill | GlyphOutlinePayloadKind::MonochromeFillStroke
    ) && outline.paths.is_empty()
    {
        reasons.insert(VariantRejectReason::EmptyGlyphOutlinePayload);
    }
    if !outline.paint_style.is_fill_only_glyph_replay() {
        reasons.insert(VariantRejectReason::UnsupportedPaintEffect);
    }
    match outline.payload_kind {
        GlyphOutlinePayloadKind::MonochromeFill => {
            if outline.stroke.is_some() {
                reasons.insert(VariantRejectReason::UnsupportedOutlinePayload);
            }
        }
        GlyphOutlinePayloadKind::MonochromeFillStroke => {
            if !outline
                .stroke
                .as_ref()
                .is_some_and(|stroke| stroke.is_strict_subset())
            {
                reasons.insert(VariantRejectReason::GlyphOutlineStrokeStyleUnsupported);
            }
        }
        GlyphOutlinePayloadKind::ColorLayers => match outline.color_layers.as_ref() {
            Some(color_layers)
                if color_layers.has_colrv0_resolved_layer_contract()
                    && options.allow_colrv0_color_layers => {}
            Some(color_layers)
                if color_layers.has_colrv1_supported_graph_contract()
                    && options.allow_colrv1_stage1_color_graph => {}
            _ => {
                reasons.insert(VariantRejectReason::UnsupportedColorGlyph);
            }
        },
        GlyphOutlinePayloadKind::BitmapGlyph => match outline.bitmap_glyph.as_ref() {
            Some(bitmap_glyph) if !bitmap_glyph.has_strict_visual_contract() => {
                reasons.insert(VariantRejectReason::UnsupportedBitmapGlyph);
            }
            Some(_) if !options.allow_bitmap_glyph => {
                reasons.insert(VariantRejectReason::UnsupportedBitmapGlyph);
            }
            Some(bitmap_glyph) => match resources.image_bytes(bitmap_glyph.image_ref) {
                None => {
                    reasons.insert(VariantRejectReason::MissingGlyphPayloadResource);
                }
                Some(bytes) if !canvaskit_bitmap_resource_is_decodable(bytes) => {
                    reasons.insert(VariantRejectReason::UnsupportedBitmapGlyph);
                }
                Some(_) => {}
            },
            None => {
                reasons.insert(VariantRejectReason::UnsupportedBitmapGlyph);
            }
        },
        GlyphOutlinePayloadKind::SvgGlyph => match outline.svg_glyph.as_ref() {
            Some(svg_glyph) if !svg_glyph.has_static_sanitized_contract() => {
                reasons.insert(VariantRejectReason::UnsupportedSvgGlyph);
            }
            Some(_) if !options.allow_svg_glyph => {
                reasons.insert(VariantRejectReason::UnsupportedSvgGlyph);
            }
            Some(svg_glyph) => match resources.svg_fragment(svg_glyph.svg_ref) {
                None => {
                    reasons.insert(VariantRejectReason::MissingGlyphPayloadResource);
                }
                Some(fragment) if !static_svg_fragment_has_path_layer(fragment) => {
                    reasons.insert(VariantRejectReason::UnsupportedSvgGlyph);
                }
                Some(_) => {}
            },
            None => {
                reasons.insert(VariantRejectReason::UnsupportedSvgGlyph);
            }
        },
    }
    collect_text_variant_diagnostics_reject_reasons(&outline.diagnostics, options, reasons);
}

fn canvaskit_bitmap_resource_is_decodable(bytes: &[u8]) -> bool {
    if bytes.is_empty() || bytes.len() > MAX_CANVASKIT_BITMAP_RESOURCE_BYTES {
        return false;
    }
    let Ok(format) = image::guess_format(bytes) else {
        return false;
    };
    let mut reader = ImageReader::with_format(Cursor::new(bytes), format);
    let mut limits = Limits::default();
    limits.max_image_width = Some(MAX_CANVASKIT_BITMAP_DIMENSION);
    limits.max_image_height = Some(MAX_CANVASKIT_BITMAP_DIMENSION);
    limits.max_alloc = Some(MAX_CANVASKIT_BITMAP_PIXELS * 4);
    reader.limits(limits);
    let Ok(image) = reader.decode() else {
        return false;
    };
    let pixels = u64::from(image.width()) * u64::from(image.height());
    pixels > 0 && pixels <= MAX_CANVASKIT_BITMAP_PIXELS
}

fn collect_text_variant_diagnostics_reject_reasons(
    diagnostics: &crate::paint::GlyphRunDiagnostics,
    options: TextVariantSelectionOptions,
    reasons: &mut BTreeSet<VariantRejectReason>,
) {
    match diagnostics.replay_eligibility {
        GlyphRunReplayEligibility::Portable => {}
        GlyphRunReplayEligibility::ConditionalExternalFont => {
            reasons.insert(VariantRejectReason::ExternalFontNotVerified);
        }
        GlyphRunReplayEligibility::LocalDiagnosticOnly
        | GlyphRunReplayEligibility::NotReplayable => {
            reasons.insert(VariantRejectReason::FontNotPortable);
        }
    }
    match diagnostics.quality {
        TextVariantQuality::Exact => {}
        TextVariantQuality::PositionAdjusted if !options.allow_position_adjusted => {
            reasons.insert(VariantRejectReason::PositionAdjustedNotAllowed);
        }
        TextVariantQuality::PositionAdjusted
            if diagnostics.max_residual_after_adjustment_px
                <= options.max_position_adjusted_residual_px => {}
        TextVariantQuality::PositionAdjusted => {
            reasons.insert(VariantRejectReason::PositionAdjustedResidualTooLarge);
        }
        TextVariantQuality::Approximate
        | TextVariantQuality::DiagnosticOnly
        | TextVariantQuality::Omitted => {
            reasons.insert(VariantRejectReason::UnsupportedPaintEffect);
        }
    }
    if diagnostics.missing_glyph_count > 0 {
        reasons.insert(VariantRejectReason::MissingGlyph);
    }
    if diagnostics.cluster_mismatch_count > 0 {
        reasons.insert(VariantRejectReason::ClusterMismatch);
    }
    if diagnostics.used_fallback_font_count > 0 {
        reasons.insert(VariantRejectReason::FontNotPortable);
    }
}

