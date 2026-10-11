//! 통합 테스트 공용 헬퍼. 샘플 경로는 `rhwp/` 기준 상대 경로다.

use std::path::{Path, PathBuf};
use std::process::{Command, Output};

use rhwp::document_core::DocumentCore;
use rhwp::wasm_api::HwpDocument;

pub fn sample_path(rel: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join(rel)
}

pub fn read_sample(rel: &str) -> Vec<u8> {
    std::fs::read(sample_path(rel)).unwrap_or_else(|e| panic!("read {rel}: {e}"))
}

pub fn load_doc(rel: &str) -> HwpDocument {
    HwpDocument::from_bytes(&read_sample(rel)).unwrap_or_else(|e| panic!("parse {rel}: {e:?}"))
}

pub fn load_core(rel: &str) -> DocumentCore {
    DocumentCore::from_bytes(&read_sample(rel)).unwrap_or_else(|e| panic!("parse {rel}: {e:?}"))
}

/// 테스트 대상 CLI. nextest 아카이브 실행은 `CARGO_BIN_EXE_rhwp` 를 런타임에 재매핑해
/// 주입하므로 그 값을 컴파일타임 경로보다 우선한다 (#3289).
pub fn rhwp_bin() -> String {
    std::env::var("CARGO_BIN_EXE_rhwp").unwrap_or_else(|_| env!("CARGO_BIN_EXE_rhwp").to_string())
}

pub fn run(args: &[&str]) -> Output {
    Command::new(rhwp_bin())
        .args(args)
        .output()
        .expect("rhwp 실행 실패")
}

/// 실패 메시지용 명령·출력 요약.
pub fn describe(args: &[&str], output: &Output) -> String {
    format!(
        "명령: rhwp {}\nstdout:\n{}\nstderr:\n{}",
        args.join(" "),
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    )
}

/// 종료 코드를 확인하고 출력을 돌려준다.
pub fn assert_code(args: &[&str], expected: i32) -> Output {
    let output = run(args);
    assert_eq!(
        output.status.code(),
        Some(expected),
        "종료 코드 {expected} 를 기대했다\n{}",
        describe(args, &output)
    );
    output
}

/// stdout 전체가 JSON 하나여야 한다(`--json` 계약).
pub fn parse_json(args: &[&str], output: &Output) -> serde_json::Value {
    serde_json::from_slice(&output.stdout).unwrap_or_else(|e| {
        panic!(
            "stdout 이 순수 JSON 이 아닙니다 ({e}).\n{}",
            describe(args, output)
        )
    })
}
