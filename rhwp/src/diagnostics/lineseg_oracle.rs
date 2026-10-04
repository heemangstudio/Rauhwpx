//! LINE_SEG 오라클 — 한컴이 저장한 줄 배치를 정답으로 엔진 줄 계산을 채점한다.
//!
//! 한컴은 저장 파일마다 자기 조판 결과(HWPX `<hp:linesegarray>`, HWP5 PARA_LINE_SEG)를
//! 남긴다. 엔진은 일관된 저장값을 그대로 쓰므로 PDF 정합은 대부분 한컴 조판을 반영하고,
//! 저장값이 없을 때(편집 후 포함) 쓰는 우리 줄 계산은 따로 측정되지 않는다. 이 도구는
//! 저장값이 있는 문단을 저장값 없이 `reflow_line_segs` 로 다시 계산해 줄 단위로 비교한다.
//!
//! - `full`: 편집 reflow 와 같은 폭 해석 (본문 단 폭−여백, 셀/글상자 내폭−여백,
//!   머리말 = 쪽 본문 폭−여백, 각주·미주 = 단 폭−여백)
//! - `given`: 저장 첫 줄 segment_width 를 폭으로 준다 — 폭 해석 오류를 빼고 줄 계산만 본다
//!
//! vertical_pos 는 앞 문단의 저장 끝에서 편집 경로(`recalculate_section_vpos`)로 이어 붙인
//! 값이다. flags 는 구현 비트와 쪽/단 첫 줄 비트(조판 결과)를 빼고 비교한다.
//!
//! ```text
//! rhwp lineseg-oracle <문서 | --batch 폴더> [-o 출력폴더] [--font-path 경로]... [-j N]
//!                     [--edit-scope] [--json]
//! ```
//!
//! 출력: `summary.json`(문서별 + 한컴 저장 문서 합계), `mismatches.tsv`(문단당 첫 불일치
//! 줄 1행, 모드별), `docs/<id>.json`.

use std::collections::BTreeMap;
use std::fmt::Write as _;
use std::fs;
use std::io::Read as _;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use serde_json::{json, Value};

use crate::document_core::DocumentCore;
use crate::model::control::Control;
use crate::model::document::Document;
use crate::model::paragraph::{LineSeg, Paragraph};
use crate::model::style::{Alignment, LineSpacingType};
use crate::parser::FileFormat;
use crate::renderer::composer::{
    recalculate_section_vpos, reflow_line_segs, tokenize_paragraph, BreakToken,
};
use crate::renderer::style_resolver::ResolvedStyleSet;
use crate::renderer::{hwpunit_to_px, px_to_hwpunit};

const FIELDS: [&str; 8] = [
    "line_height",
    "text_height",
    "baseline_distance",
    "line_spacing",
    "vertical_pos",
    "segment_width",
    "column_start",
    "flags",
];
const FLAG_MASK: u32 = !(LineSeg::TAG_IMPLEMENTATION_PROPERTY
    | LineSeg::TAG_FIRST_LINE_OF_PAGE
    | LineSeg::TAG_FIRST_LINE_OF_COLUMN);
const MODES: [&str; 2] = ["full", "given"];
/// `--path load`: 저장값을 버리고 로드한 엔진 결과(로드 시 합성 LINE_SEG)를 채점한다.
const LOAD_MODES: [&str; 1] = ["load"];

fn modes(load: bool) -> &'static [&'static str] {
    if load {
        &LOAD_MODES
    } else {
        &MODES
    }
}
/// rhwp HWPX 직렬화 템플릿의 appVersion — 한컴 저장과 구분할 수 없어 제외한다.
const RHWP_TEMPLATE_APP_VERSION: &str = "11, 0, 0, 3524 WIN32LEWindows_8";
const TSV_HEADER: &str =
    "doc\tmode\tcontainer\tdepth\tpath\tclass\tline\tn_stored\tn_ours\tbad_lines\tkind\t\
field\tours\tstored\tdelta\tdiffs\tbreak_delta_chars\tfont_hangul\tfont_latin\tsize_pt\t\
max_size_pt\tn_styles\tratio\tlatin_ratio\tspacing_pct\tbold\talign\tls_type\tls_value\t\
sp_before_hu\tsp_after_hu\tindent_hu\tmargin_l_hu\tmargin_r_hu\twidth_hu\tours_width_hu\t\
chars\thangul\tlatin\tdigit\tpunct\tspace\tother\tends_space\tctx_stored\tctx_ours\tvalign\thead\tfont_lh\tstored_seg\tours_seg\tmeasured_hu\tavail_hu\tours_measured_hu\n";

fn seg_fields(s: &LineSeg) -> [i64; 8] {
    [
        s.line_height as i64,
        s.text_height as i64,
        s.baseline_distance as i64,
        s.line_spacing as i64,
        s.vertical_pos as i64,
        s.segment_width as i64,
        s.column_start as i64,
        (s.tag & FLAG_MASK) as i64,
    ]
}

/// 줄 단위 비교 집계. 필드 일치율의 분모는 정렬된 줄(시작·끝이 같은 줄)이다.
#[derive(Debug, Default, Clone)]
pub struct Tally {
    pub paras: u64,
    pub para_exact: u64,
    pub para_breaks: u64,
    pub lines: u64,
    pub lines_aligned: u64,
    pub exact: [u64; 8],
    pub within1: [u64; 8],
    pub within10: [u64; 8],
}

impl Tally {
    fn add(&mut self, o: &Tally) {
        self.paras += o.paras;
        self.para_exact += o.para_exact;
        self.para_breaks += o.para_breaks;
        self.lines += o.lines;
        self.lines_aligned += o.lines_aligned;
        for i in 0..8 {
            self.exact[i] += o.exact[i];
            self.within1[i] += o.within1[i];
            self.within10[i] += o.within10[i];
        }
    }

    fn to_json(&self) -> Value {
        let pct = |n: u64, d: u64| {
            if d == 0 {
                Value::Null
            } else {
                json!((n as f64 * 1000.0 / d as f64).round() / 10.0)
            }
        };
        let fields: serde_json::Map<String, Value> = FIELDS
            .iter()
            .enumerate()
            .map(|(i, name)| {
                let a = self.lines_aligned;
                let v = json!({
                    "exact": pct(self.exact[i], a),
                    "pm1": pct(self.within1[i], a),
                    "pm10": pct(self.within10[i], a),
                });
                (name.to_string(), v)
            })
            .collect();
        json!({
            "paras": self.paras,
            "para_exact_pct": pct(self.para_exact, self.paras),
            "para_break_pct": pct(self.para_breaks, self.paras),
            "lines": self.lines,
            "line_aligned_pct": pct(self.lines_aligned, self.lines),
            "fields_pct": fields,
        })
    }
}

/// 문단 하나의 줄 비교 결과.
#[derive(Debug, Default)]
pub struct LineCompare {
    pub break_match: bool,
    pub exact: bool,
    pub tally: Tally,
    /// 첫 불일치: (저장 줄 인덱스, 줄바꿈 불일치 여부, [(필드, 우리, 저장)])
    pub first: Option<(usize, bool, Vec<(usize, i64, i64)>)>,
    /// 정렬되지 않았거나 필드가 다른 저장 줄 수
    pub bad_lines: usize,
}

/// 저장 줄과 재계산 줄을 비교한다. 줄 i 는 [text_start_i, text_start_{i+1}) 범위로
/// 정렬하며, 시작과 끝이 같은 줄만 필드를 비교한다.
pub fn compare_lines(stored: &[LineSeg], ours: &[LineSeg]) -> LineCompare {
    let end = |segs: &[LineSeg], i: usize| segs.get(i + 1).map(|s| s.text_start);
    let mut out = LineCompare {
        break_match: stored.len() == ours.len()
            && stored
                .iter()
                .zip(ours)
                .all(|(s, o)| s.text_start == o.text_start),
        ..Default::default()
    };
    let mut fields_ok = true;
    out.tally.paras = 1;
    out.tally.lines = stored.len() as u64;
    for (si, s) in stored.iter().enumerate() {
        let oi = ours.iter().position(|o| o.text_start == s.text_start);
        let aligned = oi.filter(|&oi| end(ours, oi) == end(stored, si));
        let Some(oi) = aligned else {
            if out.first.is_none() {
                out.first = Some((si, true, Vec::new()));
            }
            out.bad_lines += 1;
            continue;
        };
        out.tally.lines_aligned += 1;
        let (sv, ov) = (seg_fields(s), seg_fields(&ours[oi]));
        let mut diffs = Vec::new();
        for f in 0..8 {
            let d = (ov[f] - sv[f]).abs();
            out.tally.exact[f] += (d == 0) as u64;
            out.tally.within1[f] += (d <= 1) as u64;
            out.tally.within10[f] += (d <= 10) as u64;
            if d != 0 {
                diffs.push((f, ov[f], sv[f]));
            }
        }
        if !diffs.is_empty() {
            fields_ok = false;
            out.bad_lines += 1;
            if out.first.is_none() {
                out.first = Some((si, false, diffs));
            }
        }
    }
    out.exact = out.break_match && fields_ok;
    out.tally.para_breaks = out.break_match as u64;
    out.tally.para_exact = out.exact as u64;
    out
}

#[derive(Debug)]
struct Options {
    input: PathBuf,
    batch: bool,
    out_dir: PathBuf,
    font_paths: Vec<PathBuf>,
    jobs: usize,
    json: bool,
    /// 렌더 레이아웃과 같은 글꼴 스코프(문서 shaping 글꼴 + --font-path 측정 경로)에서
    /// 측정한다. 끄면(`--edit-scope`) 네이티브 편집 명령처럼 스코프 없이 측정한다.
    render_scope: bool,
    /// `--path load`: 저장 LINE_SEG 를 버리고 로드(`RHWP_IGNORE_STORED_LINESEGS=1` 과 같은
    /// 누락 합성 경로)한 결과를 비교한다. 기본은 편집 reflow 경로(`edit`).
    load: bool,
}

fn parse_args(args: &[String]) -> Result<Options, String> {
    let usage = "사용법: rhwp lineseg-oracle <문서 | --batch 폴더> [-o 출력폴더] \
                 [--font-path 경로]... [-j N] [--edit-scope] [--path edit|load] [--json]";
    let mut input = None;
    let mut opts = Options {
        input: PathBuf::new(),
        batch: false,
        out_dir: PathBuf::from("output/lineseg-oracle"),
        font_paths: Vec::new(),
        jobs: 4,
        json: false,
        render_scope: true,
        load: false,
    };
    let mut it = args.iter();
    while let Some(a) = it.next() {
        let mut value = || {
            it.next()
                .cloned()
                .ok_or_else(|| format!("{a} 다음 값이 필요합니다"))
        };
        match a.as_str() {
            "--batch" => opts.batch = true,
            "--json" => opts.json = true,
            "--edit-scope" => opts.render_scope = false,
            "--path" => {
                opts.load = match value()?.as_str() {
                    "load" => true,
                    "edit" => false,
                    o => return Err(format!("--path 는 edit|load: {o}")),
                }
            }
            "-o" | "--out" => opts.out_dir = PathBuf::from(value()?),
            "--font-path" => opts.font_paths.push(PathBuf::from(value()?)),
            "-j" => opts.jobs = value()?.parse().map_err(|_| "-j 는 정수".to_string())?,
            "-h" | "--help" => return Err(usage.to_string()),
            o if o.starts_with('-') => return Err(format!("알 수 없는 옵션: {o}\n{usage}")),
            o => input = Some(PathBuf::from(o)),
        }
    }
    opts.input = input.ok_or_else(|| usage.to_string())?;
    opts.jobs = opts.jobs.max(1);
    Ok(opts)
}

pub fn run(args: &[String]) {
    let opts = match parse_args(args) {
        Ok(o) => o,
        Err(e) => {
            eprintln!("{e}");
            std::process::exit(2);
        }
    };
    if std::env::var_os(crate::document_core::IGNORE_STORED_LINESEGS_ENV).is_some() {
        eprintln!("오류: RHWP_IGNORE_STORED_LINESEGS 가 설정되면 비교할 엔진 상태가 없습니다");
        std::process::exit(2);
    }
    // 글꼴 경로 등록은 네이티브 전용 (wasm 빌드에는 font_paths 모듈이 없다).
    #[cfg(not(target_arch = "wasm32"))]
    crate::renderer::font_paths::register_font_face_availability(&opts.font_paths);

    let (root, files) = if opts.batch {
        let mut files = Vec::new();
        collect_files(&opts.input, &mut files);
        files.sort();
        (opts.input.clone(), files)
    } else {
        let root = opts
            .input
            .parent()
            .map(Path::to_path_buf)
            .unwrap_or_default();
        (root, vec![opts.input.clone()])
    };
    if let Err(e) = fs::create_dir_all(opts.out_dir.join("docs")) {
        eprintln!("오류: 출력 폴더 생성 실패 {}: {e}", opts.out_dir.display());
        std::process::exit(1);
    }

    let queue = Arc::new(Mutex::new(
        files.into_iter().enumerate().collect::<Vec<_>>(),
    ));
    let results = Arc::new(Mutex::new(Vec::new()));
    let total = queue.lock().map(|q| q.len()).unwrap_or(0);
    std::thread::scope(|scope| {
        for _ in 0..opts.jobs.min(total.max(1)) {
            let (queue, results, root, opts) = (queue.clone(), results.clone(), &root, &opts);
            let worker = std::thread::Builder::new().stack_size(64 << 20);
            let spawned = worker.spawn_scoped(scope, move || loop {
                let Some((idx, path)) = queue.lock().ok().and_then(|mut q| q.pop()) else {
                    break;
                };
                let id = path
                    .strip_prefix(root)
                    .unwrap_or(&path)
                    .to_string_lossy()
                    .to_string();
                let run = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    process_doc(&path, &id, &opts)
                }));
                let doc = run.unwrap_or_else(|_| DocResult::failed(&id, "panic"));
                eprintln!("[{}/{total}] {} {}", total - idx, doc.status, id);
                if let Ok(mut r) = results.lock() {
                    r.push(doc);
                }
            });
            if let Err(e) = spawned {
                eprintln!("오류: 작업 스레드 생성 실패: {e}");
            }
        }
    });
    let mut docs = Arc::try_unwrap(results)
        .ok()
        .and_then(|m| m.into_inner().ok())
        .unwrap_or_default();
    docs.sort_by(|a, b| a.id.cmp(&b.id));

    let summary = write_outputs(&opts.out_dir, &docs);
    if opts.json {
        println!(
            "{}",
            serde_json::to_string_pretty(&summary).unwrap_or_default()
        );
    } else {
        print_headline(&summary);
    }
}

fn collect_files(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for e in entries.flatten() {
        let p = e.path();
        if p.is_dir() {
            collect_files(&p, out);
        } else if p
            .extension()
            .and_then(|x| x.to_str())
            .is_some_and(|x| x.eq_ignore_ascii_case("hwp") || x.eq_ignore_ascii_case("hwpx"))
        {
            out.push(p);
        }
    }
}

struct DocResult {
    id: String,
    status: &'static str,
    error: String,
    format: &'static str,
    app: String,
    hancom: bool,
    exclude_reason: String,
    flagged_seg_share: f64,
    skipped: BTreeMap<&'static str, u64>,
    /// "모드/분류" → 집계 (분류: all, container:*, class:*)
    tallies: BTreeMap<String, Tally>,
    tsv: String,
}

impl DocResult {
    fn failed(id: &str, error: &str) -> Self {
        DocResult {
            id: id.to_string(),
            status: "FAIL",
            error: error.to_string(),
            format: "?",
            app: String::new(),
            hancom: false,
            exclude_reason: String::new(),
            flagged_seg_share: 0.0,
            skipped: BTreeMap::new(),
            tallies: BTreeMap::new(),
            tsv: String::new(),
        }
    }
}

fn process_doc(path: &Path, id: &str, opts: &Options) -> DocResult {
    let data = match fs::read(path) {
        Ok(d) => d,
        Err(e) => return DocResult::failed(id, &e.to_string()),
    };
    let format = crate::parser::detect_format(&data);
    let raw = match crate::parser::parse_document(&data) {
        Ok(d) => d,
        Err(e) => return DocResult::failed(id, &format!("parse: {e}")),
    };
    let loaded = if opts.load {
        DocumentCore::from_bytes_ignoring_stored_linesegs(&data)
    } else {
        DocumentCore::from_bytes(&data)
    };
    let core = match loaded {
        Ok(c) => c,
        Err(e) => return DocResult::failed(id, &format!("load: {e:?}")),
    };
    #[cfg(not(target_arch = "wasm32"))]
    let _scopes = opts.render_scope.then(|| {
        (
            core.resolved_shaping_font_scope(),
            crate::renderer::layout::enter_measure_font_paths(opts.font_paths.clone()),
        )
    });
    #[cfg(target_arch = "wasm32")]
    let _scopes = opts
        .render_scope
        .then(|| core.resolved_shaping_font_scope());
    let mut doc = DocResult::failed(id, "");
    doc.status = "OK";
    doc.format = match format {
        FileFormat::Hwp => "hwp5",
        FileFormat::Hwpx => "hwpx",
        FileFormat::Hwp3 => "hwp3",
        FileFormat::Hml => "hml",
        _ => "other",
    };
    (doc.app, doc.exclude_reason) = provenance(format, &data, &raw);

    let mut ctx = Ctx {
        core: &core,
        styles: &core.styles,
        dpi: core.dpi,
        doc: &mut doc,
        flagged_segs: 0,
        all_segs: 0,
        load: opts.load,
        squeeze: false,
    };
    for (si, (sec, raw_sec)) in core.document.sections.iter().zip(&raw.sections).enumerate() {
        let mut prev: Option<(&Paragraph, &Paragraph)> = None;
        for (pi, (para, raw_para)) in sec.paragraphs.iter().zip(&raw_sec.paragraphs).enumerate() {
            let width = Some(core.body_reflow_width(si, pi));
            let label = format!("s{si}/p{pi}");
            ctx.compare(Site::new("body", 0, &label), para, raw_para, prev, width);
            if !raw_para.line_segs.is_empty() {
                prev = Some((raw_para, para));
            }
            ctx.visit_controls(si, pi, &mut Vec::new(), para, raw_para, &label);
        }
    }
    if ctx.all_segs > 0 {
        let share = ctx.flagged_segs as f64 / ctx.all_segs as f64;
        ctx.doc.flagged_seg_share = (share * 1000.0).round() / 1000.0;
        // 한컴은 줄마다 첫/마지막 세그먼트 비트를 남긴다. 대부분 빠졌으면 다른 저장기다.
        if share < 0.5 && ctx.doc.exclude_reason.is_empty() {
            ctx.doc.exclude_reason = "segment flags missing (non-Hancom writer?)".into();
        }
    }
    doc.hancom = doc.exclude_reason.is_empty();
    doc
}

fn provenance(format: FileFormat, data: &[u8], raw: &Document) -> (String, String) {
    match format {
        FileFormat::Hwpx => {
            let version = read_zip_entry(data, "version.xml").unwrap_or_default();
            let attr = |name: &str| {
                let key = format!(" {name}=");
                version.find(&key).and_then(|at| {
                    let rest = &version[at + key.len()..];
                    let quote = rest.chars().next()?;
                    rest[1..].split(quote).next().map(str::to_string)
                })
            };
            let app = attr("application").unwrap_or_default();
            let app_version = attr("appVersion").unwrap_or_default();
            let label = format!("{app} {app_version}").trim().to_string();
            let reason = if raw
                .hwpx_aux_entry(crate::model::document::HWP5_ORIGIN_HWPX_MARKER_PATH)
                .is_some()
            {
                "rhwp HWP5→HWPX export"
            } else if !(app.contains("Hancom") || app.contains("Hangul") || app.contains("한글"))
            {
                "version.xml not Hancom"
            } else if app_version == RHWP_TEMPLATE_APP_VERSION {
                "rhwp serializer template version (suspected generated)"
            } else {
                ""
            };
            (label, reason.to_string())
        }
        FileFormat::Hwp => {
            let v = &raw.header.version;
            let label = format!("HWP {}.{}.{}.{}", v.major, v.minor, v.build, v.revision);
            (label, String::new())
        }
        FileFormat::Hwp3 => ("HWP 3.0".into(), "hwp3 (converted line data)".into()),
        _ => (String::new(), "unsupported format".into()),
    }
}

fn read_zip_entry(data: &[u8], name: &str) -> Option<String> {
    let mut zip = zip::ZipArchive::new(std::io::Cursor::new(data)).ok()?;
    let mut file = zip.by_name(name).ok()?;
    let mut s = String::new();
    file.read_to_string(&mut s).ok()?;
    Some(s)
}

#[derive(Clone)]
struct Site<'a> {
    container: &'static str,
    depth: usize,
    path: &'a str,
}

impl<'a> Site<'a> {
    fn new(container: &'static str, depth: usize, path: &'a str) -> Self {
        Site {
            container,
            depth,
            path,
        }
    }
}

/// 쪽 단위 목록(머리말·꼬리말·주석) 문단 폭 해석.
#[derive(Clone, Copy)]
enum PageListWidth {
    /// 머리말/꼬리말: `DocumentCore::page_text_line_width_px` (구역).
    PageText(usize),
    /// 각주(true)/미주(false): `DocumentCore::note_reflow_width` (구역, 본문 문단).
    Note(usize, usize, bool),
}

struct Ctx<'a> {
    core: &'a DocumentCore,
    styles: &'a ResolvedStyleSet,
    dpi: f64,
    doc: &'a mut DocResult,
    flagged_segs: u64,
    all_segs: u64,
    load: bool,
    /// 지금 비교 중인 셀이 `글자 줄임`(Squeeze) 셀인지 (편집 경로 셀 줄 합성과 같게).
    squeeze: bool,
}

impl Ctx<'_> {
    fn skip(&mut self, reason: &'static str) {
        *self.doc.skipped.entry(reason).or_default() += 1;
    }

    /// 문단 `para`(엔진 로드본) 하위 컨테이너를 순회한다. `prefix` 는 편집 path
    /// (`(ctrl, cell, cell_para)` 사슬) — 셀·글상자·캡션 폭 해석에 그대로 쓴다.
    #[allow(clippy::too_many_arguments)]
    fn visit_controls(
        &mut self,
        si: usize,
        pi: usize,
        prefix: &mut Vec<(usize, usize, usize)>,
        para: &Paragraph,
        raw_para: &Paragraph,
        label: &str,
    ) {
        for (ci, (ctrl, raw_ctrl)) in para.controls.iter().zip(&raw_para.controls).enumerate() {
            match (ctrl, raw_ctrl) {
                (Control::Table(t), Control::Table(rt)) => {
                    // 셀 폭은 표를 한 번만 풀어 편집 경로와 같은 규칙으로 구한다.
                    let metrics = DocumentCore::table_cells_reflow_metrics(
                        t,
                        self.styles,
                        self.dpi,
                        self.core.document.layout_profile(),
                    );
                    for (cell_idx, (cell, raw_cell)) in t.cells.iter().zip(&rt.cells).enumerate() {
                        let l = format!("{label}/c{ci}/cell{cell_idx}");
                        let (cps, rps) = (&cell.paragraphs, &raw_cell.paragraphs);
                        let at = (ci, cell_idx, metrics.get(cell_idx).copied().flatten());
                        let squeeze = cell.line_wrap == crate::model::table::CellLineWrap::Squeeze;
                        let saved = std::mem::replace(&mut self.squeeze, squeeze);
                        self.visit_list(si, pi, prefix, at, "cell", cps, rps, &l);
                        self.squeeze = saved;
                    }
                    if let (Some(c), Some(rc)) = (&t.caption, &rt.caption) {
                        let l = format!("{label}/c{ci}/caption");
                        let (cps, rps) = (&c.paragraphs, &rc.paragraphs);
                        let saved = std::mem::replace(&mut self.squeeze, false);
                        self.visit_list(si, pi, prefix, (ci, 65534, None), "caption", cps, rps, &l);
                        self.squeeze = saved;
                    }
                }
                (Control::Shape(s), Control::Shape(rs)) => {
                    let tb = crate::document_core::helpers::get_textbox_from_shape(s);
                    let rtb = crate::document_core::helpers::get_textbox_from_shape(rs);
                    if let (Some(tb), Some(rtb)) = (tb, rtb) {
                        let l = format!("{label}/c{ci}/textbox");
                        let (cps, rps) = (&tb.paragraphs, &rtb.paragraphs);
                        let saved = std::mem::replace(&mut self.squeeze, false);
                        self.visit_list(si, pi, prefix, (ci, 0, None), "textbox", cps, rps, &l);
                        self.squeeze = saved;
                    }
                }
                (Control::Picture(p), Control::Picture(rp)) => {
                    if let (Some(c), Some(rc)) = (&p.caption, &rp.caption) {
                        let l = format!("{label}/c{ci}/caption");
                        let (cps, rps) = (&c.paragraphs, &rc.paragraphs);
                        let saved = std::mem::replace(&mut self.squeeze, false);
                        self.visit_list(si, pi, prefix, (ci, 0, None), "caption", cps, rps, &l);
                        self.squeeze = saved;
                    }
                }
                // 머리말/꼬리말·각주/미주: 편집 reflow 와 같은 폭. 내부 표는 제외.
                (Control::Header(h), Control::Header(rh)) if prefix.is_empty() => self
                    .visit_page_list(
                        "header",
                        &h.paragraphs,
                        &rh.paragraphs,
                        label,
                        ci,
                        PageListWidth::PageText(si),
                    ),
                (Control::Footer(f), Control::Footer(rf)) if prefix.is_empty() => self
                    .visit_page_list(
                        "footer",
                        &f.paragraphs,
                        &rf.paragraphs,
                        label,
                        ci,
                        PageListWidth::PageText(si),
                    ),
                (Control::Footnote(n), Control::Footnote(rn)) if prefix.is_empty() => self
                    .visit_page_list(
                        "footnote",
                        &n.paragraphs,
                        &rn.paragraphs,
                        label,
                        ci,
                        PageListWidth::Note(si, pi, true),
                    ),
                (Control::Endnote(n), Control::Endnote(rn)) if prefix.is_empty() => self
                    .visit_page_list(
                        "endnote",
                        &n.paragraphs,
                        &rn.paragraphs,
                        label,
                        ci,
                        PageListWidth::Note(si, pi, false),
                    ),
                (Control::Header(_) | Control::Footer(_), _)
                | (Control::Footnote(_) | Control::Endnote(_), _) => self.skip("nested_page_note"),
                (a, b) if std::mem::discriminant(a) != std::mem::discriminant(b) => {
                    self.skip("structure_mismatch")
                }
                _ => {}
            }
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn visit_list(
        &mut self,
        si: usize,
        pi: usize,
        prefix: &mut Vec<(usize, usize, usize)>,
        (ci, cell_idx, metrics): (usize, usize, Option<(u32, i16, i16)>),
        container: &'static str,
        paras: &[Paragraph],
        raw_paras: &[Paragraph],
        label: &str,
    ) {
        if paras.len() != raw_paras.len() {
            self.skip("structure_mismatch");
            return;
        }
        let mut prev: Option<(&Paragraph, &Paragraph)> = None;
        for (cpi, (para, raw_para)) in paras.iter().zip(raw_paras).enumerate() {
            prefix.push((ci, cell_idx, cpi));
            let psid = para.para_shape_id;
            let width = match metrics {
                Some(m) => Some(DocumentCore::reflow_width_from_cell_metrics(
                    m,
                    psid,
                    self.styles,
                    self.dpi,
                )),
                None => self
                    .core
                    .cell_reflow_width_by_path(si, pi, prefix, psid, self.styles),
            };
            let l = format!("{label}/p{cpi}");
            let depth = prefix.len();
            self.compare(Site::new(container, depth, &l), para, raw_para, prev, width);
            if !raw_para.line_segs.is_empty() {
                prev = Some((raw_para, para));
            }
            // 캡션(65534)은 path 하강을 지원하지 않는다.
            if cell_idx != 65534 {
                self.visit_controls(si, pi, prefix, para, raw_para, &l);
            }
            prefix.pop();
        }
    }

    fn visit_page_list(
        &mut self,
        container: &'static str,
        paras: &[Paragraph],
        raw_paras: &[Paragraph],
        label: &str,
        ci: usize,
        area: PageListWidth,
    ) {
        let mut prev: Option<(&Paragraph, &Paragraph)> = None;
        for (cpi, (para, raw_para)) in paras.iter().zip(raw_paras).enumerate() {
            let width = Some(match area {
                PageListWidth::PageText(si) => DocumentCore::page_text_line_width_px(
                    &self.core.document.sections[si].section_def.page_def,
                    para.para_shape_id,
                    self.styles,
                    self.dpi,
                ),
                PageListWidth::Note(si, pi, footnote) => {
                    self.core
                        .note_reflow_width(si, pi, footnote, para.para_shape_id)
                }
            });
            let l = format!("{label}/c{ci}/{container}/p{cpi}");
            self.compare(Site::new(container, 1, &l), para, raw_para, prev, width);
            if !raw_para.line_segs.is_empty() {
                prev = Some((raw_para, para));
            }
        }
    }

    fn compare(
        &mut self,
        site: Site,
        para: &Paragraph,
        raw_para: &Paragraph,
        prev: Option<(&Paragraph, &Paragraph)>,
        width_px: Option<f64>,
    ) {
        let stored = &raw_para.line_segs;
        if stored.is_empty() {
            return;
        }
        self.all_segs += stored.len() as u64;
        self.flagged_segs += stored
            .iter()
            .filter(|s| s.tag & LineSeg::TAG_SINGLE_SEGMENT_LINE != 0)
            .count() as u64;
        if stored
            .iter()
            .any(|s| s.line_height <= 0 || s.tag & LineSeg::TAG_IMPLEMENTATION_PROPERTY != 0)
        {
            return self.skip("stored_uncomputed");
        }
        if para.text != raw_para.text {
            return self.skip("text_changed_at_load");
        }
        let class = paragraph_class(para, stored);
        for &mode in modes(self.load) {
            if mode == "load" {
                if para.line_segs.is_empty() {
                    self.skip("load_unsynthesized");
                    continue;
                }
                let ours = load_lines(para, stored, prev);
                self.score(mode, &site, class, para, stored, &ours);
                continue;
            }
            let width = match mode {
                "full" => match width_px {
                    Some(w) => w,
                    None => {
                        self.skip("width_unresolved");
                        continue;
                    }
                },
                // 블록 개체 앵커 줄 등 저장 폭이 0 이면 줄 계산을 따로 볼 수 없다.
                _ if stored[0].segment_width <= 0 => {
                    self.skip("given_zero_width");
                    continue;
                }
                _ => hwpunit_to_px(stored[0].segment_width, self.dpi),
            };
            let ours = self.reflow(para, stored, prev.map(|p| p.0), width);
            self.score(mode, &site, class, para, stored, &ours);
        }
    }

    fn score(
        &mut self,
        mode: &str,
        site: &Site,
        class: &str,
        para: &Paragraph,
        stored: &[LineSeg],
        ours: &[LineSeg],
    ) {
        let cmp = compare_lines(stored, ours);
        let keys = [
            "all".to_string(),
            format!("container:{}", site.container),
            format!("class:{class}"),
        ];
        for key in keys {
            let t = self.doc.tallies.entry(format!("{mode}/{key}")).or_default();
            t.add(&cmp.tally);
        }
        let row = self.tsv_row(mode, site, class, para, stored, ours, &cmp);
        self.doc.tsv.push_str(&row);
    }

    /// 저장값을 버린 문단을 엔진 누락 경로로 다시 계산하고, 앞 문단 저장 끝에
    /// 편집 경로 규칙으로 이어 붙인다.
    fn reflow(
        &self,
        para: &Paragraph,
        stored: &[LineSeg],
        prev: Option<&Paragraph>,
        width_px: f64,
    ) -> Vec<LineSeg> {
        let mut ours = para.clone();
        ours.line_segs.clear();
        DocumentCore::reflow_cell_lines(&mut ours, width_px, self.squeeze, self.styles, self.dpi);
        let first_vpos = stored[0].vertical_pos;
        for seg in &mut ours.line_segs {
            seg.vertical_pos += first_vpos;
        }
        if let Some(prev) = prev {
            // 쪽/단 리셋 판정은 저장 첫 줄 태그를 원본으로 본다 (편집 reflow 와 동일 조건).
            let tag = ours.line_segs[0].tag;
            ours.line_segs[0].tag = stored[0].tag & !LineSeg::TAG_IMPLEMENTATION_PROPERTY;
            // 개체(앵커 표 등)는 남긴다 — vpos 재계산이 앞 문단 개체 높이를 본다.
            let thin = |p: &Paragraph| Paragraph {
                para_shape_id: p.para_shape_id,
                line_segs: p.line_segs.clone(),
                controls: p.controls.clone(),
                ..Default::default()
            };
            let mut pair = [thin(prev), thin(&ours)];
            let hwp3 = self.core.document.layout_profile().hwp3_layout();
            recalculate_section_vpos(&mut pair, 1, None, None, self.styles, self.dpi, hwp3);
            ours.line_segs = std::mem::take(&mut pair[1].line_segs);
            ours.line_segs[0].tag = tag;
        }
        ours.line_segs
    }

    #[allow(clippy::too_many_arguments)]
    fn tsv_row(
        &self,
        mode: &str,
        site: &Site,
        class: &str,
        para: &Paragraph,
        stored: &[LineSeg],
        ours: &[LineSeg],
        cmp: &LineCompare,
    ) -> String {
        let Some((line, is_break, diffs)) = &cmp.first else {
            return String::new();
        };
        let bad_lines = cmp.bad_lines;
        let chars: Vec<char> = para.text.chars().collect();
        let char_at = |utf16: u32| para.char_offsets.partition_point(|&o| o < utf16);
        let line_range = |segs: &[LineSeg], i: usize| {
            let start = char_at(segs[i].text_start);
            let end = segs
                .get(i + 1)
                .map(|s| char_at(s.text_start))
                .unwrap_or(chars.len());
            (start.min(chars.len()), end.min(chars.len()))
        };
        let (c0, c1) = line_range(stored, *line);
        let ours_line = ours
            .iter()
            .rposition(|o| o.text_start <= stored[*line].text_start)
            .unwrap_or(0);
        let (_, oc1) = line_range(ours, ours_line);
        let ctx = |at: usize| -> String {
            let lo = at.saturating_sub(6);
            let hi = (at + 6).min(chars.len());
            let mut s: String = chars[lo..at.min(hi)].iter().collect();
            s.push('|');
            s.extend(chars[at.min(hi)..hi].iter());
            s
        };
        let (kind, field, o, s) = if *is_break {
            let kind = if stored.len() != ours.len() {
                "break+count"
            } else {
                "break"
            };
            (kind, "text_start".to_string(), oc1 as i64, c1 as i64)
        } else {
            let (f, o, s) = diffs[0];
            ("field", FIELDS[f].to_string(), o, s)
        };
        let diff_list = diffs
            .iter()
            .map(|(f, o, s)| format!("{}:{o}/{s}", FIELDS[*f]))
            .collect::<Vec<_>>()
            .join(";");
        let style = line_style(self.styles, para, c0, c1);
        let ps = self.styles.para_styles.get(para.para_shape_id as usize);
        let hu = |px: f64| px_to_hwpunit(px, self.dpi);
        let (ls_type, ls_value) = match ps {
            Some(p) => match p.line_spacing_type {
                LineSpacingType::Percent => ("percent", p.line_spacing.round() as i64),
                LineSpacingType::Fixed => ("fixed", hu(p.line_spacing) as i64),
                LineSpacingType::SpaceOnly => ("space", hu(p.line_spacing) as i64),
                LineSpacingType::Minimum => ("minimum", hu(p.line_spacing) as i64),
            },
            None => ("?", 0),
        };
        let align = match ps.map(|p| p.alignment) {
            Some(Alignment::Justify) => "justify",
            Some(Alignment::Left) => "left",
            Some(Alignment::Right) => "right",
            Some(Alignment::Center) => "center",
            Some(Alignment::Distribute) => "distribute",
            Some(Alignment::Split) => "split",
            None => "?",
        };
        let mix = script_mix(&chars[c0..c1]);
        let ends_space = c1 > c0 && chars[c1 - 1] == ' ';
        let mut row = String::new();
        let _ = write!(
            row,
            "{}\t{mode}\t{}\t{}\t{}\t{class}\t{line}\t{}\t{}\t{}\t{kind}\t{field}\t{o}\t{s}\t{}\t{}\t",
            self.doc.id,
            site.container,
            site.depth,
            site.path,
            stored.len(),
            ours.len(),
            bad_lines,
            o - s,
            tsv_escape(&diff_list),
        );
        let _ = write!(
            row,
            "{}\t{}\t{}\t{:.1}\t{:.1}\t{}\t{}\t{}\t{:.1}\t{}\t{}\t",
            if *is_break {
                (oc1 as i64 - c1 as i64).to_string()
            } else {
                String::new()
            },
            tsv_escape(&style.font_hangul),
            tsv_escape(&style.font_latin),
            style.size_pt,
            style.max_size_pt,
            style.n_styles,
            style.ratio,
            style.latin_ratio,
            style.spacing_pct,
            style.bold as u8,
            align,
        );
        let _ = write!(
            row,
            "{ls_type}\t{ls_value}\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t",
            ps.map(|p| hu(p.spacing_before)).unwrap_or(0),
            ps.map(|p| hu(p.spacing_after)).unwrap_or(0),
            ps.map(|p| hu(p.indent)).unwrap_or(0),
            ps.map(|p| hu(p.margin_left)).unwrap_or(0),
            ps.map(|p| hu(p.margin_right)).unwrap_or(0),
            stored[*line].segment_width,
            ours[ours_line].segment_width,
        );
        let _ = writeln!(
            row,
            "{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{:?}\t{}\t{}\t{}\t{}\t{}\t{}",
            c1 - c0,
            mix[0],
            mix[1],
            mix[2],
            mix[3],
            mix[4],
            mix[5],
            ends_space as u8,
            tsv_escape(&ctx(c1)),
            if *is_break {
                tsv_escape(&ctx(oc1))
            } else {
                String::new()
            },
            ps.map(|p| p.vertical_align).unwrap_or(0),
            ps.map(|p| p.head_type).unwrap_or_default(),
            // 문단 모양 attr1 bit 22: 글꼴에 어울리는 줄 높이(fontLineHeight)
            self.core
                .document
                .doc_info
                .para_shapes
                .get(para.para_shape_id as usize)
                .map_or(0, |shape| (shape.attr1 >> 22) & 1),
            seg_summary(&stored[*line]),
            seg_summary(&ours[ours_line]),
            hu(measured_width_px(self.styles, para, &chars, c0, c1)),
            {
                // 저장 줄 가용 폭: 첫 줄은 들여쓰기, 이어지는 줄은 내어쓰기만큼 좁다.
                let indent = ps.map(|p| hu(p.indent)).unwrap_or(0);
                let cut = if *line == 0 {
                    indent.max(0)
                } else {
                    (-indent).max(0)
                };
                stored[*line].segment_width - cut
            },
            hu(measured_width_px(
                self.styles,
                para,
                &chars,
                c0,
                oc1.max(c0)
            )),
        );
        row
    }
}

/// 저장 줄 [c0, c1) 의 우리 측정 자연 폭(px, 줄 끝 공백 제외) — 줄바꿈 판단과 같은 토큰 폭.
/// 로드 경로 결과 줄을 저장 좌표계에 맞춘다. 문단 경계 간격(앞 문단 끝 줄 끝 → 첫 줄)을
/// 비교하도록 첫 줄을 저장 앞 문단 끝 + 우리 간격에 둔다. 저장이 쪽/단 시작(리셋 또는
/// 쪽·단 첫 줄 비트)이면 간격을 볼 수 없어 저장 첫 줄에 맞춘다. 앞 문단이 없으면 동일.
fn load_lines(
    para: &Paragraph,
    stored: &[LineSeg],
    prev: Option<(&Paragraph, &Paragraph)>,
) -> Vec<LineSeg> {
    let end = |s: &LineSeg| s.vertical_pos + s.line_height + s.line_spacing;
    let mut ours = para.line_segs.clone();
    let anchor = prev.and_then(|(raw_prev, our_prev)| {
        let stored_end = end(raw_prev.line_segs.last()?);
        let ours_end = end(our_prev.line_segs.last()?);
        let new_area = LineSeg::TAG_FIRST_LINE_OF_PAGE | LineSeg::TAG_FIRST_LINE_OF_COLUMN;
        (stored[0].vertical_pos >= stored_end && stored[0].tag & new_area == 0)
            .then(|| stored_end + ours[0].vertical_pos - ours_end)
    });
    let shift = anchor.unwrap_or(stored[0].vertical_pos) - ours[0].vertical_pos;
    for seg in &mut ours {
        seg.vertical_pos += shift;
    }
    ours
}

fn measured_width_px(
    styles: &ResolvedStyleSet,
    para: &Paragraph,
    chars: &[char],
    c0: usize,
    c1: usize,
) -> f64 {
    let ps = styles.para_styles.get(para.para_shape_id as usize);
    let tokens = tokenize_paragraph(
        chars,
        &para.char_offsets,
        &para.char_shapes,
        styles,
        ps.map_or(0, |p| p.english_break_unit),
        ps.map_or(0, |p| p.korean_break_unit),
    );
    let (mut width, mut pending_space) = (0.0, 0.0);
    for token in &tokens {
        match token {
            BreakToken::Text {
                start_idx,
                end_idx,
                width: w,
                char_widths,
                ..
            } => {
                let (a, b) = ((*start_idx).max(c0), (*end_idx).min(c1));
                if a >= b {
                    continue;
                }
                let len = end_idx - start_idx;
                let part = if char_widths.len() == len {
                    char_widths[a - start_idx..b - start_idx].iter().sum()
                } else {
                    // 글자별 폭이 없는 토큰은 글자 수 비례로 나눈다.
                    *w * (b - a) as f64 / len.max(1) as f64
                };
                width += pending_space + part;
                pending_space = 0.0;
            }
            BreakToken::Space { idx, width: w, .. } if (c0..c1).contains(idx) => {
                pending_space += w;
            }
            _ => {}
        }
    }
    width
}

/// `vpos/lh/th/bl/ls/cs/sw/flags` — 매개변수 탐색용 줄 원값.
fn seg_summary(s: &LineSeg) -> String {
    format!(
        "{}/{}/{}/{}/{}/{}/{}/{:x}",
        s.vertical_pos,
        s.line_height,
        s.text_height,
        s.baseline_distance,
        s.line_spacing,
        s.column_start,
        s.segment_width,
        s.tag
    )
}

/// wrap = 저장 줄이 어울림 등으로 구간이 나뉨(줄마다 폭/시작이 다르거나 다중 세그먼트),
/// object = 글자처럼 취급 개체(표·그림·도형·수식) 보유, empty = 빈 문단, text = 글자 문단.
fn paragraph_class(para: &Paragraph, stored: &[LineSeg]) -> &'static str {
    let geometry = |s: &LineSeg| (s.column_start, s.segment_width);
    let wrapped = stored.iter().any(|s| {
        s.tag & LineSeg::TAG_SINGLE_SEGMENT_LINE != LineSeg::TAG_SINGLE_SEGMENT_LINE
            || geometry(s) != geometry(&stored[0])
    });
    if wrapped {
        return "wrap";
    }
    let inline = para.controls.iter().any(|c| match c {
        Control::Table(t) => t.common.treat_as_char,
        Control::Picture(p) => p.common.treat_as_char,
        Control::Shape(s) => s.common().treat_as_char,
        Control::Equation(_) => true,
        _ => false,
    });
    if inline {
        "object"
    } else if para.text.chars().all(|c| c.is_control()) {
        "empty"
    } else {
        "text"
    }
}

#[derive(Default)]
struct LineStyle {
    font_hangul: String,
    font_latin: String,
    size_pt: f64,
    max_size_pt: f64,
    n_styles: usize,
    ratio: f64,
    latin_ratio: f64,
    spacing_pct: f64,
    bold: bool,
}

/// 줄 [c0, c1) 에서 글자 수가 가장 많은 글자 모양을 대표로 고른다.
fn line_style(styles: &ResolvedStyleSet, para: &Paragraph, c0: usize, c1: usize) -> LineStyle {
    let mut counts: BTreeMap<u32, usize> = BTreeMap::new();
    let style_at = |ci: usize| {
        let pos = para.char_offsets.get(ci).copied().unwrap_or(0);
        para.char_shapes
            .iter()
            .take_while(|cs| cs.start_pos <= pos)
            .last()
            .or(para.char_shapes.first())
            .map(|cs| cs.char_shape_id)
            .unwrap_or(0)
    };
    for ci in c0..c1.max(c0 + 1) {
        *counts.entry(style_at(ci)).or_default() += 1;
    }
    let Some((&id, _)) = counts.iter().max_by_key(|(_, &n)| n) else {
        return LineStyle::default();
    };
    let pt = |px: f64| px * 72.0 / 96.0;
    let max_size = counts
        .keys()
        .filter_map(|id| styles.char_styles.get(*id as usize))
        .map(|s| s.font_size)
        .fold(0.0, f64::max);
    let Some(s) = styles.char_styles.get(id as usize) else {
        return LineStyle::default();
    };
    let family = |i: usize| s.font_families.get(i).cloned().unwrap_or_default();
    LineStyle {
        font_hangul: family(0),
        font_latin: family(1),
        size_pt: pt(s.font_size),
        max_size_pt: pt(max_size),
        n_styles: counts.len(),
        ratio: (s.ratio * 100.0).round(),
        latin_ratio: (s.ratios.get(1).copied().unwrap_or(s.ratio) * 100.0).round(),
        spacing_pct: if s.font_size > 0.0 {
            s.letter_spacing / s.font_size * 100.0
        } else {
            0.0
        },
        bold: s.bold,
    }
}

/// [한글, 라틴, 숫자, 문장부호, 공백, 기타]
fn script_mix(chars: &[char]) -> [usize; 6] {
    let mut m = [0usize; 6];
    for &c in chars {
        let k = match c {
            '\u{AC00}'..='\u{D7A3}' | '\u{1100}'..='\u{11FF}' | '\u{3130}'..='\u{318F}' => 0,
            c if c.is_ascii_alphabetic() => 1,
            '\u{00C0}'..='\u{024F}' => 1,
            c if c.is_ascii_digit() => 2,
            c if c.is_whitespace() => 4,
            c if c.is_ascii_punctuation() => 3,
            '\u{2000}'..='\u{206F}' | '\u{3000}'..='\u{303F}' | '\u{FF00}'..='\u{FF65}' => 3,
            '\u{00A1}'..='\u{00BF}' | '\u{2190}'..='\u{25FF}' => 3,
            _ => 5,
        };
        m[k] += 1;
    }
    m
}

fn tsv_escape(s: &str) -> String {
    s.chars()
        .map(|c| match c {
            '\t' => '→',
            '\n' | '\r' => '⏎',
            c if c.is_control() => '·',
            c => c,
        })
        .collect()
}

fn doc_json(d: &DocResult) -> Value {
    let tallies: serde_json::Map<String, Value> = d
        .tallies
        .iter()
        .map(|(k, t)| (k.clone(), t.to_json()))
        .collect();
    json!({
        "doc": d.id,
        "status": d.status,
        "error": d.error,
        "format": d.format,
        "app": d.app,
        "hancom": d.hancom,
        "exclude_reason": d.exclude_reason,
        "seg_flag_share": d.flagged_seg_share,
        "skipped": d.skipped,
        "tallies": tallies,
    })
}

fn write_outputs(out: &Path, docs: &[DocResult]) -> Value {
    let mut tsv = String::from(TSV_HEADER);
    let mut totals: BTreeMap<String, Tally> = BTreeMap::new();
    let mut by_format: BTreeMap<String, u64> = BTreeMap::new();
    let mut excluded = Vec::new();
    let mut failed = Vec::new();
    let mut per_doc = Vec::new();
    for d in docs {
        *by_format
            .entry(format!("{}:{}", d.format, d.status))
            .or_default() += 1;
        if d.status != "OK" {
            failed.push(json!({"doc": d.id, "error": d.error}));
            continue;
        }
        let j = doc_json(d);
        let file = out
            .join("docs")
            .join(format!("{}.json", d.id.replace(['/', '\\'], "__")));
        let _ = fs::write(file, serde_json::to_string_pretty(&j).unwrap_or_default());
        if !d.hancom {
            excluded.push(json!({"doc": d.id, "app": d.app, "reason": d.exclude_reason}));
            continue;
        }
        tsv.push_str(&d.tsv);
        for (k, t) in &d.tallies {
            totals.entry(k.clone()).or_default().add(t);
        }
        let headline = |mode: &str| {
            d.tallies
                .get(&format!("{mode}/all"))
                .map(Tally::to_json)
                .unwrap_or(Value::Null)
        };
        per_doc.push(json!({
            "doc": d.id,
            "app": d.app,
            "full": headline("full"),
            "given": headline("given"),
            "load": headline("load"),
            "skipped": d.skipped,
        }));
    }
    let totals_json: serde_json::Map<String, Value> = totals
        .iter()
        .map(|(k, t)| (k.clone(), t.to_json()))
        .collect();
    let summary = json!({
        "files": docs.len(),
        "files_by_format_status": by_format,
        "hancom_docs": per_doc.len(),
        "totals": totals_json,
        "docs": per_doc,
        "excluded": excluded,
        "failed": failed,
    });
    let _ = fs::write(out.join("mismatches.tsv"), tsv);
    let _ = fs::write(
        out.join("summary.json"),
        serde_json::to_string_pretty(&summary).unwrap_or_default(),
    );
    summary
}

fn print_headline(summary: &Value) {
    println!(
        "files {}  hancom {}  excluded {}  failed {}",
        summary["files"],
        summary["hancom_docs"],
        summary["excluded"].as_array().map_or(0, Vec::len),
        summary["failed"].as_array().map_or(0, Vec::len),
    );
    for mode in MODES.iter().chain(&LOAD_MODES) {
        let t = &summary["totals"][format!("{mode}/all")];
        if t.is_null() {
            continue;
        }
        let f = &t["fields_pct"];
        println!(
            "{mode:5} paras {} exact {}% breaks {}% | lines {} aligned {}% | lh {} th {} bl {} ls {} vpos {} sw {} cs {} flags {}",
            t["paras"],
            t["para_exact_pct"],
            t["para_break_pct"],
            t["lines"],
            t["line_aligned_pct"],
            f["line_height"]["exact"],
            f["text_height"]["exact"],
            f["baseline_distance"]["exact"],
            f["line_spacing"]["exact"],
            f["vertical_pos"]["exact"],
            f["segment_width"]["exact"],
            f["column_start"]["exact"],
            f["flags"]["exact"],
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn seg(text_start: u32, line_height: i32) -> LineSeg {
        LineSeg {
            text_start,
            line_height,
            text_height: line_height,
            baseline_distance: line_height * 85 / 100,
            segment_width: 40000,
            tag: LineSeg::TAG_SINGLE_SEGMENT_LINE,
            ..Default::default()
        }
    }

    #[test]
    fn compare_lines_separates_breaks_from_fields() {
        let stored = [seg(0, 1000), seg(20, 1000), seg(41, 1000)];

        // 같은 줄바꿈, 구현 비트만 다름 → 정확 일치
        let mut ours = stored.to_vec();
        ours[2].tag |= LineSeg::TAG_IMPLEMENTATION_PROPERTY;
        let c = compare_lines(&stored, &ours);
        assert!(c.exact && c.break_match && c.first.is_none());
        assert_eq!(c.tally.lines_aligned, 3);

        // 첫 줄이 한 글자 일찍 끊김 → 줄 0·1 정렬 실패, 줄 2 만 필드 비교
        let ours = [seg(0, 1000), seg(19, 1000), seg(41, 1000)];
        let c = compare_lines(&stored, &ours);
        assert!(!c.break_match && !c.exact);
        assert_eq!(c.tally.lines_aligned, 1);
        assert_eq!(c.first.as_ref().map(|f| (f.0, f.1)), Some((0, true)));

        // 줄바꿈은 같고 줄 높이만 1 차이 → ±1 안에서 일치
        let mut ours = stored.to_vec();
        ours[1].line_height += 1;
        let c = compare_lines(&stored, &ours);
        assert!(c.break_match && !c.exact);
        assert_eq!((c.tally.exact[0], c.tally.within1[0]), (2, 3));
        assert_eq!(
            c.first.map(|f| (f.0, f.2)),
            Some((1, vec![(0, 1001, 1000)]))
        );
    }
}
