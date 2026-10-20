/**
 * 제품 정보 / 라이센스 다이얼로그
 *
 * 제품명과 버전만 보이고, 고지와 라이선스 전문은 접힌 "라이선스" 안에 둔다.
 * HWP 공개 스펙(hwp_spec_5.0) 저작권 조항에 따른 필수 고지 문구와 라이선스 전문을 포함한다.
 */
import { ModalDialog } from './dialog';
// MIT 등 오픈소스 라이선스는 고지문 전문을 함께 배포해야 하므로 앱에 그대로 싣는다.
import rhwpLicense from '../../../LICENSE?raw';
import thirdPartyLicenses from '../../../THIRD_PARTY_LICENSES.md?raw';

const SVG_NS = 'http://www.w3.org/2000/svg';
const HIPPO_SCALE = 2;

/* 제품명 오른쪽 위로 고개를 내민 하마. 색은 설정 하마(scripts/generate-boot-logo.py)와 같다. */
const HIPPO_COLORS: Record<string, string> = {
  o: '#62b3e2',
  s: '#2f73a0',
  h: '#b2e2fb',
  d: '#1d4766',
  k: '#0c2536',
  w: '#e6f5ff',
};

const HIPPO = [
  '.....hh..........hh.....',
  '....hsoh..hhhh..hsos....',
  '....hoooohooooohooos....',
  '...hoowkoooooooowkoos...',
  '...hookkoooooooookkos...',
  '...hoooooooooooooooos...',
  '..hhoooooooooooooooohh..',
  '.hooooooodkookdoooooooos',
  '.hooooooooooooooooooooos',
  'hoohsoooooooooooooohoohs',
  'okokssssssssssssssskokos',
];

function peekingHippo(): SVGSVGElement {
  const paths = new Map<string, string>();
  HIPPO.forEach((row, y) => {
    for (let x = 0; x < row.length;) {
      const color = row[x];
      let end = x + 1;
      while (row[end] === color) end += 1;
      if (color in HIPPO_COLORS) {
        paths.set(color, `${paths.get(color) ?? ''}M${x} ${y}h${end - x}v1h-${end - x}z`);
      }
      x = end;
    }
  });
  const width = HIPPO[0].length;
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', 'about-hippo');
  svg.setAttribute('viewBox', `0 0 ${width} ${HIPPO.length}`);
  svg.setAttribute('width', String(width * HIPPO_SCALE));
  svg.setAttribute('height', String(HIPPO.length * HIPPO_SCALE));
  svg.setAttribute('shape-rendering', 'crispEdges');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  for (const [color, d] of paths) {
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('fill', HIPPO_COLORS[color]);
    path.setAttribute('d', d);
    svg.appendChild(path);
  }
  return svg;
}

export class AboutDialog extends ModalDialog {
  constructor() {
    super('제품 정보', 460);
  }

  protected createBody(): HTMLElement {
    const body = document.createElement('div');
    body.className = 'about-body';

    const wordmark = document.createElement('div');
    wordmark.className = 'about-product-name';
    wordmark.append('HamaEditor', peekingHippo());
    body.appendChild(wordmark);

    const tagline = document.createElement('div');
    tagline.className = 'about-product-name-ko';
    tagline.textContent = '한글 문서 편집기';
    body.appendChild(tagline);

    // 버전 + 빌드 커밋
    const version = document.createElement('div');
    version.className = 'about-version';
    version.textContent = `Version ${__APP_VERSION__} (${__APP_COMMIT__})`;
    body.appendChild(version);

    // 고지, 라이선스, 저작권은 접어 둔다
    const info = document.createElement('details');
    info.className = 'about-info';
    const infoSummary = document.createElement('summary');
    infoSummary.textContent = '라이선스';
    info.appendChild(infoSummary);

    // HWP 스펙 고지 문구 (필수)
    const notice = document.createElement('div');
    notice.className = 'about-notice';
    notice.textContent =
      '본 제품은 한글과컴퓨터의 한글 문서 파일(.hwp) 공개 문서를 참고하여 개발하였습니다. '
      + 'HamaEditor는 독립 프로젝트이며 한글과컴퓨터와 무관합니다.';
    info.appendChild(notice);

    const licenseText = document.createElement('pre');
    licenseText.className = 'about-license-text';
    licenseText.textContent = `rhwp\n\n${rhwpLicense.trim()}\n\n\n${thirdPartyLicenses.trim()}`;
    info.appendChild(licenseText);

    const copyright = document.createElement('div');
    copyright.className = 'about-copyright';
    copyright.textContent = '© 2026 rhwp: Edward Kim';
    info.appendChild(copyright);

    body.appendChild(info);

    return body;
  }

  protected onConfirm(): void {
    // 정보 표시 전용 — 확인 동작 없음
  }

  override show(): void {
    super.show();
    // footer를 "닫기" 버튼 하나로 교체
    const footer = this.dialog.querySelector('.dialog-footer');
    if (footer) {
      footer.replaceChildren();
      const closeBtn = document.createElement('button');
      closeBtn.className = 'dialog-btn dialog-btn-primary';
      closeBtn.textContent = '닫기';
      closeBtn.addEventListener('click', () => this.hide());
      footer.appendChild(closeBtn);
    }
  }
}
