/**
 * 제품 정보 / 라이센스 다이얼로그
 *
 * 제품명, 버전, 고유 설치 수만 보이고 나머지는 접힌 "정보" 안에 둔다.
 * HWP 공개 스펙(hwp_spec_5.0) 저작권 조항에 따른 필수 고지 문구와 라이선스 전문을 포함한다.
 */
import { ModalDialog } from './dialog';
import {
  formatUniqueInstallCount,
  loadUniqueInstallSnapshot,
  uniqueInstallPublicUrl,
} from '../unique-installs';
// MIT 등 오픈소스 라이선스는 고지문 전문을 함께 배포해야 하므로 앱에 그대로 싣는다.
import rhwpLicense from '../../../LICENSE?raw';
import thirdPartyLicenses from '../../../THIRD_PARTY_LICENSES.md?raw';

export class AboutDialog extends ModalDialog {
  private uniqueInstallsEl: HTMLElement | null = null;
  private uniqueInstallsNoteEl: HTMLElement | null = null;

  constructor() {
    super('제품 정보', 460);
  }

  protected createBody(): HTMLElement {
    const body = document.createElement('div');
    body.className = 'about-body';

    // 제품 영문명
    const titleEn = document.createElement('div');
    titleEn.className = 'about-product-name';
    titleEn.textContent = 'HamaEditor';
    body.appendChild(titleEn);

    // 제품 한글명
    const titleKo = document.createElement('div');
    titleKo.className = 'about-product-name-ko';
    titleKo.textContent = '한국어 문서 편집기';
    body.appendChild(titleKo);

    // 버전 + 빌드 커밋
    const version = document.createElement('div');
    version.className = 'about-version';
    version.textContent = `Version ${__APP_VERSION__} (${__APP_COMMIT__})`;
    body.appendChild(version);

    const uniqueInstalls = document.createElement('div');
    uniqueInstalls.className = 'about-unique-installs';
    uniqueInstalls.hidden = true;
    this.uniqueInstallsEl = uniqueInstalls;
    body.appendChild(uniqueInstalls);

    // 고지, 라이선스, 저작권은 접어 둔다
    const info = document.createElement('details');
    info.className = 'about-info';
    const infoSummary = document.createElement('summary');
    infoSummary.textContent = '정보';
    info.appendChild(infoSummary);

    const installNote = document.createElement('div');
    installNote.className = 'about-unique-installs-note';
    installNote.hidden = true;
    this.uniqueInstallsNoteEl = installNote;
    info.appendChild(installNote);

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
    copyright.textContent = '\u00A9 2026 rhwp: Edward Kim';
    info.appendChild(copyright);

    body.appendChild(info);

    return body;
  }

  protected onConfirm(): void {
    // 정보 표시 전용 — 확인 동작 없음
  }

  override show(): void {
    super.show();
    void this.loadUniqueInstalls();
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

  private async loadUniqueInstalls(): Promise<void> {
    const target = this.uniqueInstallsEl;
    if (!target) return;
    const snapshot = await loadUniqueInstallSnapshot();
    const count = snapshot.uniqueInstalls;
    if (count == null) {
      target.hidden = true;
      if (this.uniqueInstallsNoteEl) this.uniqueInstallsNoteEl.hidden = true;
      return;
    }
    target.hidden = false;
    target.textContent = `고유 설치 ${formatUniqueInstallCount(count)}`;
    if (this.uniqueInstallsNoteEl) {
      this.uniqueInstallsNoteEl.hidden = false;
      this.uniqueInstallsNoteEl.textContent =
        `첫 실행 보고만 셉니다. ${uniqueInstallPublicUrl(snapshot)}`;
    }
  }
}
