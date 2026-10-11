interface AdblockState { enabled: boolean; pausedSites: string[]; sites: string[]; updatedAt: string; }
interface AdblockApi {
  get(): Promise<AdblockState>;
  configure(value: { enabled: boolean; pausedSites: string[] }): Promise<AdblockState>;
  update(): Promise<AdblockState>;
}

export function createAdblockSettings() {
  const api = (window as unknown as { rhwpDesktop?: { browser?: { adblock?: AdblockApi } } }).rhwpDesktop?.browser?.adblock;
  if (!api) return null;
  const section = document.createElement('section'); section.className = 'ag-browser-section';
  const heading = document.createElement('h3'); heading.className = 'ag-settings-section-title'; heading.textContent = '광고 차단';
  const label = document.createElement('label'); label.className = 'ag-browser-check';
  const enabled = document.createElement('input'); enabled.type = 'checkbox';
  label.append(enabled, document.createTextNode('광고 및 추적 요청 차단'));
  const credit = document.createElement('p'); credit.className = 'ag-browser-empty'; credit.textContent = 'Ghostery · EasyList · EasyPrivacy';
  const sites = document.createElement('div');
  const actions = document.createElement('div'); actions.className = 'ag-browser-adblock-actions';
  const input = document.createElement('input'); input.className = 'ag-settings-input'; input.placeholder = 'example.com'; input.setAttribute('aria-label', '광고 차단을 일시 중지할 사이트');
  const pause = document.createElement('button'); pause.type = 'button'; pause.className = 'ag-settings-btn'; pause.textContent = '사이트 일시 중지';
  const update = document.createElement('button'); update.type = 'button'; update.className = 'ag-settings-btn'; update.textContent = '필터 업데이트';
  const message = document.createElement('p'); message.className = 'ag-browser-message'; message.setAttribute('role', 'status');
  actions.append(input, pause, update); section.append(heading, label, credit, sites, actions, message);
  let state: AdblockState; let busy = false;
  function render() {
    enabled.checked = state.enabled; sites.replaceChildren();
    for (const site of [...new Set([...state.pausedSites, ...state.sites])]) {
      const row = document.createElement('div'); row.className = 'ag-browser-row';
      const name = document.createElement('span'); name.className = 'ag-browser-row-copy'; name.textContent = site;
      const button = document.createElement('button'); button.type = 'button'; button.className = 'ag-settings-btn';
      const paused = state.pausedSites.includes(site); button.textContent = paused ? '차단 재개' : '일시 중지'; button.setAttribute('aria-label', `${site} ${button.textContent}`);
      button.addEventListener('click', () => void change(() => api!.configure({ enabled: state.enabled, pausedSites: paused ? state.pausedSites.filter(value => value !== site) : [...state.pausedSites, site] })));
      row.append(name, button); sites.append(row);
    }
    credit.textContent = `Ghostery · EasyList · EasyPrivacy · ${state.updatedAt.slice(0, 10)}`;
  }
  function disable(value: boolean) { busy = value; for (const control of section.querySelectorAll<HTMLInputElement | HTMLButtonElement>('input,button')) control.disabled = value; }
  async function change(operation: () => Promise<AdblockState>) {
    if (busy) return; disable(true); message.textContent = '';
    try { state = await operation(); render(); message.textContent = '적용했습니다. 열린 페이지를 새로고침하세요.'; }
    catch { if (state) render(); message.textContent = '변경하지 못했습니다. 기존 설정과 필터를 유지합니다.'; }
    finally { disable(false); }
  }
  enabled.addEventListener('change', () => void change(() => api.configure({ enabled: enabled.checked, pausedSites: state.pausedSites })));
  pause.addEventListener('click', () => {
    try {
      const url = new URL(input.value.includes('://') ? input.value : `https://${input.value}`);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || !url.hostname) throw new Error();
      void change(() => api.configure({ enabled: state.enabled, pausedSites: [...new Set([...state.pausedSites, url.hostname])] }));
    } catch { message.textContent = '사이트 주소를 입력하세요.'; }
  });
  update.addEventListener('click', () => void change(() => api.update()));
  disable(true);
  void api.get().then(value => { state = value; render(); disable(false); }).catch(() => { message.textContent = '광고 차단 설정을 불러오지 못했습니다.'; });
  return section;
}
