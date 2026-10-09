//! 적대적·손상 입력에 대한 임베드 개체(WMF/EMF)와 HWP 3.0 파서의 회귀 테스트.
//!
//! 각 입력은 예전 코드에서 패닉(범위 밖 슬라이스, 음수 → usize 캐스팅, 정수 넘침),
//! 선언 길이만큼의 선할당, 스택 오버플로를 일으켰다. wasm 에서는 패닉이 엔진 인스턴스를
//! 멈추고 레이아웃마다 다시 불리므로 문서를 여는 즉시 편집기가 죽는다.
//!
//! 같은 입력을 `fuzz/regressions/<타깃>/` 에 파일로 보존한다. 빌더를 고친 뒤에는
//! `RHWP_WRITE_FUZZ_REGRESSIONS=1 cargo test --test hostile_embedded_input
//! write_fuzz_regressions -- --ignored` 로 파일을 다시 쓴다.

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use rhwp::wmf::converter::{SVGPlayer, WMFConverter};

// ── WMF 조립 도구 ────────────────────────────────────────────────────────────

const META_EOF: u16 = 0x0000;
const META_SAVEDC: u16 = 0x001E;
const META_SETBKMODE: u16 = 0x0102;
const META_SELECTOBJECT: u16 = 0x012D;
const META_DELETEOBJECT: u16 = 0x01F0;
const META_CREATEPATTERNBRUSH: u16 = 0x01F9;
const META_CREATEBRUSHINDIRECT: u16 = 0x02FC;
const META_POLYGON: u16 = 0x0324;
const META_POLYLINE: u16 = 0x0325;
const META_TEXTOUT: u16 = 0x0521;
const META_ESCAPE: u16 = 0x0626;
const META_EXTTEXTOUT: u16 = 0x0A32;
const META_STRETCHDIB: u16 = 0x0F43;

const SRCCOPY: u32 = 0x00CC_0020;
const BI_RGB: u32 = 0;
const BI_RLE8: u32 = 1;

/// RecordSize(WORD 수) 를 파라미터 길이로부터 계산한 레코드.
fn record(function: u16, params: &[u8]) -> Vec<u8> {
    let mut params = params.to_vec();
    if params.len() % 2 == 1 {
        params.push(0);
    }
    record_with_size(((6 + params.len()) / 2) as u32, function, &params)
}

/// RecordSize 를 그대로 적는 레코드 (선언 크기와 실제 크기가 다른 입력용).
fn record_with_size(size_words: u32, function: u16, params: &[u8]) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(6 + params.len());
    bytes.extend_from_slice(&size_words.to_le_bytes());
    bytes.extend_from_slice(&function.to_le_bytes());
    bytes.extend_from_slice(params);
    bytes
}

/// META_HEADER(18바이트) + 레코드들 + META_EOF.
fn wmf(number_of_objects: u16, records: &[Vec<u8>]) -> Vec<u8> {
    let mut body: Vec<u8> = records.concat();
    body.extend_from_slice(&record(META_EOF, &[]));

    let mut bytes = Vec::with_capacity(18 + body.len());
    bytes.extend_from_slice(&1u16.to_le_bytes()); // Type: MEMORYMETAFILE
    bytes.extend_from_slice(&9u16.to_le_bytes()); // HeaderSize (WORD)
    bytes.extend_from_slice(&0x0300u16.to_le_bytes()); // Version
    bytes.extend_from_slice(&(((18 + body.len()) / 2) as u32).to_le_bytes()); // Size
    bytes.extend_from_slice(&number_of_objects.to_le_bytes());
    bytes.extend_from_slice(&0u32.to_le_bytes()); // MaxRecord
    bytes.extend_from_slice(&0u16.to_le_bytes()); // NumberOfMembers
    bytes.extend_from_slice(&body);
    bytes
}

fn le16(values: &[i16]) -> Vec<u8> {
    values.iter().flat_map(|v| v.to_le_bytes()).collect()
}

/// BITMAPINFOHEADER(40바이트).
fn info_header(
    width: i32,
    height: i32,
    bit_count: u16,
    compression: u32,
    image_size: u32,
) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(40);
    bytes.extend_from_slice(&40u32.to_le_bytes());
    bytes.extend_from_slice(&width.to_le_bytes());
    bytes.extend_from_slice(&height.to_le_bytes());
    bytes.extend_from_slice(&1u16.to_le_bytes()); // Planes
    bytes.extend_from_slice(&bit_count.to_le_bytes());
    bytes.extend_from_slice(&compression.to_le_bytes());
    bytes.extend_from_slice(&image_size.to_le_bytes());
    bytes.extend_from_slice(&0i32.to_le_bytes()); // XPelsPerMeter
    bytes.extend_from_slice(&0i32.to_le_bytes()); // YPelsPerMeter
    bytes.extend_from_slice(&2u32.to_le_bytes()); // ColorUsed: 흑백 2색
    bytes.extend_from_slice(&0u32.to_le_bytes()); // ColorImportant
    bytes
}

/// 흑/백 RGBQuad 색상표.
fn two_color_quads() -> Vec<u8> {
    vec![0, 0, 0, 0, 0xFF, 0xFF, 0xFF, 0]
}

/// META_STRETCHDIB (SRCCOPY, DIB_RGB_COLORS, 16×16 대상) + 주어진 DIB.
fn stretch_dib(dib: &[u8]) -> Vec<u8> {
    let mut params = Vec::new();
    params.extend_from_slice(&SRCCOPY.to_le_bytes());
    params.extend_from_slice(&0u16.to_le_bytes()); // ColorUsage: DIB_RGB_COLORS
    params.extend_from_slice(&le16(&[16, 16, 0, 0, 16, 16, 0, 0]));
    params.extend_from_slice(dib);
    record(META_STRETCHDIB, &params)
}

/// 16×16 8bpp RLE8 그림: 줄마다 "16픽셀 색 0" + 줄 끝, 마지막에 그림 끝.
/// 압축 크기(66바이트)가 비압축 기하(16바이트 × 16줄)보다 작다.
fn rle8_pixels() -> Vec<u8> {
    let mut data = Vec::new();
    for _ in 0..16 {
        data.extend_from_slice(&[16, 0, 0, 0]);
    }
    data.extend_from_slice(&[0, 1]);
    data
}

fn wmf_stretchdib_rle8_short_image_size() -> Vec<u8> {
    let pixels = rle8_pixels();
    let mut dib = info_header(16, 16, 8, BI_RLE8, pixels.len() as u32);
    dib.extend_from_slice(&two_color_quads());
    dib.extend_from_slice(&pixels);
    wmf(0, &[stretch_dib(&dib)])
}

/// BITMAPCOREHEADER 256×256 8bpp. 예전 u16 크기 계산은 65,536 에서 넘쳤다.
fn core_dib_256(pixel_bytes: usize) -> Vec<u8> {
    let mut dib = Vec::new();
    dib.extend_from_slice(&12u32.to_le_bytes());
    dib.extend_from_slice(&256u16.to_le_bytes()); // Width
    dib.extend_from_slice(&256u16.to_le_bytes()); // Height
    dib.extend_from_slice(&1u16.to_le_bytes()); // Planes
    dib.extend_from_slice(&8u16.to_le_bytes()); // BitCount
    for i in 0..=255u8 {
        dib.extend_from_slice(&[i, i, i]); // RGBTriple 회색조
    }
    dib.extend((0..pixel_bytes).map(|i| i as u8));
    dib
}

fn wmf_stretchdib_core_header_size_overflow() -> Vec<u8> {
    wmf(0, &[stretch_dib(&core_dib_256(16))])
}

fn wmf_stretchdib_info_width_size_overflow() -> Vec<u8> {
    let mut dib = info_header(i32::MAX, 1, 8, BI_RGB, 0);
    dib.extend_from_slice(&two_color_quads());
    dib.extend_from_slice(&[0u8; 16]);
    wmf(0, &[stretch_dib(&dib)])
}

fn wmf_stretchdib_rle8_image_size_4gb() -> Vec<u8> {
    let mut dib = info_header(16, 16, 8, BI_RLE8, 0xFFFF_FFF0);
    dib.extend_from_slice(&two_color_quads());
    dib.extend_from_slice(&rle8_pixels());
    wmf(0, &[stretch_dib(&dib)])
}

fn wmf_textout_length(string_length: i16) -> Vec<u8> {
    let mut params = le16(&[string_length]);
    params.extend_from_slice(b"AB");
    params.extend_from_slice(&le16(&[10, 10]));
    wmf(0, &[record(META_TEXTOUT, &params)])
}

fn wmf_exttextout_negative_length() -> Vec<u8> {
    let mut params = le16(&[10, 10, -1]);
    params.extend_from_slice(&0u16.to_le_bytes()); // fwOpts
    params.extend_from_slice(b"AB");
    wmf(0, &[record(META_EXTTEXTOUT, &params)])
}

fn wmf_points_negative_count(function: u16) -> Vec<u8> {
    wmf(0, &[record(function, &le16(&[-1, 0, 0, 10, 10]))])
}

fn wmf_createpatternbrush_negative_height() -> Vec<u8> {
    let mut params = le16(&[0, 8, -1, 2]); // Type, Width, Height=-1, WidthBytes
    params.extend_from_slice(&[1, 1]); // Planes, BitsPixel
    params.extend_from_slice(&[0u8; 4 + 18]); // Bitmap16 나머지 + Reserved
    params.extend_from_slice(&[0u8; 4]); // Pattern
    wmf(1, &[record(META_CREATEPATTERNBRUSH, &params)])
}

fn escape(escape_function: u16, data: &[u8]) -> Vec<u8> {
    let mut params = escape_function.to_le_bytes().to_vec();
    params.extend_from_slice(data);
    record(META_ESCAPE, &params)
}

fn wmf_escape_getcolortable_start_past_count() -> Vec<u8> {
    // ByteCount=0, Start=2 → 예전 u16 뺄셈이 넘쳤다.
    wmf(0, &[escape(0x0005, &le16(&[0, 2, 0, 0]))])
}

fn wmf_escape_eps_size_below_fixed_fields() -> Vec<u8> {
    let mut data = 32u16.to_le_bytes().to_vec(); // ByteCount
    data.extend_from_slice(&4u32.to_le_bytes()); // Size < 16
    data.extend_from_slice(&0u32.to_le_bytes()); // Version
    data.extend_from_slice(&[0u8; 24]); // PointL × 3
    wmf(0, &[escape(0x1014, &data)])
}

fn wmf_escape_enhanced_metafile_size_overflow() -> Vec<u8> {
    let mut data = 34u16.to_le_bytes().to_vec(); // ByteCount
    data.extend_from_slice(&0x4346_4D57u32.to_le_bytes()); // CommentIdentifier "WMFC"
    data.extend_from_slice(&1u32.to_le_bytes()); // CommentType
    data.extend_from_slice(&0x0001_0000u32.to_le_bytes()); // Version
    data.extend_from_slice(&0u16.to_le_bytes()); // Checksum
    data.extend_from_slice(&0u32.to_le_bytes()); // Flags
    data.extend_from_slice(&1u32.to_le_bytes()); // CommentRecordCount
    data.extend_from_slice(&0u32.to_le_bytes()); // CurrentRecordSize
    data.extend_from_slice(&0u32.to_le_bytes()); // RemainingBytes
    data.extend_from_slice(&0xFFFF_FFF0u32.to_le_bytes()); // EnhancedMetafileDataSize
    wmf(0, &[escape(0x000F, &data)])
}

fn wmf_escape_record_size_4gb() -> Vec<u8> {
    let mut bytes = wmf(0, &[]);
    bytes.truncate(18); // META_EOF 제거
    bytes.extend_from_slice(&record_with_size(
        0x7FFF_FFFF,
        META_ESCAPE,
        &[0x0F, 0, 0, 0],
    ));
    bytes
}

fn wmf_deleteobject_out_of_range() -> Vec<u8> {
    wmf(0, &[record(META_DELETEOBJECT, &le16(&[5]))])
}

fn wmf_savedc_flood() -> Vec<u8> {
    let records = vec![record(META_SAVEDC, &[]); 5_000];
    wmf(u16::MAX, &records)
}

fn wmf_hatched_brush_behind_opaque_text() -> Vec<u8> {
    let mut brush = 2u16.to_le_bytes().to_vec(); // BrushStyle: BS_HATCHED
    brush.extend_from_slice(&[0x00, 0x80, 0xFF, 0x00]); // ColorRef
    brush.extend_from_slice(&5u16.to_le_bytes()); // HS_DIAGCROSS
    let mut text = le16(&[10, 10, 1]); // y, x, StringLength
    text.extend_from_slice(&0u16.to_le_bytes()); // fwOpts
    text.extend_from_slice(b"A\0");
    wmf(
        1,
        &[
            record(META_SETBKMODE, &le16(&[2])), // OPAQUE
            record(META_CREATEBRUSHINDIRECT, &brush),
            record(META_SELECTOBJECT, &le16(&[0])),
            record(META_EXTTEXTOUT, &text),
        ],
    )
}

fn wmf_regressions() -> Vec<(&'static str, Vec<u8>)> {
    vec![
        (
            "stretchdib_rle8_short_image_size.wmf",
            wmf_stretchdib_rle8_short_image_size(),
        ),
        (
            "stretchdib_core_header_size_overflow.wmf",
            wmf_stretchdib_core_header_size_overflow(),
        ),
        (
            "stretchdib_info_width_size_overflow.wmf",
            wmf_stretchdib_info_width_size_overflow(),
        ),
        (
            "stretchdib_rle8_image_size_4gb.wmf",
            wmf_stretchdib_rle8_image_size_4gb(),
        ),
        ("textout_negative_length.wmf", wmf_textout_length(-1)),
        ("textout_max_length.wmf", wmf_textout_length(i16::MAX)),
        (
            "exttextout_negative_length.wmf",
            wmf_exttextout_negative_length(),
        ),
        (
            "polyline_negative_count.wmf",
            wmf_points_negative_count(META_POLYLINE),
        ),
        (
            "polygon_negative_count.wmf",
            wmf_points_negative_count(META_POLYGON),
        ),
        (
            "createpatternbrush_negative_height.wmf",
            wmf_createpatternbrush_negative_height(),
        ),
        (
            "escape_getcolortable_start_past_count.wmf",
            wmf_escape_getcolortable_start_past_count(),
        ),
        (
            "escape_eps_size_below_fixed_fields.wmf",
            wmf_escape_eps_size_below_fixed_fields(),
        ),
        (
            "escape_enhanced_metafile_size_overflow.wmf",
            wmf_escape_enhanced_metafile_size_overflow(),
        ),
        ("escape_record_size_4gb.wmf", wmf_escape_record_size_4gb()),
        (
            "deleteobject_out_of_range.wmf",
            wmf_deleteobject_out_of_range(),
        ),
        ("savedc_flood_65535_objects.wmf", wmf_savedc_flood()),
        (
            "hatched_brush_behind_opaque_text.wmf",
            wmf_hatched_brush_behind_opaque_text(),
        ),
    ]
}

fn convert_wmf(bytes: &[u8]) -> Result<String, String> {
    WMFConverter::new(bytes, SVGPlayer::new())
        .run()
        .map(|svg| String::from_utf8(svg).expect("SVG is UTF-8"))
        .map_err(|err| err.to_string())
}

#[test]
fn hostile_wmf_records_fail_or_render_without_panicking() {
    for (name, bytes) in wmf_regressions() {
        let started = Instant::now();
        let result = std::panic::catch_unwind(|| convert_wmf(&bytes));
        assert!(result.is_ok(), "{name}: WMF conversion panicked");
        assert!(
            started.elapsed() < Duration::from_secs(2),
            "{name}: took {:?}",
            started.elapsed()
        );
    }
}

/// RLE8 DIB 는 압축 스트림 그대로 색상표와 함께 BMP 로 실려 PNG 로 디코딩돼야 한다.
/// 예전에는 비압축 기하로 줄을 잘라 범위 밖 슬라이스에서 패닉했다.
#[test]
fn rle8_stretch_dib_renders_as_png() {
    let svg = convert_wmf(&wmf_stretchdib_rle8_short_image_size()).expect("RLE8 DIB renders");
    assert!(svg.contains("data:image/png"), "{svg}");
}

/// SVG 에 실린 첫 이미지의 바이트.
fn first_embedded_image(svg: &str) -> Vec<u8> {
    use base64::Engine;

    let start = svg.find(";base64,").expect("embedded image") + ";base64,".len();
    let end = start + svg[start..].find('"').expect("closing quote");
    base64::engine::general_purpose::STANDARD
        .decode(&svg[start..end])
        .expect("valid base64")
}

/// 256×256 Core DIB 는 u16 크기 계산이 넘치지 않고 24bpp 로 펼쳐진다. 펼친 뒤에도
/// 헤더가 8bpp 로 남아 있던 예전 BMP 는 픽셀 데이터와 맞지 않았다.
#[test]
fn core_header_palette_dib_expands_to_24bpp() {
    let svg = convert_wmf(&wmf(0, &[stretch_dib(&core_dib_256(256 * 256))]))
        .expect("256×256 core DIB renders");
    let bmp = first_embedded_image(&svg);

    assert_eq!(&bmp[..2], b"BM");
    assert_eq!(
        u32::from_le_bytes(bmp[14..18].try_into().unwrap()),
        12,
        "core header"
    );
    assert_eq!(u16::from_le_bytes([bmp[24], bmp[25]]), 24, "bit count");
    assert_eq!(bmp.len(), 14 + 12 + 256 * 256 * 3);
}

#[test]
fn truncated_or_oversized_dibs_are_errors() {
    for bytes in [
        wmf_stretchdib_core_header_size_overflow(),
        wmf_stretchdib_info_width_size_overflow(),
        wmf_stretchdib_rle8_image_size_4gb(),
        wmf_escape_record_size_4gb(),
    ] {
        assert!(convert_wmf(&bytes).is_err());
    }
}

/// 헤더가 객체 수를 0 으로 적은 파일의 범위 밖 DELETEOBJECT 는 무시된다.
#[test]
fn out_of_range_delete_object_is_ignored() {
    assert!(convert_wmf(&wmf_deleteobject_out_of_range()).is_ok());
}

/// 불투명 배경 텍스트 뒤의 빗금 브러시는 필터 그림으로 그려진다.
/// 예전에는 빗금 비트맵의 줄 길이가 데이터와 맞지 않아 패닉했다.
#[test]
fn hatched_brush_behind_opaque_text_renders_its_pattern() {
    let svg = convert_wmf(&wmf_hatched_brush_behind_opaque_text()).expect("hatched text renders");
    assert!(svg.contains("<filter"), "{svg}");
    assert!(svg.contains("data:image/png"), "{svg}");
}

/// SAVEDC 는 DC 상태만 복제한다. 예전에는 헤더가 선언한 65,535칸 객체 테이블까지
/// 레코드마다 복제해 6바이트 SAVEDC 5천 개가 수십 GB 를 요구했다.
#[test]
fn savedc_flood_does_not_clone_the_object_table() {
    let started = Instant::now();
    assert!(convert_wmf(&wmf_savedc_flood()).is_ok());
    assert!(
        started.elapsed() < Duration::from_secs(2),
        "{:?}",
        started.elapsed()
    );
}

// ── EMF ─────────────────────────────────────────────────────────────────────

fn emf_record(record_type: u32, payload: &[u8]) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(8 + payload.len());
    bytes.extend_from_slice(&record_type.to_le_bytes());
    bytes.extend_from_slice(&((8 + payload.len()) as u32).to_le_bytes());
    bytes.extend_from_slice(payload);
    bytes
}

/// EMR_HEADER(88바이트) + 레코드들 + EMR_EOF.
fn emf(records: &[Vec<u8>]) -> Vec<u8> {
    let mut header = Vec::with_capacity(80);
    for v in [0i32, 0, 100, 100, 0, 0, 2540, 2540] {
        header.extend_from_slice(&v.to_le_bytes()); // Bounds, Frame
    }
    header.extend_from_slice(&0x464D_4520u32.to_le_bytes()); // " EMF"
    header.extend_from_slice(&0x0001_0000u32.to_le_bytes()); // Version
    header.extend_from_slice(&0u32.to_le_bytes()); // Bytes
    header.extend_from_slice(&0u32.to_le_bytes()); // Records
    header.extend_from_slice(&1u16.to_le_bytes()); // Handles
    header.extend_from_slice(&0u16.to_le_bytes()); // Reserved
    header.extend_from_slice(&[0u8; 12]); // nDescription, offDescription, nPalEntries
    for v in [1024i32, 768, 320, 240] {
        header.extend_from_slice(&v.to_le_bytes()); // Device, Millimeters
    }

    let mut bytes = emf_record(0x01, &header);
    for record in records {
        bytes.extend_from_slice(record);
    }
    bytes.extend_from_slice(&emf_record(0x0E, &[0u8; 12]));
    bytes
}

fn emf_restoredc_most_negative() -> Vec<u8> {
    emf(&[
        emf_record(0x21, &[]), // EMR_SAVEDC
        emf_record(0x22, &i32::MIN.to_le_bytes()),
    ])
}

fn emf_stretchdibits_offset_wrap() -> Vec<u8> {
    let mut payload = vec![0u8; 72];
    payload[40..44].copy_from_slice(&0xFFFF_FFF0u32.to_le_bytes()); // offBmiSrc
    payload[44..48].copy_from_slice(&0x20u32.to_le_bytes()); // cbBmiSrc
    payload[48..52].copy_from_slice(&0xFFFF_FFFFu32.to_le_bytes()); // offBitsSrc
    payload[52..56].copy_from_slice(&0x10u32.to_le_bytes()); // cbBitsSrc
    emf(&[emf_record(0x51, &payload)])
}

fn emf_exttextoutw_offset_wrap() -> Vec<u8> {
    let mut payload = vec![0u8; 68];
    payload[36..40].copy_from_slice(&0x7FFF_FFF8u32.to_le_bytes()); // nChars
    payload[40..44].copy_from_slice(&0xFFFF_FFF8u32.to_le_bytes()); // offString
    emf(&[emf_record(0x54, &payload)])
}

/// EMR_POLYBEZIER16 (Bounds + cpts + POINTS16).
fn emf_polybezier16(points: &[(i16, i16)]) -> Vec<u8> {
    let mut payload = vec![0u8; 16]; // Bounds
    payload.extend_from_slice(&(points.len() as u32).to_le_bytes());
    for (x, y) in points {
        payload.extend_from_slice(&x.to_le_bytes());
        payload.extend_from_slice(&y.to_le_bytes());
    }
    emf(&[emf_record(0x55, &payload)])
}

/// 시작점 뒤에 곡선 한 조각(3점)을 채우지 못하는 2점.
fn emf_polybezier16_partial_segment() -> Vec<u8> {
    emf_polybezier16(&[(0, 0), (10, 10), (20, 0)])
}

fn emf_regressions() -> Vec<(&'static str, Vec<u8>)> {
    vec![
        ("restoredc_most_negative.emf", emf_restoredc_most_negative()),
        (
            "stretchdibits_offset_wrap.emf",
            emf_stretchdibits_offset_wrap(),
        ),
        ("exttextoutw_offset_wrap.emf", emf_exttextoutw_offset_wrap()),
        (
            "polybezier16_partial_segment.emf",
            emf_polybezier16_partial_segment(),
        ),
    ]
}

#[test]
fn hostile_emf_records_fail_or_render_without_panicking() {
    assert!(
        rhwp::emf::convert_to_svg(&emf_restoredc_most_negative(), (0.0, 0.0, 10.0, 10.0)).is_ok()
    );
    for bytes in [
        emf_stretchdibits_offset_wrap(),
        emf_exttextoutw_offset_wrap(),
    ] {
        assert!(rhwp::emf::convert_to_svg(&bytes, (0.0, 0.0, 10.0, 10.0)).is_err());
    }
}

/// 시작점 + 2점짜리 PolyBezier16 은 모자란 조각을 버리고 시작점만 남긴다. 예전 반복
/// 조건은 `points[3]` 을 읽어 릴리스 빌드(wasm)에서도 패닉했다.
#[test]
fn polybezier16_drops_a_partial_trailing_segment() {
    let rect = (0.0, 0.0, 10.0, 10.0);

    let svg = rhwp::emf::convert_to_svg(&emf_polybezier16_partial_segment(), rect)
        .expect("partial PolyBezier16 renders");
    assert!(svg.contains(r#"d="M0 0""#), "{svg}");

    let svg = rhwp::emf::convert_to_svg(
        &emf_polybezier16(&[(0, 0), (1, 1), (2, 2), (3, 3), (4, 4)]),
        rect,
    )
    .expect("one full segment renders");
    assert!(svg.contains(r#"d="M0 0 C1 1 2 2 3 3""#), "{svg}");
}

// ── HWP 3.0 ─────────────────────────────────────────────────────────────────

/// 숨은 설명(ch=15) 하나만 담은 문단이 `depth` 단 중첩된 문단 목록.
fn hwp3_nested_hidden_comment_list(depth: usize) -> Vec<u8> {
    let mut body = Vec::new();
    for _ in 0..depth {
        body.push(1u8); // follow_prev_para_shape
        body.extend_from_slice(&4u16.to_le_bytes()); // char_count: 컨트롤 1개 = 4 hchar
        body.extend_from_slice(&[0u8; 2 + 1 + 1 + 4 + 1 + 31]); // line_count ~ rep_char_shape
        body.extend_from_slice(&15u16.to_le_bytes()); // 여는 특수 문자 코드
        body.extend_from_slice(&0u32.to_le_bytes()); // header_val1
        body.extend_from_slice(&15u16.to_le_bytes()); // 닫는 특수 문자 코드
        body.extend_from_slice(&[0u8; 8]); // 숨은 설명 정보
    }
    for _ in 0..=depth {
        body.push(0u8);
        body.extend_from_slice(&0u16.to_le_bytes()); // char_count = 0: 목록 끝
        body.extend_from_slice(&[0u8; 40]);
    }
    body
}

/// 서명 + 문서 정보(128) + 요약(1008) + deflate 본문(글꼴 0 · 스타일 0 · 문단 목록).
fn hwp3_file_with_nested_hidden_comments(depth: usize) -> Vec<u8> {
    use std::io::Write;

    let mut body = vec![0u8; 7 * 2 + 2]; // 7개 언어 글꼴 수 = 0, 스타일 수 = 0
    body.extend_from_slice(&hwp3_nested_hidden_comment_list(depth));
    let mut encoder = flate2::write::DeflateEncoder::new(Vec::new(), flate2::Compression::best());
    encoder.write_all(&body).expect("deflate body");
    let compressed = encoder.finish().expect("deflate body");

    let mut bytes = b"HWP Document File V3.00 \x1a\x01\x02\x03\x04\x05".to_vec();
    assert_eq!(bytes.len(), 30);
    let mut doc_info = [0u8; 128];
    doc_info[124] = 1; // compressed
    bytes.extend_from_slice(&doc_info);
    bytes.extend_from_slice(&[0u8; 1008]);
    bytes.extend_from_slice(&compressed);
    bytes
}

/// 1,000단 중첩 숨은 설명(압축 1 KB 남짓)이 wasm 기본 스택(1 MiB)에서 스택
/// 오버플로 대신 오류로 끝나야 한다. 예전 파서는 이 입력에서 프로세스째 죽었다.
#[test]
fn deeply_nested_hwp3_document_is_rejected_on_a_wasm_sized_stack() {
    let bytes = hwp3_file_with_nested_hidden_comments(1000);
    assert!(
        bytes.len() < 8 * 1024,
        "fixture should stay tiny: {}",
        bytes.len()
    );

    let result = std::thread::Builder::new()
        .stack_size(1 << 20)
        .spawn(move || {
            rhwp::parser::hwp3::parse_hwp3(&bytes)
                .map(|_| ())
                .map_err(|e| e.to_string())
        })
        .expect("spawn parser thread")
        .join()
        .expect("parser thread must not panic");

    let err = result.expect_err("1,000-level nesting must be rejected");
    assert!(err.contains("중첩"), "{err}");
}

fn hwp3_regressions() -> Vec<(&'static str, Vec<u8>)> {
    vec![(
        "nested_hidden_comments_1000.hwp",
        hwp3_file_with_nested_hidden_comments(1000),
    )]
}

// ── HML ─────────────────────────────────────────────────────────────────────

fn hml_regressions() -> Vec<(&'static str, Vec<u8>)> {
    let mut xml = String::from(r#"<HWPML Version="2.91"><HEAD/><BODY><SECTION/></BODY><TAIL>"#);
    for _ in 0..=rhwp::parser::hml::HmlLimits::default().max_preserved_fragments {
        xml.push_str("<a/>");
    }
    xml.push_str("</TAIL></HWPML>");
    vec![("tail_children_over_fragment_cap.hml", xml.into_bytes())]
}

// ── 퍼징 회귀 입력 ─────────────────────────────────────────────────────────

fn regressions_dir(target: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("fuzz/regressions")
        .join(target)
}

fn all_regressions() -> Vec<(&'static str, Vec<(&'static str, Vec<u8>)>)> {
    vec![
        ("parse_wmf", wmf_regressions()),
        ("parse_emf", emf_regressions()),
        ("parse_hwp3", hwp3_regressions()),
        ("parse_hml", hml_regressions()),
    ]
}

/// 퍼징 하네스와 같은 진입점으로 `fuzz/regressions/` 의 모든 입력을 다시 돌린다.
#[test]
fn committed_fuzz_regressions_replay_without_panicking() {
    let mut replayed = 0;
    for target in [
        "parse_wmf",
        "parse_emf",
        "parse_hwp3",
        "parse_hml",
        "parse_ole_chart",
    ] {
        let Ok(entries) = std::fs::read_dir(regressions_dir(target)) else {
            continue;
        };
        for entry in entries {
            let path = entry.expect("dir entry").path();
            let bytes = std::fs::read(&path).expect("read regression input");
            let outcome = std::thread::Builder::new()
                .stack_size(1 << 20)
                .spawn(move || match target {
                    "parse_wmf" => {
                        let _ = WMFConverter::new(bytes.as_slice(), SVGPlayer::new()).run();
                    }
                    "parse_emf" => {
                        let _ = rhwp::emf::convert_to_svg(&bytes, (0.0, 0.0, 100.0, 100.0));
                    }
                    "parse_hwp3" => {
                        let _ = rhwp::parser::hwp3::parse_hwp3(&bytes);
                    }
                    "parse_hml" => {
                        let _ = rhwp::parser::hml::parse_hml(&bytes);
                    }
                    _ => {
                        if let Ok(chart) = rhwp::ole_chart::parse_ole_chart_contents(&bytes) {
                            let _ = rhwp::ole_chart::render_ole_chart_svg_fragment(
                                &chart, 0.0, 0.0, 300.0, 200.0, 1,
                            );
                        }
                    }
                })
                .expect("spawn replay thread")
                .join();
            assert!(outcome.is_ok(), "{} panicked", path.display());
            replayed += 1;
        }
    }

    let expected: usize = all_regressions().iter().map(|(_, cases)| cases.len()).sum();
    assert!(
        replayed >= expected,
        "replayed {replayed} of {expected} committed inputs"
    );
}

/// 빌더 결과를 `fuzz/regressions/` 에 쓴다. 평소에는 건너뛴다.
#[test]
#[ignore]
fn write_fuzz_regressions() {
    if std::env::var_os("RHWP_WRITE_FUZZ_REGRESSIONS").is_none() {
        return;
    }
    for (target, cases) in all_regressions() {
        let dir = regressions_dir(target);
        std::fs::create_dir_all(&dir).expect("create regressions dir");
        for (name, bytes) in cases {
            std::fs::write(dir.join(name), bytes).expect("write regression input");
        }
    }
}
