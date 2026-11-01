//! Text variant grouping validation.
//!
//! Schema v1 keeps `TextRun` as the root fallback op and attaches optional
//! visual alternatives such as `GlyphRun` through variant metadata. Consumers
//! choose one variant set per equivalence group.

use std::collections::{HashMap, HashSet};
use std::fmt;

use crate::paint::{
    LayerNode, LayerNodeKind, PageLayerTree, PaintOp, PaintVariantMeta, TextVariantKind,
};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TextVariantScopeError {
    CrossLeafGroup {
        equivalence_group: String,
        first_leaf: String,
        second_leaf: String,
    },
    MissingDefaultFallback {
        equivalence_group: String,
        leaf: String,
    },
    MissingSidecarAnchorOpId {
        equivalence_group: String,
        variant_id: String,
        leaf: String,
    },
    InvalidSidecarAnchor {
        equivalence_group: String,
        variant_id: String,
        anchor_op_id: String,
        leaf: String,
    },
    MixedGlyphOutlinePayload {
        equivalence_group: String,
        variant_id: String,
        leaf: String,
    },
    EmptyVariantSet {
        equivalence_group: String,
        variant_id: String,
        leaf: String,
    },
    DuplicatePart {
        equivalence_group: String,
        variant_id: String,
        part_index: u32,
        leaf: String,
    },
    PartCountMismatch {
        equivalence_group: String,
        variant_id: String,
        expected: u32,
        actual: u32,
        leaf: String,
    },
}

impl fmt::Display for TextVariantScopeError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::CrossLeafGroup {
                equivalence_group,
                first_leaf,
                second_leaf,
            } => write!(
                f,
                "text variant group `{equivalence_group}` crosses leaf scope `{first_leaf}` and `{second_leaf}`"
            ),
            Self::MissingDefaultFallback {
                equivalence_group,
                leaf,
            } => write!(
                f,
                "text variant group `{equivalence_group}` in leaf `{leaf}` has no default fallback"
            ),
            Self::MissingSidecarAnchorOpId {
                equivalence_group,
                variant_id,
                leaf,
            } => write!(
                f,
                "text sidecar variant `{variant_id}` in group `{equivalence_group}` at leaf `{leaf}` has no anchorOpId"
            ),
            Self::InvalidSidecarAnchor {
                equivalence_group,
                variant_id,
                anchor_op_id,
                leaf,
            } => write!(
                f,
                "text sidecar variant `{variant_id}` in group `{equivalence_group}` at leaf `{leaf}` anchors `{anchor_op_id}`, expected the same paint-order slot"
            ),
            Self::MixedGlyphOutlinePayload {
                equivalence_group,
                variant_id,
                leaf,
            } => write!(
                f,
                "glyph outline variant `{variant_id}` in group `{equivalence_group}` at leaf `{leaf}` mixes payload families"
            ),
            Self::EmptyVariantSet {
                equivalence_group,
                variant_id,
                leaf,
            } => write!(
                f,
                "text variant `{variant_id}` in group `{equivalence_group}` at leaf `{leaf}` has zero parts"
            ),
            Self::DuplicatePart {
                equivalence_group,
                variant_id,
                part_index,
                leaf,
            } => write!(
                f,
                "text variant `{variant_id}` in group `{equivalence_group}` at leaf `{leaf}` repeats part {part_index}"
            ),
            Self::PartCountMismatch {
                equivalence_group,
                variant_id,
                expected,
                actual,
                leaf,
            } => write!(
                f,
                "text variant `{variant_id}` in group `{equivalence_group}` at leaf `{leaf}` has {actual} parts, expected {expected}"
            ),
        }
    }
}

impl std::error::Error for TextVariantScopeError {}

#[derive(Debug, Default)]
struct LeafGroupState {
    has_default_fallback: bool,
    variants: HashMap<String, VariantPartState>,
}

#[derive(Debug, Default)]
struct VariantPartState {
    expected_part_count: Option<u32>,
    parts: HashSet<u32>,
}

pub fn validate_text_variant_scope(tree: &PageLayerTree) -> Result<(), TextVariantScopeError> {
    let mut group_leaf_paths = HashMap::new();
    validate_node(&tree.root, "root".to_string(), &mut group_leaf_paths)
}

fn validate_node(
    node: &LayerNode,
    path: String,
    group_leaf_paths: &mut HashMap<String, String>,
) -> Result<(), TextVariantScopeError> {
    match &node.kind {
        LayerNodeKind::Group { children, .. } => {
            for (index, child) in children.iter().enumerate() {
                validate_node(child, format!("{path}/group[{index}]"), group_leaf_paths)?;
            }
        }
        LayerNodeKind::ClipRect { child, .. } => {
            validate_node(child, format!("{path}/clip"), group_leaf_paths)?;
        }
        LayerNodeKind::Leaf { ops } => {
            validate_leaf(ops, path, group_leaf_paths)?;
        }
    }
    Ok(())
}

fn validate_leaf(
    ops: &[PaintOp],
    leaf_path: String,
    group_leaf_paths: &mut HashMap<String, String>,
) -> Result<(), TextVariantScopeError> {
    let mut groups = HashMap::<String, LeafGroupState>::new();
    let has_text_run_fallback = ops.iter().any(|op| matches!(op, PaintOp::TextRun { .. }));
    for op in ops {
        let Some(variant) = op_variant(op) else {
            continue;
        };
        validate_sidecar_anchor(&variant, &leaf_path)?;
        if let PaintOp::GlyphOutline { outline, .. } = op {
            if !outline.has_exclusive_payload_family() {
                return Err(TextVariantScopeError::MixedGlyphOutlinePayload {
                    equivalence_group: variant.equivalence_group.clone(),
                    variant_id: variant.variant_id.clone(),
                    leaf: leaf_path,
                });
            }
        }
        if let Some(first_leaf) = group_leaf_paths.get(&variant.equivalence_group) {
            if first_leaf != &leaf_path {
                return Err(TextVariantScopeError::CrossLeafGroup {
                    equivalence_group: variant.equivalence_group.clone(),
                    first_leaf: first_leaf.clone(),
                    second_leaf: leaf_path,
                });
            }
        } else {
            group_leaf_paths.insert(variant.equivalence_group.clone(), leaf_path.clone());
        }

        let group = groups.entry(variant.equivalence_group.clone()).or_default();
        group.has_default_fallback |= has_text_run_fallback || variant.is_default_fallback;
        let state = group
            .variants
            .entry(variant.variant_id.clone())
            .or_default();
        match state.expected_part_count {
            Some(expected) if expected != variant.part_count => {
                return Err(TextVariantScopeError::PartCountMismatch {
                    equivalence_group: variant.equivalence_group.clone(),
                    variant_id: variant.variant_id.clone(),
                    expected,
                    actual: variant.part_count,
                    leaf: leaf_path,
                });
            }
            Some(_) => {}
            None => {
                state.expected_part_count = Some(variant.part_count);
            }
        }
        if variant.part_count == 0 {
            return Err(TextVariantScopeError::EmptyVariantSet {
                equivalence_group: variant.equivalence_group.clone(),
                variant_id: variant.variant_id.clone(),
                leaf: leaf_path,
            });
        }
        if !state.parts.insert(variant.part_index) {
            return Err(TextVariantScopeError::DuplicatePart {
                equivalence_group: variant.equivalence_group.clone(),
                variant_id: variant.variant_id.clone(),
                part_index: variant.part_index,
                leaf: leaf_path,
            });
        }
    }

    for (equivalence_group, group) in groups {
        if !group.has_default_fallback {
            return Err(TextVariantScopeError::MissingDefaultFallback {
                equivalence_group,
                leaf: leaf_path,
            });
        }
        for (variant_id, state) in group.variants {
            let expected = state.expected_part_count.unwrap_or_default();
            let actual = state.parts.len() as u32;
            if expected != actual || !(0..expected).all(|index| state.parts.contains(&index)) {
                return Err(TextVariantScopeError::PartCountMismatch {
                    equivalence_group: equivalence_group.clone(),
                    variant_id,
                    expected,
                    actual,
                    leaf: leaf_path,
                });
            }
        }
    }
    Ok(())
}

fn op_variant(op: &PaintOp) -> Option<PaintVariantMeta> {
    match op {
        PaintOp::GlyphRun { run, .. } => Some(run.variant.clone()),
        PaintOp::GlyphOutline { outline, .. } => Some(outline.variant.clone()),
        _ => None,
    }
}

fn validate_sidecar_anchor(
    variant: &PaintVariantMeta,
    leaf_path: &str,
) -> Result<(), TextVariantScopeError> {
    if variant.variant_kind != TextVariantKind::GlyphOutline {
        return Ok(());
    }
    let Some(anchor_op_id) = &variant.anchor_op_id else {
        return Err(TextVariantScopeError::MissingSidecarAnchorOpId {
            equivalence_group: variant.equivalence_group.clone(),
            variant_id: variant.variant_id.clone(),
            leaf: leaf_path.to_string(),
        });
    };
    // Schema v1 does not assign an explicit op id to the fallback TextRun.
    // The equivalence group is the exported paint-order slot id, so P14
    // sidecars anchor to that slot until per-op ids exist.
    if anchor_op_id != &variant.equivalence_group {
        return Err(TextVariantScopeError::InvalidSidecarAnchor {
            equivalence_group: variant.equivalence_group.clone(),
            variant_id: variant.variant_id.clone(),
            anchor_op_id: anchor_op_id.clone(),
            leaf: leaf_path.to_string(),
        });
    }
    Ok(())
}

