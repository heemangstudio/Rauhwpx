# 시작 및 스트리밍 성능 검증

2026-10-06 macOS에서 Chrome headless와 Studio 개발 서버를 사용했다. 비교 기준은 `c0603be6`이며, 같은 브라우저에서 기준 코드와 변경 코드를 번갈아 실행했다.

| 작업 | 변경 전 | 변경 후 | 계측 범위 |
| --- | ---: | ---: | --- |
| 긴 답변 Markdown 갱신 | 55.30ms | 23.50ms | 27,489자 답변을 64자씩 갱신한 파싱·DOM 처리 시간 중앙값, 2.35배 |
| 시작 준비 | 4.43초 | 2.55초 | 글꼴 로드에 배치당 1초, WASM 초기화에 2초를 추가한 지연 시나리오 |

스트리밍 비교는 프로덕션 사이드바의 렌더러에 샘플 답변을 재생했다. 준비 실행 하나를 제외한 다섯 번의 표본을 사용했고, 완료 후 DOM이 기준 코드와 같은지 확인했다. 모델 응답 대기 시간과 레이아웃·페인트 시간은 포함하지 않았다. 파싱만 계측한 별도 결과는 한글 본문 2.80배, 혼합 Markdown 4.04배였다.

시작 비교는 외부 요청을 차단한 새 브라우저 컨텍스트에서 실행했다. 지연을 추가하지 않은 localhost 표본은 약 0.7~0.9초였으며, 글꼴과 WASM을 기다리는 구간의 단축은 지연 시나리오에서 확인했다. 시작 영상은 같은 지연 조건을 사용한 별도 실행이다.

- [시작 전](startup-before.mp4), [시작 후](startup-after.mp4), [시작 계측 원본](startup-results.json)
- [스트리밍 전](streaming-before.mp4), [스트리밍 후](streaming-after.mp4), [스트리밍 계측 원본](streaming-results.json)
- [파서 계측 원본](parser-results.json)
- [편집기 검증](editor-live-results.json), [한글·영문 입력 계측](typing-results.json)

실제 Studio `http://127.0.0.1:7700`에서 파일 메뉴로 새 문서를 만들고, 키보드로 입력한 뒤 실행 취소·다시 실행을 확인했다. 사이드바 재생은 `http://127.0.0.1:7715`의 로컬 fixture를 사용했다.

후속 계측은 `npm run dev:sidebar`를 실행한 뒤 Studio 디렉터리에서 `node e2e/chat-stream-bench.mjs --json=stream.json`으로 반복할 수 있다.
