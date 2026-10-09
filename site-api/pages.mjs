function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const SHELL_CSS = `
:root {
  --bg: #0b0c0f;
  --text: #f4f3ef;
  --muted: #8d8e96;
  --soft: #b8b8bf;
  --bear: #d4cdc4;
}
* { box-sizing: border-box; }
html, body { height: 100%; }
body {
  margin: 0;
  display: grid;
  place-items: center;
  padding: 28px 18px;
  background:
    radial-gradient(circle at 50% -42%, rgba(82, 105, 169, 0.065), transparent 38%),
    var(--bg);
  color: var(--text);
  font: 15px/1.45 -apple-system, BlinkMacSystemFont, "Apple SD Gothic Neo", "Malgun Gothic", sans-serif;
}
.wrap { width: min(400px, 100%); }
.brand {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  margin: 0 0 22px;
  color: var(--soft);
  font-size: 13px;
  font-weight: 700;
  letter-spacing: 0.01em;
}
.mark {
  width: 18px;
  height: 18px;
  background: var(--bear);
  -webkit-mask: url("/rau.png") center / contain no-repeat;
  mask: url("/rau.png") center / contain no-repeat;
}
.card {
  width: 100%;
  padding: 28px 24px 24px;
  border: 1px solid #fff;
  border-radius: 16px;
  background: #17181c;
  box-shadow:
    0 0 0 1px rgba(255, 255, 255, 0.16) inset,
    0 18px 50px rgba(0, 0, 0, 0.16);
}
.hero {
  display: grid;
  place-items: center;
  width: 38px;
  height: 38px;
  margin-bottom: 18px;
}
.hero span {
  width: 32px;
  height: 32px;
  background: var(--bear);
  -webkit-mask: url("/rau.png") center / contain no-repeat;
  mask: url("/rau.png") center / contain no-repeat;
}
h1 {
  margin: 0;
  font-size: 28px;
  font-weight: 700;
  letter-spacing: -0.03em;
  line-height: 1.12;
}
p {
  margin: 10px 0 0;
  color: var(--muted);
  font-size: 14px;
  line-height: 1.55;
}
.hero-count {
  margin: 18px 0 0;
  color: var(--text);
  font: 700 56px/1.05 -apple-system, BlinkMacSystemFont, "Apple SD Gothic Neo", "Malgun Gothic", sans-serif;
  letter-spacing: -0.04em;
}
`.trim();

function shell({ title, body }) {
  return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<link rel="icon" href="/rau.png">
<style>${SHELL_CSS}</style>
</head>
<body>
<div class="wrap">
  <div class="brand"><span class="mark" aria-hidden="true"></span>HamaEditor</div>
  ${body}
</div>
</body>
</html>`;
}

export function renderUniqueInstallsPage({ uniqueInstalls }) {
  const count = Number.isSafeInteger(uniqueInstalls) && uniqueInstalls >= 0 ? uniqueInstalls : 0;
  return shell({
    title: 'HamaEditor 고유 설치',
    body: `
<section class="card">
  <div class="hero"><span></span></div>
  <h1>고유 데스크톱 설치</h1>
  <p class="hero-count">${escapeHtml(count.toLocaleString('ko-KR'))}</p>
  <p>공식 macOS arm64·Windows x64 앱을 설치한 뒤 그 기기에서 처음 연 횟수입니다. 자동 업데이트와 GitHub 다운로드 수는 넣지 않습니다.</p>
  <p>데스크톱 앱이 보낸 첫 실행 보고이며 기기 증명(attestation)은 아닙니다. HMAC은 아무 서명 없는 요청을 거를 뿐, 패키지를 연 누구나 같은 서명을 만들 수 있습니다.</p>
  <p>첫 실행 때 익명 설치 식별자, 앱 버전, OS, 아키텍처만 받습니다. 이름, 이메일, 호스트 이름, 문서 경로는 저장하지 않으며 IP는 신원으로 쓰지 않습니다.</p>
</section>`,
  });
}
