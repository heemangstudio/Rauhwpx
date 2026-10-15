import type { DesktopHost } from '../desktop-integration';
import { licenseSummary, type LicenseStatus } from './agent-sidebar/settings-license';
import './license-gate.css';

/** 메인의 상태를 입력·명령·에이전트에 함께 적용한다. 상태를 읽기 전에는 편집을 잠근다. */
export async function installLicenseGate(setReadOnly: (value: boolean) => void): Promise<void> {
  const api = (window as unknown as DesktopHost).rhwpDesktop?.license;
  if (!api) return;
  setReadOnly(true);
  const banner = document.createElement('aside');
  banner.className = 'license-banner';
  banner.setAttribute('aria-label', '라이선스');
  const label = document.createElement('span');
  label.setAttribute('role', 'status');
  label.textContent = '라이선스를 확인하고 있어요.';
  const activate = document.createElement('button');
  activate.type = 'button';
  activate.textContent = '라이선스 활성화';
  activate.addEventListener('click', () => { void api.openActivation(); });
  banner.append(label, activate);
  const area = document.getElementById('editor-area');
  if (area) area.before(banner);
  else document.body.prepend(banner);
  let receivedChange = false;
  function render(status: LicenseStatus): void {
    setReadOnly(!status.canEdit);
    const summary = licenseSummary(status);
    banner.hidden = status.canEdit;
    label.textContent = `${summary.title}. ${summary.detail}`;
  }
  const unsubscribe = api.onChange(status => { receivedChange = true; render(status); });
  window.addEventListener('pagehide', unsubscribe, { once: true });
  try {
    const initial = await api.getStatus();
    if (!receivedChange) render(initial);
  } catch {
    label.textContent = '라이선스를 확인하지 못했어요. 읽기 전용으로 열었어요.';
  }
}
