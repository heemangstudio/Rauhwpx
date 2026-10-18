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

    const name = el('td');
    name.append(document.createTextNode(license.name || license.email || '—'));
    if (showTier && license.tier === 'beta') name.append(el('span', 'tag', '베타'));
    const keyCell = el('td');
    const keyButton = el('button', 'key mono', mask(license.key));
    keyButton.type = 'button';
    keyButton.title = '복사';
    keyButton.addEventListener('click', () => { void copy(keyButton, license.key); });
    keyCell.append(keyButton);

    const devices = license.devices ?? [];
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

  async function loadBetas() {
    try {
      const { betas } = await api('GET', '/api/betas');
      render('beta-table', betas, { errorTarget: 'beta-error', refresh: loadBetas, showTier: false });
      $('beta-table').hidden = betas.length === 0;
      $('beta-empty').hidden = betas.length > 0;
    } catch (error) {
      showError('beta-error', error);
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
    } catch (error) {
      showError('beta-error', error);
    }
  })();
})();
