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
    amount_invalid: '크레딧은 0에서 1000달러 사이예요.',
    budget_exhausted: '전체 크레딧 예산을 넘어요.',
    upstream_unavailable: 'OpenRouter에 연결하지 못했어요.',
    gift_provisioning: '크레딧 키를 만드는 중이에요. 잠시 뒤 다시 해 주세요.',
    event_inactive: '크레딧 이벤트가 꺼져 있어요.',
    email_invalid: '이메일 주소가 올바르지 않아요.',
    email_missing: '이메일 주소를 넣어 주세요.',
    device_not_found: '이미 빠진 기기예요.',
    lifetime_key: '평생 키는 연장할 수 없어요.',
    license_revoked: '해지된 키예요. 먼저 복구해 주세요.',
    order_not_found: '주문을 찾을 수 없어요.',
    order_refunded: '환불된 주문이에요.',
    renewal_use_extend: '갱신 결제는 쓰던 키를 연장해서 처리해요.',
    not_a_renewal: '갱신 결제가 아니에요.',
    event_not_found: '이미 처리한 항목이에요.',
    plan_required: '등급을 골라 주세요.',
    plan_invalid: '등급이 올바르지 않아요.',
    duration_required: '기간을 넣어 주세요.',
    duration_conflict: '기간은 개월이나 일 중 하나로 넣어 주세요.',
    duration_invalid: '기간은 1에서 120개월, 또는 1에서 3660일 사이예요.',
    count_invalid: '개수는 1에서 1000 사이예요.',
    redeem_by_invalid: '사용 기한은 오늘이나 그 뒤 날짜예요.',
    invalid_code: '코드를 찾을 수 없어요.',
    invalid_format: '코드 형식이 올바르지 않아요.',
    batch_not_found: '묶음을 찾을 수 없어요.',
    code_redeemed: '이미 사용한 코드예요. 그 키를 해지해 주세요.',
    copy_failed: '복사하지 못했어요.',
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
  const dollars = (n, cents = false) => `$${cents || n % 1 ? n.toFixed(2) : n}`;
  const won = (n) => (typeof n === 'number' ? `${n.toLocaleString('ko-KR')}원` : '');

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

  /**
   * 크레딧 칸. 받은 키는 쓴 만큼/한도, 아직 안 받은 키는 정해 둔 금액을 보여 줘요.
   * 금액을 누르면 그 자리에서 고칠 수 있어요.
   */
  function giftCell(license, { errorTarget, refresh }) {
    const cell = el('td', 'num credit');
    const gift = license.gift;
    if (!gift) { cell.textContent = '—'; return cell; }
    if (gift.status === 'revoked') { cell.append(el('span', 'muted', '중지됨')); return cell; }
    const label = gift.status === 'active' && gift.usedUsd !== null
      ? `${dollars(gift.usedUsd, true)} / ${dollars(gift.amountUsd)}`
      : dollars(gift.amountUsd);
    const show = el('button', 'amount', label);
    show.type = 'button';
    show.title = '크레딧 바꾸기';
    show.addEventListener('click', () => {
      const input = el('input', 'amount');
      Object.assign(input, { type: 'number', min: '0', max: '1000', step: '0.01', value: String(gift.amountUsd) });
      input.setAttribute('aria-label', '크레딧 (달러)');
      const save = el('button', 'primary', '저장');
      save.type = 'button';
      const form = el('span', 'edit');
      form.append(input, save);
      cell.classList.add('editing');
      cell.replaceChildren(form);
      input.focus();
      input.select();
      const cancel = () => { cell.classList.remove('editing'); cell.replaceChildren(show); };
      const submit = async () => {
        if (input.value.trim() === '') return cancel();
        input.disabled = save.disabled = true;
        try {
          await api('POST', '/api/gift-amount', { keyId: license.keyId, amountUsd: Number(input.value) });
        } catch (error) {
          showError(errorTarget, error);
        }
        cell.classList.remove('editing');
        await refresh();
      };
      save.addEventListener('click', () => { void submit(); });
      form.addEventListener('focusout', (event) => {
        if (!input.disabled && !form.contains(event.relatedTarget)) cancel();
      });
      input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') { event.preventDefault(); void submit(); }
        else if (event.key === 'Escape') cancel();
      });
    });
    cell.append(show);
    return cell;
  }

  /** 펼친 줄을 여닫는 단추. */
  function chevron(detail, label = '기기 보기') {
    const toggle = el('button', 'chevron', '›');
    toggle.type = 'button';
    toggle.setAttribute('aria-label', label);
    toggle.setAttribute('aria-expanded', 'false');
    toggle.addEventListener('click', () => {
      detail.hidden = !detail.hidden;
      toggle.setAttribute('aria-expanded', String(!detail.hidden));
    });
    return toggle;
  }

  function keyCell(key) {
    const cell = el('td');
    const button = el('button', 'key mono', mask(key));
    button.type = 'button';
    button.title = '복사';
    button.addEventListener('click', () => { void copy(button, key); });
    cell.append(button);
    return cell;
  }

  /** 펼친 줄의 기기 목록. 기기마다 그 기기만 빼는 단추가 있어요. */
  function deviceList(license, { errorTarget, refresh }) {
    const devices = license.devices ?? [];
    if (devices.length === 0) return el('span', 'muted', '활성화된 기기가 없어요.');
    const list = el('ul', 'devices');
    for (const d of devices) {
      const item = el('li');
      const remove = confirmButton('빼기', '뺄까요?', async () => {
        try {
          await api('POST', '/api/remove-device', { keyId: license.keyId, deviceId: d.deviceId });
        } catch (error) {
          showError(errorTarget, error);
        }
        await refresh();
      }, 'small');
      item.append(
        el('span', '', PLATFORMS[d.platform] ?? d.platform ?? '—'),
        el('span', 'muted num', fmt(d.lastSeenAt)),
        el('span', 'muted mono', d.deviceId),
        remove,
      );
      list.append(item);
    }
    return list;
  }

  /** license: { keyId, key, name?, email?, tier?, status, deviceLimit, devices[], createdAt, gift? } */
  function rows(license, { errorTarget, refresh, showTier, showGift = false }) {
    const revoked = license.status === 'revoked';
    const row = el('tr', revoked ? 'revoked' : '');
    const detail = el('tr', 'detail');
    detail.hidden = true;
    const toggle = chevron(detail);

    const devices = license.devices ?? [];
    const name = el('td');
    name.append(lamp(!revoked && recent(lastSeen(devices))), document.createTextNode(license.name || license.email || '—'));
    if (showTier && license.tier === 'beta') name.append(el('span', 'tag', '베타'));

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
      keyCell(license.key),
      el('td', revoked ? 'status bad' : 'status', revoked ? '해지됨' : '사용 중'),
      el('td', 'num', `${devices.length}/${license.deviceLimit ?? 2}`),
      ...(showGift ? [giftCell(license, { errorTarget, refresh })] : []),
      el('td', 'num', fmt(lastSeen(devices))),
      el('td', 'num', fmt(license.createdAt, dateOnly)),
      actions,
    );

    const cell = el('td');
    cell.colSpan = showGift ? 9 : 8;
    cell.append(deviceList(license, { errorTarget, refresh }));
    detail.append(cell);
    return [row, detail];
  }

  const DELIVERY = { pending: '보내는 중', sent: '보냄', failed: '실패', skipped: '건너뜀', no_address: '주소 없음', manual: '안 보냄' };
  const TERM = { past_due: '결제 실패', lapsed: '만료됨' };

  /** customer: GET /api/customers 의 한 줄. 펼치면 기기와 키 다시 보내기가 나와요. */
  function customerRows(customer, { refresh }) {
    const errorTarget = 'customer-error';
    const revoked = customer.status === 'revoked';
    const row = el('tr', revoked ? 'revoked' : '');
    const detail = el('tr', 'detail');
    detail.hidden = true;
    const toggle = chevron(detail, '자세히 보기');
    const devices = customer.devices ?? [];

    const email = el('td');
    // 선물 코드로 만든 키는 이메일 없이 계정에 붙어요.
    const gift = customer.source === 'gift_code' && !customer.email;
    email.append(lamp(!revoked && recent(lastSeen(devices))), gift ? el('span', 'muted', '선물 코드') : document.createTextNode(customer.email || '—'));
    const term = TERM[customer.subscriptionStatus];
    const status = el('td', revoked || term ? 'status bad' : 'status', revoked ? '해지됨' : term ?? '사용 중');
    const expiry = el('td', 'num');
    if (customer.subscriptionStatus === 'lifetime') expiry.textContent = '평생';
    else {
      expiry.textContent = fmt(customer.expiresAt, dateOnly);
      if (customer.autoRenew === false) expiry.append(el('span', 'muted', ' · 갱신 끔'));
    }
    const delivery = customer.emailDelivery ?? {};
    const mail = el('td', delivery.status === 'failed' ? 'status bad' : '', DELIVERY[delivery.status] ?? '—');
    mail.title = [delivery.lastAttemptAt ? fmt(delivery.lastAttemptAt) : '', delivery.error ?? ''].filter(Boolean).join(' · ');

    const act = (path, body = {}) => async () => {
      try {
        await api('POST', path, { keyId: customer.keyId, ...body });
      } catch (error) {
        showError(errorTarget, error);
      }
      await refresh();
    };
    const resendOpen = el('button', '', '다시 보내기');
    resendOpen.type = 'button';
    resendOpen.addEventListener('click', () => {
      detail.hidden = false;
      toggle.setAttribute('aria-expanded', 'true');
      detail.querySelector('input')?.focus();
    });
    const extend = confirmButton('1년 연장', '연장할까요?', act('/api/extend'));
    extend.disabled = revoked || customer.subscriptionStatus === 'lifetime';
    let primary;
    if (revoked) {
      primary = el('button', '', '복구');
      primary.type = 'button';
      primary.addEventListener('click', () => { primary.disabled = true; void act('/api/restore')(); });
    } else {
      primary = confirmButton('해지', '해지할까요?', act('/api/revoke'), 'danger');
    }
    const actions = el('td', 'actions');
    actions.append(resendOpen, extend, primary);

    const toggleCell = el('td');
    toggleCell.append(toggle);
    row.append(
      toggleCell,
      email,
      keyCell(customer.key),
      status,
      expiry,
      el('td', 'num', `${devices.length}/${customer.deviceLimit ?? 2}`),
      mail,
      el('td', 'num', fmt(customer.createdAt, dateOnly)),
      actions,
    );

    const cell = el('td');
    cell.colSpan = 9;
    const resend = el('form', 'resend');
    const to = el('input', 'grow');
    Object.assign(to, { type: 'email', value: customer.email ?? '', placeholder: '이메일', required: true, maxLength: 254 });
    to.setAttribute('aria-label', '받을 이메일');
    const send = el('button', 'primary', '키 다시 보내기');
    send.type = 'submit';
    resend.append(to, send);
    resend.addEventListener('submit', async (event) => {
      event.preventDefault();
      send.disabled = true;
      await act('/api/resend-email', { email: to.value.trim() })();
    });
    cell.append(deviceList(customer, { errorTarget, refresh }), resend);
    if (customer.merchantUid) {
      cell.append(el('p', 'muted order', [`주문번호 ${customer.merchantUid}`, won(customer.amount)].filter(Boolean).join(' · ')));
    }
    detail.append(cell);
    return [row, detail];
  }

  /** 표를 다시 그려요. 펼쳐 둔 줄은 idOf 로 알아보고 계속 펼쳐 둬요. */
  function render(tableId, items, build, idOf = (item) => item.keyId) {
    const body = $(tableId).querySelector('tbody');
    const open = new Set([...body.querySelectorAll('tr.detail:not([hidden])')].map((tr) => tr.dataset.id));
    body.replaceChildren();
    for (const item of items) {
      const [row, detail] = build(item);
      detail.dataset.id = idOf(item);
      if (open.has(detail.dataset.id)) {
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
      const { betas, giftEvent } = await api('GET', '/api/betas');
      noticeNewDevices(betas);
      $('gift').hidden = !giftEvent;
      if (giftEvent) $('gift').placeholder = dollars(giftEvent.amountUsd);
      // 확인을 묻는 단추나 고치는 중인 크레딧이 있으면 자동 새로고침이 그 상태를 지우지 않게 표만 그대로 둬요.
      if (background && document.querySelector('#beta-table .armed, #beta-table .editing')) return;
      render('beta-table', betas, (b) => rows(b, { errorTarget: 'beta-error', refresh: loadBetas, showTier: false, showGift: true }));
      $('beta-table').hidden = betas.length === 0;
      $('beta-empty').hidden = betas.length > 0;
    } catch (error) {
      if (!background) showError('beta-error', error);
    }
  }

  // 확인을 묻는 단추가 켜져 있거나 입력 중이면 자동 새로고침이 그 상태를 지우지 않게 해요.
  const busy = (scope) => Boolean(document.querySelector(`${scope} .armed, ${scope} .editing, ${scope} input:focus, ${scope} select:focus`));

  let customers = [];
  function showCustomers() {
    const needle = $('customer-filter').value.trim().toLowerCase();
    const list = needle
      ? customers.filter((c) => (c.email ?? '').toLowerCase().includes(needle) || c.key.toLowerCase().includes(needle))
      : customers;
    render('customer-table', list, (c) => customerRows(c, { refresh: refreshAll }));
    $('customer-table').hidden = customers.length === 0;
    $('customer-empty').hidden = customers.length > 0;
  }

  async function loadCustomers({ background = false } = {}) {
    try {
      ({ customers } = await api('GET', '/api/customers'));
      if (background && busy('#customer-table')) return;
      showCustomers();
    } catch (error) {
      if (!background) showError('customer-error', error);
    }
  }

  /** 보류한 주문이나 확인할 이벤트 하나. 주문은 키 발급이나 연장, 이벤트는 확인으로 끝나요. */
  function attentionItem(item) {
    const li = el('li');
    const what = el('div', 'what');
    what.append(
      el('strong', '', item.reasonText),
      el('span', 'muted', [item.email, won(item.amount), fmt(item.at), item.merchantUid].filter(Boolean).join(' · ')),
    );
    const actions = el('div', 'actions');
    const run = (path, body) => async () => {
      try {
        await api('POST', path, body);
        if (path !== '/api/ack') window.hamaScene?.celebrate();
      } catch (error) {
        showError('attention-error', error);
      }
      await refreshAll();
    };
    if (item.type === 'order' && item.orderKind === 'renewal') {
      const candidates = item.candidates ?? [];
      const pickKey = el('select', 'mono');
      pickKey.setAttribute('aria-label', '연장할 키');
      for (const c of candidates) pickKey.append(new Option(`${mask(c.key)} · ${fmt(c.expiresAt, dateOnly)}`, c.keyId));
      pickKey.append(new Option('직접 입력', ''));
      pickKey.hidden = candidates.length === 0;
      const typed = el('input', 'mono');
      Object.assign(typed, { placeholder: 'HAMA-…', hidden: candidates.length > 0 });
      typed.setAttribute('aria-label', '연장할 키');
      pickKey.addEventListener('change', () => {
        typed.hidden = pickKey.value !== '';
        if (!typed.hidden) typed.focus();
      });
      const extend = el('button', 'primary', '연장');
      extend.type = 'button';
      extend.addEventListener('click', () => {
        const picked = !pickKey.hidden && pickKey.value;
        const key = typed.value.trim();
        if (!picked && !key) return typed.focus();
        extend.disabled = true;
        void run('/api/apply-renewal', { merchantUid: item.merchantUid, ...(picked ? { keyId: picked } : { key }) })();
      });
      actions.append(pickKey, typed, extend);
    } else if (item.type === 'order') {
      actions.append(confirmButton('키 발급', '발급할까요?', run('/api/release', { merchantUid: item.merchantUid }), 'primary'));
    }
    if (item.type === 'order') {
      actions.append(confirmButton('확인', '숨길까요?', run('/api/ack', { merchantUid: item.merchantUid })));
    } else {
      const ack = el('button', '', '확인');
      ack.type = 'button';
      ack.addEventListener('click', () => { ack.disabled = true; void run('/api/ack', { id: item.id })(); });
      actions.append(ack);
    }
    li.append(what, actions);
    return li;
  }

  /** 하나라도 있으면 관리 화면 위쪽 띠와 벽 화면의 숫자가 켜져요. */
  async function loadAttention({ background = false } = {}) {
    try {
      const { items } = await api('GET', '/api/attention');
      $('stat-attention').hidden = items.length === 0;
      $('stat-attention-count').textContent = items.length;
      if (background && busy('#attention')) return;
      $('attention').hidden = items.length === 0;
      $('attention-list').replaceChildren(...items.map(attentionItem));
    } catch (error) {
      if (!background) showError('attention-error', error);
    }
  }

  let lastLookup = null;
  async function runLookup() {
    if (!lastLookup) return;
    try {
      const { licenses } = await api('GET', `/api/licenses?${new URLSearchParams(lastLookup)}`);
      if (licenses.length === 0) throw new Error('invalid_key');
      render('lookup-table', licenses, (l) => rows(l, { errorTarget: 'lookup-error', refresh: refreshAll, showTier: true }));
      $('lookup-table').hidden = false;
    } catch (error) {
      $('lookup-table').hidden = true;
      showError('lookup-error', error);
    }
  }

  // ─────────── 제보 ───────────
  const ATTACHMENT_TEXT = { screenshot: '스크린샷', log: '로그', chat: '대화', document: '문서' };
  const bytes = (n) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
  const platformText = (r) => [PLATFORMS[r.os] ?? r.os, r.osVersion, r.arch].filter(Boolean).join(' ');
  // 받기 이름과 화면에서 방향 제어·제어 문자를 지워요.
  const plainName = (name) => String(name ?? '').replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, '');

  /** 세션 헤더가 필요해서 첨부는 blob 으로 받아요. */
  async function attachmentBlob(id, name) {
    let res;
    try {
      res = await fetch(`/api/feedback/attachment?${new URLSearchParams({ id, name })}`, { headers: { 'X-Admin-Session': session } });
    } catch {
      throw new Error('upstream_unreachable');
    }
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
    return res.blob();
  }

  let reports = [];
  let selectedId = null;
  let objectUrls = [];

  function releaseUrls() {
    for (const url of objectUrls) URL.revokeObjectURL(url);
    objectUrls = [];
  }

  function showFeedbackList() {
    $('feedback-list').replaceChildren(...reports.map((r) => {
      const item = el('li', r.status);
      const open = el('button', 'report');
      open.type = 'button';
      if (r.id === selectedId) open.setAttribute('aria-current', 'true');
      const what = el('span', 'what');
      what.append(
        el('span', 'line', r.preview.split('\n').find((l) => l.trim()) ?? r.preview),
        el('span', 'muted', [r.appVersion, PLATFORMS[r.os] ?? r.os, ago(r.receivedAt)].filter(Boolean).join(' · ')),
      );
      open.append(lamp(r.status === 'new'), what);
      if (r.status === 'resolved') open.append(el('span', 'tag', '해결함'));
      open.addEventListener('click', () => { void openReport(r.id); });
      item.append(open);
      return item;
    }));
  }

  function metaRows(report) {
    const m = report.meta ?? {};
    const known = {
      '앱 버전': [m.appVersion, m.commit && String(m.commit).slice(0, 10)].filter(Boolean).join(' · '),
      OS: platformText(m),
      언어: m.locale,
      라이선스: m.licenseTier,
      모델: [m.provider, m.model, m.agentMode].filter(Boolean).join(' · '),
      창: m.window?.width ? `${m.window.width}×${m.window.height}` : '',
      블러: typeof m.screenshotBlurred === 'boolean' ? (m.screenshotBlurred ? '켬' : '끔') : '',
      이메일: report.email,
      '보낸 시각': fmt(report.createdAt),
      설치: report.installHash?.slice(0, 12),
    };
    const skip = new Set(['appVersion', 'commit', 'os', 'osVersion', 'arch', 'locale', 'licenseTier', 'provider', 'model', 'agentMode', 'window', 'screenshotBlurred']);
    const extra = Object.entries(m).filter(([k]) => !skip.has(k))
      .map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)]);
    const list = el('dl', 'meta');
    for (const [k, v] of [...Object.entries(known), ...extra]) {
      if (!v) continue;
      list.append(el('dt', '', k), el('dd', k === '설치' ? 'mono' : '', v));
    }
    return list;
  }

  async function setReportStatus(id, status) {
    await api('POST', '/api/feedback/status', { id, status });
    const entry = reports.find((r) => r.id === id);
    if (entry) entry.status = status;
  }

  async function openReport(id) {
    selectedId = id;
    showFeedbackList();
    const detail = $('feedback-detail');
    releaseUrls();
    try {
      const { report } = await api('GET', `/api/feedback/report?${new URLSearchParams({ id })}`);
      if (selectedId !== id) return;
      if (report.status === 'new') {
        await setReportStatus(id, 'seen').catch(() => {});
        report.status = 'seen';
        showFeedbackList();
        showNewCount();
      }
      const view = await reportView(report);
      // 첨부를 받는 사이 다른 보고를 골랐으면 그리지 않는다. 늦게 온 보고가 고른 보고 자리를 차지하면
      // 삭제 단추가 엉뚱한 보고를 지운다.
      if (selectedId !== id) return;
      detail.replaceChildren(...view);
    } catch (error) {
      showError('feedback-error', error);
    }
  }

  async function reportView(report) {
    const a = report.attachments ?? {};
    const head = el('header', 'head');
    head.append(el('span', 'num', fmt(report.receivedAt)), el('span', 'muted', platformText(report.meta ?? {})));
    const actions = el('div', 'actions');
    if (report.email) {
      const reply = el('a', 'button', '답장');
      reply.href = `mailto:${encodeURIComponent(report.email)}?subject=${encodeURIComponent('HamaEditor 문제 보고 답변')}`;
      actions.append(reply);
    }
    const resolved = report.status === 'resolved';
    const toggle = el('button', resolved ? '' : 'primary', resolved ? '다시 열기' : '해결');
    toggle.type = 'button';
    toggle.addEventListener('click', async () => {
      toggle.disabled = true;
      try {
        await setReportStatus(report.id, resolved ? 'seen' : 'resolved');
      } catch (error) {
        showError('feedback-error', error);
      }
      await loadFeedback();
      await openReport(report.id);
    });
    const remove = confirmButton('삭제', '삭제할까요?', async () => {
      try {
        await api('POST', '/api/feedback/delete', { id: report.id });
        selectedId = null;
        releaseUrls();
        $('feedback-detail').replaceChildren();
      } catch (error) {
        showError('feedback-error', error);
      }
      await loadFeedback();
    }, 'danger');
    actions.append(toggle, remove);
    head.append(actions);

    const parts = [head, el('p', 'message', report.message)];
    if (a.screenshot) {
      const url = URL.createObjectURL(await attachmentBlob(report.id, 'screenshot'));
      objectUrls.push(url);
      const thumb = el('button', 'thumb');
      thumb.type = 'button';
      thumb.title = '크게 보기';
      const img = el('img');
      img.src = url;
      img.alt = '스크린샷';
      thumb.append(img);
      thumb.addEventListener('click', () => {
        $('shot-full').src = url;
        $('shot-dialog').showModal();
      });
      parts.push(thumb);
    }
    parts.push(metaRows(report));
    if (a.log) {
      const log = el('pre', 'log mono', '');
      log.textContent = await (await attachmentBlob(report.id, 'log')).text();
      parts.push(log);
    }
    const files = el('div', 'files');
    for (const name of ['chat', 'document']) {
      if (!a[name]) continue;
      const button = el('button', '', `${ATTACHMENT_TEXT[name]} 받기`);
      button.type = 'button';
      button.append(el('span', 'muted', ` ${plainName(a[name].name)} ${bytes(a[name].size)}`.replace(/\s+/g, ' ')));
      button.addEventListener('click', async () => {
        button.disabled = true;
        try {
          const url = URL.createObjectURL(await attachmentBlob(report.id, name));
          const link = el('a');
          link.href = url;
          link.download = name === 'document' ? plainName(a.document.name) || 'document.bin' : `${report.id}-chat.txt`;
          link.click();
          setTimeout(() => URL.revokeObjectURL(url), 10_000);
        } catch (error) {
          showError('feedback-error', error);
        } finally {
          button.disabled = false;
        }
      });
      files.append(button);
    }
    if (files.childElementCount) parts.push(files);
    return parts;
  }

  function showNewCount() {
    const fresh = reports.filter((r) => r.status === 'new').length;
    $('feedback-new').hidden = fresh === 0;
    $('feedback-new').textContent = fresh;
  }

  async function loadFeedback({ background = false } = {}) {
    try {
      const { reports: list, storage } = await api('GET', '/api/feedback');
      reports = list;
      showNewCount();
      const used = storage.maxBytes ? storage.bytes / storage.maxBytes : 0;
      $('feedback-storage').hidden = used < 0.8;
      $('feedback-storage').textContent = `제보 저장 공간 ${Math.round(used * 100)}%`;
      $('inbox').hidden = reports.length === 0;
      $('feedback-empty').hidden = reports.length > 0;
      if (background && busy('#feedback-detail')) return;
      if (selectedId && !reports.some((r) => r.id === selectedId)) {
        selectedId = null;
        releaseUrls();
        $('feedback-detail').replaceChildren();
      }
      showFeedbackList();
    } catch (error) {
      if (!background) showError('feedback-error', error);
    }
  }

  // ─────────── 선물 코드 ───────────
  const PLAN_TEXT = { basic: 'Basic', hama: 'Hama' };
  const CODE_STATUS = { active: '사용 전', redeemed: '사용함', revoked: '취소됨', expired: '기한 지남' };
  const planText = (plan) => PLAN_TEXT[plan] ?? plan;
  const termText = (batch) => (batch.durationMonths ? `${batch.durationMonths}개월` : `${batch.durationDays}일`);
  const giftForm = $('gift-form');
  const chosen = (name) => giftForm.querySelector(`input[name="${name}"]:checked`)?.value;
  const whole = (input) => (/^\d{1,6}$/.test(input.value.trim()) ? Number(input.value.trim()) : 0);
  let issuing = false;

  /** 등급, 기간, 단위, 개수가 다 있어야 만들기를 누를 수 있어요. 미리 골라 둔 값은 없어요. */
  function syncGiftForm() {
    const unit = chosen('unit');
    if (unit) $('gift-length').max = unit === 'days' ? '3660' : '120';
    else $('gift-length').removeAttribute('max');
    $('gift-submit').disabled = issuing || !chosen('plan') || !unit || whole($('gift-length')) < 1 || whole($('gift-count')) < 1;
  }
  giftForm.addEventListener('input', syncGiftForm);
  giftForm.addEventListener('change', syncGiftForm);
  $('gift-redeem-by').min = new Date().toLocaleDateString('sv-SE');

  giftForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    if ($('gift-submit').disabled) return;
    const unit = chosen('unit');
    const body = {
      plan: chosen('plan'),
      [unit === 'days' ? 'durationDays' : 'durationMonths']: whole($('gift-length')),
      count: whole($('gift-count')),
      note: $('gift-note').value.trim(),
      redeemBy: $('gift-redeem-by').value,
    };
    issuing = true;
    syncGiftForm();
    try {
      const { batch, codes } = await api('POST', '/api/gift-codes/issue', body);
      showGenerated(batch, codes);
      giftForm.reset();
      window.hamaScene?.celebrate();
      await loadGiftCodes();
    } catch (error) {
      showError('gift-error', error);
    } finally {
      issuing = false;
      syncGiftForm();
    }
  });

  // 복사하지도 저장하지도 않은 코드 창. 하나라도 있으면 페이지를 떠날 때 물어봐요.
  const unkept = new Set();
  addEventListener('beforeunload', (event) => {
    if (unkept.size === 0) return;
    event.preventDefault();
    event.returnValue = '';
  });

  function csvOf(batch, codes) {
    const rows = codes.map((code) => [code, batch.batchId, batch.plan, batch.durationMonths ?? '', batch.durationDays ?? '', batch.redeemBy ?? ''].join(','));
    return `code,batch_id,plan,duration_months,duration_days,redeem_by\n${rows.join('\n')}\n`;
  }

  /** 방금 만든 코드. 이 창의 메모리에만 있어서 닫으면 다시 볼 수 없어요. */
  function showGenerated(batch, codes) {
    const panel = el('div', 'generated');
    panel.setAttribute('role', 'group');
    panel.setAttribute('aria-label', '만든 코드');
    unkept.add(panel);
    const kept = () => { unkept.delete(panel); close.textContent = '닫기'; };

    const head = el('div', 'head');
    const summary = [planText(batch.plan), termText(batch), `${codes.length}개`, batch.redeemBy ? `${fmt(batch.redeemBy, dateOnly)}까지 사용` : '', batch.note]
      .filter(Boolean).join(' · ');
    const actions = el('div', 'actions');
    const copyAll = el('button', 'primary', '복사');
    copyAll.type = 'button';
    copyAll.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(codes.join('\n'));
        copyAll.textContent = '복사했어요';
        setTimeout(() => { copyAll.textContent = '복사'; }, 1200);
        kept();
      } catch {
        showError('gift-error', new Error('copy_failed'));
      }
    });
    const save = el('button', '', 'CSV 저장');
    save.type = 'button';
    save.addEventListener('click', () => {
      const url = URL.createObjectURL(new Blob([csvOf(batch, codes)], { type: 'text/csv;charset=utf-8' }));
      const link = el('a');
      link.href = url;
      link.download = `gift-codes-${batch.batchId}.csv`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
      kept();
    });
    // 아직 안 챙긴 코드면 한 번 더 눌러야 닫혀요.
    const close = el('button', '', '닫기');
    close.type = 'button';
    let armed = null;
    close.addEventListener('click', () => {
      if (unkept.has(panel) && !armed) {
        close.textContent = '닫을까요?';
        close.classList.add('armed');
        armed = setTimeout(() => { armed = null; close.textContent = '닫기'; close.classList.remove('armed'); }, 3000);
        return;
      }
      clearTimeout(armed);
      unkept.delete(panel);
      panel.remove();
      $('gift-length').focus();
    });
    actions.append(copyAll, save, close);
    head.append(el('span', 'summary', summary), actions);
    panel.append(head, el('p', 'muted once', '닫으면 다시 볼 수 없어요.'), el('pre', 'codes mono', codes.join('\n')));
    $('generated').prepend(panel);
    copyAll.focus();
  }

  /** 펼친 묶음의 코드. 코드는 앞 네 글자만 보여요. */
  function codeList(batch) {
    const list = el('ul', 'codes-list');
    const head = el('li', 'head');
    for (const text of ['코드', '상태', '사용한 날', '계정', '키', '']) head.append(el('span', '', text));
    list.append(head);
    for (const code of batch.codes) {
      const item = el('li', code.status);
      const action = el('span', 'action');
      if (code.status === 'active') {
        action.append(confirmButton('취소', '취소할까요?', async () => {
          try {
            await api('POST', '/api/gift-codes/revoke', { codeHash: code.codeHash });
          } catch (error) {
            showError('gift-error', error);
          }
          await loadGiftCodes();
        }, 'small danger'));
      }
      item.append(
        el('span', 'mono', code.maskedCode),
        el('span', code.status === 'revoked' || code.status === 'expired' ? 'status bad' : 'status', CODE_STATUS[code.status] ?? code.status),
        el('span', 'num', fmt(code.redeemedAt)),
        el('span', 'mono id', code.accountId ?? '—'),
        el('span', 'mono id', code.keyId ?? '—'),
        action,
      );
      list.append(item);
    }
    const wrap = el('div', 'codes-wrap');
    wrap.append(list);
    return wrap;
  }

  /** 묶음 한 줄과 펼치면 나오는 코드 목록. */
  function batchRows(batch) {
    const c = batch.counts;
    const total = c.active + c.redeemed + c.revoked + c.expired;
    const row = el('tr', c.active === 0 ? 'revoked' : '');
    const detail = el('tr', 'detail');
    detail.hidden = true;
    const toggleCell = el('td');
    toggleCell.append(chevron(detail, '코드 보기'));
    const revokeAll = confirmButton('남은 코드 취소', '취소할까요?', async () => {
      try {
        await api('POST', '/api/gift-codes/revoke', { batchId: batch.batchId });
      } catch (error) {
        showError('gift-error', error);
      }
      await loadGiftCodes();
    }, 'danger');
    revokeAll.disabled = c.active === 0;
    const actions = el('td', 'actions');
    actions.append(revokeAll);
    const note = el('td', batch.note ? '' : 'muted', batch.note || '—');
    if (batch.note) note.title = batch.note;
    row.append(
      toggleCell,
      el('td', 'num', fmt(batch.createdAt, dateOnly)),
      el('td', '', planText(batch.plan)),
      el('td', 'num', termText(batch)),
      el('td', 'num', `${c.active} / ${total}`),
      el('td', 'num', String(c.redeemed)),
      el('td', 'num', String(c.revoked)),
      el('td', 'num', String(c.expired)),
      el('td', 'num', batch.redeemBy ? fmt(batch.redeemBy, dateOnly) : '—'),
      note,
      actions,
    );
    const cell = el('td');
    cell.colSpan = 11;
    cell.append(codeList(batch));
    detail.append(cell);
    return [row, detail];
  }

  /** 장면의 숫자와 벽 화면 목록: 남은 코드, 사용한 코드, 최근 24시간에 사용한 코드. */
  function showGiftOverview(batches) {
    const codes = batches.flatMap((batch) => batch.codes.map((code) => ({ ...code, batch })));
    const redeemed = codes.filter((code) => code.status === 'redeemed')
      .sort((a, b) => String(b.redeemedAt).localeCompare(String(a.redeemedAt)));
    $('stat-unused').textContent = codes.filter((code) => code.status === 'active').length;
    $('stat-redeemed').textContent = redeemed.length;
    $('stat-recent').textContent = redeemed.filter((code) => recent(code.redeemedAt)).length;
    $('roster').replaceChildren(...redeemed.slice(0, 60).map((code) => {
      const item = el('li', recent(code.redeemedAt) ? '' : 'quiet');
      item.append(
        lamp(recent(code.redeemedAt)),
        el('span', 'who', code.maskedCode.slice(0, 9)),
        el('span', 'num', `${planText(code.batch.plan)} ${termText(code.batch)}`),
        el('span', 'seen', ago(code.redeemedAt)),
      );
      return item;
    }));
  }

  /** 누가 코드를 새로 쓰면 하마가 별똥별을 봐요. 첫 불러오기는 세지 않아요. */
  let knownRedeemed = null;
  function noticeRedemptions(batches) {
    const ids = new Set(batches.flatMap((b) => b.codes.filter((c) => c.status === 'redeemed').map((c) => c.codeHash)));
    const fresh = knownRedeemed && [...ids].some((id) => !knownRedeemed.has(id));
    knownRedeemed = ids;
    if (fresh) window.hamaScene?.celebrate();
  }

  async function loadGiftCodes({ background = false } = {}) {
    try {
      const { batches } = await api('GET', '/api/gift-codes');
      showGiftOverview(batches);
      noticeRedemptions(batches);
      if (background && busy('#batch-table')) return;
      render('batch-table', batches, batchRows, (batch) => batch.batchId);
      $('batch-table').hidden = batches.length === 0;
      $('batch-empty').hidden = batches.length > 0;
    } catch (error) {
      if (!background) showError('gift-error', error);
    }
  }

  // ─────────── 탭 ───────────
  const TABS = ['gifts', 'keys', 'feedback'];
  function selectTab(name, { focus = false } = {}) {
    for (const tab of TABS) {
      const on = tab === name;
      $(`tab-${tab}`).setAttribute('aria-selected', String(on));
      $(`tab-${tab}`).tabIndex = on ? 0 : -1;
      $(`panel-${tab}`).hidden = !on;
    }
    if (focus) $(`tab-${name}`).focus();
    history.replaceState(null, '', name === 'gifts' ? location.pathname : `#${name}`);
  }
  for (const tab of TABS) $(`tab-${tab}`).addEventListener('click', () => selectTab(tab));
  document.querySelector('.tabs').addEventListener('keydown', (event) => {
    const at = TABS.findIndex((tab) => $(`tab-${tab}`) === document.activeElement);
    if (at < 0) return;
    const next = { ArrowRight: at + 1, ArrowLeft: at - 1, Home: 0, End: TABS.length - 1 }[event.key];
    if (next === undefined) return;
    event.preventDefault();
    selectTab(TABS[(next + TABS.length) % TABS.length], { focus: true });
  });
  selectTab(TABS.includes(location.hash.slice(1)) ? location.hash.slice(1) : 'gifts');

  $('shot-dialog').addEventListener('click', () => $('shot-dialog').close());

  async function refreshAll() {
    await Promise.all([loadAttention(), loadGiftCodes(), loadFeedback(), loadCustomers(), loadBetas(), runLookup()]);
  }

  $('issue-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const submit = event.submitter;
    submit.disabled = true;
    try {
      const { license } = await api('POST', '/api/issue', { email: $('issue-email').value.trim() });
      $('issued-email').textContent = `${license.email} · ${fmt(license.expiresAt, dateOnly)}까지`;
      $('issued-key').textContent = license.key;
      $('issued').hidden = false;
      $('issue-email').value = '';
      window.hamaScene?.celebrate();
      await loadCustomers();
    } catch (error) {
      showError('customer-error', error);
    } finally {
      submit.disabled = false;
    }
  });
  $('issued-key').addEventListener('click', (event) => {
    void copy(event.currentTarget, event.currentTarget.textContent);
  });
  $('customer-filter').addEventListener('input', showCustomers);

  $('create-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const submit = event.submitter;
    submit.disabled = true;
    try {
      const giftUsd = $('gift').hidden ? '' : $('gift').value.trim();
      const { license, gift } = await api('POST', '/api/issue-beta', {
        name: $('name').value.trim(),
        devices: Number($('devices').value || 5),
        note: $('note').value.trim(),
        ...(giftUsd ? { giftUsd: Number(giftUsd) } : {}),
      });
      $('created-name').textContent = `${license.name} · 기기 ${license.deviceLimit}대${gift ? ` · 크레딧 ${dollars(gift.amountUsd)}` : ''}`;
      $('created-key').textContent = license.key;
      $('created').hidden = false;
      $('name').value = '';
      $('note').value = '';
      $('gift').value = '';
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
      showError('gift-error', error);
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
      await Promise.all([loadAttention(), loadGiftCodes(), loadFeedback(), loadCustomers(), loadBetas()]);
      setInterval(() => {
        void loadAttention({ background: true });
        void loadGiftCodes({ background: true });
        void loadFeedback({ background: true });
        void loadCustomers({ background: true });
        void loadBetas({ background: true });
      }, 60_000);
    } catch (error) {
      showError('gift-error', error);
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
