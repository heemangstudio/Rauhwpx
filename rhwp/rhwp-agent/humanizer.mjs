/**
 * 한글 AI 티 제거 규칙 — epoko77-ai/im-not-ai (humanize-korean v2.3.2, MIT) quick-rules 를
 * 라이브 문서 편집에 맞게 옮긴 것. 룰북은 모든 하네스의 시스템 브리프에 한 번 실리고(캐시),
 * 문서 작성 단계의 턴마다 짧은 트리거가 붙는다. 전체 분류 체계는 번들 스킬 humanize-korean.
 */
export function isBuildPhase(phase) {
  return phase === 'direct' || phase === 'implementing' || phase === 'switching';
}

export const HUMANIZE_KOREAN_RULES = `<humanize_korean source="epoko77-ai/im-not-ai v2.3.2">
Applies to every Korean passage you write into the document: drafts, rewrites, summaries, headings, captions, table cells. Not to chat replies. Apply it inside the same apply_edits batch; it never costs an extra read, tool call, or report. Text you write must come out without these AI tells. Existing passages the user did not ask you to change stay as they are; when the user asks to polish, 윤문, or remove AI 티, treat the requested range as input and fix only detected spans.

4대 철칙: ① 의미 불변 — 사실·주장·수치·고유명사·직접 인용·부정·인과는 그대로. ② 근거 기반 — 탐지된 span 만 수술적으로 고친다. ③ 장르·격식 유지 — 보고서를 에세이로, 합쇼체를 해요체로 바꾸지 않는다. 존댓말과 반말을 섞지 않는다. ④ 과윤문 금지 — 윤문 요청에서 문단의 30% 넘게 바뀌면 다시 보고, 50%를 넘으면 그 문단을 원문으로 되돌린다. 사용자가 다시 쓰기를 요청한 범위는 그 요청을 따른다.

Do-NOT: 고유명사·제품명·기관명, 수치·날짜·단위, 발화 표지(말했다·밝혔다·따르면)가 붙은 직접 인용, 법률 조문, 수식·통계 표기, 업계 표준 약어(API·GPU·LLM 등)는 탐지도 윤문도 하지 않는다.
서법 보존: 당위("~해야 한다")나 추측("~일 수 있다")을 단정으로 바꾸지 않는다. 표지가 반복될 때만 서법을 유지한 채 배치를 바꾼다.
내용 앵커: 문장마다 주장을 이루는 핵심 명사·개념어는 원형 그대로 한 번 이상 남긴다. 관용구를 걷어낼 때 수식어·형식명사만 지운다. 확신이 없으면 그 문장은 고치지 않는다.
새로 쓸 때: 사용자가 준 자료, 문서, 확인한 출처의 사실만 쓴다. 구체적으로 보이려고 수치·사례·출처·경험을 지어내지 않는다. 모르는 값은 비워 두거나 사용자에게 묻는다.
빼기 전용: 원문에 없던 비유·수사·상투구를 새로 심지 않는다. '-했-'을 '-하였-'으로 올리지 않는다. 살아 있는 구어 종결은 보존한다.

## 패턴 (ID [심각도] 신호 → 처방). S1 은 한 번만 나와도 고친다. S2 는 반복될 때 고친다.
A 번역투
- A-1 [S1] "~에 대해(서)" 한 문단 3회+ → 목적격 조사로("X에 대해 논의" → "X를 논의")
- A-3 [S1] "~에 있어(서)" → "~에서", "~을 볼 때"
- A-5 [S2] "~와 관련하여/관련된" → "~에", "~의"
- A-6 [S2] "~에 기반하여/바탕으로" 남발 → "~로", "~을 보고"
- A-7 [S1] "가지고 있다", have/make/take+명사 직역 → "경쟁력이 강하다"처럼 형용사·동사로
- A-8 [S1] 이중 피동 "~되어진다/~지게 된다" → 능동 또는 단일 피동
- A-9 [S2] "~에 의해" 피동 → 행위자를 주어로("AI에 의해 생성" → "AI가 만든")
- A-10 [S2] "~할 수 있다" 4회+ → 단정 전환 없이 일부만 다른 완곡으로. 의학·법률·정책 글은 보존
- A-11 [S2] "~을 위해" 남발 → "~려고", "~도록"
- A-15 [S2] 추상 주어 + 보여준다/제공한다/가져온다 → 구체 주어로, 사역은 "X 때문에/덕분에"
- A-18 [S2] 명사 앞 3어절+ 관형절 → 문장을 나눈다
- A-19 [S2] "~에서의/~으로의/~으로부터의" → 절로 풀어 쓴다
- A-20 [S2] "~되고 있다" 한 문단 3회+ → 일부만 "심해졌다"처럼 단언으로
- A-21 [S2] "단순한 X를 넘어 Y" → "X만이 아니라 Y다" 또는 삭제
- A-22 [S2] "~은 명확하다/분명하다" 평가 술어 → 명제를 바로 단언
- A-24 [S2] "더 이상 ~ 않다" 2회+ → "이제"나 변화 동사로. "더 이상 A가 아니라 B"를 새로 만들지 않는다
B 영어 과다
- B-1 [S2] 한글(영어) 병기 반복 → 첫 등장만 병기
- B-2 [S2] seamless·robust·leverage 같은 광고성 영어 → 한국어로. 표준 기술 용어는 원어 유지
C 구조
- C-2 [S2] 보고서·칼럼의 3개+ 연속 불릿 → 나열이 의미 있는 곳만 남기고 산문으로
- C-5 [S1] 이모지 → 문서 본문에서는 삭제
- C-7 [S2] 문단 머리 "먼저-반면-결국" 3단 공식 → 접속사 1~2개로
- C-8 [S1] "A가 아니라 B", "~것은 아니다" 대구 2회+ → 하나만 살리고 평서문으로. 전멸 금지
- C-9 [S2] "1) 2) 3)" 나열 → 본문에 녹인다
- C-10 [S2] "X: Y" 콜론 부제 헤딩 반복 → 단일 명사구로. 실제 절 제목은 보존
- C-11 [S1] 연결어미(-고/-며/-지만/-면서/-아서/-어서) 직후 쉼표 → 쉼표 삭제. 윤문으로 이런 쉼표를 늘리지 않는다
D AI 관용구
- D-1 [S1] "결론적으로/따라서/이를 통해/요약하면/정리하자면" 3회 초과 → 1~2개만 남긴다
- D-2 [S1] "시사하는 바가 크다/주목할 만하다/매우 중요하다" → 삭제하거나 구체 결론으로
- D-3 [S1] "크게 세 가지로 나눌 수 있다/다음과 같다" 도입구 → 삭제하고 바로 본론
- D-5 [S2] "기술이 묻는다" 같은 의인화 추상 주어 → 사람·기관 주어로
- D-6 [S2] "~할 때입니다/~시점입니다" 결말 → 구체 동사로, 문서당 1회 이하
- D-7 [S2] "X에서 Y로/X을 넘어 Y로" 반복 → 직접 단언, 문서당 1회 이하
- D-8 [S2] "중요한 것은/핵심은/관건은 ~이다" 분열문 → "방향이 필요하다"처럼 주어-서술 직결
- D-9 [S2] "~로 이어진다/~에 직결된다", 논리 결산 "결국" 2회+ → 인과를 구체로. "결국"은 1회만
- D-10 [S2] "~하는 이유다" 도치 결산 → "그래서 ~다", 문서당 1회 이하
- D-11 [S2] 후반부 "향후/앞으로/중장기적으로" → 삭제하거나 원문의 실제 시점으로
- D-12 [S2] "과제도 남아 있다/한계도 분명하다" 문패 → 실제 과제를 첫 문장으로
- D-14 [S2] "진단은 서늘하다" 같은 감각 술어 평가, 잠식·청사진·적신호·신호탄 같은 사전 은유, 같은 은유 3회+ → 명제로 직역
E 리듬
- E-1 [S2] 문장 길이가 고르고 긴 문장이 없다 → 내용을 더하지 않고 인접 문장을 잇거나 끊는다
- E-2 [S2] 같은 종결어미 4문장+ 연속, 자동 "~고 있다" → 종결을 바꾸고 "읽는다"처럼 단순 시제로
- E-7 [S2] 한 문서 안 경어법 혼재 → 하나로 통일
F 수식
- F-4 [S2] -성/-적/-화 명사화 누적 → 동사·형용사 어근으로
- F-5 [S2] "전략적 함의" 같은 "~적 N" 3회+ → "전략 함의"처럼 풀어 쓴다
- F-7 [S2] 확대·강화·개선·확보·마련·구축 밀집 → 구체 행위 동사로
G 완곡
- G-1 [S2] "~로 보인다/~로 판단된다" 반복 → 유보 강도는 그대로 두고 종결 형태만 바꾼다
- G-2 [S2] "~할 가능성이 있을 수 있다" 중첩 → 완곡 하나만. 의학·법률·정책·계약 글은 보존
H 접속사
- H-4 [S2] "즉" 남발 → 생략하거나 문서당 2회 이하
I 형식명사
- I-2 [S2] "주목할 점은 ~라는 점에 있다" → "X는 ~다"로
- I-3 [S2] "~다는 것이다/~다는 뜻이다" 결말 → "~다", 합쳐서 2회 이하
- I-4 [S2] 당위로 끝나는 문단 2개+ → 당위 문장을 문단 앞·중간으로 옮긴다. 삭제·서법 변경 금지
- I-7 [S2] 출처 없는 "~다는 분석이다/평가다" → 직접 서술로. 출처를 지어내지 않는다
J 장식
- J-1 [S2] 문장마다 핵심어 굵게 → 본문 굵게를 거의 걷는다
- J-2 [S1] 강조용 따옴표 5회+ → 진짜 인용만 남긴다
- J-3 [S2] 문장마다 대시(—) 부가 설명 → 쉼표·괄호·별도 문장으로. 원문에 있던 대시는 보존

## Self-check, inside the same batch, before apply_edits
1. 고유명사·수치·날짜·인용·내용 앵커가 그대로인가.
2. 장르와 격식이 원문·문서와 같은가.
3. S1 패턴이 남지 않았는가. 연결어미 쉼표와 D-14 은유가 늘지 않았는가.
4. 원문에 없던 수사나 상투구를 넣지 않았는가.
Fix violations in the same batch. Do not re-read the document, call verify_changes, or report scores, grades, or change rates for this check.
For a dedicated full pass on long or heavily AI-written text, read the bundled humanize-korean skill and its references.
</humanize_korean>`;

const ENGLISH_DISCIPLINE = `Applies to document drafts, rewrites, summaries, headings, captions, and table cells, not to chat replies. Preserve facts, figures, dates, units, proper nouns, quotations, citations, negation, uncertainty, and causality; never invent examples, sources, or experiences.
- Start with what the reader needs to understand. Let paragraph breaks follow changes in the thought.
- Choose familiar, precise wording and verbs that make the action clear. Keep established terminology.
- Let sentence length follow meaning. Do not alternate short and long sentences on purpose or force fragments.
- Revise empty framing ("In conclusion", "it is important to note") and vague praise when they add nothing.
- Match the writer's register and regional spelling. Use contractions, humour, or a strong stance only where the author and reader call for them.
Check these inside the same apply_edits batch; do not re-read or call verify_changes for it.`;

const PERSONAL_VOICE = 'A personal voice portrait is active: follow its observed tendencies where they fit the passage, and ignore numeric style targets in older profiles. The rules above still win on meaning and AI tells.';

/** 문서 작성 단계의 턴 트리거. 룰북 본문은 시스템 브리프(HUMANIZE_KOREAN_RULES)에 있다. */
export function humanizerPromptBlock(phase, { language = 'ko', personalProfile = false } = {}) {
  if (!isBuildPhase(phase)) return '';
  const voice = personalProfile ? `\n${PERSONAL_VOICE}` : '';
  if (language === 'en') return `<english_writing_discipline>\n${ENGLISH_DISCIPLINE}${voice}\n</english_writing_discipline>`;
  return `<humanize_korean_trigger>
Every Korean passage you write into the document this turn goes through the humanize_korean rules in your system instructions before the apply_edits call: write it free of their patterns and run the self-check in the same batch. When the user asks to polish, 윤문, or remove AI 티, apply them to the requested range as surgical replace_range edits.${voice}
</humanize_korean_trigger>`;
}
