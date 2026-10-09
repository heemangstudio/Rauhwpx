use super::*;
use crate::model::document::*;
use crate::model::paragraph::{LineSeg, Paragraph};
use crate::model::style::*;
use crate::parser::cfb_reader::decompress_stream;

#[test]
fn test_compress_decompress_roundtrip() {
    let original = b"Hello, HWP World! Test data for compression roundtrip.";
    let compressed = compress_stream(original).unwrap();
    let decompressed = decompress_stream(&compressed).unwrap();
    assert_eq!(decompressed, original);
}

#[test]
fn test_compress_empty_data() {
    let original = b"";
    let compressed = compress_stream(original).unwrap();
    let decompressed = decompress_stream(&compressed).unwrap();
    assert_eq!(decompressed, original);
}

#[test]
fn bounded_compression_rejects_incompressible_output_at_the_sink() {
    // Xorshift bytes are deterministic but do not collapse into a tiny deflate
    // stream. The destination writer errors as soon as zlib tries to cross the
    // 64-byte limit; it never grows a complete encoded copy first.
    let mut state = 0x1234_5678u32;
    let data = (0..16 * 1024)
        .map(|_| {
            state ^= state << 13;
            state ^= state >> 17;
            state ^= state << 5;
            state as u8
        })
        .collect::<Vec<_>>();
    let error = compress_stream_limited(&data, 64)
        .expect_err("incompressible output must stop at the bounded sink");
    assert!(error.to_string().contains("byte limit"), "{error}");
}

#[test]
fn raw_structural_streams_are_checked_before_copying() {
    let section = Section {
        raw_stream: Some(vec![0x5a; 65]),
        raw_provenance: None,
        ..Default::default()
    };
    let error = crate::serializer::body_text::serialize_section_limited(&section, 64)
        .expect_err("oversized raw section must fail before cloning");
    assert!(error.contains("65 > 64"), "{error}");

    let borrowed = crate::serializer::body_text::serialize_section_limited(&section, 65)
        .expect("exact raw-section limit");
    assert!(matches!(borrowed, std::borrow::Cow::Borrowed(_)));

    let doc_info = DocInfo {
        raw_stream: Some(vec![0x7b; 65]),
        raw_stream_dirty: false,
        ..Default::default()
    };
    let error = crate::serializer::doc_info::serialize_doc_info_limited(
        &doc_info,
        &DocProperties::default(),
        64,
    )
    .expect_err("oversized raw DocInfo must fail before cloning");
    assert!(error.contains("65 > 64"), "{error}");
}

#[test]
fn generated_preview_stops_at_the_character_limit() {
    let doc = Document {
        sections: vec![Section {
            paragraphs: vec![Paragraph {
                text: "가".repeat(100_000),
                ..Default::default()
            }],
            ..Default::default()
        }],
        ..Default::default()
    };
    let preview = build_preview_text(&doc);
    assert_eq!(preview.chars().count(), 1_000);
    assert_eq!(preview.len(), 3_000);
}

#[test]
fn test_serialize_hwp_empty_document() {
    let doc = Document::default();
    let bytes = serialize_hwp(&doc).unwrap();
    // CFB 시그니처 확인 (0xD0CF11E0A1B11AE1)
    assert!(bytes.len() > 512);
    assert_eq!(&bytes[0..4], &[0xD0, 0xCF, 0x11, 0xE0]);
}

#[test]
fn extra_preview_replaces_fallback_without_duplicate_directory_entry() {
    let expected = vec![0x41, 0x00, 0x42, 0x00];
    let doc = Document {
        preview: Some(Preview {
            image: None,
            text: Some("fallback".to_string()),
        }),
        extra_streams: vec![("/PrvText".to_string(), expected.clone())],
        ..Default::default()
    };
    let bytes = serialize_hwp(&doc).expect("preview overlay should serialize");
    let mut cfb = crate::parser::cfb_reader::CfbReader::open(&bytes).expect("strict CFB open");
    assert_eq!(cfb.read_stream_raw("/PrvText").unwrap(), expected);
}

#[test]
fn extra_stream_cannot_shadow_generated_core_stream() {
    let doc = Document {
        extra_streams: vec![("/DocInfo".to_string(), b"corrupt".to_vec())],
        ..Default::default()
    };
    let error = serialize_hwp(&doc).expect_err("core stream collision must fail closed");
    assert!(error
        .to_string()
        .contains("conflicts with generated HWP stream"));
}

#[test]
fn failed_lazy_bindata_materialization_preserves_the_original_cfb_stream() {
    #[derive(Debug)]
    struct RawFallback(Vec<u8>);

    impl crate::model::bin_data::BinDataResolver for RawFallback {
        fn resolve(&self, _key: &str) -> Vec<u8> {
            Vec::new()
        }

        fn resolve_limited(&self, _key: &str, _max_bytes: usize) -> Option<Vec<u8>> {
            None
        }

        fn resolve_original_stream_limited(
            &self,
            _key: &str,
            _expected_encoding: crate::model::bin_data::BinDataStreamEncoding,
            max_bytes: usize,
        ) -> Option<Vec<u8>> {
            (self.0.len() <= max_bytes).then(|| self.0.clone())
        }
    }

    let original = vec![0x78, 0x9c, 0x01, 0x02, 0x03];
    let mut bin_data = crate::model::bin_data::BinData::default();
    bin_data.data_type = crate::model::bin_data::BinDataType::Embedding;
    bin_data.storage_id = 1;
    bin_data.extension = Some("dat".to_string());
    let doc = Document {
        doc_info: DocInfo {
            bin_data_list: vec![bin_data],
            ..Default::default()
        },
        bin_data_content: vec![BinDataContent {
            id: 1,
            data: crate::model::bin_data::BinDataBytes::lazy(
                std::sync::Arc::new(RawFallback(original.clone())),
                "BIN0001.dat".to_string(),
            ),
            extension: "dat".to_string(),
        }],
        ..Default::default()
    };

    let bytes = serialize_hwp(&doc).expect("raw BinData fallback must serialize");
    let mut cfb = crate::parser::cfb_reader::CfbReader::open(&bytes).expect("strict CFB open");
    assert_eq!(cfb.read_bin_data("BIN0001.dat").unwrap(), original);
}

#[test]
fn raw_bindata_fallback_is_limited_to_the_remaining_encoded_budget() {
    #[derive(Debug)]
    struct BudgetProbe {
        decoded_limit: std::sync::atomic::AtomicUsize,
        raw_limit: std::sync::atomic::AtomicUsize,
    }

    impl crate::model::bin_data::BinDataResolver for BudgetProbe {
        fn resolve(&self, _key: &str) -> Vec<u8> {
            unreachable!("bounded serializer path must be used")
        }

        fn resolve_limited(&self, _key: &str, max_bytes: usize) -> Option<Vec<u8>> {
            self.decoded_limit
                .store(max_bytes, std::sync::atomic::Ordering::SeqCst);
            None
        }

        fn resolve_original_stream_limited(
            &self,
            _key: &str,
            _expected_encoding: crate::model::bin_data::BinDataStreamEncoding,
            max_bytes: usize,
        ) -> Option<Vec<u8>> {
            self.raw_limit
                .store(max_bytes, std::sync::atomic::Ordering::SeqCst);
            (6 <= max_bytes).then(|| vec![0; 6])
        }
    }

    let resolver = std::sync::Arc::new(BudgetProbe {
        decoded_limit: std::sync::atomic::AtomicUsize::new(0),
        raw_limit: std::sync::atomic::AtomicUsize::new(0),
    });
    let mut bin_data = crate::model::bin_data::BinData::default();
    bin_data.data_type = crate::model::bin_data::BinDataType::Embedding;
    bin_data.storage_id = 1;
    bin_data.extension = Some("dat".to_string());
    let content = BinDataContent {
        id: 1,
        data: crate::model::bin_data::BinDataBytes::lazy(
            resolver.clone(),
            "BIN0001.dat".to_string(),
        ),
        extension: "dat".to_string(),
    };

    let error = write_hwp_cfb_with_stream_budget(
        b"123",
        b"45",
        &[],
        &[bin_data],
        &[content],
        &None,
        &[],
        false,
        10,
    )
    .expect_err("raw fallback larger than the remaining five bytes must fail closed");

    assert!(error
        .to_string()
        .contains("could not be materialized safely"));
    assert_eq!(
        resolver
            .decoded_limit
            .load(std::sync::atomic::Ordering::SeqCst),
        5
    );
    assert_eq!(
        resolver.raw_limit.load(std::sync::atomic::Ordering::SeqCst),
        5
    );
}

#[test]
fn compressed_lazy_fallbacks_charge_their_aggregate_decoded_size() {
    #[derive(Debug)]
    struct CompressedFallback {
        encoded: Vec<u8>,
        raw_reads: std::sync::atomic::AtomicUsize,
    }

    impl crate::model::bin_data::BinDataResolver for CompressedFallback {
        fn resolve(&self, _key: &str) -> Vec<u8> {
            unreachable!("bounded serializer path must be used")
        }

        fn resolve_limited(&self, _key: &str, _max_bytes: usize) -> Option<Vec<u8>> {
            None
        }

        fn resolve_original_stream_limited(
            &self,
            _key: &str,
            expected: crate::model::bin_data::BinDataStreamEncoding,
            max_bytes: usize,
        ) -> Option<Vec<u8>> {
            assert!(expected.compressed);
            self.raw_reads
                .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            (self.encoded.len() <= max_bytes).then(|| self.encoded.clone())
        }
    }

    let decoded = vec![0x41; 12 * 1024];
    let resolver = std::sync::Arc::new(CompressedFallback {
        encoded: compress_stream(&decoded).expect("raw deflate fixture"),
        raw_reads: std::sync::atomic::AtomicUsize::new(0),
    });
    let mut bin_data_list = Vec::new();
    let mut bin_data_content = Vec::new();
    for id in 1..=2u16 {
        let mut bin_data = crate::model::bin_data::BinData::default();
        bin_data.data_type = crate::model::bin_data::BinDataType::Embedding;
        bin_data.compression = crate::model::bin_data::BinDataCompression::Compress;
        bin_data.storage_id = id;
        bin_data.extension = Some("dat".to_string());
        bin_data_list.push(bin_data);
        bin_data_content.push(BinDataContent {
            id,
            data: crate::model::bin_data::BinDataBytes::lazy(
                resolver.clone(),
                format!("BIN{id:04X}.dat"),
            ),
            extension: "dat".to_string(),
        });
    }
    let doc = Document {
        doc_info: DocInfo {
            bin_data_list,
            ..Default::default()
        },
        bin_data_content,
        ..Default::default()
    };
    let structural_bytes = serialize_file_header(&doc.header).len()
        + serialize_doc_info(&doc.doc_info, &doc.doc_properties).len();
    let error = serialize_hwp_with_limits(
        &doc,
        HwpWriteLimits {
            max_structural_member_bytes: crate::parser::limits::MAX_STRUCTURAL_BYTES,
            // The first decoded stream fits; the second is one byte over the
            // aggregate budget. Charging encoded lengths would incorrectly
            // permit both highly compressible streams.
            max_expanded_bytes: (structural_bytes + decoded.len() * 2 - 1) as u64,
            max_encoded_bytes: 1024 * 1024,
            max_output_bytes: 1024 * 1024,
        },
    )
    .expect_err("aggregate decoded BinData budget must fail closed");

    assert!(
        error
            .to_string()
            .contains("expanded BinData stream exceeds remaining byte budget"),
        "{error}"
    );
    assert_eq!(
        resolver.raw_reads.load(std::sync::atomic::Ordering::SeqCst),
        2
    );
}

#[test]
fn duplicate_lazy_bindata_paths_fail_before_any_materialization() {
    #[derive(Debug)]
    struct CountingResolver(std::sync::atomic::AtomicUsize);

    impl crate::model::bin_data::BinDataResolver for CountingResolver {
        fn resolve(&self, _key: &str) -> Vec<u8> {
            unreachable!("bounded serializer path must be used")
        }

        fn resolve_limited(&self, _key: &str, _max_bytes: usize) -> Option<Vec<u8>> {
            self.0.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            Some(vec![1, 2, 3])
        }
    }

    let resolver = std::sync::Arc::new(CountingResolver(std::sync::atomic::AtomicUsize::new(0)));
    let mut bin_data = crate::model::bin_data::BinData::default();
    bin_data.data_type = crate::model::bin_data::BinDataType::Embedding;
    bin_data.storage_id = 1;
    bin_data.extension = Some("dat".to_string());
    let lazy = || BinDataContent {
        id: 1,
        data: crate::model::bin_data::BinDataBytes::lazy(
            resolver.clone(),
            "BIN0001.dat".to_string(),
        ),
        extension: "dat".to_string(),
    };
    let doc = Document {
        doc_info: DocInfo {
            bin_data_list: vec![bin_data],
            ..Default::default()
        },
        bin_data_content: vec![lazy(), lazy()],
        ..Default::default()
    };

    let error = serialize_hwp(&doc).expect_err("duplicate paths must fail before multiplying data");
    assert!(error
        .to_string()
        .contains("duplicate generated BinData stream"));
    assert_eq!(resolver.0.load(std::sync::atomic::Ordering::SeqCst), 0);
}

#[test]
fn invalid_bindata_path_fails_before_lazy_materialization() {
    #[derive(Debug)]
    struct CountingResolver(std::sync::atomic::AtomicUsize);

    impl crate::model::bin_data::BinDataResolver for CountingResolver {
        fn resolve(&self, _key: &str) -> Vec<u8> {
            unreachable!("bounded serializer path must be used")
        }

        fn resolve_limited(&self, _key: &str, _max_bytes: usize) -> Option<Vec<u8>> {
            self.0.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            Some(vec![1, 2, 3])
        }
    }

    let resolver = std::sync::Arc::new(CountingResolver(std::sync::atomic::AtomicUsize::new(0)));
    let invalid_extension = "x/../../DocInfo";
    let mut bin_data = crate::model::bin_data::BinData::default();
    bin_data.data_type = crate::model::bin_data::BinDataType::Embedding;
    bin_data.storage_id = 1;
    bin_data.extension = Some(invalid_extension.to_string());
    let doc = Document {
        doc_info: DocInfo {
            bin_data_list: vec![bin_data],
            ..Default::default()
        },
        bin_data_content: vec![BinDataContent {
            id: 1,
            data: crate::model::bin_data::BinDataBytes::lazy(
                resolver.clone(),
                format!("BIN0001.{invalid_extension}"),
            ),
            extension: invalid_extension.to_string(),
        }],
        ..Default::default()
    };

    let error = serialize_hwp(&doc).expect_err("unsafe BinData paths must fail closed");
    assert!(error.to_string().contains("invalid BinData storage name"));
    assert_eq!(resolver.0.load(std::sync::atomic::Ordering::SeqCst), 0);
}

#[test]
fn implicit_cfb_storages_are_counted_before_lazy_materialization() {
    #[derive(Debug)]
    struct CountingResolver(std::sync::atomic::AtomicUsize);

    impl crate::model::bin_data::BinDataResolver for CountingResolver {
        fn resolve(&self, _key: &str) -> Vec<u8> {
            unreachable!("bounded serializer path must be used")
        }

        fn resolve_limited(&self, _key: &str, _max_bytes: usize) -> Option<Vec<u8>> {
            self.0.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            Some(vec![1])
        }
    }

    let resolver = std::sync::Arc::new(CountingResolver(std::sync::atomic::AtomicUsize::new(0)));
    let mut bin_data_list = Vec::new();
    let mut bin_data_content = Vec::new();
    for id in 1..=2u16 {
        let mut bin_data = crate::model::bin_data::BinData::default();
        bin_data.data_type = crate::model::bin_data::BinDataType::Embedding;
        bin_data.storage_id = id;
        bin_data.extension = Some("dat".to_string());
        bin_data_list.push(bin_data);
        bin_data_content.push(BinDataContent {
            id,
            data: crate::model::bin_data::BinDataBytes::lazy(
                resolver.clone(),
                format!("BIN{id:04X}.dat"),
            ),
            extension: "dat".to_string(),
        });
    }
    let doc = Document {
        doc_info: DocInfo {
            bin_data_list,
            ..Default::default()
        },
        // Requested stream count is exactly 4096. The implicit BodyText and
        // BinData storages make the real directory contain 4097 entries.
        sections: vec![Section::default(); 4090],
        bin_data_content,
        ..Default::default()
    };

    let error = serialize_hwp(&doc).expect_err("implicit storage entries must share the limit");
    assert!(
        error.to_string().contains("directory entry count"),
        "{error}"
    );
    assert_eq!(resolver.0.load(std::sync::atomic::Ordering::SeqCst), 0);
}

#[test]
fn test_serialize_hwp_cfb_streams() {
    let doc = Document {
        header: FileHeader {
            version: HwpVersion {
                major: 5,
                minor: 0,
                build: 6,
                revision: 1,
            },
            flags: 0,
            compressed: false,
            encrypted: false,
            distribution: false,
            raw_data: None,
        },
        doc_properties: DocProperties {
            section_count: 1,
            page_start_num: 1,
            ..Default::default()
        },
        doc_info: DocInfo::default(),
        sections: vec![crate::model::document::Section {
            section_def: SectionDef::default(),
            paragraphs: vec![Paragraph {
                text: "테스트".to_string(),
                line_segs: vec![LineSeg {
                    line_height: 400,
                    baseline_distance: 320,
                    ..Default::default()
                }],
                ..Default::default()
            }],
            raw_stream: None,
            raw_provenance: None,
        }],
        preview: None,
        bin_data_content: Vec::new(),
        extra_streams: Vec::new(),
        hwpx_aux_entries: Vec::new(),
        is_hwp3_variant: false,
        is_hwpx_variant: false,
        provenance: Default::default(),
    };

    let bytes = serialize_hwp(&doc).unwrap();

    // CFB로 읽어서 스트림 확인
    let mut cfb = crate::parser::cfb_reader::CfbReader::open(&bytes).unwrap();
    assert!(cfb.has_stream("/FileHeader"));
    assert!(cfb.has_stream("/DocInfo"));
    assert!(cfb.has_stream("/BodyText/Section0"));

    // FileHeader 크기 확인
    let header = cfb.read_file_header().unwrap();
    assert_eq!(header.len(), 256);
}

#[test]
fn test_serialize_hwp_compressed() {
    let doc = Document {
        header: FileHeader {
            version: HwpVersion {
                major: 5,
                minor: 0,
                build: 6,
                revision: 1,
            },
            flags: 0x01,
            compressed: true,
            encrypted: false,
            distribution: false,
            raw_data: None,
        },
        doc_properties: DocProperties {
            section_count: 1,
            page_start_num: 1,
            ..Default::default()
        },
        doc_info: DocInfo::default(),
        sections: vec![crate::model::document::Section::default()],
        preview: None,
        bin_data_content: Vec::new(),
        extra_streams: Vec::new(),
        hwpx_aux_entries: Vec::new(),
        is_hwp3_variant: false,
        is_hwpx_variant: false,
        provenance: Default::default(),
    };

    let bytes = serialize_hwp(&doc).unwrap();

    // CFB로 읽고 DocInfo가 압축 해제 가능한지 확인
    let mut cfb = crate::parser::cfb_reader::CfbReader::open(&bytes).unwrap();
    let doc_info_raw = cfb.read_stream_raw("/DocInfo").unwrap();
    let decompressed = decompress_stream(&doc_info_raw).unwrap();
    assert!(!decompressed.is_empty());
}

#[test]
fn test_full_roundtrip_uncompressed() {
    // 최소 Document 구성
    let mut doc_info = DocInfo::default();
    doc_info.font_faces = vec![Vec::new(); 7];
    doc_info.font_faces[0].push(Font {
        raw_data: None,
        name: "함초롬바탕".to_string(),
        alt_type: 0,
        is_embedded: false,
        bin_item_id_ref: String::new(),
        resolved_bin_data_id: None,
        alt_name: None,
        type_info: None,
        default_name: None,
        subst_font: None,
    });
    doc_info.char_shapes.push(CharShape {
        font_ids: [0; 7],
        ratios: [100; 7],
        spacings: [0; 7],
        relative_sizes: [100; 7],
        char_offsets: [0; 7],
        base_size: 1000,
        attr: 0,
        text_color: 0,
        underline_color: 0,
        shade_color: 0x00FFFFFF,
        shadow_color: 0x00B2B2B2,
        strike_color: 0,
        ..Default::default()
    });
    doc_info.para_shapes.push(ParaShape {
        line_spacing: 160,
        ..Default::default()
    });
    doc_info.styles.push(Style {
        local_name: "바탕글".to_string(),
        english_name: "Normal".to_string(),
        ..Default::default()
    });

    let original = Document {
        header: FileHeader {
            version: HwpVersion {
                major: 5,
                minor: 0,
                build: 6,
                revision: 1,
            },
            flags: 0,
            compressed: false,
            encrypted: false,
            distribution: false,
            raw_data: None,
        },
        doc_properties: DocProperties {
            section_count: 1,
            page_start_num: 1,
            footnote_start_num: 1,
            endnote_start_num: 1,
            picture_start_num: 1,
            table_start_num: 1,
            equation_start_num: 1,
            raw_data: None,
            caret_list_id: 0,
            caret_para_id: 0,
            caret_char_pos: 0,
        },
        doc_info,
        sections: vec![crate::model::document::Section {
            section_def: SectionDef::default(),
            paragraphs: vec![Paragraph {
                text: "안녕하세요".to_string(),
                char_count: 6, // 5문자 + 문단 끝
                line_segs: vec![LineSeg {
                    line_height: 400,
                    baseline_distance: 320,
                    ..Default::default()
                }],
                ..Default::default()
            }],
            raw_stream: None,
            raw_provenance: None,
        }],
        preview: None,
        bin_data_content: Vec::new(),
        extra_streams: Vec::new(),
        hwpx_aux_entries: Vec::new(),
        is_hwp3_variant: false,
        is_hwpx_variant: false,
        provenance: Default::default(),
    };

    // Document → HWP bytes
    let hwp_bytes = serialize_hwp(&original).unwrap();

    // HWP bytes → CFB → 스트림 읽기
    let mut cfb = crate::parser::cfb_reader::CfbReader::open(&hwp_bytes).unwrap();

    // FileHeader 라운드트립
    let header_data = cfb.read_file_header().unwrap();
    let parsed_header = crate::parser::header::parse_file_header(&header_data).unwrap();
    assert_eq!(parsed_header.version.major, 5);
    assert!(!parsed_header.flags.compressed);

    // DocInfo 라운드트립
    let doc_info_data = cfb.read_doc_info(false).unwrap();
    let (parsed_info, parsed_props) =
        crate::parser::doc_info::parse_doc_info(&doc_info_data).unwrap();
    assert_eq!(parsed_props.section_count, 1);
    assert_eq!(parsed_info.font_faces[0][0].name, "함초롬바탕");
    assert_eq!(parsed_info.styles[0].local_name, "바탕글");

    // BodyText 라운드트립
    let section_data = cfb.read_body_text_section(0, false, false).unwrap();
    let parsed_section = crate::parser::body_text::parse_body_text_section(&section_data).unwrap();
    assert_eq!(parsed_section.paragraphs.len(), 1);
    assert_eq!(parsed_section.paragraphs[0].text, "안녕하세요");
}

#[test]
fn test_full_roundtrip_compressed() {
    let original = Document {
        header: FileHeader {
            version: HwpVersion {
                major: 5,
                minor: 0,
                build: 6,
                revision: 1,
            },
            flags: 0x01,
            compressed: true,
            encrypted: false,
            distribution: false,
            raw_data: None,
        },
        doc_properties: DocProperties {
            section_count: 1,
            page_start_num: 1,
            footnote_start_num: 1,
            endnote_start_num: 1,
            picture_start_num: 1,
            table_start_num: 1,
            equation_start_num: 1,
            raw_data: None,
            caret_list_id: 0,
            caret_para_id: 0,
            caret_char_pos: 0,
        },
        doc_info: DocInfo::default(),
        sections: vec![crate::model::document::Section {
            section_def: SectionDef::default(),
            paragraphs: vec![Paragraph {
                text: "Hello World".to_string(),
                char_count: 12,
                line_segs: vec![LineSeg {
                    line_height: 400,
                    baseline_distance: 320,
                    ..Default::default()
                }],
                ..Default::default()
            }],
            raw_stream: None,
            raw_provenance: None,
        }],
        preview: None,
        bin_data_content: Vec::new(),
        extra_streams: Vec::new(),
        hwpx_aux_entries: Vec::new(),
        is_hwp3_variant: false,
        is_hwpx_variant: false,
        provenance: Default::default(),
    };

    // Document → HWP bytes (compressed)
    let hwp_bytes = serialize_hwp(&original).unwrap();

    // HWP bytes → CFB → 압축 해제 → 스트림 읽기
    let mut cfb = crate::parser::cfb_reader::CfbReader::open(&hwp_bytes).unwrap();

    // DocInfo 라운드트립 (압축 해제)
    let doc_info_data = cfb.read_doc_info(true).unwrap();
    let (_parsed_info, parsed_props) =
        crate::parser::doc_info::parse_doc_info(&doc_info_data).unwrap();
    assert_eq!(parsed_props.section_count, 1);

    // BodyText 라운드트립 (압축 해제)
    let section_data = cfb.read_body_text_section(0, true, false).unwrap();
    let parsed_section = crate::parser::body_text::parse_body_text_section(&section_data).unwrap();
    assert_eq!(parsed_section.paragraphs[0].text, "Hello World");
}

#[test]
fn test_serialize_after_edit() {
    use std::path::Path;

    let path = Path::new("samples/hwp-3.0-HWPML.hwp");
    assert!(path.exists(), "테스트 입력 파일 없음: {:?}", path);

    let data = std::fs::read(path).unwrap();
    let mut doc = crate::wasm_api::HwpDocument::from_bytes(&data).unwrap();

    // 첫 번째 문단에 텍스트 삽입
    let result = doc.insert_text_native(0, 0, 0, "테스트");
    eprintln!("insert result: {:?}", result);
    assert!(result.is_ok());

    // 직렬화
    match doc.export_hwp_native() {
        Ok(bytes) => {
            eprintln!("편집 후 직렬화 성공: {}KB", bytes.len() / 1024);
            assert_eq!(&bytes[0..4], &[0xD0, 0xCF, 0x11, 0xE0]);
        }
        Err(e) => {
            panic!("편집 후 직렬화 실패: {}", e);
        }
    }
}

#[test]
fn test_serialize_after_edit_roundtrip() {
    use std::path::Path;

    // 여러 샘플 파일에 대해 편집 후 라운드트립 검증
    let files = [
        "samples/hwp-3.0-HWPML.hwp",
        "samples/hwp-multi-001.hwp",
        "samples/20250130-hongbo.hwp",
    ];

    for file_path in &files {
        let path = Path::new(file_path);
        assert!(path.exists(), "테스트 입력 파일 없음: {:?}", file_path);

        let data = std::fs::read(path).unwrap();
        let mut doc = crate::wasm_api::HwpDocument::from_bytes(&data).unwrap();

        // rhwp-studio와 동일하게 convertToEditable 호출
        let _ = doc.convert_to_editable_native();

        // 텍스트 삽입
        let result = doc.insert_text_native(0, 0, 0, "테스트추가");
        assert!(result.is_ok(), "{}: 텍스트 삽입 실패", file_path);

        // 직렬화
        let bytes = doc
            .export_hwp_native()
            .unwrap_or_else(|e| panic!("{}: 직렬화 실패: {}", file_path, e));

        // CFB 매직 확인
        assert_eq!(
            &bytes[0..4],
            &[0xD0, 0xCF, 0x11, 0xE0],
            "{}: CFB 매직 불일치",
            file_path
        );

        // 라운드트립: 다시 파싱 가능한지 검증
        let parsed = crate::parser::parse_hwp(&bytes);
        assert!(
            parsed.is_ok(),
            "{}: 라운드트립 파싱 실패: {:?}",
            file_path,
            parsed.err()
        );

        let parsed = parsed.unwrap();
        let para_text = &parsed.sections[0].paragraphs[0].text;
        assert!(
            para_text.starts_with("테스트추가"),
            "{}: 삽입된 텍스트 미발견, 실제: '{}'",
            file_path,
            &para_text[..para_text.len().min(30)]
        );

        eprintln!("{}: 라운드트립 성공 ({}KB)", file_path, bytes.len() / 1024);
    }
}

#[test]
fn test_serialize_real_hwp_files() {
    use std::path::Path;

    let sample_dir = Path::new("samples");
    assert!(
        sample_dir.exists(),
        "테스트 입력 파일 없음: {:?}",
        sample_dir
    );

    for entry in std::fs::read_dir(sample_dir).unwrap() {
        let entry = entry.unwrap();
        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) != Some("hwp") {
            continue;
        }
        let fname = path.file_name().unwrap().to_string_lossy().to_string();
        eprintln!("테스트: {}", fname);

        let data = std::fs::read(&path).unwrap();
        let doc = match crate::parser::parse_hwp(&data) {
            Ok(d) => d,
            Err(e) => {
                eprintln!("  파싱 실패 (건너뜀): {}", e);
                continue;
            }
        };

        match serialize_hwp(&doc) {
            Ok(bytes) => {
                eprintln!("  직렬화 성공: {}KB", bytes.len() / 1024);
                // CFB 시그니처 확인
                assert_eq!(
                    &bytes[0..4],
                    &[0xD0, 0xCF, 0x11, 0xE0],
                    "{}: CFB 시그니처 불일치",
                    fname
                );
            }
            Err(e) => {
                panic!("{}: 직렬화 실패: {}", fname, e);
            }
        }
    }
}

/// 표 구조 변경(행/열 추가/삭제) 후 라운드트립 검증
#[test]
fn test_table_structure_change_roundtrip() {
    use std::path::Path;

    let path = Path::new("samples/hwp_table_test.hwp");
    assert!(path.exists(), "테스트 입력 파일 없음: {:?}", path);

    let data = std::fs::read(path).unwrap();

    // 행 추가 라운드트립
    {
        let mut doc = crate::wasm_api::HwpDocument::from_bytes(&data).unwrap();
        let _ = doc.convert_to_editable_native();
        doc.insert_table_row_native(0, 3, 0, 0, true).unwrap();
        let bytes = doc.export_hwp_native().unwrap();
        let parsed = crate::parser::parse_hwp(&bytes);
        assert!(
            parsed.is_ok(),
            "행 추가 후 라운드트립 실패: {:?}",
            parsed.err()
        );
        eprintln!("행 추가 라운드트립: 성공");
    }

    // 열 추가 라운드트립
    {
        let mut doc = crate::wasm_api::HwpDocument::from_bytes(&data).unwrap();
        let _ = doc.convert_to_editable_native();
        doc.insert_table_column_native(0, 3, 0, 0, true).unwrap();
        let bytes = doc.export_hwp_native().unwrap();
        let parsed = crate::parser::parse_hwp(&bytes);
        assert!(
            parsed.is_ok(),
            "열 추가 후 라운드트립 실패: {:?}",
            parsed.err()
        );
        eprintln!("열 추가 라운드트립: 성공");
    }

    // 행 삭제 라운드트립
    {
        let mut doc = crate::wasm_api::HwpDocument::from_bytes(&data).unwrap();
        let _ = doc.convert_to_editable_native();
        doc.delete_table_row_native(0, 3, 0, 0).unwrap();
        let bytes = doc.export_hwp_native().unwrap();
        let parsed = crate::parser::parse_hwp(&bytes);
        assert!(
            parsed.is_ok(),
            "행 삭제 후 라운드트립 실패: {:?}",
            parsed.err()
        );
        eprintln!("행 삭제 라운드트립: 성공");
    }

    // 열 삭제 라운드트립
    {
        let mut doc = crate::wasm_api::HwpDocument::from_bytes(&data).unwrap();
        let _ = doc.convert_to_editable_native();
        doc.delete_table_column_native(0, 3, 0, 0).unwrap();
        let bytes = doc.export_hwp_native().unwrap();
        let parsed = crate::parser::parse_hwp(&bytes);
        assert!(
            parsed.is_ok(),
            "열 삭제 후 라운드트립 실패: {:?}",
            parsed.err()
        );
        eprintln!("열 삭제 라운드트립: 성공");
    }
}

/// 표 컨트롤 삭제 + 라운드트립 테스트
#[test]
fn test_delete_table_control_roundtrip() {
    use std::path::Path;

    let path = Path::new("samples/hwp_table_test.hwp");
    assert!(path.exists(), "테스트 입력 파일 없음: {:?}", path);

    let data = std::fs::read(path).unwrap();
    let mut doc = crate::wasm_api::HwpDocument::from_bytes(&data).unwrap();
    let _ = doc.convert_to_editable_native();

    // 표 삭제
    let result = doc.delete_table_control_native(0, 3, 0);
    assert!(result.is_ok(), "표 삭제 실패: {:?}", result.err());

    // 라운드트립: 직렬화 → 파싱
    let bytes = doc.export_hwp_native().unwrap();
    let parsed = crate::parser::parse_hwp(&bytes);
    assert!(
        parsed.is_ok(),
        "표 삭제 후 라운드트립 실패: {:?}",
        parsed.err()
    );
    eprintln!("표 삭제 라운드트립: 성공");
}

/// OLE Storage BinData 는 `[4-byte LE size][CFB 컨테이너]` 형식이다.
/// 파서(`load_bin_data_content`)가 내부 CFB 노출을 위해 size prefix 를 제거하므로,
/// 직렬화 시 다시 복원해야 한다. 미복원 시 한컴이 CFB 매직(D0CF11E0)을 OLE 개체
/// 크기(~3.75GB)로 오인하여 "메모리 부족" 오류로 문서를 열지 못한다.
#[test]
fn test_ole_storage_size_prefix_restored() {
    use crate::model::bin_data::{BinData, BinDataContent, BinDataType};

    // 가짜 OLE 내부 CFB: CFB 매직 + 임의 페이로드
    let mut ole_cfb = vec![0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1];
    ole_cfb.extend_from_slice(&[0x42u8; 64]);

    let mut doc_info = DocInfo::default();
    doc_info.bin_data_list.push(BinData {
        data_type: BinDataType::Storage,
        storage_id: 1,
        extension: Some("OLE".to_string()),
        ..Default::default()
    });

    let doc = Document {
        header: FileHeader {
            version: HwpVersion {
                major: 5,
                minor: 0,
                build: 6,
                revision: 1,
            },
            flags: 0,
            compressed: false,
            encrypted: false,
            distribution: false,
            raw_data: None,
        },
        doc_properties: DocProperties {
            section_count: 1,
            page_start_num: 1,
            ..Default::default()
        },
        doc_info,
        sections: vec![crate::model::document::Section {
            section_def: SectionDef::default(),
            paragraphs: vec![Paragraph {
                line_segs: vec![LineSeg {
                    line_height: 400,
                    baseline_distance: 320,
                    ..Default::default()
                }],
                ..Default::default()
            }],
            raw_stream: None,
            raw_provenance: None,
        }],
        preview: None,
        bin_data_content: vec![BinDataContent {
            id: 1,
            data: ole_cfb.clone().into(),
            extension: "OLE".to_string(),
        }],
        extra_streams: Vec::new(),
        hwpx_aux_entries: Vec::new(),
        is_hwp3_variant: false,
        is_hwpx_variant: false,
        provenance: Default::default(),
    };

    let bytes = serialize_hwp(&doc).unwrap();
    let mut cfb = crate::parser::cfb_reader::CfbReader::open(&bytes).unwrap();
    let stream = cfb.read_bin_data("BIN0001.OLE").unwrap();

    // 선두 4바이트 = OLE CFB 길이의 LE size prefix
    assert!(
        stream.len() >= 12,
        "OLE 스트림이 prefix + CFB 매직 길이 이상이어야 한다"
    );
    let prefix = u32::from_le_bytes([stream[0], stream[1], stream[2], stream[3]]);
    assert_eq!(
        prefix as usize,
        ole_cfb.len(),
        "4-byte size prefix 가 OLE CFB 길이와 일치해야 한다"
    );
    // prefix 직후가 내부 CFB 매직
    assert_eq!(
        &stream[4..12],
        &[0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1],
        "size prefix 다음은 CFB 매직이어야 한다"
    );
    // prefix 를 제외한 본문이 원본 OLE CFB 와 동일
    assert_eq!(&stream[4..], &ole_cfb[..], "OLE CFB 본문이 보존되어야 한다");
}

/// 압축 문서에서는 OLE Storage 도 `[size][CFB]` payload 를 만든 뒤 BinData 압축 정책에 따라
/// raw deflate 로 저장해야 한다. 한컴 저장본의 chart OLE Storage 가 이 형태를 사용한다.
#[test]
fn test_compressed_ole_storage_payload_is_deflated() {
    use crate::model::bin_data::{BinData, BinDataContent, BinDataType};

    let mut ole_cfb = vec![0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1];
    ole_cfb.extend_from_slice(&[0x42u8; 64]);

    let mut doc_info = DocInfo::default();
    doc_info.bin_data_list.push(BinData {
        data_type: BinDataType::Storage,
        storage_id: 1,
        extension: Some("OLE".to_string()),
        ..Default::default()
    });

    let doc = Document {
        header: FileHeader {
            version: HwpVersion {
                major: 5,
                minor: 0,
                build: 6,
                revision: 1,
            },
            flags: 0x01,
            compressed: true,
            encrypted: false,
            distribution: false,
            raw_data: None,
        },
        doc_properties: DocProperties {
            section_count: 1,
            page_start_num: 1,
            ..Default::default()
        },
        doc_info,
        sections: vec![crate::model::document::Section {
            section_def: SectionDef::default(),
            paragraphs: vec![Paragraph {
                line_segs: vec![LineSeg {
                    line_height: 400,
                    baseline_distance: 320,
                    ..Default::default()
                }],
                ..Default::default()
            }],
            raw_stream: None,
            raw_provenance: None,
        }],
        preview: None,
        bin_data_content: vec![BinDataContent {
            id: 1,
            data: ole_cfb.clone().into(),
            extension: "OLE".to_string(),
        }],
        extra_streams: Vec::new(),
        hwpx_aux_entries: Vec::new(),
        is_hwp3_variant: false,
        is_hwpx_variant: false,
        provenance: Default::default(),
    };

    let bytes = serialize_hwp(&doc).unwrap();
    let mut cfb = crate::parser::cfb_reader::CfbReader::open(&bytes).unwrap();
    let stream = cfb.read_bin_data("BIN0001.OLE").unwrap();
    assert!(
        !stream.starts_with(&(ole_cfb.len() as u32).to_le_bytes()),
        "compressed OLE Storage stream should not expose the size prefix before decompression"
    );

    let payload = decompress_stream(&stream).expect("OLE Storage stream must be deflated");
    let prefix = u32::from_le_bytes([payload[0], payload[1], payload[2], payload[3]]);
    assert_eq!(prefix as usize, ole_cfb.len());
    assert_eq!(
        &payload[4..12],
        &[0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1]
    );
    assert_eq!(&payload[4..], &ole_cfb[..]);
}
