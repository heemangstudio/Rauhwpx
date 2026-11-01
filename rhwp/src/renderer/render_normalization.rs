//! Render-only derived state shared by pagination, measurement, and layout.
//!
//! The editable document IR remains authoritative.  Logical paths are the
//! durable cache keys; pointer indexes are rebuilt from the current source IR
//! and exist only as a fast lookup surface for renderer hot paths.

use crate::model::control::Control;
use crate::model::document::Document;
use crate::model::shape::SizeCriterion;
use crate::model::table::Table;
use std::collections::HashMap;
use std::sync::Arc;

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub enum RenderPathEntry {
    TableCell {
        control_index: usize,
        cell_index: usize,
        paragraph_index: usize,
    },
    TableCaption {
        control_index: usize,
        paragraph_index: usize,
    },
    ShapeTextBox {
        control_index: usize,
        paragraph_index: usize,
    },
    PictureCaption {
        control_index: usize,
        paragraph_index: usize,
    },
}

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct RenderPath {
    pub section_index: usize,
    pub parent_paragraph_index: usize,
    pub entries: Vec<RenderPathEntry>,
    pub target_control_index: Option<usize>,
}

impl RenderPath {
    pub fn top_level(section_index: usize, parent_paragraph_index: usize) -> Self {
        Self {
            section_index,
            parent_paragraph_index,
            entries: Vec::new(),
            target_control_index: None,
        }
    }
}

#[derive(Clone, Debug)]
pub struct NestedTableWidthProjection {
    pub path: RenderPath,
    pub source_width: u32,
    pub effective_width: u32,
    pub width_scale: f64,
    table_pointer: usize,
}

#[derive(Clone, Debug, Default)]
pub struct RenderNormalizationOverlay {
    nested_table_widths_by_path: HashMap<RenderPath, Arc<NestedTableWidthProjection>>,
    nested_table_widths_by_pointer: HashMap<usize, Arc<NestedTableWidthProjection>>,
}

impl RenderNormalizationOverlay {
    pub fn from_document(document: &Document) -> Self {
        Self::from_document_reusing(document, &Self::default())
    }

    pub fn from_document_reusing(document: &Document, previous: &Self) -> Self {
        let mut overlay = Self::default();
        let hwp5_stored_pagination_layout = document.layout_profile().native_hwp5_layout()
            || document.layout_profile().hwp5_origin_hwpx();
        for (section_index, section) in document.sections.iter().enumerate() {
            for (parent_paragraph_index, paragraph) in section.paragraphs.iter().enumerate() {
                for (control_index, control) in paragraph.controls.iter().enumerate() {
                    let Control::Table(table) = control else {
                        continue;
                    };
                    let path = RenderPath::top_level(section_index, parent_paragraph_index);
                    if hwp5_stored_pagination_layout && table.common.treat_as_char {
                        let page_def = &section.section_def.page_def;
                        let body_width = page_def
                            .width
                            .saturating_sub(page_def.margin_left)
                            .saturating_sub(page_def.margin_right);
                        let source_width = table.common.width;
                        if body_width > 0
                            && source_width > body_width
                            && f64::from(body_width) >= f64::from(source_width) * 0.9
                        {
                            let mut top_path = path.clone();
                            top_path.target_control_index = Some(control_index);
                            let table_pointer = table.as_ref() as *const Table as usize;
                            let projection = Arc::new(NestedTableWidthProjection {
                                path: top_path.clone(),
                                source_width,
                                effective_width: body_width,
                                width_scale: f64::from(body_width) / f64::from(source_width),
                                table_pointer,
                            });
                            overlay
                                .nested_table_widths_by_pointer
                                .insert(table_pointer, Arc::clone(&projection));
                            overlay
                                .nested_table_widths_by_path
                                .insert(top_path, projection);
                        }
                    }
                    overlay.collect_nested_tables(table, path, control_index, previous);
                }
            }
        }
        overlay
    }

    fn collect_nested_tables(
        &mut self,
        owner_table: &Table,
        path: RenderPath,
        owner_control_index: usize,
        previous: &Self,
    ) {
        for (cell_index, cell) in owner_table.cells.iter().enumerate() {
            if cell.width >= 0x8000_0000 {
                continue;
            }
            for (paragraph_index, paragraph) in cell.paragraphs.iter().enumerate() {
                for (control_index, control) in paragraph.controls.iter().enumerate() {
                    let Control::Table(nested) = control else {
                        continue;
                    };

                    let mut nested_path = path.clone();
                    nested_path.entries.push(RenderPathEntry::TableCell {
                        control_index: owner_control_index,
                        cell_index,
                        paragraph_index,
                    });
                    nested_path.target_control_index = Some(control_index);

                    let source_width = nested.common.width;
                    // An absolute width is already in HWPUNIT and must remain the saved width.
                    // Relative widths may be projected to their containing cell unless noAdjust
                    // asks us to preserve the saved column ladder.
                    if !nested.common.treat_as_char
                        && !matches!(nested.common.width_criterion, SizeCriterion::Absolute)
                        && (nested.attr | nested.raw_table_record_attr) & 0x08 == 0
                        && source_width > 0
                        && u64::from(source_width) < u64::from(cell.width)
                    {
                        let effective_width = cell.width;
                        let table_pointer = nested.as_ref() as *const Table as usize;
                        let projection = previous
                            .nested_table_widths_by_path
                            .get(&nested_path)
                            .filter(|projection| {
                                projection.source_width == source_width
                                    && projection.effective_width == effective_width
                                    && projection.table_pointer == table_pointer
                            })
                            .map(Arc::clone)
                            .unwrap_or_else(|| {
                                Arc::new(NestedTableWidthProjection {
                                    path: nested_path.clone(),
                                    source_width,
                                    effective_width,
                                    width_scale: f64::from(effective_width)
                                        / f64::from(source_width),
                                    table_pointer,
                                })
                            });
                        self.nested_table_widths_by_pointer
                            .insert(projection.table_pointer, Arc::clone(&projection));
                        self.nested_table_widths_by_path
                            .insert(nested_path.clone(), projection);
                    }

                    self.collect_nested_tables(nested, nested_path, control_index, previous);
                }
            }
        }
    }

    #[inline]
    pub fn nested_table_width_scale(&self, table: &Table) -> f64 {
        let key = table as *const Table as usize;
        self.nested_table_widths_by_pointer
            .get(&key)
            .map(|projection| projection.width_scale)
            .unwrap_or(1.0)
    }

    pub fn projection_for_path(
        &self,
        path: &RenderPath,
    ) -> Option<Arc<NestedTableWidthProjection>> {
        self.nested_table_widths_by_path.get(path).map(Arc::clone)
    }

    pub fn nested_table_projection_count(&self) -> usize {
        self.nested_table_widths_by_path.len()
    }
}

