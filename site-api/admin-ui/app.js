(() => {
  const session = document.querySelector('meta[name="admin-session"]').content;
  const $ = (id) => document.getElementById(id);
  const dateTime = new Intl.DateTimeFormat('ko-KR', { dateStyle: 'medium', timeStyle: 'short' });
  const dateOnly = new Intl.DateTimeFormat('ko-KR', { dateStyle: 'medium' });
  const fmt = (value, style = dateTime) => (value ? style.format(new Date(value)) : '—');
  const PLATFORMS = { darwin: 'macOS', win32: 'Windows', linux: 'Linux' };
  const ERRORS = {
    forbidden: '관리자 토큰이 맞지 않아요.',
    token_missing: '관리자 토큰을 먼저 저장해 주세요.',
    name_required: '이름을 넣어 주세요.',
    devices_invalid: '기기 수는 1에서 50 사이 숫자예요.',
    invalid_key: '키를 찾을 수 없어요.',
    upstream_unreachable: '라이선스 서버에 연결하지 못했어요.',
    keychain_unavailable: '키체인을 쓸 수 없어요.',
    rate_limited: '요청이 많아요. 잠시 뒤 다시 해 주세요.',
  };

  async function api(method, path, body) {
    let res;
    try {
      res = await fetch(path, {
        method,
        headers: { 'X-Admin-Session': session, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    } catch {
      throw new Error('upstream_unreachable');
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      if (data.error === 'forbidden' || data.error === 'token_missing') $('token-form').hidden = false;
      throw new Error(data.error || `HTTP ${res.status}`);
    }
    return data;
  }

  const errorTimers = new Map();
  function showError(target, error) {
    const node = $(target);
    node.textContent = ERRORS[error.message] ?? error.message;
    clearTimeout(errorTimers.get(target));
    errorTimers.set(target, setTimeout(() => { node.textContent = ''; }, 5000));
  }

  const mask = (key) => `${key.slice(0, 10)}…${key.slice(-5)}`;

  async function copy(button, text) {
    await navigator.clipboard.writeText(text);
    button.classList.add('copied');
    setTimeout(() => button.classList.remove('copied'), 1200);
  }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function lastSeen(devices) {
    return devices.map((d) => d.lastSeenAt).filter(Boolean).sort().at(-1);
  }

  const DAY = 24 * 60 * 60 * 1000;
  const recent = (value) => Boolean(value) && Date.now() - new Date(value).getTime() < DAY;
  const lamp = (on) => el('span', on ? 'lamp on' : 'lamp');

  /** 두 번 눌러야 실행되는 단추. 첫 번째 누름은 3초 동안 확인을 묻는다. */
  function confirmButton(label, confirmLabel, run, className = '') {
    const button = el('button', className, label);
    button.type = 'button';
    let armed = null;
    button.addEventListener('click', async () => {
      if (!armed) {
        button.textContent = confirmLabel;
        button.classList.add('armed');
        armed = setTimeout(() => { armed = null; button.textContent = label; button.classList.remove('armed'); }, 3000);
        return;
      }
      clearTimeout(armed);
      armed = null;
      button.disabled = true;
      await run();
    });
    return button;
  }

  /** license: { keyId, key, name?, email?, tier?, status, deviceLimit, devices[], createdAt } */
  function rows(license, { errorTarget, refresh, showTier }) {
    const revoked = license.status === 'revoked';
    const row = el('tr', revoked ? 'revoked' : '');
    const detail = el('tr', 'detail');
    detail.hidden = true;

    const toggle = el('button', 'chevron', '›');
    toggle.type = 'button';
    toggle.setAttribute('aria-label', '기기 보기');
    toggle.setAttribute('aria-expanded', 'false');
    toggle.addEventListener('click', () => {
      detail.hidden = !detail.hidden;
      toggle.setAttribute('aria-expanded', String(!detail.hidden));
    });

    const devices = license.devices ?? [];
    const name = el('td');
    name.append(lamp(!revoked && recent(lastSeen(devices))), document.createTextNode(license.name || license.email || '—'));
    if (showTier && license.tier === 'beta') name.append(el('span', 'tag', '베타'));
    const keyCell = el('td');
    const keyButton = el('button', 'key mono', mask(license.key));
    keyButton.type = 'button';
    keyButton.title = '복사';
    keyButton.addEventListener('click', () => { void copy(keyButton, license.key); });
    keyCell.append(keyButton);

    const act = (path) => async () => {
      try {
        await api('POST', path, { keyId: license.keyId });
      } catch (error) {
        showError(errorTarget, error);
      }
      await refresh();
    };
    let primary;
    if (revoked) {
      primary = el('button', '', '복구');
      primary.type = 'button';
      primary.addEventListener('click', () => { primary.disabled = true; void act('/api/restore')(); });
    } else {
      primary = confirmButton('해지', '해지할까요?', act('/api/revoke'), 'danger');
    }
    const reset = confirmButton('기기 초기화', '초기화할까요?', act('/api/reset-devices'));
    reset.disabled = devices.length === 0;
    const actions = el('td', 'actions');
    actions.append(primary, reset);

    const toggleCell = el('td');
    toggleCell.append(toggle);
    row.append(
      toggleCell,
      name,
      keyCell,
      el('td', revoked ? 'status bad' : 'status', revoked ? '해지됨' : '사용 중'),
      el('td', 'num', `${devices.length}/${license.deviceLimit ?? 2}`),
      el('td', 'num', fmt(lastSeen(devices))),
      el('td', 'num', fmt(license.createdAt, dateOnly)),
      actions,
    );

    const cell = el('td');
    cell.colSpan = 8;
    if (devices.length === 0) {
      cell.append(el('span', 'muted', '활성화된 기기가 없어요.'));
    } else {
      const list = el('ul', 'devices');
      for (const d of devices) {
        const item = el('li');
        item.append(
          el('span', '', PLATFORMS[d.platform] ?? d.platform ?? '—'),
          el('span', 'muted num', fmt(d.lastSeenAt)),
          el('span', 'muted mono', d.deviceId),
        );
        list.append(item);
      }
      cell.append(list);
    }
    detail.append(cell);
    return [row, detail];
  }

  function render(tableId, licenses, options) {
    const body = $(tableId).querySelector('tbody');
    const open = new Set([...body.querySelectorAll('tr.detail:not([hidden])')].map((tr) => tr.dataset.keyId));
    body.replaceChildren();
    for (const license of licenses) {
      const [row, detail] = rows(license, options);
      detail.dataset.keyId = license.keyId;
      if (open.has(license.keyId)) {
        detail.hidden = false;
        row.querySelector('.chevron').setAttribute('aria-expanded', 'true');
      }
      body.append(row, detail);
    }
  }

  const relative = new Intl.RelativeTimeFormat('ko', { numeric: 'auto' });
  function ago(value) {
    if (!value) return '—';
    const minutes = Math.round((Date.now() - new Date(value).getTime()) / 60000);
    if (minutes < 1) return '방금';
    if (minutes < 60) return relative.format(-minutes, 'minute');
    if (minutes < 60 * 24) return relative.format(-Math.round(minutes / 60), 'hour');
    return relative.format(-Math.round(minutes / 60 / 24), 'day');
  }

  /** 벽 화면용 숫자와 목록. 해지한 키는 세지 않아요. */
  function showOverview(betas) {
    const active = betas.filter((b) => b.status !== 'revoked');
    const devices = active.flatMap((b) => b.devices ?? []);
    $('stat-testers').textContent = active.length;
    $('stat-devices').textContent = devices.length;
    $('stat-recent').textContent = devices.filter((d) => recent(d.lastSeenAt)).length;

    const list = active
      .map((b) => ({ name: b.name || '—', devices: b.devices ?? [], limit: b.deviceLimit ?? 2, seen: lastSeen(b.devices ?? []) }))
      .sort((a, b) => String(b.seen ?? '').localeCompare(String(a.seen ?? '')));
    $('roster').replaceChildren(...list.map((tester) => {
      const item = el('li', recent(tester.seen) ? '' : 'quiet');
      item.append(
        lamp(recent(tester.seen)),
        el('span', 'who', tester.name),
        el('span', 'num', `${tester.devices.length}/${tester.limit}`),
        el('span', 'seen', ago(tester.seen)),
      );
      return item;
    }));
  }

  /** 새로 나타난 기기가 있으면 하마가 별똥별을 봐요. 첫 불러오기는 세지 않아요. */
  let knownDevices = null;
  function noticeNewDevices(betas) {
    const ids = new Set(betas.flatMap((b) => (b.devices ?? []).map((d) => `${b.keyId}:${d.deviceId}`)));
    const fresh = knownDevices && [...ids].some((id) => !knownDevices.has(id));
    knownDevices = ids;
    if (fresh) window.hamaScene?.celebrate();
  }

  async function loadBetas({ background = false } = {}) {
    try {
      const { betas } = await api('GET', '/api/betas');
      showOverview(betas);
      noticeNewDevices(betas);
      // 확인을 묻는 단추가 있으면 자동 새로고침이 그 상태를 지우지 않게 표만 그대로 둬요.
      if (background && document.querySelector('#beta-table .armed')) return;
      render('beta-table', betas, { errorTarget: 'beta-error', refresh: loadBetas, showTier: false });
      $('beta-table').hidden = betas.length === 0;
      $('beta-empty').hidden = betas.length > 0;
    } catch (error) {
      if (!background) showError('beta-error', error);
    }
  }

  let lastLookup = null;
  async function runLookup() {
    if (!lastLookup) return;
    try {
      const { licenses } = await api('GET', `/api/licenses?${new URLSearchParams(lastLookup)}`);
      if (licenses.length === 0) throw new Error('invalid_key');
      render('lookup-table', licenses, { errorTarget: 'lookup-error', refresh: refreshAll, showTier: true });
      $('lookup-table').hidden = false;
    } catch (error) {
      $('lookup-table').hidden = true;
      showError('lookup-error', error);
    }
  }

  async function refreshAll() {
    await Promise.all([loadBetas(), runLookup()]);
  }

  $('create-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const submit = event.submitter;
    submit.disabled = true;
    try {
      const { license } = await api('POST', '/api/issue-beta', {
        name: $('name').value.trim(),
        devices: Number($('devices').value || 5),
        note: $('note').value.trim(),
      });
      $('created-name').textContent = `${license.name} · 기기 ${license.deviceLimit}대`;
      $('created-key').textContent = license.key;
      $('created').hidden = false;
      $('name').value = '';
      $('note').value = '';
      window.hamaScene?.celebrate();
      await loadBetas();
    } catch (error) {
      showError('beta-error', error);
    } finally {
      submit.disabled = false;
    }
  });
  $('created-key').addEventListener('click', (event) => {
    void copy(event.currentTarget, event.currentTarget.textContent);
  });

  $('lookup-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const value = $('lookup').value.trim();
    lastLookup = value.includes('@') ? { email: value } : { key: value };
    await runLookup();
  });

  $('token-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      await api('POST', '/api/token', { token: $('token').value });
      $('token').value = '';
      $('token-form').hidden = true;
      await refreshAll();
    } catch (error) {
      showError('beta-error', error);
    }
  });

  (async () => {
    try {
      const state = await api('GET', '/api/state');
      $('upstream').textContent = new URL(state.upstream).host;
      if (!state.tokenSource) {
        $('token-form').hidden = false;
        return;
      }
      await loadBetas();
      setInterval(() => { void loadBetas({ background: true }); }, 60_000);
    } catch (error) {
      showError('beta-error', error);
    }
  })();

  // ─────────── 벽에 거는 화면 ───────────
  const root = document.documentElement;
  const toggle = $('wall-toggle');
  function setWall(on) {
    root.classList.toggle('wall', on);
    toggle.textContent = on ? '나가기' : '전체 화면';
    toggle.setAttribute('aria-pressed', String(on));
    window.hamaScene?.layout();
    wake();
  }
  async function toggleWall() {
    const on = !root.classList.contains('wall');
    if (!document.fullscreenEnabled) return setWall(on);
    try {
      if (on) await root.requestFullscreen();
      else if (document.fullscreenElement) await document.exitFullscreen();
      else setWall(false);
    } catch {
      setWall(on);
    }
  }
  document.addEventListener('fullscreenchange', () => setWall(Boolean(document.fullscreenElement)));
  toggle.addEventListener('click', () => { void toggleWall(); });
  document.addEventListener('keydown', (event) => {
    if (event.target.closest?.('input, textarea, select') || event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.key === 'f' || event.key === 'F') { event.preventDefault(); void toggleWall(); }
    else if (event.key === 'Escape' && root.classList.contains('wall') && !document.fullscreenElement) setWall(false);
  });

  // 가만히 3초가 지나면 커서와 단추를 숨겨요.
  let idleTimer = 0;
  function wake() {
    root.classList.remove('idle');
    clearTimeout(idleTimer);
    if (root.classList.contains('wall')) idleTimer = setTimeout(() => root.classList.add('idle'), 3000);
  }
  for (const type of ['pointermove', 'pointerdown', 'keydown']) document.addEventListener(type, wake, { passive: true });

  // 화면이 타지 않게 장면 전체를 3분마다 몇 픽셀씩 옮겨요.
  const DRIFT = [[0, 0], [2, 1], [4, 2], [5, 4], [3, 5], [1, 4], [-1, 2], [-2, 0], [-1, -2], [1, -1]];
  let driftStep = 0;
  setInterval(() => {
    driftStep = (driftStep + 1) % DRIFT.length;
    const [x, y] = DRIFT[driftStep];
    document.querySelector('.drift').style.transform = `translate(${x}px, ${y}px)`;
  }, 180_000);

  window.hamaScene?.mount($('stage'));
})();
