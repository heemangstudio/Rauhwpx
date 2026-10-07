# RHWP v0.8.7 선별 이식 검토 (2026-10-06)

이 작업은 최근 배포본의 유용한 변경을 한 draft PR로 모으는 한정된 작업이다.
비교 기준은 Rauhwpx main `33c48f6e07ff8a82584d3313e104572075ac322b`와
[RHWP v0.8.7](https://github.com/edwardkim/rhwp/releases/tag/v0.8.7)
태그/당시 main `1a76570e833917d15817415a53c09ad61ab3203f`이다.
v0.8.7은 2026-10-06 07:54:34 UTC에 배포됐다. 릴리스 주요 항목과 최근 main
100개 커밋, 관련 저장·편집 PR의 실제 diff를 비교했다. 전체 누적 변경 이식은 아니다.
GitHub compare의 merge-base가 채택한 JSON commit 및 #7478 merge commit과 같고
behind_by=0인 것도 확인해 두 구현이 고정된 v0.8.7의 조상임을 검증했다.

## 기존 원본과 라이선스

Rauhwpx README/CONTRIBUTING은 Edward Kim의 RHWP 포크임을 명시한다.
Rauhwpx 최초 커밋 `d5cc6fea`는 상위 저장소 이력을 병합하지 않고 `rhwp/`에
코드를 들여온 독립 root다. 그 커밋의 Cargo.toml blob
`ff31a901a2197c6eb93c854e4d6b84465b598498`, LICENSE blob
`ce1af1c38f99275435ca0459477560c49daaf8d8`, form_query.rs blob
`67a13a2dc2521a57e22304bb0253818a57d53bb2`는
[upstream v0.8.2](https://github.com/edwardkim/rhwp/tree/9b16aa9e23f476e2b335d7c029fc9f24a199d63c)와 같다.
초기 src 전체 tree는 같지 않으므로 정확한 전체 fork 지점이나 공통 git 조상을 주장하지 않는다.
현재 버전 문자열만으로 적용 여부를 판단하지 않고 현재 함수와 회귀 검사를 확인했다.

[고정 v0.8.7 LICENSE](https://github.com/edwardkim/rhwp/blob/1a76570e833917d15817415a53c09ad61ab3203f/LICENSE)는
MIT, Copyright (c) 2025-2026 Edward Kim이다. 재사용한 소스·테스트에 대해
`rhwp/LICENSE`의 전체 저작권/허가 고지와 `rhwp/THIRD_PARTY_LICENSES.md`를 유지한다.
외부 라이브러리·글꼴·바이너리를 새로 가져오지 않는다. 기존 공개 표본만 사용한다.
MIT 소스 라이선스를 글꼴 라이선스로 확대 해석하지 않는다.

## 채택 (우선순위 순)

| 우선순위 | 변경과 근거 | 정확한 upstream |
| --- | --- | --- |
| 높음 | 양식 text/caption/value의 정식 JSON 해석. 현재 부분 문자열 해석은 이스케이프를 해석하지 않고 중첩 키·잘못된 JSON의 일부도 적용한다. 본문/셀에 같은 계약을 적용하고 기존 snapshot revision·raw stream 무효화는 유지한다. | semanticist21 구현 [c96ee8ecce31b97e42f647f0791c6aa58261bd99](https://github.com/edwardkim/rhwp/commit/c96ee8ecce31b97e42f647f0791c6aa58261bd99), 원본 6529a6aaa6e2be432b42ea101983eba2ce7ec914 |
| 높음 | 위 양식 값의 native API·HWP/HWPX 저장/재열기·셀 snapshot·실패 원자성 회귀를 재사용한다. | semanticist21 검사 [b2e5b43bc305403c9434727626ddca9eb3f1d00b](https://github.com/edwardkim/rhwp/commit/b2e5b43bc305403c9434727626ddca9eb3f1d00b), 원본 694d65555982afe6e22af2faa7948235fccb3995 |
| 중간 | 새 HWPX/변환 문서의 layoutCompatibility에서 실제 HWPX 요소가 아닌 char/paragraph/section/object/field 자식을 제거한다. 기존 HWPX tail은 그대로 보존하고 포크의 두 실제 compatibility flag 및 targetProgram을 유지한다. 네 가지 flag 조합을 reference ZIP XML과 대조하고 재열기한다. | moongioh 원본 [a53850cb6ccd7e0037a115f1fdea422a98b05a26](https://github.com/edwardkim/rhwp/commit/a53850cb6ccd7e0037a115f1fdea422a98b05a26), [#7478](https://github.com/edwardkim/rhwp/pull/7478), merge b19eb36c48dcc58ed293b0fcf1989e879b52936d |

원본 JSON 구현 diff만 선택 적용한다. 호환성 코드는 포크에 맞게 수정한다.
renderer·paint·Studio·WASM binding 구현은 수정하지 않는다.

## 제외 / 보류

| 항목 | 판단 |
| --- | --- |
| 표 pageBreak/repeatHeader 및 캡션 저장 ([#7338](https://github.com/edwardkim/rhwp/pull/7338), c1ac0f987229956c839eb54f824741ff4ba43420) | 이미 main의 sync_raw_record_attr / table_record_attr가 해결한다. issue_7323_table_page_break_save 및 table_page_split_and_caption_contract 회귀가 존재한다. 중복 이식 제외. |
| TAC·중첩/rowspan 표 배치, footer/picture/connector, 셀 문단 vpos | [Rauhwpx #431](https://github.com/heemangstudio/Rauhwpx/pull/431), [#350](https://github.com/heemangstudio/Rauhwpx/pull/350), [#347](https://github.com/heemangstudio/Rauhwpx/pull/347)의 작업과 겹친다. 별도 rendering 검토와 지정 모델이 필요하다. |
| 영어 UI, 링크 편집, overwrite/find, 표 뒤 Enter, 폰트 공급자/그리기 | UI/frontend/rendering 구현과 시각 판단은 검증된 Claude Opus 5.5만 허용된다. 이 환경에는 claude/t3code 실행 파일·서비스·callable tool이 없고 정확한 모델을 검증할 수 없어 보류한다. |
| HFT/상위 폰트 자료 | [#378](https://github.com/heemangstudio/Rauhwpx/pull/378)와 겹치며 별도 폰트 라이선스 범위가 필요하다. 파일 복사 없음. |
| 빈 머리말/꼬리말 HWP5 header ([#7460](https://github.com/edwardkim/rhwp/pull/7460), 02530b9ed567a44663edb26c65fb565c4a79f00d) | missing 후보이나 upstream의 Vec<Record> 후처리를 포크의 bounded streaming writer에 그대로 적용할 수 없다. 출력 버전·record length·byte budget 및 기존 roundtrip 계약을 별도로 검증해야 하므로 이번 두 수정의 범위에서 제외한다. |
| 붙은 머리말 필드 슬롯 ([#7528](https://github.com/edwardkim/rhwp/pull/7528), 087f705079087870bb48df58bf4daedf97721f94 / b7fca20aa48be36c8c3f5ef83e37262d99a3afec) | 포크는 다른 field marker/직렬화 구조를 쓴다. upstream lower_header_footer_field_markers가 없으므로 그대로 이식하지 않는다. 별도 재현·호환성 검토 대상이다. |
| 입력/SVG/네트워크 경계 [#7602](https://github.com/edwardkim/rhwp/pull/7602), WMF 경계 | 보안/auth 변경은 이번 작업의 명시적 제한 밖이며 SVG는 rendering 라우팅도 필요하다. gate나 보호 검사를 변경하지 않는다. |
| 버전·npm·스토어·macOS 배포 자동화 | Rauhwpx의 독립 배포 정책을 바꾸지 않는다. draft만 제출하며 merge/release 없음. |

검토 당시 open PR은 #435, #431, #378, #350, #347, #341이었다.
각 PR의 전체 변경 파일 목록(각각 50/4/10/13/21/12개)을 읽었으며 이번
form_query.rs / serializer/hwpx/header.rs 및 새 회귀 파일과 겹치는 경로는 없었다.
Cloud PR #435/#341도 포함해 중복 여부를 확인했다.

## 검증과 남은 게이트

Rust/Cargo 1.93.1과 작업 worktree 자체 target을 사용했다. 다른 worktree의 Cargo
산출물은 재사용하지 않았다. FormObject가 Serialize를 구현하지 않는 포크에 맞춰
upstream 회귀의 개체 비교 두 곳만 전체 Debug 값 비교로 바꿨다.

- 수정 전: form_value_json 5개 모두 실패; HWPX 폴백 XML 회귀 1개 실패,
  원본 header tail 보존 회귀 1개 통과. 원인은 escaped quote/Unicode/제어 문자
  해석 누락, 잘못된 JSON 부분 적용, 폴백에 잘못된 자식 다섯이 남는 현상이다.
- 수정 후: 아래 6개 integration 파일의 22개 검사 통과. native 실제 DocumentCore
  API로 기존 공개 표본을 열고 값을 바꾼 다음 HWP/HWPX 저장본을 재열기했다.
- 기존 Studio form-edit-in-cell / undo-form-value 검사 7개 통과.
  이 기존 검사는 source contract이며 새 실행 증거를 대신하지 않는다.
- native module 검사: form_query 4개, serializer::hwpx::header 44개,
  parser::hwpx::header 53개 통과. 기존 script/resource budget 검사도 유지된다.
- cargo clippy --locked --offline --profile release-test --lib --test form_value_json
  --test upstream_hwpx_compatibility 통과(exit 0). 24개 library 경고는 변경하지 않은
  파일에서 나왔다. lint 정책을 낮추거나 무관한 경고를 수정하지 않았다.
- 새 nodejs WASM package의 실제 HwpDocument API:
  [실행 스크립트](form-value-wasm-smoke.cjs)로 70개 저장 후 재열기 값,
  21개 잘못된 입력, 7개 snapshot 복원 검사 통과. mock이나 기존 WASM 재사용 없음.
- 변경 Rust 파일 rustfmt 검사, git diff --check, publish docs 검사 통과.
- 전체 cargo fmt --check는 기준 main과 같은 renderer/layout.rs:2573의 import
  줄 정렬로 실패한다. 이 파일은 main과 byte 단위로 같고 변경하지 않았다.
- 사용한 fresh WASM SHA-256:
  `62af2845f207509974c4cca97de0bde1c5f27ea9be508f5c8fb6bfe95d3be7d9`.
  UI/한컴 실행 및 전체 engine/nightly suite는 수행하지 않았다.

```sh
source /workspace/rauhwpx-onboarding/env.sh
# rhwp/에서
cargo test --locked --offline --profile release-test \
  --test form_value_json --test upstream_hwpx_compatibility \
  --test hwpx_form_roundtrip --test issue_1534_hwpx_form_caption_escape \
  --test issue_7323_table_page_break_save --test table_page_split_and_caption_contract
wasm-pack build --target nodejs --dev --out-dir /tmp/rhwp-upstream-wasm -- --locked --offline
# 저장소 root에서
node docs/upstream/form-value-wasm-smoke.cjs /tmp/rhwp-upstream-wasm
```

이번 기록은 한컴 2014 실행 성공, 시각 parity 또는 Studio 사용자 조작 성공을
주장하지 않는다. upstream 작성자의 한컴 관찰과 여기서 실행한 검사를 구분한다.
Opus 5.5 경로 부재로 UI 구현/시각 검토/Studio UI 실행 검증은 수행하지 않는다.
draft의 정확한 remote head와 CI 결과, 서명 여부는 PR에서 확인한다.
