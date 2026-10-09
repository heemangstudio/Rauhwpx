//! 말뭉치 전수 라운드트립 baseline 과 디버그 빌드에서 20초 이상 걸리는 테스트.
//! 기본 `cargo test` 는 건너뛴다(`test = false`). 실행: `cargo test --profile release-test --test sweeps`.
//! 빠른 회귀 테스트는 `tests/it/` 에 둔다.

mod huge_table_page_pins;
mod hwp5_roundtrip_baseline;
mod hwp5_serialize_all_samples;
mod hwpx_roundtrip_baseline;
mod ir_field_sweep_baseline;
mod issue_1402_enum_token_whitelist;
mod line_spacing_pagination;
mod visual_roundtrip_baseline;
