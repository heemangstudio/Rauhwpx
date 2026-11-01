//! 엔진 통합 테스트를 바이너리 하나로 묶는다. 새 테스트는 이 디렉터리에 모듈 파일로 추가하고
//! 아래에 `mod` 를 등록한다. 공용 헬퍼는 `common.rs` 에 둔다.

mod cli_exit_codes;
mod cli_json_contract;
mod common;
mod hml_parser;
mod hostile_embedded_input;
mod hwpx_border_line_semantics;
mod hwpx_empty_text_fragments;
mod issue_1008_gradient;
mod issue_1028_hwpx_textbox_vertical;
mod issue_1608_hwpx_native_no_hwp3_tolerance;
mod issue_2722_table_grid_alloc;
mod issue_2743_hml_resource_id_limit;
mod issue_2833_hml_adapter_row_sizes;
mod issue_3349_export_text_option_order;
mod issue_6868_cross_section_orphan_field_end;
mod issue_824;
mod issue_825;
mod issue_929;
mod issue_hml_shape_child_attribution;
mod lenient_cfb_path_lookup;
