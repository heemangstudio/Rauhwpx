use crate::model::style::UnderlineType;
use crate::paint::layer_tree::{
    CacheHint, ClipKind, GroupKind, LayerNode, LayerNodeKind, LayerOutputOptions, PageLayerTree,
};
use crate::paint::paint_op::{PaintOp, TextDecorationKind};
use crate::paint::profile::RenderProfile;
use crate::paint::{
    lower_font_native_glyph_sidecars, register_embedded_font_resources, EmbeddedFontFace,
    EmbeddedFontResolver, TextShapeLowerer,
};
use crate::renderer::render_tree::{PageRenderTree, RenderNode, RenderNodeType};

/// semantic render tree를 visual layer tree로 내린다.
pub struct LayerBuilder {
    profile: RenderProfile,
    output_options: LayerOutputOptions,
}

impl LayerBuilder {
    pub fn new(profile: RenderProfile) -> Self {
        Self {
            profile,
            output_options: LayerOutputOptions::default(),
        }
    }

    pub fn with_output_options(mut self, output_options: LayerOutputOptions) -> Self {
        self.output_options = output_options;
        self
    }

    pub fn build(&mut self, tree: &PageRenderTree) -> PageLayerTree {
        self.build_with_embedded_fonts(tree, &[])
    }

    pub fn build_with_embedded_fonts(
        &mut self,
        tree: &PageRenderTree,
        fonts: &[EmbeddedFontFace<'_>],
    ) -> PageLayerTree {
        let (page_width, page_height) = match &tree.root.node_type {
            RenderNodeType::Page(page) => (page.width, page.height),
            _ => (tree.root.bbox.width, tree.root.bbox.height),
        };

        let root = LayerNode::group(
            tree.root.bbox,
            Some(tree.root.id),
            self.build_children(&tree.root),
            self.cache_hint_for(&tree.root.node_type),
            GroupKind::Generic,
        )
        .with_layer(tree.root.layer);

        let mut layer_tree =
            PageLayerTree::with_profile(page_width, page_height, root, self.profile)
                .with_output_options(self.output_options);
        register_embedded_font_resources(&mut layer_tree.resources, fonts);
        TextShapeLowerer::new(&EmbeddedFontResolver::new(fonts)).lower_root(&mut layer_tree.root);
        lower_font_native_glyph_sidecars(&mut layer_tree.root, &mut layer_tree.resources, fonts);
        layer_tree
    }

    fn build_children(&mut self, node: &RenderNode) -> Vec<LayerNode> {
        node.children
            .iter()
            .filter_map(|child| self.build_node(child))
            .collect()
    }

    fn build_node(&mut self, node: &RenderNode) -> Option<LayerNode> {
        if !node.visible || (node.editor_only && !self.profile.shows_editor_visuals()) {
            return None;
        }

        let own_ops = match &node.node_type {
            RenderNodeType::PageBackground(background) => Some(vec![PaintOp::page_background(
                node.bbox,
                background.clone(),
            )]),
            RenderNodeType::TextRun(run) => {
                Some(text_run_ops(node.bbox, run.clone(), self.output_options))
            }
            RenderNodeType::FootnoteMarker(marker) => {
                Some(vec![PaintOp::footnote_marker(node.bbox, marker.clone())])
            }
            RenderNodeType::Line(line) => Some(vec![PaintOp::line(node.bbox, line.clone())]),
            RenderNodeType::Rectangle(rect) => {
                Some(vec![PaintOp::rectangle(node.bbox, rect.clone())])
            }
            RenderNodeType::Ellipse(ellipse) => {
                Some(vec![PaintOp::ellipse(node.bbox, ellipse.clone())])
            }
            RenderNodeType::Path(path) => Some(vec![PaintOp::path(node.bbox, path.clone())]),
            RenderNodeType::Image(image) => Some(vec![PaintOp::image(
                node.bbox,
                image.clone(),
                crate::renderer::image_resolver::resolve_image_payload(image),
            )]),
            RenderNodeType::Equation(equation) => {
                Some(vec![PaintOp::equation(node.bbox, equation.clone())])
            }
            RenderNodeType::FormObject(form) => {
                Some(vec![PaintOp::form_object(node.bbox, form.clone())])
            }
            RenderNodeType::Placeholder(placeholder) => {
                Some(vec![PaintOp::placeholder(node.bbox, placeholder.clone())])
            }
            RenderNodeType::RawSvg(raw) => Some(vec![PaintOp::raw_svg(node.bbox, raw.clone())]),
            _ => None,
        };

        if let Some(ops) = own_ops {
            let own_leaf = LayerNode::leaf(node.bbox, Some(node.id), ops).with_layer(node.layer);
            return if node.children.is_empty() {
                Some(own_leaf)
            } else {
                let mut children = Vec::with_capacity(node.children.len() + 1);
                children.push(own_leaf);
                children.extend(self.build_children(node));
                Some(
                    LayerNode::group(
                        node.bbox,
                        Some(node.id),
                        children,
                        self.cache_hint_for(&node.node_type),
                        self.group_kind_for(&node.node_type),
                    )
                    .with_layer(node.layer),
                )
            };
        }

        match &node.node_type {
            RenderNodeType::Body {
                clip_rect: Some(clip),
            } => {
                let child = LayerNode::group(
                    node.bbox,
                    Some(node.id),
                    self.build_children(node),
                    self.cache_hint_for(&node.node_type),
                    GroupKind::Body,
                );
                Some(
                    LayerNode::clip_rect(node.bbox, Some(node.id), *clip, child, ClipKind::Body)
                        .with_layer(node.layer),
                )
            }
            RenderNodeType::TableCell(cell) if cell.clip => {
                let child = LayerNode::group(
                    node.bbox,
                    Some(node.id),
                    self.build_children(node),
                    self.cache_hint_for(&node.node_type),
                    GroupKind::TableCell(cell.clone()),
                );
                Some(
                    LayerNode::clip_rect(
                        node.bbox,
                        Some(node.id),
                        node.bbox,
                        child,
                        ClipKind::TableCell,
                    )
                    .with_layer(node.layer),
                )
            }
            RenderNodeType::TextBox => {
                let child = LayerNode::group(
                    node.bbox,
                    Some(node.id),
                    self.build_children(node),
                    self.cache_hint_for(&node.node_type),
                    GroupKind::TextBox,
                );
                Some(
                    LayerNode::clip_rect(
                        node.bbox,
                        Some(node.id),
                        node.bbox,
                        child,
                        ClipKind::TextBox,
                    )
                    .with_layer(node.layer),
                )
            }
            _ => Some(
                LayerNode::group(
                    node.bbox,
                    Some(node.id),
                    self.build_children(node),
                    self.cache_hint_for(&node.node_type),
                    self.group_kind_for(&node.node_type),
                )
                .with_layer(node.layer),
            ),
        }
    }

    fn cache_hint_for(&self, node_type: &RenderNodeType) -> CacheHint {
        match node_type {
            RenderNodeType::Header | RenderNodeType::Footer | RenderNodeType::MasterPage => {
                CacheHint::StaticSubtree
            }
            RenderNodeType::PageBackground(_)
                if matches!(self.profile, RenderProfile::FastPreview) =>
            {
                CacheHint::PreferRaster
            }
            _ => CacheHint::None,
        }
    }

    fn group_kind_for(&self, node_type: &RenderNodeType) -> GroupKind {
        match node_type {
            RenderNodeType::MasterPage => GroupKind::MasterPage,
            RenderNodeType::Header => GroupKind::Header,
            RenderNodeType::Footer => GroupKind::Footer,
            RenderNodeType::Body { .. } => GroupKind::Body,
            RenderNodeType::Column(index) => GroupKind::Column(*index),
            RenderNodeType::FootnoteArea => GroupKind::FootnoteArea,
            RenderNodeType::TextLine(line) => GroupKind::TextLine(line.clone()),
            RenderNodeType::Table(table) => GroupKind::Table(table.clone()),
            RenderNodeType::TableCell(cell) => GroupKind::TableCell(cell.clone()),
            RenderNodeType::TextBox => GroupKind::TextBox,
            RenderNodeType::Group(group) => GroupKind::Group(group.clone()),
            _ => GroupKind::Generic,
        }
    }
}

fn text_run_ops(
    bbox: crate::renderer::render_tree::BoundingBox,
    run: crate::renderer::render_tree::TextRunNode,
    output_options: LayerOutputOptions,
) -> Vec<PaintOp> {
    let has_char_overlap = run.char_overlap.is_some();
    let show_text_marks = output_options.show_paragraph_marks || output_options.show_control_codes;
    let has_control_mark = show_text_marks
        && (run.is_para_end
            || run.is_line_break_end
            || run.text.chars().any(|ch| matches!(ch, ' ' | '\t')));
    // Legacy renderers bypass normal text decoration/leader paint for overlap runs.
    let has_tab_leader = !has_char_overlap && !run.style.tab_leaders.is_empty();
    let has_underline = !has_char_overlap && run.style.underline != UnderlineType::None;
    let has_strikethrough = !has_char_overlap && run.style.strikethrough;
    let has_emphasis_dot = !has_char_overlap && run.style.emphasis_dot > 0;

    let mut ops = Vec::with_capacity(
        1 + has_char_overlap as usize
            + has_control_mark as usize
            + has_tab_leader as usize
            + has_underline as usize
            + has_strikethrough as usize
            + has_emphasis_dot as usize,
    );
    ops.push(PaintOp::text_run(bbox, run.clone()));
    if has_char_overlap {
        ops.push(PaintOp::char_overlap(bbox, run.clone()));
    }
    if has_control_mark {
        ops.push(PaintOp::text_control_mark(bbox, run.clone()));
    }
    if has_tab_leader {
        ops.push(PaintOp::tab_leader(bbox, run.clone()));
    }
    if has_underline {
        ops.push(PaintOp::text_decoration(
            bbox,
            run.clone(),
            TextDecorationKind::Underline,
        ));
    }
    if has_strikethrough {
        ops.push(PaintOp::text_decoration(
            bbox,
            run.clone(),
            TextDecorationKind::Strikethrough,
        ));
    }
    if has_emphasis_dot {
        ops.push(PaintOp::text_decoration(
            bbox,
            run,
            TextDecorationKind::EmphasisDot,
        ));
    }
    ops
}

