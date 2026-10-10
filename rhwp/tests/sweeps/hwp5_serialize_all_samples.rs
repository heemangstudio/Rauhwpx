//! `samples/*.hwp` 전부를 HWP5 로 직렬화해 CFB 파일이 나오는지 확인한다
//! (`serializer::cfb_writer` 단위 테스트에서 옮김. 배포용 문서도 포함한다).

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
        let doc = match rhwp::parser::parse_hwp(&data) {
            Ok(d) => d,
            Err(e) => {
                eprintln!("  파싱 실패 (건너뜀): {}", e);
                continue;
            }
        };

        match rhwp::serializer::serialize_hwp(&doc) {
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
