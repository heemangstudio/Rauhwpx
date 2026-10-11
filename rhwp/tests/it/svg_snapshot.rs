//! SVG snapshot regression tests for HWPX rendering.
//!
//! Pure-Rust replacement for `tools/verify_hwpx.py`, which requires Windows
//! + Hancom Office + pyhwpx and cannot run in CI. This harness invokes
//!   `rhwp::wasm_api::HwpDocument::render_page_svg_native()` directly so the
//!   same SVG the CLI produces is diffed against committed golden files.
//!
//! # Updating goldens
//!
//! When rhwp's rendering intentionally changes, regenerate goldens:
//!
//! ```sh
//! UPDATE_GOLDEN=1 cargo test --test svg_snapshot
//! ```
//!
//! Commit the resulting `tests/golden_svg/**/*.svg` files alongside the
//! source change and mention the intentional diff in the PR body.
//!
//! # Determinism
//!
//! These tests assume:
//! - `render_page_svg_native` output is deterministic for a fixed input
//!   (no timestamps, no random IDs, no host-font-dependent glyph IDs).
//! - Font embedding is OFF (`FontEmbedMode::None` via the native entry
//!   point) so host system fonts cannot leak into the snapshot.
//!
//! If a flake is observed, the first debugging step is to diff two
//! back-to-back runs on the same machine. Host-specific variance
//! indicates a real determinism bug — worth its own issue.

use std::fs;
use std::path::{Path, PathBuf};

/// Generate an SVG for a specific page and compare against the committed
/// golden. Set `UPDATE_GOLDEN=1` to regenerate.
fn check_snapshot(hwpx_relpath: &str, page: u32, golden_name: &str) {
    let repo_root = env!("CARGO_MANIFEST_DIR");
    let hwpx_path = Path::new(repo_root).join(hwpx_relpath);
    let bytes =
        fs::read(&hwpx_path).unwrap_or_else(|e| panic!("read {}: {}", hwpx_path.display(), e));

    let doc = rhwp::wasm_api::HwpDocument::from_bytes(&bytes)
        .unwrap_or_else(|e| panic!("parse {}: {}", hwpx_relpath, e));

    let actual = doc
        .render_page_svg_native(page)
        .unwrap_or_else(|e| panic!("render {} p.{}: {}", hwpx_relpath, page, e));

    let golden_path = PathBuf::from(repo_root)
        .join("tests/golden_svg")
        .join(format!("{golden_name}.svg"));

    if std::env::var("UPDATE_GOLDEN").as_deref() == Ok("1") {
        if let Some(parent) = golden_path.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(&golden_path, &actual).unwrap();
        eprintln!("UPDATED {}", golden_path.display());
        return;
    }

    let expected = fs::read_to_string(&golden_path).unwrap_or_else(|e| {
        panic!(
            "missing golden {}: {}. Run `UPDATE_GOLDEN=1 cargo test --test svg_snapshot` to create.",
            golden_path.display(),
            e
        )
    });

    if actual != expected {
        // Write the actual output next to the golden for local inspection
        // without polluting the committed tree.
        let actual_path = golden_path.with_extension("actual.svg");
        let _ = fs::write(&actual_path, &actual);
        panic!(
            "SVG snapshot mismatch for {}.\n  expected: {}\n  actual:   {}\n\
             Inspect the diff; if intentional, rerun with UPDATE_GOLDEN=1.",
            golden_name,
            golden_path.display(),
            actual_path.display()
        );
    }
}

#[test]
fn table_text_page_0() {
    check_snapshot("samples/hwpx/table-text.hwpx", 0, "table-text/page-0");
}

/// Issue #147: aift.hwp 4페이지 — MEMO 컨트롤이 바탕쪽으로 오분류되어 렌더링되는 버그
#[test]
fn issue_147_aift_page3() {
    check_snapshot("samples/aift.hwp", 3, "issue-147/aift-page3");
}

/// Determinism probe: render the same page twice in one process and assert
/// byte-for-byte equality. If this ever fails, the snapshot tests above
/// are unreliable regardless of golden correctness.
#[test]
fn render_is_deterministic_within_process() {
    let repo_root = env!("CARGO_MANIFEST_DIR");
    let bytes =
        fs::read(Path::new(repo_root).join("samples/hwpx/form-002.hwpx")).expect("sample present");

    let doc = rhwp::wasm_api::HwpDocument::from_bytes(&bytes).expect("parse");
    let a = doc.render_page_svg_native(0).expect("render #1");
    let b = doc.render_page_svg_native(0).expect("render #2");
    assert_eq!(a, b, "render_page_svg_native must be deterministic");
}
