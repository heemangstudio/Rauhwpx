//! 쪽 › 쪽 여백 프리셋: `set_page_def_all_native` 는 모든 구역에 주어진 키만 덮어쓰고
//! 용지·방향·제본 여백은 구역마다 그대로 둔다.

use super::common::load_core;

#[test]
fn set_page_def_all_updates_only_given_keys_in_every_section() {
    let mut core = load_core("samples/2026_oss_rst.hwp");
    let before: Vec<_> = core
        .document()
        .sections
        .iter()
        .map(|s| s.section_def.page_def.clone())
        .collect();
    assert!(before.len() > 1, "다구역 샘플이어야 한다");

    let result = core
        .set_page_def_all_native(r#"{"marginTop":1417,"marginBottom":1417,"marginHeader":2835}"#)
        .unwrap();
    assert!(result.contains("\"ok\":true"), "{result}");

    for (i, (old, section)) in before.iter().zip(&core.document().sections).enumerate() {
        let new = &section.section_def.page_def;
        assert_eq!(
            (new.margin_top, new.margin_bottom, new.margin_header),
            (1417, 1417, 2835),
            "구역 {i}"
        );
        assert_eq!(
            (
                new.width,
                new.height,
                new.landscape,
                new.margin_left,
                new.margin_right,
                new.margin_footer,
                new.margin_gutter,
            ),
            (
                old.width,
                old.height,
                old.landscape,
                old.margin_left,
                old.margin_right,
                old.margin_footer,
                old.margin_gutter,
            ),
            "구역 {i} 의 다른 쪽 설정이 바뀌었다"
        );
    }
}
