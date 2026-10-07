---
name: humanize-korean
description: Remove AI tells from Korean text in the live document (번역투, AI 관용구, 기계적 병렬, 피동·접속사 남발, 리듬 균일성) while preserving every fact. Based on epoko77-ai/im-not-ai v2.3.2. Use when the user asks "AI 티 없애줘", "사람이 쓴 것처럼", "윤문", "번역투 고쳐줘", "자연스럽게 다듬어줘", or for a full pass over long AI-written Korean. Its core rules already apply automatically to every Korean passage you write.
icon: sparkles
---

시스템 지침의 `humanize_korean` 룰북이 기본 규칙이다. 이 스킬은 사용자가 기존 본문의 AI 티 제거를 명시적으로 요청했을 때의 전체 절차다.

## 1. 읽기
- `live_document` 블록이 대상 범위를 전부 보여 주면 그대로 쓴다. 아니면 대상 범위를 `get_structure` `text: "full"`로 한 번 읽는다(사용자가 쪽을 지정하면 `pages: [first, last]`).
- 장르(보고서·공문·칼럼·에세이·블로그)와 격식(합쇼체·해요체·한다체)을 정한다. 결과는 이 둘을 바꾸지 않는다.
- 문장마다 내용 앵커(주장을 이루는 핵심 명사·개념어)를 속으로 목록화한다.

## 2. 경로
- **가볍게**: 어휘 티가 거의 없는 글. 확실한 S1 만 고친다. 고칠 곳이 거의 없으면 "이미 자연스럽습니다"라고 알리고 억지로 고치지 않는다.
- **표준**(기본): 글 전체를 지배하는 패턴 3~6개를 룰북 ID 로 진단한 뒤, 그 패턴의 span 만 고친다.
- **정밀**: 사용자가 "정밀하게", "제대로"라고 하거나 AI 티가 매우 짙은 장문. 룰북에 없는 패턴이 의심되면 `references/diagnosis-rules.md`(85패턴 슬림 인덱스)를 읽는다. 치환 예시가 필요하면 `references/rewriting-playbook.md`, 패턴 하나의 정의·예외를 확인할 때만 `references/ai-tell-taxonomy.md`의 해당 절을 읽는다. 큰 파일이므로 전부 읽지 않는다.

## 3. 쓰기
- 모든 수정을 `apply_edits` 한 번에 보낸다. 각 항목은 틀린 구간에 `anchor`를 건 `replace_range`이고, 반복되면 `occurrence`나 `within`을 쓴다. 고칠 곳이 없는 문단은 다시 쓰지 않는다.
- 글자·문단 서식은 그대로 둔다.
- 문단의 30% 넘게 바뀌면 다시 보고, 50%를 넘으면 그 문단은 원문으로 둔다.
- 보내기 전에 룰북의 자체 점검을 같은 배치 안에서 끝낸다.

## 4. 보고
`after` 경고가 있으면 고친다. 사용자에게는 고친 패턴 몇 가지와 그 예 하나 정도만 짧게 알린다. 점수·등급·변경률 표는 내지 않는다.

출처: [epoko77-ai/im-not-ai](https://github.com/epoko77-ai/im-not-ai) (MIT, `LICENSE.txt`). `references/`는 원본 그대로이며, 원본의 스크립트·`_workspace`·서브에이전트 절차는 이 앱에서 쓰지 않는다.
