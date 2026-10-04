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

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> Document {
        let mut document = parse_document(include_bytes!("../../saved/blank2010.hwp")).unwrap();
        let mut para = document.sections[0].paragraphs[0].clone();
        para.controls.clear();
        para.ctrl_data_records.clear();
        para.raw_header_extra.clear();
        para.text = "first".into();
        document.sections[0].raw_stream = None;
        document.sections[0].paragraphs = vec![para.clone(), para.clone(), para];
        document
    }

    #[test]
    fn review_each_paragraph_preserves_unrelated_local_work() {
        let base = fixture();
        let mut current = base.clone();
        current.sections[0].paragraphs[0].text = "local".into();
        let mut incoming = base.clone();
        incoming.sections[0].paragraphs[1].text = "cloud one".into();
        incoming.sections[0].paragraphs[2].text = "cloud two".into();
        let (_, analysis, _) = review_documents(&base, &current, &incoming).unwrap();
        assert_eq!(
            analysis.conflicts.len(),
            2,
            "{:?}",
            analysis
                .conflicts
                .iter()
                .map(|v| &v.value.path)
                .collect::<Vec<_>>()
        );
        assert!(analysis.conflicts.iter().all(|v| v.automatic));
        let mut choices = analysis
            .conflicts
            .iter()
            .map(|v| (v.value.id.clone(), MergeResolution::Incoming))
            .collect::<BTreeMap<_, _>>();
        let output = apply_review(&base, &current, &incoming, &choices).unwrap();
        assert_eq!(output.sections[0].paragraphs[0].text, "local");
        assert_eq!(output.sections[0].paragraphs[1].text, "cloud one");
        choices.insert(
            analysis.conflicts[1].value.id.clone(),
            MergeResolution::Current,
        );
        let output = apply_review(&base, &current, &incoming, &choices).unwrap();
        assert_eq!(output.sections[0].paragraphs[2].text, "first");
        assert_eq!(output.sections[0].paragraphs[1].text, "cloud one");
    }

    #[test]
    fn review_conflicts_are_explicit_and_stale_choices_do_not_apply() {
        let base = fixture();
        let mut current = base.clone();
        current.sections[0].paragraphs[0].text = "local".into();
        let mut incoming = base.clone();
        incoming.sections[0].paragraphs[0].text = "remote".into();
        let (_, analysis, _) = review_documents(&base, &current, &incoming).unwrap();
        assert!(analysis.conflicts.iter().any(|v| !v.automatic));
        assert_eq!(
            dh(&apply_review(&base, &current, &incoming, &BTreeMap::new()).unwrap()),
            dh(&current)
        );
        let choices = analysis
            .conflicts
            .iter()
            .map(|v| (v.value.id.clone(), MergeResolution::Current))
            .collect();
        let rejected = apply_review(&base, &current, &incoming, &choices).unwrap();
        assert_eq!(dh(&rejected), dh(&current));
        current.sections[0].paragraphs[0].text = "new local".into();
        assert_eq!(
            dh(&apply_review(&base, &current, &incoming, &choices).unwrap()),
            dh(&current)
        );
    }

    #[test]
    fn review_structural_insertions_are_atomic_and_rejectable() {
        let base = fixture();
        let mut incoming = base.clone();
        let inserted = incoming.sections[0].paragraphs[0].clone();
        incoming.sections[0].paragraphs.push(inserted);
        let (_, analysis, _) = review_documents(&base, &base, &incoming).unwrap();
        assert_eq!(analysis.conflicts.len(), 1);
        assert!(!analysis.conflicts[0].value.supports_manual);
        let choices = BTreeMap::from([(
            analysis.conflicts[0].value.id.clone(),
            MergeResolution::Current,
        )]);
        assert_eq!(
            dh(&apply_review(&base, &base, &incoming, &choices).unwrap()),
            dh(&base)
        );
    }

    fn identified_fixture() -> Document {
        let mut document = fixture();
        for (index, paragraph) in document.sections[0].paragraphs.iter_mut().enumerate() {
            paragraph.raw_header_extra = vec![0; 10];
            paragraph.raw_header_extra[6..10].copy_from_slice(&(index as u32 + 1).to_le_bytes());
            paragraph.text = format!("paragraph {index}");
        }
        document
    }

    #[test]
    fn review_insert_delete_and_text_are_independently_selectable() {
        let base = identified_fixture();
        let mut current = base.clone();
        current.sections[0].paragraphs[0].text = "local".into();
        let mut incoming = base.clone();
        let mut inserted = incoming.sections[0].paragraphs[0].clone();
        inserted.raw_header_extra[6..10].copy_from_slice(&4_u32.to_le_bytes());
        inserted.text = "inserted".into();
        incoming.sections[0].paragraphs.insert(1, inserted);
        incoming.sections[0].paragraphs[2].text = "incoming".into();
        incoming.sections[0].paragraphs.pop();
        let (_, analysis, _) = review_documents(&base, &current, &incoming).unwrap();
        assert_eq!(analysis.analysis_version, 3);
        assert_eq!(analysis.conflicts.len(), 3);
        for mask in 0..8 {
            let choices = analysis
                .conflicts
                .iter()
                .enumerate()
                .map(|(index, unit)| {
                    (
                        unit.value.id.clone(),
                        if mask & (1 << index) != 0 {
                            MergeResolution::Incoming
                        } else {
                            MergeResolution::Current
                        },
                    )
                })
                .collect();
            let output = apply_review(&base, &current, &incoming, &choices).unwrap();
            let mut expected = vec!["local"];
            if mask & 1 != 0 {
                expected.push("inserted");
            }
            expected.push(if mask & 2 != 0 {
                "incoming"
            } else {
                "paragraph 1"
            });
            if mask & 4 == 0 {
                expected.push("paragraph 2");
            }
            for bytes in [
                serialize_hwp(&output).unwrap(),
                serialize_hwpx(&output).unwrap(),
            ] {
                let loaded = parse_regenerated_document(&bytes).unwrap();
                validate_resource_dependencies(&loaded).unwrap();
                assert_eq!(paragraph_texts(&loaded), expected, "selection {mask}");
            }
        }
    }

    #[test]
    fn review_image_dependencies_do_not_capture_unrelated_text() {
        use crate::model::bin_data::{BinData, BinDataType};
        let mut base = identified_fixture();
        let original = parse_document(include_bytes!("../../saved/blank2010.hwp")).unwrap();
        base.sections[0].paragraphs[0].controls =
            original.sections[0].paragraphs[0].controls.clone();
        base.sections[0].paragraphs[0].ctrl_data_records =
            original.sections[0].paragraphs[0].ctrl_data_records.clone();
        let mut current = base.clone();
        current.sections[0].paragraphs[0].text = "local".into();
        current.sections[0].paragraphs[2].text = "local choice".into();
        let mut incoming = base.clone();
        incoming.sections[0].paragraphs[2].text = "incoming".into();
        incoming.doc_info.bin_data_list.push(BinData {
            attr: 1,
            data_type: BinDataType::Embedding,
            storage_id: 1,
            extension: Some("png".into()),
            ..Default::default()
        });
        incoming.doc_info.raw_stream = None;
        incoming.bin_data_content.push(BinDataContent {
            id: 1,
            data: BinDataBytes::from(
                include_bytes!("../../rhwp-chrome/icons/icon-16.png").to_vec(),
            ),
            extension: "png".into(),
        });
        let mut inserted = incoming.sections[0].paragraphs[0].clone();
        inserted.raw_header_extra[6..10].copy_from_slice(&4_u32.to_le_bytes());
        inserted.text.clear();
        inserted.controls.clear();
        inserted.ctrl_data_records.clear();
        let mut picture = Picture::default();
        picture.image_attr.bin_data_id = 1;
        picture.common.width = 1000;
        picture.common.height = 1000;
        inserted
            .controls
            .push(Control::Picture(Box::new(picture.clone())));
        inserted.ctrl_data_records.push(None);
        incoming.sections[0].paragraphs.insert(1, inserted);
        // Both sides allocated slot 1. Selected incoming paragraphs must use
        // the merger's rewritten slot while the local image stays unchanged.
        current.doc_info.bin_data_list = incoming.doc_info.bin_data_list.clone();
        current.doc_info.raw_stream = None;
        current.bin_data_content.push(BinDataContent {
            id: 1,
            data: BinDataBytes::from(
                include_bytes!("../../rhwp-chrome/icons/icon-32.png").to_vec(),
            ),
            extension: "png".into(),
        });
        current.sections[0].paragraphs[0]
            .controls
            .push(Control::Picture(Box::new(picture)));
        current.sections[0].paragraphs[0]
            .ctrl_data_records
            .push(None);
        let (_, analysis, _) = review_documents(&base, &current, &incoming).unwrap();
        assert_eq!(
            analysis.conflicts.len(),
            2,
            "{:?}",
            analysis
                .conflicts
                .iter()
                .map(|unit| &unit.value.path)
                .collect::<Vec<_>>()
        );
        assert!(analysis.conflicts[1]
            .dependency_ids
            .iter()
            .any(|id| id.starts_with("resources:")));
        assert!(!analysis.conflicts[0].automatic);
        assert!(analysis.conflicts[1].automatic);
        for mask in 0..4 {
            let choices = analysis
                .conflicts
                .iter()
                .enumerate()
                .map(|(index, unit)| {
                    (
                        unit.value.id.clone(),
                        if mask & (1 << index) != 0 {
                            MergeResolution::Incoming
                        } else {
                            MergeResolution::Current
                        },
                    )
                })
                .collect();
            let output = apply_review(&base, &current, &incoming, &choices).unwrap();
            for bytes in [
                serialize_hwp(&output).unwrap(),
                serialize_hwpx(&output).unwrap(),
            ] {
                let loaded = parse_regenerated_document(&bytes).unwrap();
                validate_resource_dependencies(&loaded).unwrap();
                assert_eq!(counts(&loaded), counts(&output));
                assert_eq!(loaded.sections[0].paragraphs[0].text, "local");
                assert_eq!(
                    loaded.sections[0].paragraphs.last().unwrap().text,
                    if mask & 1 != 0 {
                        "incoming"
                    } else {
                        "local choice"
                    }
                );
                assert_eq!(
                    loaded.bin_data_content.len(),
                    1 + usize::from(mask & 2 != 0)
                );
                assert_eq!(
                    loaded.sections[0].paragraphs.len(),
                    if mask & 2 != 0 { 4 } else { 3 }
                );
            }
        }
        let mut shared = incoming.clone();
        let image_paragraph = shared.sections[0].paragraphs.remove(1);
        shared.sections[0].paragraphs[0]
            .controls
            .extend(image_paragraph.controls);
        shared.sections[0].paragraphs[0]
            .ctrl_data_records
            .extend(image_paragraph.ctrl_data_records);
        let (_, shared_analysis, _) = review_documents(&base, &current, &shared).unwrap();
        assert_eq!(
            shared_analysis.conflicts.len(),
            2,
            "an image can share unchanged section controls"
        );
        let image_choice = BTreeMap::from([(
            shared_analysis.conflicts[1].value.id.clone(),
            MergeResolution::Incoming,
        )]);
        let shared_output = apply_review(&base, &current, &shared, &image_choice).unwrap();
        assert_eq!(shared_output.sections[0].paragraphs[0].text, "local");
        assert_eq!(shared_output.sections[0].paragraphs[2].text, "local choice");
        assert_eq!(shared_output.bin_data_content.len(), 2);

        let before = &analysis.conflicts[1].value.fingerprint;
        incoming.bin_data_content[0].data = BinDataBytes::from(vec![1, 2, 3]);
        let (_, changed, _) = review_documents(&base, &current, &incoming).unwrap();
        assert_ne!(before, &changed.conflicts[1].value.fingerprint);
        incoming.sections[0].paragraphs[1].ctrl_data_records[0] = Some(vec![1, 2, 3]);
        let (_, opaque, targets) = review_documents(&base, &current, &incoming).unwrap();
        assert_eq!(opaque.conflicts.len(), 1);
        assert!(matches!(targets.as_slice(), [Target::Document]));
    }

    #[test]
    fn review_fresh_manifest_identities_preserve_image_and_text_choices() {
        use crate::model::bin_data::{BinData, BinDataType};
        let mut base = parse_document(include_bytes!("../../saved/blank2010.hwp")).unwrap();
        let mut paragraph = base.sections[0].paragraphs[0].clone();
        paragraph.raw_header_extra.resize(12, 0);
        paragraph.raw_header_extra[6..10].fill(0);
        paragraph.text = "IMAGE ANCHOR".into();
        base.sections[0].paragraphs = vec![paragraph.clone(), paragraph];
        base.sections[0].paragraphs[1].text = "BASE TEXT".into();
        base.sections[0].raw_stream = None;
        let mut current = base.clone();
        current.sections[0].paragraphs[1].text = "LOCAL BASE TEXT".into();
        let mut incoming = base.clone();
        incoming.sections[0].paragraphs[1].text = "REMOTE BASE TEXT".into();
        incoming.doc_info.bin_data_list.push(BinData {
            attr: 1,
            data_type: BinDataType::Embedding,
            storage_id: 1,
            extension: Some("png".into()),
            ..Default::default()
        });
        incoming.doc_info.raw_stream = None;
        incoming.bin_data_content.push(BinDataContent {
            id: 1,
            data: BinDataBytes::from(
                include_bytes!("../../rhwp-chrome/icons/icon-16.png").to_vec(),
            ),
            extension: "png".into(),
        });
        let mut picture = Picture::default();
        picture.image_attr.bin_data_id = 1;
        picture.common.width = 1000;
        picture.common.height = 1000;
        incoming.sections[0].paragraphs[0]
            .controls
            .push(Control::Picture(Box::new(picture)));
        incoming.sections[0].paragraphs[0]
            .ctrl_data_records
            .push(None);
        let manifest = |commit: &str| -> ManifestHints {
            serde_json::from_value(json!({
                "entries": (0..2).map(|index| json!({
                    "identity": format!("node:{commit}:paragraph:sections/0/paragraphs/{index}"),
                    "kind": "paragraph",
                    "path": ["sections", "0", "paragraphs", &index.to_string()]
                })).collect::<Vec<_>>()
            }))
            .unwrap()
        };
        for format in [FileFormat::Hwp, FileFormat::Hwpx] {
            let serialize = |document: &Document| match format {
                FileFormat::Hwp => serialize_hwp(document).unwrap(),
                _ => serialize_hwpx(document).unwrap(),
            };
            let (b, c, i, restore) = manifest_documents(
                &serialize(&base),
                &serialize(&current),
                &serialize(&incoming),
                &manifest("base"),
                &manifest("base"),
                &manifest("incoming"),
            )
            .unwrap();
            let (_, analysis, _) = review_documents(&b, &c, &i).unwrap();
            assert_eq!(analysis.conflicts.len(), 2, "{format:?}");
            assert!(analysis.conflicts.iter().any(|unit| !unit.automatic));
            // A section change forces the whole-document path. Exporting its
            // lazy image must preserve both atomic and paragraph-group IDs.
            let mut atomic_incoming = i.clone();
            atomic_incoming.sections[0].section_def.page_num += 1;
            let (_, atomic, targets) = review_documents(&b, &c, &atomic_incoming).unwrap();
            assert!(matches!(targets.as_slice(), [Target::Document]));
            let atomic_choices = BTreeMap::from([(
                atomic.conflicts[0].value.id.clone(),
                MergeResolution::Incoming,
            )]);
            let atomic_output = apply_review(&b, &c, &atomic_incoming, &atomic_choices).unwrap();
            let _ = serialize(&atomic_output);
            let (_, reloaded, _) = review_documents(&b, &c, &atomic_incoming).unwrap();
            assert_eq!(atomic.conflicts[0].value.id, reloaded.conflicts[0].value.id);
            assert_eq!(
                apply_review(&b, &c, &atomic_incoming, &atomic_choices)
                    .unwrap()
                    .bin_data_content
                    .len(),
                1
            );
            for mask in 0..4 {
                let choices = analysis
                    .conflicts
                    .iter()
                    .map(|unit| {
                        let position = unit.position.as_ref().unwrap().paragraph;
                        (
                            unit.value.id.clone(),
                            if mask & (1 << position) != 0 {
                                MergeResolution::Incoming
                            } else {
                                MergeResolution::Current
                            },
                        )
                    })
                    .collect();
                let mut output = apply_review(&b, &c, &i, &choices).unwrap();
                restore_manifest_ids(&mut output, &restore);
                let loaded = parse_regenerated_document(&serialize(&output)).unwrap();
                validate_resource_dependencies(&loaded).unwrap();
                assert_eq!(loaded.sections[0].paragraphs.len(), 2);
                assert_eq!(loaded.sections[0].paragraphs[0].text, "IMAGE ANCHOR");
                assert_eq!(
                    loaded.sections[0].paragraphs[1].text,
                    if mask & 2 != 0 {
                        "REMOTE BASE TEXT"
                    } else {
                        "LOCAL BASE TEXT"
                    }
                );
                assert_eq!(
                    loaded.bin_data_content.len(),
                    usize::from(mask & 1 != 0),
                    "{format:?}, selection {mask}"
                );
                assert_eq!(counts(&loaded), counts(&output));
            }
        }
    }

    #[test]
    fn review_mixed_choices_and_manual_text_reload_in_both_formats() {
        let base = fixture();
        let mut incoming = base.clone();
        incoming.sections[0].paragraphs[1].text = "cloud one".into();
        incoming.sections[0].paragraphs[2].text = "cloud two".into();
        let (_, analysis, _) = review_documents(&base, &base, &incoming).unwrap();
        assert_eq!(analysis.conflicts.len(), 2);
        for mask in 0..4 {
            let choices = analysis
                .conflicts
                .iter()
                .enumerate()
                .map(|(n, unit)| {
                    (
                        unit.value.id.clone(),
                        if mask & (1 << n) != 0 {
                            MergeResolution::Incoming
                        } else {
                            MergeResolution::Current
                        },
                    )
                })
                .collect();
            let output = apply_review(&base, &base, &incoming, &choices).unwrap();
            for bytes in [
                serialize_hwp(&output).unwrap(),
                serialize_hwpx(&output).unwrap(),
            ] {
                let loaded = parse_regenerated_document(&bytes).unwrap();
                validate_resource_dependencies(&loaded).unwrap();
                for n in 0..2 {
                    assert_eq!(
                        loaded.sections[0].paragraphs[n + 1].text,
                        if mask & (1 << n) != 0 {
                            incoming.sections[0].paragraphs[n + 1].text.as_str()
                        } else {
                            "first"
                        }
                    );
                }
            }
        }
        let choices = analysis
            .conflicts
            .iter()
            .map(|unit| {
                (
                    unit.value.id.clone(),
                    MergeResolution::Manual {
                        payload: json!("직접 수정"),
                    },
                )
            })
            .collect();
        let output = apply_review(&base, &base, &incoming, &choices).unwrap();
        assert_eq!(output.sections[0].paragraphs[1].text, "직접 수정");
        assert_eq!(output.sections[0].paragraphs[2].text, "직접 수정");
    }

    fn form002_edited_bytes() -> (Vec<u8>, Vec<u8>, Vec<u8>) {
        let bytes = std::fs::read("samples/hwpx/form-002.hwpx").expect("form-002.hwpx");
        let mut current = crate::wasm_api::HwpDocument::from_bytes(&bytes).expect("current");
        current
            .insert_text_native(0, 0, 0, "UNSAVED_CLOUD_HANDOFF ")
            .expect("handoff");
        current
            .insert_text_native(0, 0, 0, "LOCAL_DURING_CLOUD ")
            .expect("local");
        let current_bytes = current.export_hwpx_native().expect("export current");
        let mut incoming = crate::wasm_api::HwpDocument::from_bytes(&bytes).expect("incoming");
        incoming
            .insert_text_native(0, 0, 0, "UNSAVED_CLOUD_HANDOFF ")
            .expect("incoming handoff");
        let length = incoming
            .get_paragraph_length_native(0, 0)
            .expect("paragraph length");
        incoming
            .insert_text_native(0, 0, length, " CLOUD_FINISHED")
            .expect("cloud");
        let incoming_bytes = incoming.export_hwpx_native().expect("export incoming");
        (bytes, current_bytes, incoming_bytes)
    }

    fn form002_cloud_workspace_bytes() -> (Vec<u8>, Vec<u8>, Vec<u8>) {
        let bytes = std::fs::read("samples/hwpx/form-002.hwpx").expect("form-002.hwpx");
        let mut current = crate::wasm_api::HwpDocument::from_bytes(&bytes).expect("current");
        current
            .insert_text_native(0, 0, 0, "UNSAVED_CLOUD_HANDOFF ")
            .expect("handoff");
        current
            .insert_text_native(0, 1, 0, "LOCAL_DURING_CLOUD ")
            .expect("local");
        let current_bytes = current.export_hwpx_native().expect("export current");
        let mut incoming = crate::wasm_api::HwpDocument::from_bytes(&bytes).expect("incoming");
        incoming
            .insert_text_native(0, 0, 0, "UNSAVED_CLOUD_HANDOFF ")
            .expect("incoming handoff");
        let length = incoming
            .get_paragraph_length_native(0, 0)
            .expect("paragraph length");
        incoming
            .insert_text_native(0, 0, length, " CLOUD_FINISHED")
            .expect("cloud");
        let incoming_bytes = incoming.export_hwpx_native().expect("export incoming");
        (bytes, current_bytes, incoming_bytes)
    }

    fn paragraph_texts(document: &Document) -> Vec<String> {
        document
            .sections
            .first()
            .map(|section| {
                section
                    .paragraphs
                    .iter()
                    .map(|para| para.text.clone())
                    .collect()
            })
            .unwrap_or_default()
    }

    #[test]
    fn form002_review_materialize_roundtrips_inserted_text() {
        let (base_bytes, current_bytes, incoming_bytes) = form002_edited_bytes();
        let base = parse(&base_bytes, "base").expect("parse base");
        let current = parse(&current_bytes, "current").expect("parse current");
        let incoming = parse(&incoming_bytes, "incoming").expect("parse incoming");
        validate_resource_dependencies(&base).expect("base resources");
        validate_resource_dependencies(&current).expect("current resources");
        validate_resource_dependencies(&incoming).expect("incoming resources");
        let (_, analysis, _) =
            review_documents(&base, &current, &incoming).expect("review analysis");
        let reject = analysis
            .conflicts
            .iter()
            .map(|unit| (unit.value.id.clone(), MergeResolution::Current))
            .collect();
        let output = apply_review(&base, &current, &incoming, &reject)
            .unwrap_or_else(|error| panic!("all-current review materialize: {error}"));
        let serialized =
            serialize_hwpx(&output).unwrap_or_else(|error| panic!("serialize: {error}"));
        let loaded = parse_regenerated_document(&serialized)
            .unwrap_or_else(|error| panic!("reload: {error}"));
        validate_resource_dependencies(&loaded)
            .unwrap_or_else(|error| panic!("reloaded resources: {error}"));
        assert_eq!(
            counts(&loaded),
            counts(&output),
            "review result failed structural validation"
        );
        let accept = analysis
            .conflicts
            .iter()
            .map(|unit| (unit.value.id.clone(), MergeResolution::Incoming))
            .collect();
        apply_review(&base, &current, &incoming, &accept)
            .unwrap_or_else(|error| panic!("all-incoming review materialize: {error}"));
    }

    #[test]
    fn form002_disjoint_paragraph_edits_keep_local_and_cloud_text() {
        let (base_bytes, current_bytes, incoming_bytes) = form002_cloud_workspace_bytes();
        let base = parse(&base_bytes, "base").expect("parse base");
        let current = parse(&current_bytes, "current").expect("parse current");
        let incoming = parse(&incoming_bytes, "incoming").expect("parse incoming");
        let joined = |document: &Document| paragraph_texts(document).join("\n");
        let (_, analysis, _) =
            review_documents(&base, &current, &incoming).expect("review analysis");
        assert!(
            analysis
                .conflicts
                .iter()
                .all(|unit| unit.position.is_some()),
            "text-only Cloud edits collapsed to document-wide review: {:?}",
            analysis
                .conflicts
                .iter()
                .map(|unit| (
                    &unit.value.path,
                    &unit.value.kind,
                    unit.position
                        .as_ref()
                        .map(|pos| (pos.section, pos.paragraph))
                ))
                .collect::<Vec<_>>()
        );
        let mut choices = analysis
            .conflicts
            .iter()
            .map(|unit| (unit.value.id.clone(), MergeResolution::Current))
            .collect::<BTreeMap<_, _>>();
        for unit in &analysis.conflicts {
            let incoming_text = value_text(&unit.value.incoming).unwrap_or("");
            if incoming_text.contains("CLOUD_FINISHED") {
                choices.insert(
                    unit.value.id.clone(),
                    if unit.value.supports_both {
                        MergeResolution::Both {
                            order: "current-first".into(),
                        }
                    } else {
                        MergeResolution::Incoming
                    },
                );
            }
        }
        let output = apply_review(&base, &current, &incoming, &choices)
            .unwrap_or_else(|error| panic!("mixed review: {error}"));
        let merged = joined(&output);
        assert!(
            merged.contains("LOCAL_DURING_CLOUD"),
            "missing local text: {merged}"
        );
        assert!(
            merged.contains("CLOUD_FINISHED"),
            "missing cloud text: {merged}; {}",
            serde_json::to_string(&analysis).unwrap()
        );
        assert!(
            merged.contains("UNSAVED_CLOUD_HANDOFF"),
            "missing handoff text: {merged}"
        );
        let cloud_unit = analysis
            .conflicts
            .iter()
            .find(|unit| {
                value_text(&unit.value.incoming).is_some_and(|text| text.contains("CLOUD_FINISHED"))
            })
            .expect("Cloud paragraph review unit");
        assert!(current.sections[0].paragraphs[0]
            .controls
            .iter()
            .any(|control| matches!(control, Control::Table(_))));
        assert!(
            !cloud_unit.value.supports_both && !cloud_unit.value.supports_manual,
            "table-bearing paragraphs require an atomic current/incoming choice"
        );
        for selected in [&current, &output] {
            let loaded = parse_regenerated_document(&serialize_hwpx(selected).unwrap()).unwrap();
            validate_resource_dependencies(&loaded).unwrap();
            assert_eq!(counts(&loaded), counts(selected));
            assert_eq!(paragraph_texts(&loaded), paragraph_texts(selected));
        }
        let all_both = analysis
            .conflicts
            .iter()
            .map(|unit| {
                (
                    unit.value.id.clone(),
                    if unit.value.supports_both {
                        MergeResolution::Both {
                            order: "current-first".into(),
                        }
                    } else {
                        MergeResolution::Incoming
                    },
                )
            })
            .collect();
        let both_output = apply_review(&base, &current, &incoming, &all_both)
            .unwrap_or_else(|error| panic!("all-both review: {error}"));
        let both_merged = joined(&both_output);
        assert!(
            both_merged.contains("CLOUD_FINISHED"),
            "all-both missing cloud text: {both_merged}"
        );
        let by_fingerprint = analysis
            .conflicts
            .iter()
            .map(|unit| {
                (
                    unit.value.fingerprint.clone(),
                    choices
                        .get(&unit.value.id)
                        .cloned()
                        .unwrap_or(MergeResolution::Current),
                )
            })
            .collect();
        let fingerprint_output = apply_review(&base, &current, &incoming, &by_fingerprint)
            .unwrap_or_else(|error| panic!("fingerprint choices: {error}"));
        let fingerprint_merged = joined(&fingerprint_output);
        assert!(
            fingerprint_merged.contains("CLOUD_FINISHED"),
            "fingerprint choices missing cloud text: {fingerprint_merged}"
        );
        assert!(
            fingerprint_merged.contains("LOCAL_DURING_CLOUD"),
            "fingerprint choices missing local text: {fingerprint_merged}"
        );
        let by_position = analysis
            .conflicts
            .iter()
            .filter_map(|unit| {
                Some((
                    review_position_key(unit.position.as_ref()?),
                    choices
                        .get(&unit.value.id)
                        .cloned()
                        .unwrap_or(MergeResolution::Current),
                ))
            })
            .collect();
        let position_output = apply_review(&base, &current, &incoming, &by_position)
            .unwrap_or_else(|error| panic!("position choices: {error}"));
        let position_merged = joined(&position_output);
        assert!(
            position_merged.contains("CLOUD_FINISHED"),
            "position choices missing cloud text: {position_merged}"
        );
        assert!(
            position_merged.contains("LOCAL_DURING_CLOUD"),
            "position choices missing local text: {position_merged}"
        );
    }

    #[test]
    fn review_paragraph_both_keeps_prefix_and_suffix() {
        let base = fixture();
        let mut current = base.clone();
        current.sections[0].paragraphs[0].text = format!(
            "LOCAL_DURING_CLOUD {}",
            current.sections[0].paragraphs[0].text
        );
        let mut incoming = base.clone();
        incoming.sections[0].paragraphs[0].text =
            format!("{} CLOUD_FINISHED", incoming.sections[0].paragraphs[0].text);
        let (_, analysis, _) = review_documents(&base, &current, &incoming).unwrap();
        let paragraph = analysis
            .conflicts
            .iter()
            .find(|unit| {
                unit.position
                    == Some(ReviewPosition {
                        section: 0,
                        paragraph: 0,
                    })
            })
            .expect("paragraph 0 review unit");
        assert!(paragraph.value.supports_both);
        let mut choices = analysis
            .conflicts
            .iter()
            .map(|unit| (unit.value.id.clone(), MergeResolution::Current))
            .collect::<BTreeMap<_, _>>();
        choices.insert(
            paragraph.value.id.clone(),
            MergeResolution::Both {
                order: "current-first".into(),
            },
        );
        let output = apply_review(&base, &current, &incoming, &choices).unwrap();
        assert!(
            output.sections[0].paragraphs[0]
                .text
                .contains("LOCAL_DURING_CLOUD"),
            "{}",
            output.sections[0].paragraphs[0].text
        );
        assert!(
            output.sections[0].paragraphs[0]
                .text
                .contains("CLOUD_FINISHED"),
            "{}",
            output.sections[0].paragraphs[0].text
        );
    }
}
