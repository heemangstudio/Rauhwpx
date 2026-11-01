use skia_safe::{
    gradient, paint, png_encoder, surfaces, Canvas, Color, Color4f, Font, FontMgr, FontStyle,
    Paint, PathBuilder, PathEffect, RRect, Rect, TileMode, Typeface,
};
use std::borrow::Cow;
use std::collections::{BTreeSet, HashMap, HashSet};

use crate::error::HwpError;
use crate::model::image::ImageEffect;
use crate::model::style::ImageFillMode;
use crate::model::ColorRef;
use crate::paint::replay_order::layer_node_has_replay_plane;
use crate::paint::{
    paint_op_replay_plane_with_layer, GlyphRunOrientation, GlyphRunReplayEligibility,
    LayerGlyphRunPaint, LayerNode, LayerNodeKind, LayerOutputOptions, PageLayerTree, PaintOp,
    PaintReplayPlane, ResourceArena, TextVariantQuality,
};
use crate::renderer::form_caption::display_form_caption;
use crate::renderer::layer_renderer::{
    LayerRasterRenderer, LayerRenderResult, RasterOutputFormat, RasterRenderOptions,
    RasterRenderOutput,
};
use crate::renderer::render_tree::{BoundingBox, RenderLayerInfo};
use crate::renderer::{
    svg_arc_to_beziers, GradientFillInfo, LineStyle, PathCommand, ShapeStyle, StrokeDash,
};

use super::equation_conv::render_equation;
use super::font_lookup::{
    collect_system_families, legacy_typeface_for_style, match_system_family_style,
    SystemFontFamilies,
};
use super::image_conv::{draw_image_bytes, draw_svg_fragment, ImageSampling};
use super::text_replay::{draw_text_run, SkiaTextReplay};

fn shadow_foreground_bbox(
    bbox: BoundingBox,
    nominal_height_pt: Option<f64>,
    transformed: bool,
) -> BoundingBox {
    let Some(nominal_height_pt) = nominal_height_pt else {
        return bbox;
    };
    let css_per_pt = 96.0 / 72.0;
    let width_pt = bbox.width / css_per_pt;
    let height_pt = bbox.height / css_per_pt;
    if transformed
        || !width_pt.is_finite()
        || !height_pt.is_finite()
        || !nominal_height_pt.is_finite()
        || width_pt < 1.0
        || height_pt < 1.0
        || nominal_height_pt <= 0.0
    {
        return bbox;
    }
    // The effect preraster has whole-point dimensions. Its vertical raster origin
    // moves when scaled height crosses a point boundary; hp:sz remains the anchor.
    BoundingBox::new(
        bbox.x,
        bbox.y + (height_pt.floor() - nominal_height_pt.ceil()) * css_per_pt,
        width_pt.floor() * css_per_pt,
        height_pt.floor() * css_per_pt,
    )
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum NativeGlyphRunReplayProofReason {
    EmptyGlyphIds,
    GlyphPositionCountMismatch,
    AdvanceCountMismatch,
    GlyphTransformUnsupported,
    VerticalOrientationUnsupported,
    StrictVisualIneligible,
    MissingGlyph,
    ClusterMismatch,
    UnsupportedQuality,
    PositionAdjustedResidualTooLarge,
    ReplayEligibilityNotPortable,
    UnsupportedPaintEffect,
    GlyphIdOutOfRange,
    PlacementNotFinite,
    PositionNotFinite,
    FontFaceMissing,
    FontBlobMissing,
    FontBlobNotPortable,
    FontBlobBytesMissing,
    FontBlobDataRefMismatch,
    FontBlobDigestMismatch,
    FaceIndexUnsupported,
    FontVariationUnsupported,
    TypefaceConstructionNotImplemented,
}

impl NativeGlyphRunReplayProofReason {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::EmptyGlyphIds => "emptyGlyphIds",
            Self::GlyphPositionCountMismatch => "glyphPositionCountMismatch",
            Self::AdvanceCountMismatch => "advanceCountMismatch",
            Self::GlyphTransformUnsupported => "glyphTransformUnsupported",
            Self::VerticalOrientationUnsupported => "verticalOrientationUnsupported",
            Self::StrictVisualIneligible => "strictVisualIneligible",
            Self::MissingGlyph => "missingGlyph",
            Self::ClusterMismatch => "clusterMismatch",
            Self::UnsupportedQuality => "unsupportedQuality",
            Self::PositionAdjustedResidualTooLarge => "positionAdjustedResidualTooLarge",
            Self::ReplayEligibilityNotPortable => "replayEligibilityNotPortable",
            Self::UnsupportedPaintEffect => "unsupportedPaintEffect",
            Self::GlyphIdOutOfRange => "glyphIdOutOfRange",
            Self::PlacementNotFinite => "placementNotFinite",
            Self::PositionNotFinite => "positionNotFinite",
            Self::FontFaceMissing => "fontFaceMissing",
            Self::FontBlobMissing => "fontBlobMissing",
            Self::FontBlobNotPortable => "fontBlobNotPortable",
            Self::FontBlobBytesMissing => "fontBlobBytesMissing",
            Self::FontBlobDataRefMismatch => "fontBlobDataRefMismatch",
            Self::FontBlobDigestMismatch => "fontBlobDigestMismatch",
            Self::FaceIndexUnsupported => "faceIndexUnsupported",
            Self::FontVariationUnsupported => "fontVariationUnsupported",
            Self::TypefaceConstructionNotImplemented => "typefaceConstructionNotImplemented",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NativeGlyphRunReplayProof {
    pub contract_replayable: bool,
    pub typeface_constructible: bool,
    pub reasons: Vec<NativeGlyphRunReplayProofReason>,
}

fn native_skia_can_replay_glyph_run(run: &LayerGlyphRunPaint, resources: &ResourceArena) -> bool {
    native_skia_glyph_run_replay_proof(run, resources).typeface_constructible
}

fn native_skia_glyph_run_contract_is_replayable(
    run: &LayerGlyphRunPaint,
    resources: &ResourceArena,
) -> bool {
    native_skia_glyph_run_replay_proof(run, resources).contract_replayable
}

pub fn native_skia_glyph_run_replay_proof(
    run: &LayerGlyphRunPaint,
    resources: &ResourceArena,
) -> NativeGlyphRunReplayProof {
    let mut contract_reasons = BTreeSet::new();
    let mut construction_reasons = BTreeSet::new();

    if run.glyph_ids.is_empty() {
        contract_reasons.insert(NativeGlyphRunReplayProofReason::EmptyGlyphIds);
    }
    if run.glyph_ids.len() != run.positions.len() {
        contract_reasons.insert(NativeGlyphRunReplayProofReason::GlyphPositionCountMismatch);
    }
    if run
        .advances
        .as_ref()
        .is_some_and(|advances| advances.len() != run.glyph_ids.len())
    {
        contract_reasons.insert(NativeGlyphRunReplayProofReason::AdvanceCountMismatch);
    }
    if run.glyph_transforms.is_some() {
        contract_reasons.insert(NativeGlyphRunReplayProofReason::GlyphTransformUnsupported);
    }
    if run.orientation != GlyphRunOrientation::Horizontal {
        contract_reasons.insert(NativeGlyphRunReplayProofReason::VerticalOrientationUnsupported);
    }
    if !run.diagnostics.strict_visual_eligible {
        contract_reasons.insert(NativeGlyphRunReplayProofReason::StrictVisualIneligible);
    }
    if run.diagnostics.missing_glyph_count != 0 {
        contract_reasons.insert(NativeGlyphRunReplayProofReason::MissingGlyph);
    }
    if run.diagnostics.cluster_mismatch_count != 0 {
        contract_reasons.insert(NativeGlyphRunReplayProofReason::ClusterMismatch);
    }
    if !matches!(
        run.diagnostics.quality,
        TextVariantQuality::Exact | TextVariantQuality::PositionAdjusted
    ) {
        contract_reasons.insert(NativeGlyphRunReplayProofReason::UnsupportedQuality);
    }
    if run.diagnostics.quality == TextVariantQuality::PositionAdjusted {
        let tolerance = 0.5_f64.min(0.25_f64.max(run.paint_style.font_size * 0.005));
        if !run.diagnostics.max_residual_after_adjustment_px.is_finite()
            || run.diagnostics.max_residual_after_adjustment_px > tolerance
        {
            contract_reasons
                .insert(NativeGlyphRunReplayProofReason::PositionAdjustedResidualTooLarge);
        }
    }
    if run.diagnostics.replay_eligibility != GlyphRunReplayEligibility::Portable {
        contract_reasons.insert(NativeGlyphRunReplayProofReason::ReplayEligibilityNotPortable);
    }
    if !run.paint_style.is_fill_only_glyph_replay() {
        contract_reasons.insert(NativeGlyphRunReplayProofReason::UnsupportedPaintEffect);
    }
    if run
        .glyph_ids
        .iter()
        .any(|glyph_id| *glyph_id > u16::MAX as u32)
    {
        contract_reasons.insert(NativeGlyphRunReplayProofReason::GlyphIdOutOfRange);
    }
    let font_resources = resources.font_resources();
    let face = font_resources
        .faces
        .iter()
        .find(|face| face.id == run.shape_key.font_instance.face_key);
    if let Some(face) = face {
        if face.face_index != 0 {
            construction_reasons.insert(NativeGlyphRunReplayProofReason::FaceIndexUnsupported);
        }
        let blob = font_resources
            .blobs
            .iter()
            .find(|blob| blob.id == face.blob_key);
        if let Some(blob) = blob {
            if !blob.portability.is_self_contained_replayable() {
                contract_reasons.insert(NativeGlyphRunReplayProofReason::FontBlobNotPortable);
            } else if let crate::paint::FontPortability::PortableBlob { data_ref, .. } =
                &blob.portability
            {
                if blob.data_ref.as_ref() != Some(data_ref) {
                    contract_reasons
                        .insert(NativeGlyphRunReplayProofReason::FontBlobDataRefMismatch);
                }
                match resources.font_blob_bytes_for_ref(data_ref) {
                    Some(bytes) if font_blob_digest_matches(bytes, blob) => {}
                    Some(_) => {
                        contract_reasons
                            .insert(NativeGlyphRunReplayProofReason::FontBlobDigestMismatch);
                    }
                    None => {
                        contract_reasons
                            .insert(NativeGlyphRunReplayProofReason::FontBlobBytesMissing);
                    }
                }
            }
        } else {
            contract_reasons.insert(NativeGlyphRunReplayProofReason::FontBlobMissing);
        }
    } else {
        contract_reasons.insert(NativeGlyphRunReplayProofReason::FontFaceMissing);
    }
    if !run.shape_key.font_instance.variations.is_empty() {
        construction_reasons.insert(NativeGlyphRunReplayProofReason::FontVariationUnsupported);
    }
    let transform = run.placement.run_to_page;
    if ![
        transform.a,
        transform.b,
        transform.c,
        transform.d,
        transform.e,
        transform.f,
        run.placement.baseline_y,
    ]
    .into_iter()
    .all(f64::is_finite)
    {
        contract_reasons.insert(NativeGlyphRunReplayProofReason::PlacementNotFinite);
    }
    if !run
        .positions
        .iter()
        .all(|position| position.x.is_finite() && position.y.is_finite())
    {
        contract_reasons.insert(NativeGlyphRunReplayProofReason::PositionNotFinite);
    }

    let contract_replayable = contract_reasons.is_empty();
    if contract_replayable && construction_reasons.is_empty() {
        construction_reasons
            .insert(NativeGlyphRunReplayProofReason::TypefaceConstructionNotImplemented);
    }
    let typeface_constructible = contract_replayable && construction_reasons.is_empty();
    let mut reasons = contract_reasons
        .into_iter()
        .chain(construction_reasons)
        .collect::<Vec<_>>();
    reasons.sort();

    NativeGlyphRunReplayProof {
        contract_replayable,
        typeface_constructible,
        reasons,
    }
}

fn font_blob_digest_matches(bytes: &[u8], blob: &crate::paint::FontBlobResource) -> bool {
    let actual = crate::paint::resource_digest_hex(bytes);
    let portability_digest_matches = match &blob.portability {
        crate::paint::FontPortability::PortableBlob { digest, .. } => {
            font_digest_matches_resource_bytes(digest, &actual)
        }
        _ => false,
    };
    let blob_digest_matches = blob
        .digest
        .as_ref()
        .is_none_or(|digest| font_digest_matches_resource_bytes(digest, &actual));
    portability_digest_matches && blob_digest_matches
}

fn font_digest_matches_resource_bytes(digest: &crate::paint::FontDigest, actual: &str) -> bool {
    digest.algorithm == crate::paint::RESOURCE_KEY_ALGORITHM && digest.value == actual
}

const FORM_CJK_FAMILIES: &[&str] = &[
    "Malgun Gothic",
    "맑은 고딕",
    "NanumGothic",
    "나눔고딕",
    "AppleGothic",
    // #3300: 시스템 부재 headless 환경에서는 bundled_typefaces가 이 두 family를 제공한다.
    "Noto Sans KR ExtraLight",
    "Noto Sans KR",
];

pub(super) type TypefaceCatalog = HashMap<String, Vec<Typeface>>;

fn normalize_typeface_alias(value: &str) -> Option<String> {
    let normalized = value.split_whitespace().collect::<Vec<_>>().join(" ");
    (!normalized.is_empty()).then(|| normalized.to_lowercase())
}

fn typeface_aliases(face: &ttf_parser::Face<'_>, typeface: &Typeface) -> BTreeSet<String> {
    let mut aliases = BTreeSet::new();
    let mut insert = |value: &str| {
        if let Some(alias) = normalize_typeface_alias(value) {
            aliases.insert(alias);
        }
    };

    insert(&typeface.family_name());
    for localized in typeface.new_family_name_iterator() {
        insert(&localized.string);
    }
    if let Some(postscript_name) = typeface.post_script_name() {
        insert(&postscript_name);
    }
    for name in face.names() {
        if matches!(
            name.name_id,
            ttf_parser::name_id::FAMILY
                | ttf_parser::name_id::FULL_NAME
                | ttf_parser::name_id::POST_SCRIPT_NAME
                | ttf_parser::name_id::TYPOGRAPHIC_FAMILY
                | ttf_parser::name_id::COMPATIBLE_FULL
                | ttf_parser::name_id::WWS_FAMILY
        ) {
            if let Some(value) = name.to_string() {
                insert(&value);
            }
        }
    }
    aliases
}

fn typeface_style_distance(candidate: FontStyle, requested: FontStyle) -> (u8, i32, i32) {
    (
        u8::from(candidate.slant() != requested.slant()),
        (*candidate.width() - *requested.width()).abs(),
        (*candidate.weight() - *requested.weight()).abs(),
    )
}

pub(super) fn typeface_for_style(
    catalog: &TypefaceCatalog,
    family: &str,
    requested: FontStyle,
) -> Option<Typeface> {
    let alias = normalize_typeface_alias(family)?;
    catalog
        .get(&alias)?
        .iter()
        .enumerate()
        .min_by_key(|(index, face)| {
            (
                typeface_style_distance(face.font_style(), requested),
                *index,
            )
        })
        .map(|(_, face)| face.clone())
}

pub struct SkiaLayerRenderer {
    font_mgr: FontMgr,
    /// 사용자 지정 폰트 source에서 미리 로드한 폰트 카탈로그.
    /// key = 정규화한 family/full/PostScript 별칭, value = 파일 우선순위의 style face.
    custom_typefaces: TypefaceCatalog,
    /// [#3300] 번들 최후-폴백 폰트(ttfs/opensource). custom 과 분리해 해석
    /// 체인에서 custom·시스템 매칭 **뒤**에만 선다 — custom 에 섞으면 깊은
    /// 폴백(Noto Sans KR)이 시스템 1순위(문서 지정 맑은 고딕 등)를 제치고
    /// 본문 전체를 폴백 서체로 렌더한다(r23 발산 −6.9pp).
    bundled_typefaces: TypefaceCatalog,
    /// 시스템에 실제 존재하는 font family 목록.
    /// headless macOS 에서 missing family 를 CoreText 에 넘기면 downloadable font
    /// lookup IPC가 영구 대기할 수 있어, match_family_style 호출 전 사전 필터로 사용한다.
    system_families: SystemFontFamilies,
}

impl SkiaLayerRenderer {
    pub fn new() -> Self {
        // [perf] FontMgr::default() + collect_system_families() (시스템 폰트 family 전수
        // 열거) 는 페이지당 ~8ms 가 드는데, 프로세스(스레드) 내에서 불변이다. 매 렌더마다
        // 재열거하지 않도록 thread-local 로 1회만 계산하고, 이후 new() 는 캐시를 복제
        // (FontMgr = refcount bump, families = HashSet clone ~수십 µs) 해 재사용한다.
        // 폰트 매칭 입력이 동일하므로 렌더 출력은 바이트 단위로 불변이다.
        thread_local! {
            static SKIA_FONT_BASE: (FontMgr, SystemFontFamilies) = {
                let font_mgr = FontMgr::default();
                let system_families = collect_system_families(&font_mgr);
                (font_mgr, system_families)
            };
        }
        SKIA_FONT_BASE.with(|(font_mgr, system_families)| Self {
            font_mgr: font_mgr.clone(),
            custom_typefaces: HashMap::new(),
            bundled_typefaces: HashMap::new(),
            system_families: system_families.clone(),
        })
    }

    fn load_typefaces_from_sources(
        font_mgr: &FontMgr,
        sources: &[std::path::PathBuf],
        into: &mut TypefaceCatalog,
    ) {
        for path in crate::renderer::font_paths::font_files(sources) {
            let Ok(data) = std::fs::read(&path) else {
                continue;
            };
            let face_count = ttf_parser::fonts_in_collection(&data).unwrap_or(1).min(256);
            for face_index in 0..face_count {
                let Ok(face) = ttf_parser::Face::parse(&data, face_index) else {
                    continue;
                };
                let Some(typeface) = font_mgr.new_from_data(&data, Some(face_index as usize))
                else {
                    continue;
                };
                for alias in typeface_aliases(&face, &typeface) {
                    let faces = into.entry(alias).or_default();
                    if !faces
                        .iter()
                        .any(|existing| existing.unique_id() == typeface.unique_id())
                    {
                        faces.push(typeface.clone());
                    }
                }
            }
        }
    }

    /// 사용자 지정 폰트 디렉토리 (ttfs 등) 의 폰트를 로드하여 Skia 가 직접 사용 가능하게 한다.
    /// SVG 의 `--font-path` 와 동일한 패턴.
    pub fn with_font_paths(mut self, font_paths: &[std::path::PathBuf]) -> Self {
        // [#2864] 조달 순서는 renderer::font_paths 가 단일 정의한다.
        // [#3300] custom(호출자+환경변수)과 번들 최후-폴백을 분리 적재한다 —
        // 시스템 디렉터리는 어느 쪽에도 넣지 않는다(스타일 매칭은 FontMgr 담당).
        let custom_sources = crate::renderer::font_paths::custom_font_sources(font_paths);
        Self::load_typefaces_from_sources(
            &self.font_mgr,
            &custom_sources,
            &mut self.custom_typefaces,
        );
        let bundled_dirs = crate::renderer::font_paths::bundled_font_dirs();
        Self::load_typefaces_from_sources(
            &self.font_mgr,
            &bundled_dirs,
            &mut self.bundled_typefaces,
        );
        self
    }

    pub fn render_raster_with_options(
        &self,
        tree: &PageLayerTree,
        options: RasterRenderOptions,
    ) -> LayerRenderResult<RasterRenderOutput> {
        if let Some(dpi) = options.dpi {
            if !dpi.is_finite() || dpi <= 0.0 {
                return Err(HwpError::RenderError(format!("invalid raster dpi: {dpi}")));
            }
        }
        if options.format != RasterOutputFormat::Png {
            return Err(HwpError::RenderError(
                "Skia raster renderer currently supports PNG output".to_string(),
            ));
        }

        let raster_dimension = |value: f64, label: &str| -> LayerRenderResult<i32> {
            if !value.is_finite() || value <= 0.0 {
                return Err(HwpError::RenderError(format!(
                    "invalid page {label}: {value}"
                )));
            }
            if !options.scale.is_finite() || options.scale <= 0.0 {
                return Err(HwpError::RenderError(format!(
                    "invalid raster scale: {}",
                    options.scale
                )));
            }
            if options.max_dimension <= 0 {
                return Err(HwpError::RenderError(format!(
                    "invalid raster max dimension: {}",
                    options.max_dimension
                )));
            }
            let scaled = (value * options.scale).ceil();
            if !scaled.is_finite() || scaled <= 0.0 || scaled > options.max_dimension as f64 {
                return Err(HwpError::RenderError(format!(
                    "raster {label} out of range: {scaled}"
                )));
            }
            Ok(scaled as i32)
        };
        let width = raster_dimension(tree.page_width, "width")?;
        let height = raster_dimension(tree.page_height, "height")?;
        if options.max_pixels == 0 {
            return Err(HwpError::RenderError(
                "invalid raster max pixel count: 0".to_string(),
            ));
        }
        let pixel_count = (width as u64)
            .checked_mul(height as u64)
            .ok_or_else(|| HwpError::RenderError("raster pixel count overflow".to_string()))?;
        if pixel_count > options.max_pixels {
            return Err(HwpError::RenderError(format!(
                "raster pixel count out of range: {pixel_count}"
            )));
        }

        let mut surface = surfaces::raster_n32_premul((width, height))
            .ok_or_else(|| HwpError::RenderError("Skia raster surface 생성 실패".to_string()))?;
        let canvas = surface.canvas();
        let clear_color = if let Some(color) = options.background_color {
            colorref_to_skia(color, 1.0)
        } else if options.transparent {
            Color::from_argb(0, 0, 0, 0)
        } else {
            Color::WHITE
        };
        canvas.clear(clear_color);
        if options.scale != 1.0 {
            canvas.scale((options.scale as f32, options.scale as f32));
        }

        self.render_page_to_canvas_with_options(canvas, tree, options.scale as f32, false)?;

        let image = surface.image_snapshot();
        let mut png_options = png_encoder::Options::default();
        // PNG is lossless at every zlib level. Level 1 avoids spending most of
        // native export time on compression while preserving decoded pixels.
        png_options.z_lib_level = 1;
        let data = png_encoder::encode_image(
            None::<&mut skia_safe::gpu::DirectContext>,
            &image,
            &png_options,
        )
        .ok_or_else(|| HwpError::RenderError("Skia PNG 인코딩 실패".to_string()))?;
        Ok(RasterRenderOutput {
            bytes: data.as_bytes().to_vec(),
            format: RasterOutputFormat::Png,
            width,
            height,
            dpi: options.dpi,
            color_space: options.color_space,
        })
    }

    /// Replay a page into an existing Skia canvas.
    ///
    /// Raster surfaces and vector recording surfaces must consume the same
    /// replay-plane, clip, text-variant, and fallback policy. Surface setup
    /// such as clearing, CSS-pixel scaling, and page finalization remains the
    /// caller's responsibility.
    pub(crate) fn render_page_to_canvas_strict(
        &self,
        canvas: &Canvas,
        tree: &PageLayerTree,
        fallback_raster_scale: f32,
    ) -> LayerRenderResult<()> {
        self.render_page_to_canvas_with_options(canvas, tree, fallback_raster_scale, true)
    }

    fn render_page_to_canvas_with_options(
        &self,
        canvas: &Canvas,
        tree: &PageLayerTree,
        fallback_raster_scale: f32,
        strict_resource_failures: bool,
    ) -> LayerRenderResult<()> {
        if !fallback_raster_scale.is_finite() || fallback_raster_scale <= 0.0 {
            return Err(HwpError::RenderError(format!(
                "invalid Skia fallback raster scale: {fallback_raster_scale}"
            )));
        }
        let mut next_text_source_id = 0_u32;
        for replay_plane in PaintReplayPlane::ORDERED {
            if !layer_node_has_replay_plane(&tree.root, replay_plane) {
                continue;
            }
            self.render_node(
                canvas,
                &tree.root,
                &tree.output_options,
                &tree.resources,
                replay_plane,
                None,
                tree.profile.shows_editor_visuals(),
                &mut next_text_source_id,
                fallback_raster_scale,
                strict_resource_failures,
            )?;
        }
        Ok(())
    }

    fn render_node(
        &self,
        canvas: &Canvas,
        node: &LayerNode,
        output_options: &LayerOutputOptions,
        resources: &ResourceArena,
        replay_plane: PaintReplayPlane,
        inherited_layer: Option<RenderLayerInfo>,
        show_editor_placeholders: bool,
        next_text_source_id: &mut u32,
        fallback_raster_scale: f32,
        strict_resource_failures: bool,
    ) -> LayerRenderResult<()> {
        let active_layer =
            crate::paint::replay_order::inherited_replay_layer(node.layer, inherited_layer);
        let clip_enabled = output_options.clip_enabled;
        let apply_dash = |paint: &mut Paint, dash: StrokeDash| {
            let base_width = paint.stroke_width().max(1.0);
            // 점선은 선 굵기 비례 간격(한컴 규칙)이라 이미 실제 선폭이 곱해져 나온다.
            let interval_scale = if matches!(dash, StrokeDash::Dot) {
                1.0
            } else {
                base_width
            };
            let intervals: Option<[f32; 6]> = match dash {
                StrokeDash::Solid => None,
                StrokeDash::Dash => Some([6.0, 3.0, 0.0, 0.0, 0.0, 0.0]),
                StrokeDash::LongDash => Some([10.0, 3.0, 0.0, 0.0, 0.0, 0.0]),
                StrokeDash::Dot => {
                    let (on, off) = crate::renderer::dot_dash_segments(paint.stroke_width() as f64);
                    Some([on as f32, off as f32, 0.0, 0.0, 0.0, 0.0])
                }
                StrokeDash::Circle => {
                    paint.set_stroke_cap(paint::Cap::Round);
                    Some([0.1, 3.0, 0.0, 0.0, 0.0, 0.0])
                }
                StrokeDash::DashDot => Some([6.0, 3.0, 2.0, 3.0, 0.0, 0.0]),
                StrokeDash::DashDotDot => Some([6.0, 3.0, 2.0, 3.0, 2.0, 3.0]),
            };
            if let Some(intervals) = intervals {
                let intervals = intervals
                    .into_iter()
                    .filter(|value| *value > 0.0)
                    .map(|value| value * interval_scale)
                    .collect::<Vec<_>>();
                if let Some(effect) = PathEffect::dash(&intervals, 0.0) {
                    paint.set_path_effect(effect);
                }
            }
        };
        let make_fill_paint = |style: &ShapeStyle| -> Option<Paint> {
            let color = style
                .pattern
                .map(|pattern| pattern.background_color)
                .or(style.fill_color)?;
            let mut paint = Paint::default();
            paint.set_anti_alias(true);
            paint.set_style(paint::Style::Fill);
            paint.set_color(colorref_to_skia(color, style.opacity as f32));
            Some(paint)
        };
        let make_gradient_fill_paint =
            |gradient: &GradientFillInfo,
             bbox: &crate::renderer::render_tree::BoundingBox,
             opacity: f32|
             -> Option<Paint> { gradient_fill_paint(gradient, bbox, opacity) };
        let make_stroke_paint = |style: &ShapeStyle| -> Option<Paint> {
            let mut paint = Paint::default();
            paint.set_anti_alias(true);
            paint.set_style(paint::Style::Stroke);
            paint.set_stroke_width(if style.stroke_width > 0.0 {
                style.stroke_width as f32
            } else {
                1.0
            });
            paint.set_color(colorref_to_skia(style.stroke_color?, style.opacity as f32));
            apply_dash(&mut paint, style.stroke_dash);
            Some(paint)
        };
        let make_line_paint = |style: &LineStyle| {
            let mut paint = Paint::default();
            paint.set_anti_alias(true);
            paint.set_style(paint::Style::Stroke);
            paint.set_stroke_width(if style.width > 0.0 {
                style.width as f32
            } else {
                1.0
            });
            paint.set_color(colorref_to_skia(style.color, 1.0));
            apply_dash(&mut paint, style.dash);
            paint
        };
        let draw_placeholder = |bbox: crate::renderer::render_tree::BoundingBox, label: &str| {
            if bbox.width <= 0.0 || bbox.height <= 0.0 {
                return;
            }
            let rect = Rect::from_xywh(
                bbox.x as f32,
                bbox.y as f32,
                bbox.width as f32,
                bbox.height as f32,
            );
            let mut fill = Paint::default();
            fill.set_anti_alias(true);
            fill.set_style(paint::Style::Fill);
            fill.set_color(Color::from_argb(48, 96, 96, 96));
            canvas.draw_rect(rect, &fill);
            let mut stroke = Paint::default();
            stroke.set_anti_alias(true);
            stroke.set_style(paint::Style::Stroke);
            stroke.set_stroke_width(1.0);
            stroke.set_color(Color::from_argb(160, 96, 96, 96));
            canvas.draw_rect(rect, &stroke);
            let mut font = Font::default();
            font.set_size(10.0);
            let mut text = Paint::default();
            text.set_anti_alias(true);
            text.set_color(Color::from_argb(220, 64, 64, 64));
            draw_text_run(
                canvas,
                label,
                (bbox.x as f32 + 4.0, (bbox.y + bbox.height / 2.0) as f32),
                &font,
                &text,
            );
        };
        let draw_image = |data: &[u8],
                          bbox: crate::renderer::render_tree::BoundingBox,
                          fill_mode,
                          original_size,
                          crop,
                          crop_reference_size,
                          effect,
                          has_shadow,
                          is_picture| {
            draw_image_bytes(
                canvas,
                data,
                bbox.x as f32,
                bbox.y as f32,
                bbox.width as f32,
                bbox.height as f32,
                fill_mode,
                original_size,
                crop,
                crop_reference_size,
                effect,
                ImageSampling::linear(),
                has_shadow,
                is_picture,
            )
        };
        let text_replay = SkiaTextReplay {
            canvas,
            font_mgr: &self.font_mgr,
            custom_typefaces: &self.custom_typefaces,
            bundled_typefaces: &self.bundled_typefaces,
            system_families: &self.system_families,
            output_options,
        };
        let open_shape_transform =
            |transform: crate::renderer::render_tree::ShapeTransform,
             bbox: &crate::renderer::render_tree::BoundingBox| {
                canvas.save();
                let cx = (bbox.x + bbox.width / 2.0) as f32;
                let cy = (bbox.y + bbox.height / 2.0) as f32;
                if transform.horz_flip {
                    canvas.translate((cx * 2.0, 0.0));
                    canvas.scale((-1.0, 1.0));
                }
                if transform.vert_flip {
                    canvas.translate((0.0, cy * 2.0));
                    canvas.scale((1.0, -1.0));
                }
                // [Task #1067] svg/web_canvas 와 동일 — 한쪽만 대칭이면 회전 부호 반전.
                if transform.rotation != 0.0 {
                    canvas.rotate(
                        transform.rotation_after_flip() as f32,
                        Some((cx, cy).into()),
                    );
                }
            };

        match &node.kind {
            LayerNodeKind::Group { children, .. } => {
                for child in children {
                    self.render_node(
                        canvas,
                        child,
                        output_options,
                        resources,
                        replay_plane,
                        active_layer,
                        show_editor_placeholders,
                        next_text_source_id,
                        fallback_raster_scale,
                        strict_resource_failures,
                    )?;
                }
            }
            LayerNodeKind::ClipRect { clip, child, .. } => {
                if !clip_enabled {
                    return self.render_node(
                        canvas,
                        child,
                        output_options,
                        resources,
                        replay_plane,
                        active_layer,
                        show_editor_placeholders,
                        next_text_source_id,
                        fallback_raster_scale,
                        strict_resource_failures,
                    );
                }
                canvas.save();
                canvas.clip_rect(
                    Rect::from_xywh(
                        clip.x as f32,
                        clip.y as f32,
                        clip.width as f32,
                        clip.height as f32,
                    ),
                    None,
                    Some(true),
                );
                let result = self.render_node(
                    canvas,
                    child,
                    output_options,
                    resources,
                    replay_plane,
                    active_layer,
                    show_editor_placeholders,
                    next_text_source_id,
                    fallback_raster_scale,
                    strict_resource_failures,
                );
                canvas.restore();
                result?;
            }
            LayerNodeKind::Leaf { ops } => {
                let mut variant_order = 0usize;
                let mut glyph_variants =
                    HashMap::<String, HashMap<String, (usize, u32, HashSet<u32>, bool)>>::new();
                let mut glyph_variant_sources = HashMap::<String, u32>::new();
                for op in ops {
                    if paint_op_replay_plane_with_layer(op, active_layer) != replay_plane {
                        continue;
                    }
                    if let PaintOp::GlyphRun { run, .. } = op {
                        glyph_variant_sources
                            .entry(run.variant.equivalence_group.clone())
                            .or_insert(run.source.id.0);
                        let group = glyph_variants
                            .entry(run.variant.equivalence_group.clone())
                            .or_default();
                        let state =
                            group
                                .entry(run.variant.variant_id.clone())
                                .or_insert_with(|| {
                                    let order = variant_order;
                                    variant_order = variant_order.saturating_add(1);
                                    (order, run.variant.part_count, HashSet::new(), true)
                                });
                        if state.1 != run.variant.part_count || run.variant.part_count == 0 {
                            state.3 = false;
                        }
                        if !state.2.insert(run.variant.part_index) {
                            state.3 = false;
                        }
                        state.3 &= native_skia_can_replay_glyph_run(run, resources);
                    }
                }
                let mut selected_text_variants = HashMap::new();
                for (group, variants) in glyph_variants {
                    let mut candidates = variants.into_iter().collect::<Vec<_>>();
                    candidates.sort_by_key(|(_, (order, _, _, _))| *order);
                    for (variant_id, (_, expected_part_count, parts, supported)) in candidates {
                        let parts_complete = parts.len() as u32 == expected_part_count
                            && (0..expected_part_count).all(|index| parts.contains(&index));
                        if supported && parts_complete {
                            selected_text_variants.insert(group, variant_id);
                            break;
                        }
                    }
                }
                let selected_text_sources = selected_text_variants
                    .keys()
                    .filter_map(|group| glyph_variant_sources.get(group).copied())
                    .collect::<HashSet<_>>();
                for op in ops {
                    if paint_op_replay_plane_with_layer(op, active_layer) != replay_plane {
                        continue;
                    }
                    let skip_unselected_text_variant = match op {
                        PaintOp::TextRun { .. } => {
                            let source_id = *next_text_source_id;
                            *next_text_source_id = (*next_text_source_id).saturating_add(1);
                            selected_text_sources.contains(&source_id)
                        }
                        PaintOp::GlyphRun { run, .. } => {
                            match selected_text_variants.get(&run.variant.equivalence_group) {
                                Some(selected) => selected != &run.variant.variant_id,
                                None => true,
                            }
                        }
                        PaintOp::GlyphOutline { .. } => true,
                        _ => false,
                    };
                    if skip_unselected_text_variant {
                        continue;
                    }
                    match op {
                        PaintOp::PageBackground { bbox, background } => {
                            let rect = Rect::from_xywh(
                                bbox.x as f32,
                                bbox.y as f32,
                                bbox.width as f32,
                                bbox.height as f32,
                            );
                            if let Some(color) = background
                                .gradient
                                .as_ref()
                                .and_then(|gradient| gradient.colors.first().copied())
                                .or(background.background_color)
                            {
                                let mut paint = Paint::default();
                                paint.set_anti_alias(true);
                                paint.set_style(paint::Style::Fill);
                                paint.set_color(colorref_to_skia(color, 1.0));
                                canvas.draw_rect(rect, &paint);
                            }
                            if let Some(image) = &background.image {
                                // 밝기·대비는 한컴 방식으로 픽셀에 굽는다 (반투명 합성 없음,
                                // 한컴 Mac PDF 실측). 구운 픽셀에는 효과가 이미 들어 있다.
                                let baked = crate::renderer::image_resolver::hancom_adjusted_picture_png_bytes(
                                    &image.data,
                                    image.effect,
                                    image.brightness,
                                    image.contrast,
                                );
                                let (data, effect) = match baked.as_deref() {
                                    Some(png) => (png, ImageEffect::RealPic),
                                    None => (image.data.as_ref(), image.effect),
                                };
                                let rendered = draw_image(
                                    data,
                                    *bbox,
                                    Some(image.fill_mode),
                                    None,
                                    None,
                                    None,
                                    effect,
                                    false,
                                    true,
                                );
                                if !rendered && strict_resource_failures {
                                    return Err(HwpError::RenderError(
                                        "Skia page background image decode failed".to_string(),
                                    ));
                                }
                            }
                            if let Some(color) = background.border_color {
                                let mut paint = Paint::default();
                                paint.set_anti_alias(true);
                                paint.set_style(paint::Style::Stroke);
                                paint.set_stroke_width(if background.border_width > 0.0 {
                                    background.border_width as f32
                                } else {
                                    1.0
                                });
                                paint.set_color(colorref_to_skia(color, 1.0));
                                canvas.draw_rect(rect, &paint);
                            }
                        }
                        PaintOp::TextRun { bbox, run } => {
                            let is_marker = !matches!(
                                run.field_marker,
                                crate::renderer::render_tree::FieldMarkerType::None
                            );
                            text_replay.draw_text(
                                run.display_or_text(),
                                *bbox,
                                &run.style,
                                run.baseline,
                                run.rotation,
                                run.is_vertical,
                                run.char_overlap.as_ref(),
                                is_marker,
                                run.is_para_end,
                                run.is_line_break_end,
                                run.display_text.is_some(),
                                &run.text,
                            );
                        }
                        PaintOp::GlyphRun { run, .. } => {
                            if !native_skia_can_replay_glyph_run(run, resources) {
                                continue;
                            }
                            // Unreachable until native_skia_can_replay_glyph_run can verify
                            // blob-backed typeface construction. Keep the TextRun fallback.
                        }
                        PaintOp::GlyphOutline { .. } => {}
                        PaintOp::FootnoteMarker { bbox, marker } => {
                            let style = crate::renderer::TextStyle {
                                font_family: marker.font_family.clone(),
                                // 각주 번호 위첨자: 본문 글꼴의 0.75 배율 (한컴 PDF 정합)
                                font_size: (marker.base_font_size * 0.75).max(7.0),
                                color: marker.color,
                                bold: marker.bold,
                                ..Default::default()
                            };
                            let sup_size = style.font_size;
                            text_replay.draw_text(
                                &marker.text,
                                *bbox,
                                &style,
                                // 본문 baseline 에서 (본문-위첨자) 크기 차만큼만 올려 top 정렬
                                marker.baseline - (marker.base_font_size - sup_size) * 0.85,
                                0.0,
                                false,
                                None,
                                false,
                                false,
                                false,
                                false,
                                &marker.text,
                            );
                        }
                        PaintOp::Line { bbox, line } => {
                            if line.transform.has_transform() {
                                open_shape_transform(line.transform, bbox);
                            }
                            canvas.draw_line(
                                (line.x1 as f32, line.y1 as f32),
                                (line.x2 as f32, line.y2 as f32),
                                &make_line_paint(&line.style),
                            );
                            if line.transform.has_transform() {
                                canvas.restore();
                            }
                        }
                        PaintOp::Rectangle { bbox, rect } => {
                            if rect.transform.has_transform() {
                                open_shape_transform(rect.transform, bbox);
                            }
                            let sk_rect = Rect::from_xywh(
                                bbox.x as f32,
                                bbox.y as f32,
                                bbox.width as f32,
                                bbox.height as f32,
                            );
                            let fan = rect.gradient.as_deref().and_then(|gradient| {
                                crate::renderer::gradient_fill::conical_polygons(gradient, *bbox)
                            });
                            if let Some(polygons) = &fan {
                                canvas.save();
                                let clip = skia_safe::RRect::new_rect_xy(
                                    sk_rect,
                                    rect.corner_radius as f32,
                                    rect.corner_radius as f32,
                                );
                                canvas.clip_rrect(clip, None, true);
                                for polygon in polygons {
                                    let mut path = PathBuilder::new();
                                    path.move_to((
                                        polygon.points[0].0 as f32,
                                        polygon.points[0].1 as f32,
                                    ));
                                    for &(x, y) in &polygon.points[1..] {
                                        path.line_to((x as f32, y as f32));
                                    }
                                    path.close();
                                    let mut paint = Paint::default();
                                    paint.set_anti_alias(true);
                                    paint.set_color(colorref_to_skia(
                                        polygon.color,
                                        rect.style.opacity as f32,
                                    ));
                                    canvas.draw_path(&path.detach(), &paint);
                                }
                                canvas.restore();
                            }
                            if let Some(fill) = rect
                                .gradient
                                .as_deref()
                                .and_then(|gradient| {
                                    make_gradient_fill_paint(
                                        gradient,
                                        bbox,
                                        rect.style.opacity as f32,
                                    )
                                })
                                .or_else(|| {
                                    rect.gradient
                                        .as_ref()
                                        .and_then(|gradient| gradient.colors.first().copied())
                                        .map(|color| {
                                            let mut paint = Paint::default();
                                            paint.set_anti_alias(true);
                                            paint.set_style(paint::Style::Fill);
                                            paint.set_color(colorref_to_skia(
                                                color,
                                                rect.style.opacity as f32,
                                            ));
                                            paint
                                        })
                                })
                                .or_else(|| make_fill_paint(&rect.style))
                                .filter(|_| fan.is_none())
                            {
                                if rect.corner_radius > 0.0 {
                                    canvas.draw_round_rect(
                                        sk_rect,
                                        rect.corner_radius as f32,
                                        rect.corner_radius as f32,
                                        &fill,
                                    );
                                } else {
                                    canvas.draw_rect(sk_rect, &fill);
                                }
                            }
                            if let Some(stroke) = make_stroke_paint(&rect.style) {
                                if rect.corner_radius > 0.0 {
                                    canvas.draw_round_rect(
                                        sk_rect,
                                        rect.corner_radius as f32,
                                        rect.corner_radius as f32,
                                        &stroke,
                                    );
                                } else {
                                    canvas.draw_rect(sk_rect, &stroke);
                                }
                            }
                            if rect.transform.has_transform() {
                                canvas.restore();
                            }
                        }
                        PaintOp::Ellipse { bbox, ellipse } => {
                            if ellipse.transform.has_transform() {
                                open_shape_transform(ellipse.transform, bbox);
                            }
                            let oval = Rect::from_xywh(
                                bbox.x as f32,
                                bbox.y as f32,
                                bbox.width as f32,
                                bbox.height as f32,
                            );
                            if let Some(fill) = ellipse
                                .gradient
                                .as_deref()
                                .and_then(|gradient| {
                                    make_gradient_fill_paint(
                                        gradient,
                                        bbox,
                                        ellipse.style.opacity as f32,
                                    )
                                })
                                .or_else(|| {
                                    ellipse
                                        .gradient
                                        .as_ref()
                                        .and_then(|gradient| gradient.colors.first().copied())
                                        .map(|color| {
                                            let mut paint = Paint::default();
                                            paint.set_anti_alias(true);
                                            paint.set_style(paint::Style::Fill);
                                            paint.set_color(colorref_to_skia(
                                                color,
                                                ellipse.style.opacity as f32,
                                            ));
                                            paint
                                        })
                                })
                                .or_else(|| make_fill_paint(&ellipse.style))
                            {
                                canvas.draw_oval(oval, &fill);
                            }
                            if let Some(stroke) = make_stroke_paint(&ellipse.style) {
                                canvas.draw_oval(oval, &stroke);
                            }
                            if ellipse.transform.has_transform() {
                                canvas.restore();
                            }
                        }
                        PaintOp::Path { bbox, path } => {
                            if path.transform.has_transform() {
                                open_shape_transform(path.transform, bbox);
                            }
                            let mut builder = PathBuilder::new();
                            let mut current = (0.0, 0.0);
                            for command in &path.commands {
                                match *command {
                                    PathCommand::MoveTo(x, y) => {
                                        builder.move_to((x as f32, y as f32));
                                        current = (x, y);
                                    }
                                    PathCommand::LineTo(x, y) => {
                                        builder.line_to((x as f32, y as f32));
                                        current = (x, y);
                                    }
                                    PathCommand::CurveTo(x1, y1, x2, y2, x, y) => {
                                        builder.cubic_to(
                                            (x1 as f32, y1 as f32),
                                            (x2 as f32, y2 as f32),
                                            (x as f32, y as f32),
                                        );
                                        current = (x, y);
                                    }
                                    PathCommand::ArcTo(
                                        rx,
                                        ry,
                                        rotation,
                                        large_arc,
                                        sweep,
                                        x,
                                        y,
                                    ) => {
                                        for segment in svg_arc_to_beziers(
                                            current.0, current.1, rx, ry, rotation, large_arc,
                                            sweep, x, y,
                                        ) {
                                            if let PathCommand::CurveTo(x1, y1, x2, y2, ex, ey) =
                                                segment
                                            {
                                                builder.cubic_to(
                                                    (x1 as f32, y1 as f32),
                                                    (x2 as f32, y2 as f32),
                                                    (ex as f32, ey as f32),
                                                );
                                                current = (ex, ey);
                                            }
                                        }
                                    }
                                    PathCommand::ClosePath => {
                                        builder.close();
                                    }
                                }
                            }
                            let sk_path = builder.detach();
                            if let Some(fill) = path
                                .gradient
                                .as_deref()
                                .and_then(|gradient| {
                                    make_gradient_fill_paint(
                                        gradient,
                                        bbox,
                                        path.style.opacity as f32,
                                    )
                                })
                                .or_else(|| make_fill_paint(&path.style))
                            {
                                canvas.draw_path(&sk_path, &fill);
                            }
                            if let Some(stroke) = make_stroke_paint(&path.style) {
                                canvas.draw_path(&sk_path, &stroke);
                            }
                            if path.transform.has_transform() {
                                canvas.restore();
                            }
                        }
                        PaintOp::Image {
                            bbox,
                            image,
                            resolved,
                        } => {
                            let effective_bbox = image.transform.effective_image_bbox(bbox);
                            let effective_bbox = if let Some(shadow) = image.shadow.as_ref() {
                                let matrix = canvas.local_to_device_as_3x3();
                                let unsuitable_transform = image.transform.has_transform()
                                    || !matrix.is_scale_translate()
                                    || matrix.scale_x() <= 0.0
                                    || matrix.scale_y() <= 0.0;
                                shadow_foreground_bbox(
                                    effective_bbox,
                                    shadow.nominal_height_pt,
                                    unsuitable_transform,
                                )
                            } else {
                                effective_bbox
                            };
                            if image.transform.has_transform() {
                                open_shape_transform(image.transform, &effective_bbox);
                            }
                            let data = resolved
                                .as_deref()
                                .map(|payload| payload.data.as_ref())
                                .or(image.data.as_deref());
                            if let Some(data) = data {
                                let effect = if resolved
                                    .as_deref()
                                    .is_some_and(|payload| payload.suppress_effects)
                                {
                                    ImageEffect::RealPic
                                } else {
                                    image.effect
                                };
                                let opacity = image.opacity.clamp(0.0, 1.0);
                                if opacity < 1.0 {
                                    let alpha = (255.0 * opacity).round() as u32;
                                    canvas.save_layer_alpha(None, alpha);
                                }
                                // 잘린 그림의 알파를 같은 변환 아래에서 그림자로 합성한다.
                                let shadow_layer = image.shadow.as_ref().map(|shadow| {
                                    let rgb =
                                        u32::from_str_radix(&shadow.color[1..], 16).unwrap_or(0);
                                    let color = Color4f::new(
                                        ((rgb >> 16) & 255) as f32 / 255.0,
                                        ((rgb >> 8) & 255) as f32 / 255.0,
                                        (rgb & 255) as f32 / 255.0,
                                        shadow.alpha as f32,
                                    );
                                    let mut paint = Paint::default();
                                    paint.set_image_filter(skia_safe::image_filters::drop_shadow(
                                        (shadow.offset_x as f32, shadow.offset_y as f32),
                                        (shadow.blur_sigma as f32, shadow.blur_sigma as f32),
                                        color,
                                        None,
                                        None,
                                        None,
                                    ));
                                    canvas.save_layer(
                                        &skia_safe::canvas::SaveLayerRec::default().paint(&paint),
                                    );
                                });
                                let rendered = draw_image(
                                    data,
                                    effective_bbox,
                                    // [#7235] 칸·도형 채우기 None은 배치가 아니라 contain이다.
                                    // 쪽 배경 경로의 None은 늘려 채우기를 유지한다.
                                    image.fill_mode.map(|mode| {
                                        if mode == ImageFillMode::None {
                                            ImageFillMode::Zoom
                                        } else {
                                            mode
                                        }
                                    }),
                                    image.original_size,
                                    image.crop,
                                    image.original_size_hu,
                                    effect,
                                    image.shadow.is_some(),
                                    true,
                                );
                                if shadow_layer.is_some() {
                                    canvas.restore();
                                }
                                if opacity < 1.0 {
                                    canvas.restore();
                                }
                                if image.transform.has_transform() {
                                    canvas.restore();
                                }
                                if !rendered && strict_resource_failures {
                                    return Err(HwpError::RenderError(format!(
                                        "Skia image decode failed for binData {}",
                                        image.bin_data_id
                                    )));
                                }
                            } else {
                                if strict_resource_failures {
                                    if image.transform.has_transform() {
                                        canvas.restore();
                                    }
                                    return Err(HwpError::RenderError(format!(
                                        "Skia image data is missing for binData {}",
                                        image.bin_data_id
                                    )));
                                }
                                draw_placeholder(effective_bbox, "image");
                                if image.transform.has_transform() {
                                    canvas.restore();
                                }
                            }
                        }
                        PaintOp::Equation { bbox, equation } => {
                            // 한컴은 저장 폭보다 좁은 수식을 늘리지 않고 상자 왼쪽에 둔다
                            // (math-001 실측: 525HU 상자의 `1`, 1050HU 상자의 `10` 모두
                            // 자연 pitch 4.725pt 그대로).
                            render_equation(
                                canvas,
                                &self.font_mgr,
                                &self.custom_typefaces,
                                &self.bundled_typefaces,
                                &self.system_families,
                                &equation.layout_box,
                                bbox.x,
                                bbox.y,
                                equation.color,
                                equation.font_size,
                                &equation.font_name,
                                &equation.version_info,
                            );
                        }
                        PaintOp::FormObject { bbox, form } => {
                            self.draw_form_control(canvas, *bbox, form);
                        }
                        PaintOp::Placeholder { bbox, placeholder } => {
                            // [Task #2225] 그림 미지정 placeholder 는 편집 profile에서만 표시.
                            if placeholder.kind
                                != crate::renderer::render_tree::PlaceholderKind::MissingPicture
                                || show_editor_placeholders
                            {
                                draw_placeholder(*bbox, placeholder.label.as_str());
                            }
                        }
                        PaintOp::RawSvg { bbox, raw } => {
                            if !draw_svg_fragment(
                                canvas,
                                raw.svg.as_str(),
                                bbox.x as f32,
                                bbox.y as f32,
                                bbox.width as f32,
                                bbox.height as f32,
                                ImageSampling::linear(),
                                fallback_raster_scale,
                            ) {
                                if strict_resource_failures {
                                    return Err(HwpError::RenderError(
                                        "Skia raw SVG raster fallback failed".to_string(),
                                    ));
                                }
                                draw_placeholder(*bbox, "svg");
                            }
                        }
                        PaintOp::CharOverlap { .. }
                        | PaintOp::TextControlMark { .. }
                        | PaintOp::TabLeader { .. }
                        | PaintOp::TextDecoration { .. } => {}
                    }
                }
            }
        }
        Ok(())
    }
}

impl LayerRasterRenderer for SkiaLayerRenderer {
    fn render_raster(
        &self,
        tree: &PageLayerTree,
        options: RasterRenderOptions,
    ) -> LayerRenderResult<RasterRenderOutput> {
        self.render_raster_with_options(tree, options)
    }
}

impl SkiaLayerRenderer {
    fn make_form_font(&self, size: f32) -> Font {
        let style = FontStyle::default();
        for family in FORM_CJK_FAMILIES {
            if let Some(tf) = typeface_for_style(&self.custom_typefaces, family, style) {
                return Font::new(tf, size);
            }
            if let Some(tf) =
                match_system_family_style(&self.font_mgr, &self.system_families, family, style)
            {
                return Font::new(tf, size);
            }
            // [#3300] 시스템 폰트가 없는 headless 환경에서는 번들 폰트가
            // custom·system 뒤의 최후 폴백으로 form caption의 한국어를 구제한다.
            if let Some(tf) = typeface_for_style(&self.bundled_typefaces, family, style) {
                return Font::new(tf, size);
            }
        }
        if let Some(tf) = legacy_typeface_for_style(&self.font_mgr, style) {
            return Font::new(tf, size);
        }
        let mut f = Font::default();
        f.set_size(size);
        f
    }

    fn draw_form_control(
        &self,
        canvas: &Canvas,
        bbox: crate::renderer::render_tree::BoundingBox,
        form: &crate::renderer::render_tree::FormObjectNode,
    ) {
        use crate::model::control::FormType;

        if bbox.width <= 0.0 || bbox.height <= 0.0 {
            return;
        }

        let x = bbox.x as f32;
        let y = bbox.y as f32;
        let w = bbox.width as f32;
        let h = bbox.height as f32;
        let rect = Rect::from_xywh(x, y, w, h);

        let bg_color = parse_css_color(&form.back_color).unwrap_or(Color::from_rgb(240, 240, 240));
        let fg_color = parse_css_color(&form.fore_color).unwrap_or(Color::from_rgb(0, 0, 0));
        let border_color = Color::from_rgb(160, 160, 160);

        match form.form_type {
            FormType::PushButton => {
                let mut fill = Paint::default();
                fill.set_anti_alias(true);
                fill.set_style(paint::Style::Fill);
                fill.set_color(bg_color);
                let rrect = RRect::new_rect_xy(rect, 3.0, 3.0);
                canvas.draw_rrect(rrect, &fill);

                let mut stroke = Paint::default();
                stroke.set_anti_alias(true);
                stroke.set_style(paint::Style::Stroke);
                stroke.set_stroke_width(1.0);
                stroke.set_color(border_color);
                canvas.draw_rrect(rrect, &stroke);

                let label = if form.caption.is_empty() {
                    Cow::Borrowed(form.name.as_str())
                } else {
                    display_form_caption(&form.caption)
                };
                if !label.is_empty() {
                    let font = self.make_form_font((h * 0.45).clamp(8.0, 14.0));
                    let mut tp = Paint::default();
                    tp.set_anti_alias(true);
                    tp.set_color(fg_color);
                    let text_w = font.measure_str(label.as_ref(), Some(&tp)).0;
                    let tx = x + (w - text_w) / 2.0;
                    let ty = y + h / 2.0 + font.size() * 0.35;
                    draw_text_run(canvas, label.as_ref(), (tx, ty), &font, &tp);
                }
            }
            FormType::CheckBox => {
                let box_size = h.min(w).min(14.0);
                let bx = x + 2.0;
                let by = y + (h - box_size) / 2.0;
                let box_rect = Rect::from_xywh(bx, by, box_size, box_size);

                let mut fill = Paint::default();
                fill.set_anti_alias(true);
                fill.set_style(paint::Style::Fill);
                fill.set_color(bg_color);
                canvas.draw_rect(box_rect, &fill);

                let mut stroke = Paint::default();
                stroke.set_anti_alias(true);
                stroke.set_style(paint::Style::Stroke);
                stroke.set_stroke_width(1.0);
                stroke.set_color(border_color);
                canvas.draw_rect(box_rect, &stroke);

                if form.value != 0 {
                    let mut check = Paint::default();
                    check.set_anti_alias(true);
                    check.set_style(paint::Style::Stroke);
                    check.set_stroke_width(2.0);
                    check.set_color(fg_color);
                    check.set_stroke_cap(paint::Cap::Round);
                    let cx = bx + box_size * 0.2;
                    let cy = by + box_size * 0.55;
                    let mx = bx + box_size * 0.4;
                    let my = by + box_size * 0.75;
                    let ex = bx + box_size * 0.8;
                    let ey = by + box_size * 0.25;
                    let mut builder = PathBuilder::new();
                    builder.move_to((cx, cy));
                    builder.line_to((mx, my));
                    builder.line_to((ex, ey));
                    let path = builder.detach();
                    canvas.draw_path(&path, &check);
                }

                if !form.caption.is_empty() {
                    let caption = display_form_caption(&form.caption);
                    let font = self.make_form_font((h * 0.6).clamp(8.0, 13.0));
                    let mut tp = Paint::default();
                    tp.set_anti_alias(true);
                    tp.set_color(fg_color);
                    let tx = bx + box_size + 4.0;
                    let ty = y + h / 2.0 + font.size() * 0.35;
                    draw_text_run(canvas, caption.as_ref(), (tx, ty), &font, &tp);
                }
            }
            FormType::RadioButton => {
                let r = h.min(w).min(14.0) / 2.0;
                let cx = x + 2.0 + r;
                let cy = y + h / 2.0;

                let mut fill = Paint::default();
                fill.set_anti_alias(true);
                fill.set_style(paint::Style::Fill);
                fill.set_color(bg_color);
                canvas.draw_circle((cx, cy), r, &fill);

                let mut stroke = Paint::default();
                stroke.set_anti_alias(true);
                stroke.set_style(paint::Style::Stroke);
                stroke.set_stroke_width(1.0);
                stroke.set_color(border_color);
                canvas.draw_circle((cx, cy), r, &stroke);

                if form.value != 0 {
                    let mut dot = Paint::default();
                    dot.set_anti_alias(true);
                    dot.set_style(paint::Style::Fill);
                    dot.set_color(fg_color);
                    canvas.draw_circle((cx, cy), r * 0.5, &dot);
                }

                if !form.caption.is_empty() {
                    let caption = display_form_caption(&form.caption);
                    let font = self.make_form_font((h * 0.6).clamp(8.0, 13.0));
                    let mut tp = Paint::default();
                    tp.set_anti_alias(true);
                    tp.set_color(fg_color);
                    let tx = cx + r + 4.0;
                    let ty = y + h / 2.0 + font.size() * 0.35;
                    draw_text_run(canvas, caption.as_ref(), (tx, ty), &font, &tp);
                }
            }
            FormType::ComboBox => {
                let mut fill = Paint::default();
                fill.set_anti_alias(true);
                fill.set_style(paint::Style::Fill);
                fill.set_color(bg_color);
                canvas.draw_rect(rect, &fill);

                let mut stroke = Paint::default();
                stroke.set_anti_alias(true);
                stroke.set_style(paint::Style::Stroke);
                stroke.set_stroke_width(1.0);
                stroke.set_color(border_color);
                canvas.draw_rect(rect, &stroke);

                // 드롭다운 화살표 영역
                let arrow_w = h.min(20.0);
                let ax = x + w - arrow_w;
                let arrow_rect = Rect::from_xywh(ax, y, arrow_w, h);
                let mut abg = Paint::default();
                abg.set_anti_alias(true);
                abg.set_style(paint::Style::Fill);
                abg.set_color(bg_color);
                canvas.draw_rect(arrow_rect, &abg);
                canvas.draw_line((ax, y), (ax, y + h), &stroke);

                // 화살표 삼각형
                let mut arrow = Paint::default();
                arrow.set_anti_alias(true);
                arrow.set_style(paint::Style::Fill);
                arrow.set_color(Color::from_rgb(80, 80, 80));
                let acx = ax + arrow_w / 2.0;
                let acy = y + h / 2.0;
                let as_ = (arrow_w * 0.25).min(5.0);
                let mut builder = PathBuilder::new();
                builder.move_to((acx - as_, acy - as_ * 0.5));
                builder.line_to((acx + as_, acy - as_ * 0.5));
                builder.line_to((acx, acy + as_ * 0.5));
                builder.close();
                let path = builder.detach();
                canvas.draw_path(&path, &arrow);

                if !form.text.is_empty() {
                    let font = self.make_form_font((h * 0.55).clamp(8.0, 13.0));
                    let mut tp = Paint::default();
                    tp.set_anti_alias(true);
                    tp.set_color(fg_color);
                    let tx = x + 4.0;
                    let ty = y + h / 2.0 + font.size() * 0.35;
                    draw_text_run(canvas, &form.text, (tx, ty), &font, &tp);
                }
            }
            FormType::Edit => {
                let mut fill = Paint::default();
                fill.set_anti_alias(true);
                fill.set_style(paint::Style::Fill);
                fill.set_color(bg_color);
                canvas.draw_rect(rect, &fill);

                let mut stroke = Paint::default();
                stroke.set_anti_alias(true);
                stroke.set_style(paint::Style::Stroke);
                stroke.set_stroke_width(1.0);
                stroke.set_color(border_color);
                canvas.draw_rect(rect, &stroke);

                if !form.text.is_empty() {
                    let font = self.make_form_font((h * 0.55).clamp(8.0, 13.0));
                    let mut tp = Paint::default();
                    tp.set_anti_alias(true);
                    tp.set_color(fg_color);
                    let tx = x + 4.0;
                    let ty = y + h / 2.0 + font.size() * 0.35;
                    draw_text_run(canvas, &form.text, (tx, ty), &font, &tp);
                }
            }
        }
    }
}

fn parse_css_color(s: &str) -> Option<Color> {
    let s = s.trim().trim_start_matches('#');
    if s.len() != 6 {
        return None;
    }
    let r = u8::from_str_radix(&s[0..2], 16).ok()?;
    let g = u8::from_str_radix(&s[2..4], 16).ok()?;
    let b = u8::from_str_radix(&s[4..6], 16).ok()?;
    Some(Color::from_rgb(r, g, b))
}

fn gradient_fill_paint(
    gradient: &GradientFillInfo,
    bbox: &crate::renderer::render_tree::BoundingBox,
    opacity: f32,
) -> Option<Paint> {
    if gradient.colors.len() < 2 || bbox.width <= 0.0 || bbox.height <= 0.0 {
        return None;
    }

    let mut colors = gradient
        .colors
        .iter()
        .map(|&color| Color4f::from(colorref_to_skia(color, opacity)))
        .collect::<Vec<_>>();
    let mut positions = if gradient.positions.len() == colors.len()
        && gradient
            .positions
            .iter()
            .all(|position| position.is_finite() && (0.0..=1.0).contains(position))
        && gradient.positions.windows(2).all(|pair| pair[0] <= pair[1])
        && gradient.positions.first() < gradient.positions.last()
    {
        Some(
            gradient
                .positions
                .iter()
                .map(|position| position.clamp(0.0, 1.0) as f32)
                .collect::<Vec<_>>(),
        )
    } else {
        None
    };

    // 한컴 선형 채우기의 첫 색은 지정 중심에 있고, 끝 색은 양쪽 가장자리에 놓인다.
    // 중심이 가장자리면 기존 단방향 채우기와 같다.
    if gradient.gradient_type == 1
        && colors.len() == 2
        && gradient.positions.as_slice() == [0.0, 1.0]
    {
        let radians = (gradient.angle as f64).to_radians();
        let dx = radians.sin() * bbox.width;
        let dy = radians.cos() * bbox.height;
        let distance_squared = dx * dx + dy * dy;
        if distance_squared > 0.0 {
            let center_dx = (gradient.center_x as f64 / 100.0 - 0.5) * bbox.width;
            let center_dy = (gradient.center_y as f64 / 100.0 - 0.5) * bbox.height;
            let center =
                (0.5 + (center_dx * dx + center_dy * dy) / distance_squared).clamp(0.0, 1.0) as f32;
            if center > 0.0 && center < 1.0 {
                colors = vec![colors[1], colors[0], colors[1]];
                positions = Some(vec![0.0, center, 1.0]);
            } else if center >= 1.0 {
                colors.swap(0, 1);
            }
        }
    }
    let gradient_colors =
        gradient::Colors::new(&colors, positions.as_deref(), TileMode::Clamp, None);
    let gradient_spec =
        gradient::Gradient::new(gradient_colors, gradient::Interpolation::default());

    let shader = if gradient.gradient_type == 3 {
        let center = (
            (bbox.x + bbox.width * gradient.center_x as f64 / 100.0) as f32,
            (bbox.y + bbox.height * gradient.center_y as f64 / 100.0) as f32,
        );
        let angle = gradient.angle as f32;
        gradient::shaders::sweep_gradient(center, (-angle, 180.0 - angle), &gradient_spec, None)
    } else if gradient.gradient_type == 2 {
        let center = (
            (bbox.x + bbox.width * gradient.center_x as f64 / 100.0) as f32,
            (bbox.y + bbox.height * gradient.center_y as f64 / 100.0) as f32,
        );
        gradient::shaders::radial_gradient(
            (center, (bbox.width.max(bbox.height) / 2.0) as f32),
            &gradient_spec,
            None,
        )
    } else {
        let angle = ((gradient.angle % 360 + 360) % 360) as f64;
        let radians = angle.to_radians();
        let sin = radians.sin();
        let cos = radians.cos();
        let center_x = bbox.x + bbox.width / 2.0;
        let center_y = bbox.y + bbox.height / 2.0;
        let start = (
            (center_x - sin * bbox.width / 2.0) as f32,
            (center_y - cos * bbox.height / 2.0) as f32,
        );
        let end = (
            (center_x + sin * bbox.width / 2.0) as f32,
            (center_y + cos * bbox.height / 2.0) as f32,
        );
        gradient::shaders::linear_gradient((start, end), &gradient_spec, None)
    }?;

    let mut paint = Paint::default();
    paint.set_anti_alias(true);
    paint.set_style(paint::Style::Fill);
    paint.set_shader(shader);
    Some(paint)
}

pub(super) fn colorref_to_skia(color: ColorRef, alpha_scale: f32) -> Color {
    let b = ((color >> 16) & 0xFF) as u8;
    let g = ((color >> 8) & 0xFF) as u8;
    let r = (color & 0xFF) as u8;
    let a = (255.0 * alpha_scale.clamp(0.0, 1.0)).round() as u8;
    Color::from_argb(a, r, g, b)
}

