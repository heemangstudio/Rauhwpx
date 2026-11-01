//! Reviewable, dependency-safe selections over the structural merge result.
//!
//! Paragraphs are the smallest independent document unit here. Changes to
//! positional resources or container structure are grouped with their users;
//! rejecting one can therefore never leave dangling resource references.
use super::*;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewAnalysis {
    analysis_version: u32,
    result: Value,
    conflicts: Vec<ReviewUnit>,
    automatic_operation_count: usize,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ReviewUnit {
    #[serde(flatten)]
    value: MergeConflict,
    automatic: bool,
    dependency_ids: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    position: Option<ReviewPosition>,
}

#[derive(Clone, PartialEq, Eq, Serialize)]
struct ReviewPosition {
    section: usize,
    paragraph: usize,
}

enum Target {
    Document,
    Paragraph(usize, usize),
    Conflict,
    Group {
        edits: Vec<ParagraphEdit>,
        resources: bool,
    },
}

#[derive(Clone)]
struct ParagraphEdit {
    section: usize,
    current: std::ops::Range<usize>,
    proposed: std::ops::Range<usize>,
}

fn paragraph_value(p: &Paragraph) -> Value {
    json!({
        "text": p.text,
        "contentHash": paragraph_hash(p).to_hex().to_string(),
        "controls": p.controls.len()
    })
}

fn paragraph_hash(p: &Paragraph) -> blake3::Hash {
    let mut value = p.clone();
    value.char_count = 0;
    value.char_offsets.clear();
    value.line_segs.clear();
    for byte in value.raw_header_extra.iter_mut().take(6) {
        *byte = 0;
    }
    dh(&value)
}

fn value_text(value: &Value) -> Option<&str> {
    match value {
        Value::String(text) => Some(text),
        Value::Object(object) => object.get("text").and_then(Value::as_str),
        _ => None,
    }
}

fn texts_support_both(base: &Value, current: &Value, incoming: &Value) -> bool {
    match (value_text(base), value_text(current), value_text(incoming)) {
        (Some(base), Some(current), Some(incoming)) if current != incoming => {
            merge_text(base, current, incoming).is_some()
                || both_text(base, current, incoming, false).is_some()
        }
        _ => false,
    }
}

fn review_position_key(position: &ReviewPosition) -> String {
    format!("review-pos:{}:{}", position.section, position.paragraph)
}

fn review_choice(
    choices: &BTreeMap<String, MergeResolution>,
    unit: &ReviewUnit,
) -> MergeResolution {
    choices
        .get(&unit.value.id)
        .or_else(|| choices.get(&unit.value.fingerprint))
        .or_else(|| {
            unit.position
                .as_ref()
                .filter(|_| unit.value.path.get(1).map(String::as_str) != Some("group"))
                .and_then(|position| choices.get(&review_position_key(position)))
        })
        .cloned()
        .unwrap_or(MergeResolution::Current)
}

fn unit(
    path: Vec<String>,
    b: Value,
    c: Value,
    i: Value,
    dependencies: Vec<String>,
    manual: bool,
) -> ReviewUnit {
    let both = manual && texts_support_both(&b, &c, &i);
    let mut value = conflict(
        &path,
        MergeConflictReason::SameFieldChanged,
        &b,
        &c,
        &i,
        both,
    );
    let mut dependencies = dependencies;
    dependencies.sort();
    dependencies.dedup();
    value.fingerprint =
        blake3::hash(&serde_json::to_vec(&json!([3, value.fingerprint, dependencies])).unwrap())
            .to_hex()
            .to_string();
    value.id = format!("review:{}", value.fingerprint);
    value.supports_manual = manual;
    value.kind = if manual {
        "rich-text"
    } else {
        "document-change"
    }
    .into();
    ReviewUnit {
        value,
        automatic: dependencies.is_empty(),
        dependency_ids: dependencies,
        position: None,
    }
}

fn plain_text(p: &Paragraph) -> bool {
    p.controls.is_empty()
        && p.field_ranges.is_empty()
        && p.range_tags.is_empty()
        && p.tab_extended.is_empty()
        && p.char_shapes.len() <= 1
        && p.char_shapes
            .first()
            .is_none_or(|shape| shape.start_pos == 0)
        && p.ctrl_data_records.iter().all(Option::is_none)
        && p.orphan_field_ends.is_empty()
        && p.markpen_marks.is_empty()
}

fn paragraph_identity(p: &Paragraph) -> Option<u32> {
    p.raw_header_extra
        .get(6..10)
        .map(|bytes| u32::from_le_bytes(bytes.try_into().unwrap()))
        .filter(|id| *id != 0)
}

// Unique identities take precedence over content anchors. An ambiguous region
// stays one atomic range; we never guess which repeated paragraph was deleted.
fn paragraph_edits(
    section: usize,
    current: &[Paragraph],
    proposed: &[Paragraph],
) -> Option<Vec<ParagraphEdit>> {
    let mut old = BTreeMap::<String, Vec<usize>>::new();
    let mut new = BTreeMap::<String, Vec<usize>>::new();
    for (paragraphs, keys) in [(current, &mut old), (proposed, &mut new)] {
        for (index, paragraph) in paragraphs.iter().enumerate() {
            let key = paragraph_identity(paragraph)
                .map(|id| format!("id:{id}"))
                .unwrap_or_else(|| format!("hash:{}", paragraph_hash(paragraph)));
            keys.entry(key).or_default().push(index);
        }
    }
    let mut anchors = old
        .iter()
        .filter_map(|(key, indices)| {
            let others = new.get(key)?;
            (indices.len() == 1 && others.len() == 1).then_some((indices[0], others[0]))
        })
        .collect::<Vec<_>>();
    anchors.sort_unstable();
    // Reordering needs an explicit move operation; overlapping replacement
    // ranges cannot safely express independent choices.
    if anchors.windows(2).any(|pair| pair[0].1 >= pair[1].1) {
        return None;
    }
    let mut edits = vec![];
    let (mut a, mut b) = (0, 0);
    for (x, y) in anchors
        .into_iter()
        .chain(std::iter::once((current.len(), proposed.len())))
    {
        if (a != x || b != y)
            && (x - a != y - b
                || current[a..x]
                    .iter()
                    .zip(&proposed[b..y])
                    .any(|(old, new)| paragraph_hash(old) != paragraph_hash(new)))
        {
            edits.push(ParagraphEdit {
                section,
                current: a..x,
                proposed: b..y,
            });
        }
        if x < current.len()
            && y < proposed.len()
            && paragraph_hash(&current[x]) != paragraph_hash(&proposed[y])
        {
            edits.push(ParagraphEdit {
                section,
                current: x..x + 1,
                proposed: y..y + 1,
            });
        }
        a = x + 1;
        b = y + 1;
    }
    Some(edits)
}

fn same_resource_content(left: &[BinDataContent], right: &[BinDataContent]) -> bool {
    left.len() == right.len()
        && left
            .iter()
            .zip(right)
            .all(|(left, right)| resources_equal(Some(left), Some(right)))
}

fn document_value(document: &Document) -> Result<Value, String> {
    // Keep every document field in the fingerprint while replacing mutable
    // lazy-resolver state with the exact payload identity.
    let Document {
        header,
        doc_properties,
        doc_info,
        sections,
        preview,
        bin_data_content,
        extra_streams,
        hwpx_aux_entries,
        is_hwp3_variant,
        is_hwpx_variant,
        provenance,
    } = document;
    let resources = bin_data_content
        .iter()
        .map(|content| {
            let identity = if let Some(identity) = content.data.payload_identity() {
                identity.token()
            } else {
                let bytes = content
                    .data
                    .load_limited_shared(crate::parser::limits::MAX_BINARY_BYTES)
                    .ok_or_else(|| {
                        format!(
                            "cannot fingerprint review resource {} within binary limits",
                            content.id
                        )
                    })?;
                crate::model::bin_data::BinDataPayloadIdentity::new(
                    "decoded",
                    bytes.len() as u64,
                    *blake3::hash(&bytes).as_bytes(),
                )
                .token()
            };
            Ok((content.id, &content.extension, identity))
        })
        .collect::<Result<Vec<_>, String>>()?;
    let hash = dh(&(
        header,
        doc_properties,
        doc_info,
        sections,
        preview,
        resources,
        extra_streams,
        hwpx_aux_entries,
        is_hwp3_variant,
        is_hwpx_variant,
        provenance,
    ));
    Ok(json!({"kind": "document", "hash": format!("blake3:{}", hash.to_hex())}))
}

fn independent_groups(
    c: &Document,
    candidate: &Document,
    conflicts: &[MergeConflict],
) -> Option<(Vec<ReviewUnit>, Vec<Target>)> {
    if c.sections.len() != candidate.sections.len()
        || dh(&c.header) != dh(&candidate.header)
        || dh(&c.doc_properties) != dh(&candidate.doc_properties)
        || dh(&c.extra_streams) != dh(&candidate.extra_streams)
    {
        return None;
    }
    let resources = !same_resource_content(&c.bin_data_content, &candidate.bin_data_content)
        || dh(&c.doc_info.bin_data_list) != dh(&candidate.doc_info.bin_data_list);
    let normalize = |d: &Document| {
        let mut info = d.doc_info.clone();
        info.bin_data_list.clear();
        info.raw_stream = None;
        info.raw_stream_dirty = false;
        // Structural merging regenerates the encoded records even when all
        // style properties are unchanged. Compare their modeled values.
        for font in info.font_faces.iter_mut().flatten() {
            font.raw_data = None;
        }
        macro_rules! clear_encoded_records {
            ($($field:ident),+) => { $(for value in &mut info.$field { value.raw_data = None; })+ };
        }
        clear_encoded_records!(
            border_fills,
            char_shapes,
            tab_defs,
            numberings,
            bullets,
            para_shapes,
            styles
        );
        info
    };
    if dh(&normalize(c)) != dh(&normalize(candidate)) {
        return None;
    }
    // Existing declaration slots and payloads must retain their meaning so
    // rejected paragraphs can safely keep referring to the current resources.
    let payloads = candidate
        .bin_data_content
        .iter()
        .map(|value| (value.id, value))
        .collect::<BTreeMap<_, _>>();
    if candidate.doc_info.bin_data_list.len() < c.doc_info.bin_data_list.len()
        || c.doc_info
            .bin_data_list
            .iter()
            .zip(&candidate.doc_info.bin_data_list)
            .any(|(old, new)| dh(old) != dh(new))
        || c.bin_data_content
            .iter()
            .any(|old| !resources_equal(Some(old), payloads.get(&old.id).copied()))
    {
        return None;
    }
    let mut independent = vec![];
    let mut dependent = vec![];
    let mut probe = resources.then(|| {
        let mut probe = c.clone();
        probe.sections.clear();
        probe.doc_properties.section_count = 1;
        probe
    });
    for (section, (old, new)) in c.sections.iter().zip(&candidate.sections).enumerate() {
        if dh(&old.section_def) != dh(&new.section_def) {
            return None;
        }
        for edit in paragraph_edits(section, &old.paragraphs, &new.paragraphs)? {
            let paragraphs = &new.paragraphs[edit.proposed.clone()];
            let unchanged_controls = edit.current.len() == 1
                && edit.proposed.len() == 1
                && dh(&old.paragraphs[edit.current.start].controls) == dh(&paragraphs[0].controls)
                && dh(&old.paragraphs[edit.current.start].ctrl_data_records)
                    == dh(&paragraphs[0].ctrl_data_records);
            if resources
                && !unchanged_controls
                && paragraphs.iter().any(|p| {
                    p.ctrl_data_records
                    .iter()
                    .skip(p.controls.len())
                    .any(Option::is_some)
                    || p.controls.iter().enumerate().any(|(index, control)| {
                        let raw = p.ctrl_data_records.get(index).cloned().flatten();
                        if matches!(control, Control::Picture(picture) if picture.caption.is_none())
                            && raw.is_none()
                        {
                            return false;
                        }
                        // A newly added image may share its paragraph with
                        // existing section/table/opaque controls. Their
                        // unchanged bytes still refer to current resources.
                        !(edit.current.len() == 1
                            && edit.proposed.len() == 1
                            && old.paragraphs[edit.current.start]
                                .controls
                                .iter()
                                .enumerate()
                                .any(|(old_index, existing)| {
                                    dh(existing) == dh(control)
                                        && old.paragraphs[edit.current.start]
                                            .ctrl_data_records
                                            .get(old_index)
                                            .cloned()
                                            .flatten()
                                            == raw
                                }))
                    })
                })
            {
                // Opaque controls may contain references we cannot inspect.
                return None;
            }
            let needs_resources = if let Some(probe) = &mut probe {
                probe.sections = vec![Section {
                    section_def: new.section_def.clone(),
                    paragraphs: paragraphs.to_vec(),
                    ..Section::default()
                }];
                let required = validate_resource_dependencies(probe).is_err();
                required
            } else {
                false
            };
            if needs_resources {
                dependent.push(edit);
            } else {
                independent.push(vec![edit]);
            }
        }
    }
    if resources {
        independent.push(dependent);
    }
    let resource_hash = if resources {
        // Lazy resolver caches change after export or preview. A saved choice
        // must identify the resource payload, never its cache state.
        let identities = candidate
            .bin_data_content
            .iter()
            .map(|content| {
                let observation = ResourceObservation::new(content);
                observation.payload.external_identity()?;
                Some(observation.value())
            })
            .collect::<Option<Vec<_>>>()?;
        Some(
            dh(&(&candidate.doc_info.bin_data_list, identities))
                .to_hex()
                .to_string(),
        )
    } else {
        None
    };
    let count = independent.len();
    let mut units = vec![];
    let mut targets = vec![];
    let mut assigned = BTreeMap::<String, usize>::new();
    for (index, edits) in independent.into_iter().enumerate() {
        let has_resources = resources && index + 1 == count;
        let values = |d: &Document, incoming: bool| -> Value {
            let paragraphs = edits.iter().map(|edit| {
                let range = if incoming { edit.proposed.clone() } else { edit.current.clone() };
                json!({"section": edit.section, "start": range.start,
                    "paragraphs": d.sections[edit.section].paragraphs[range].iter().map(paragraph_value).collect::<Vec<_>>()})
            }).collect::<Vec<_>>();
            let text = edits
                .iter()
                .flat_map(|edit| {
                    let range = if incoming {
                        edit.proposed.clone()
                    } else {
                        edit.current.clone()
                    };
                    d.sections[edit.section].paragraphs[range]
                        .iter()
                        .map(|paragraph| paragraph.text.as_str())
                })
                .collect::<Vec<_>>()
                .join("\n");
            json!({"text": text, "groups": paragraphs})
        };
        let mut dependencies = conflicts
            .iter()
            .filter(|conflict| {
                edits.iter().any(|edit| {
                    let path = &conflict.path;
                    if path.len() < 4
                        || path[0] != "sections"
                        || path[1] != edit.section.to_string()
                        || path[2] != "paragraphs"
                    {
                        return false;
                    }
                    if let Some(identity) = path[3]
                        .strip_prefix('@')
                        .and_then(|value| value.parse::<u32>().ok())
                    {
                        return c.sections[edit.section].paragraphs[edit.current.clone()]
                            .iter()
                            .chain(
                                candidate.sections[edit.section].paragraphs[edit.proposed.clone()]
                                    .iter(),
                            )
                            .any(|paragraph| paragraph_identity(paragraph) == Some(identity));
                    }
                    // Numeric conflict paths are only unambiguous when this range
                    // retained its positions through the structural merge.
                    edit.current == edit.proposed
                        && path[3]
                            .parse::<usize>()
                            .ok()
                            .is_some_and(|position| edit.current.contains(&position))
                })
            })
            .map(|conflict| {
                *assigned.entry(conflict.id.clone()).or_default() += 1;
                conflict.id.clone()
            })
            .collect::<Vec<_>>();
        let automatic = dependencies.is_empty();
        if has_resources {
            dependencies.push(format!("resources:{}", resource_hash.as_ref().unwrap()));
        }
        let current_value = values(c, false);
        let mut review = unit(
            vec!["sections".into(), "group".into(), index.to_string()],
            current_value.clone(),
            current_value,
            values(candidate, true),
            dependencies,
            false,
        );
        // These dependencies are automatic resource additions, not conflicts.
        review.automatic = automatic;
        review.value.supports_both = false;
        if let Some(edit) = edits.first() {
            review.position = Some(ReviewPosition {
                section: edit.section,
                paragraph: edit.current.start,
            });
        }
        units.push(review);
        targets.push(Target::Group {
            edits,
            resources: has_resources,
        });
    }
    conflicts
        .iter()
        .all(|conflict| assigned.get(&conflict.id) == Some(&1))
        .then_some((units, targets))
}

fn apply_groups(
    c: &Document,
    candidate: &Document,
    analysis: &ReviewAnalysis,
    targets: &[Target],
    choices: &BTreeMap<String, MergeResolution>,
) -> Result<Document, String> {
    let mut output = c.clone();
    let mut selected = vec![];
    for (unit, target) in analysis.conflicts.iter().zip(targets) {
        let Target::Group { edits, resources } = target else {
            unreachable!()
        };
        match review_choice(choices, unit) {
            MergeResolution::Current => continue,
            MergeResolution::Incoming => {}
            _ => return Err(format!("{} requires an atomic selection", unit.value.id)),
        }
        if *resources {
            output.doc_info = candidate.doc_info.clone();
            output.bin_data_content = candidate.bin_data_content.clone();
        }
        selected.extend(edits.iter());
    }
    selected.sort_by_key(|edit| {
        std::cmp::Reverse((edit.section, edit.current.start, edit.current.end))
    });
    for edit in selected {
        let section = &mut output.sections[edit.section];
        section.paragraphs.splice(
            edit.current.clone(),
            candidate.sections[edit.section].paragraphs[edit.proposed.clone()]
                .iter()
                .cloned(),
        );
        section.raw_stream = None;
    }
    validate_resource_dependencies(&output)?;
    Ok(output)
}

fn review_documents(
    b: &Document,
    c: &Document,
    i: &Document,
) -> Result<(Document, ReviewAnalysis, Vec<Target>), String> {
    let (automatic_candidate, mut initial) = merge_doc(b, c, i, None)?;
    // Cached thumbnails/text and HWPX aux zip entries are regenerated from the
    // chosen document; they must not turn independent content edits into a
    // document-wide conflict.
    initial.conflicts.retain(|item| {
        !matches!(
            item.path.first().map(String::as_str),
            Some("preview" | "hwpx_aux_entries")
        ) && item.kind != "line-layout"
    });
    let incoming_choices = initial
        .conflicts
        .iter()
        .map(|item| (item.id.clone(), MergeResolution::Incoming))
        .collect();
    let candidate = if initial.conflicts.is_empty() {
        automatic_candidate.clone()
    } else {
        merge_doc(b, c, i, Some(&incoming_choices))?.0
    };
    let mut units = vec![];
    let mut targets = vec![];
    // Paragraph topology and global changes use dependency groups when their
    // references are understood; unsupported dependencies stay document-wide.
    let global_changed = dh(&b.header) != dh(&i.header)
        || dh(&b.doc_info) != dh(&i.doc_info)
        || !same_resource_content(&b.bin_data_content, &i.bin_data_content)
        || dh(&b.extra_streams) != dh(&i.extra_streams)
        || [
            b.doc_properties.page_start_num,
            b.doc_properties.footnote_start_num,
            b.doc_properties.endnote_start_num,
            b.doc_properties.picture_start_num,
            b.doc_properties.table_start_num,
            b.doc_properties.equation_start_num,
        ] != [
            i.doc_properties.page_start_num,
            i.doc_properties.footnote_start_num,
            i.doc_properties.endnote_start_num,
            i.doc_properties.picture_start_num,
            i.doc_properties.table_start_num,
            i.doc_properties.equation_start_num,
        ];
    let same_layout = c.sections.len() == candidate.sections.len()
        && c.sections.len() == b.sections.len()
        && c.sections
            .iter()
            .zip(&candidate.sections)
            .zip(&b.sections)
            .all(|((c, n), b)| {
                c.paragraphs.len() == n.paragraphs.len()
                    && c.paragraphs.len() == b.paragraphs.len()
                    && dh(&c.section_def) == dh(&n.section_def)
                    && c.paragraphs
                        .iter()
                        .zip(&n.paragraphs)
                        .all(|(c, n)| c.raw_header_extra.get(6..) == n.raw_header_extra.get(6..))
            });
    let grouped = if !same_layout || global_changed {
        independent_groups(c, &candidate, &initial.conflicts)
    } else {
        None
    };
    if let Some((grouped_units, grouped_targets)) = grouped {
        units = grouped_units;
        targets = grouped_targets;
    } else if !same_layout || global_changed {
        let current_value = document_value(c)?;
        let candidate_value = document_value(&candidate)?;
        if candidate_value != current_value || !initial.conflicts.is_empty() {
            units.push(unit(
                vec![],
                document_value(b)?,
                current_value,
                candidate_value,
                initial.conflicts.iter().map(|v| v.id.clone()).collect(),
                false,
            ));
            targets.push(Target::Document);
        }
    } else {
        for (s, section) in candidate.sections.iter().enumerate() {
            for (p, proposed) in section.paragraphs.iter().enumerate() {
                let current = &c.sections[s].paragraphs[p];
                if paragraph_hash(current) == paragraph_hash(proposed) {
                    continue;
                }
                let base = &b.sections[s].paragraphs[p];
                let paragraph_id = current
                    .raw_header_extra
                    .get(6..10)
                    .map(|v| u32::from_le_bytes(v.try_into().unwrap()))
                    .filter(|id| *id != 0);
                let index_path = vec![
                    "sections".into(),
                    s.to_string(),
                    "paragraphs".into(),
                    p.to_string(),
                ];
                let path = paragraph_id
                    .map(|id| {
                        let mut identity_path = index_path.clone();
                        identity_path[3] = format!("@{id}");
                        identity_path
                    })
                    .unwrap_or_else(|| index_path.clone());
                let dependencies: Vec<String> = initial
                    .conflicts
                    .iter()
                    .filter(|item| {
                        item.path.starts_with(&index_path) || item.path.starts_with(&path)
                    })
                    .map(|item| item.id.clone())
                    .collect();
                if !dependencies.is_empty()
                    && paragraph_hash(&automatic_candidate.sections[s].paragraphs[p])
                        == paragraph_hash(current)
                {
                    for original in initial
                        .conflicts
                        .iter()
                        .filter(|item| dependencies.contains(&item.id))
                    {
                        units.push(ReviewUnit {
                            value: original.clone(),
                            automatic: false,
                            dependency_ids: vec![original.id.clone()],
                            position: Some(ReviewPosition {
                                section: s,
                                paragraph: p,
                            }),
                        });
                        targets.push(Target::Conflict);
                    }
                    continue;
                }
                units.push(unit(
                    path,
                    paragraph_value(base),
                    paragraph_value(current),
                    paragraph_value(proposed),
                    dependencies,
                    plain_text(current) && plain_text(proposed),
                ));
                units.last_mut().unwrap().position = Some(ReviewPosition {
                    section: s,
                    paragraph: p,
                });
                targets.push(Target::Paragraph(s, p));
            }
        }
        // A conflict path that cannot be attributed confidently must never be
        // advertised as an automatic change.
        if initial
            .conflicts
            .iter()
            .any(|item| !units.iter().any(|u| u.dependency_ids.contains(&item.id)))
        {
            units = vec![unit(
                vec![],
                document_value(b)?,
                document_value(c)?,
                document_value(&candidate)?,
                initial.conflicts.iter().map(|v| v.id.clone()).collect(),
                false,
            )];
            targets = vec![Target::Document];
        }
    }
    let automatic_operation_count = units.iter().filter(|v| v.automatic).count();
    let result = summary(&candidate);
    Ok((
        candidate,
        ReviewAnalysis {
            analysis_version: 3,
            result,
            conflicts: units,
            automatic_operation_count,
        },
        targets,
    ))
}

fn apply_review(
    b: &Document,
    c: &Document,
    i: &Document,
    choices: &BTreeMap<String, MergeResolution>,
) -> Result<Document, String> {
    let (mut output, analysis, targets) = review_documents(b, c, i)?;
    if analysis
        .conflicts
        .iter()
        .all(|unit| matches!(review_choice(choices, unit), MergeResolution::Current))
    {
        validate_resource_dependencies(c)?;
        return Ok(c.clone());
    }
    if targets
        .iter()
        .any(|target| matches!(target, Target::Group { .. }))
    {
        return apply_groups(c, &output, &analysis, &targets, choices);
    }
    if targets
        .iter()
        .any(|target| matches!(target, Target::Conflict))
    {
        let mut structural_choices = analysis
            .conflicts
            .iter()
            .flat_map(|unit| {
                unit.dependency_ids
                    .iter()
                    .map(|id| (id.clone(), MergeResolution::Incoming))
            })
            .collect::<BTreeMap<_, _>>();
        for (unit, target) in analysis.conflicts.iter().zip(&targets) {
            if matches!(target, Target::Conflict) {
                structural_choices.insert(unit.value.id.clone(), review_choice(choices, unit));
            }
        }
        output = merge_doc(b, c, i, Some(&structural_choices))?.0;
    }
    for (unit, target) in analysis.conflicts.iter().zip(targets) {
        if matches!(target, Target::Conflict) {
            continue;
        }
        match review_choice(choices, unit) {
            MergeResolution::Incoming => {}
            MergeResolution::Current => match target {
                Target::Document => output = c.clone(),
                Target::Paragraph(s, p) => {
                    output.sections[s].paragraphs[p] = c.sections[s].paragraphs[p].clone()
                }
                Target::Conflict | Target::Group { .. } => unreachable!(),
            },
            MergeResolution::Both { order } if unit.value.supports_both => {
                let Target::Paragraph(s, p) = target else {
                    return Err(format!("{} does not support this selection", unit.value.id));
                };
                let inc_first = match order.as_str() {
                    "incoming-first" => true,
                    "current-first" => false,
                    _ => return Err("invalid both order".into()),
                };
                let combined = merge_text(
                    &b.sections[s].paragraphs[p].text,
                    &c.sections[s].paragraphs[p].text,
                    &i.sections[s].paragraphs[p].text,
                )
                .or_else(|| {
                    both_text(
                        &b.sections[s].paragraphs[p].text,
                        &c.sections[s].paragraphs[p].text,
                        &i.sections[s].paragraphs[p].text,
                        inc_first,
                    )
                })
                .ok_or("unsafe both text")?;
                output.sections[s].paragraphs[p] = c.sections[s].paragraphs[p].clone();
                let para = &mut output.sections[s].paragraphs[p];
                if para.text != combined {
                    para.authored_text_runs = None;
                }
                para.text = combined;
                para.line_segs.clear();
                crate::document_core::queries::field_query::rebuild_char_offsets(para);
            }
            MergeResolution::Manual { payload } if unit.value.supports_manual => {
                let Target::Paragraph(s, p) = target else {
                    return Err("manual document replacement is unsupported".into());
                };
                let text = payload
                    .as_str()
                    .or_else(|| payload.get("text").and_then(Value::as_str))
                    .ok_or("manual paragraph requires text")?;
                if text.chars().any(|ch| ch.is_control()) {
                    return Err("manual paragraph contains control characters".into());
                }
                let para = &mut output.sections[s].paragraphs[p];
                if para.text != text {
                    para.authored_text_runs = None;
                }
                para.text = text.into();
                para.line_segs.clear();
                crate::document_core::queries::field_query::rebuild_char_offsets(para);
            }
            _ => return Err(format!("{} does not support this selection", unit.value.id)),
        }
    }
    validate_resource_dependencies(&output)?;
    Ok(output)
}

#[wasm_bindgen(js_name=structuralMergeReviewDocument)]
pub fn review_document(
    b: &[u8],
    c: &[u8],
    i: &[u8],
    bm: &str,
    cm: &str,
    im: &str,
) -> Result<String, JsValue> {
    let run = || -> Result<String, String> {
        let (bm, cm, im) = parse_manifests(bm, cm, im)?;
        let (b, c, i, _) = manifest_documents(b, c, i, &bm, &cm, &im)?;
        serde_json::to_string(&review_documents(&b, &c, &i)?.1).map_err(|e| e.to_string())
    };
    run().map_err(|e| JsValue::from_str(&e))
}

#[wasm_bindgen(js_name=structuralMergeMaterializeReviewDocument)]
pub fn materialize_review_document(
    b: &[u8],
    c: &[u8],
    i: &[u8],
    bm: &str,
    cm: &str,
    im: &str,
    resolutions: &str,
) -> Result<Vec<u8>, JsValue> {
    let run = || -> Result<Vec<u8>, String> {
        let format = fmt(c)?;
        let (bm, cm, im) = parse_manifests(bm, cm, im)?;
        let (b, c, i, restore) = manifest_documents(b, c, i, &bm, &cm, &im)?;
        let choices = serde_json::from_str(resolutions)
            .map_err(|e| format!("invalid review choices: {e}"))?;
        let mut output = apply_review(&b, &c, &i, &choices)?;
        restore_manifest_ids(&mut output, &restore);
        let bytes = match format {
            FileFormat::Hwp => serialize_hwp(&output),
            _ => serialize_hwpx(&output),
        }
        .map_err(|e| e.to_string())?;
        let loaded = parse_regenerated_document(&bytes).map_err(|e| e.to_string())?;
        validate_resource_dependencies(&loaded)?;
        if counts(&loaded) != counts(&output) {
            return Err("review result failed structural validation".into());
        }
        Ok(bytes)
    };
    run().map_err(|e| JsValue::from_str(&e))
}

