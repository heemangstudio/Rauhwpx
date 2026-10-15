/* 활성화 화면. 체험이 끝났거나 키가 해지되면 메인이 이 창을 띄운다. 설정에서도 연다. */
(function () {
  const api = window.hamaLicense;
  const $ = (id) => document.getElementById(id);
  const summary = $('summary');
  const form = $('activate-form');
  const keyInput = $('key');
  const activateButton = $('activate');
  const activateNote = $('activate-note');
  const licensedNote = $('licensed-note');
  const dateTime = new Intl.DateTimeFormat('ko-KR', { dateStyle: 'medium', timeStyle: 'short' });
  const when = (ms) => (ms ? dateTime.format(new Date(ms)) : '—');

  function summaryFor(status) {
    switch (status.state) {
      case 'licensed':
        return [status.offline ? '라이선스가 활성화되어 있어요. 지금은 오프라인이라 마지막 확인으로 쓰고 있어요.' : '라이선스가 활성화되어 있어요.', false];
      case 'trial': {
        const hours = Math.max(0, Math.ceil((status.trial.endsAt - Date.now()) / 3600000));
        return [`체험 중이에요. ${hours}시간 또는 저장 ${status.trial.savesLeft}번 남았어요.`, false];
      }
      case 'trial_expired':
        return ['체험이 끝나 읽기 전용이에요. 문서는 열어 볼 수 있지만 저장하려면 라이선스 키가 필요해요.', true];
      case 'revoked':
        return ['이 라이선스는 해지되었어요(환불 등). 읽기 전용이에요. 새 키를 넣으면 다시 저장할 수 있어요.', true];
      case 'lease_expired':
        return ['7일 넘게 라이선스를 확인하지 못해 읽기 전용이에요. 인터넷에 연결한 뒤 ‘지금 확인’을 눌러 주세요.', true];
      case 'needs_activation':
        return ['이 Mac에서 라이선스를 다시 활성화해야 해요. 키를 다시 넣어 주세요.', true];
      default:
        return ['개발 빌드라 라이선스를 확인하지 않아요.', false];
    }
  }

  function render(status) {
    const [text, bad] = summaryFor(status);
    summary.textContent = text;
    summary.classList.toggle('bad', bad);
    const hasLicense = Boolean(status.license);
    const showLicensed = hasLicense && ['licensed', 'lease_expired'].includes(status.state);
    $('licensed-section').hidden = !showLicensed;
    $('activate-section').hidden = showLicensed;
    if (hasLicense) {
      $('masked-key').textContent = status.license.maskedKey;
      $('last-check').textContent = when(status.license.lastCheckAt);
      $('lease-expires').textContent = when(status.license.leaseExpiresAt);
      if (status.license.lastError && !showLicensed) activateNote.textContent = status.license.lastError;
    }
    if (!status.activationAvailable && status.state !== 'unenforced') {
      activateNote.textContent = '이 빌드에는 라이선스 확인 키가 들어 있지 않아 활성화할 수 없어요.';
      activateButton.disabled = true;
    }
  }

  async function busy(button, task) {
    button.disabled = true;
    try { return await task(); } finally { button.disabled = false; }
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    activateNote.classList.remove('ok');
    activateNote.textContent = '';
    const result = await busy(activateButton, () => api.activate(keyInput.value));
    if (result.ok) {
      keyInput.value = '';
      licensedNote.classList.add('ok');
      licensedNote.textContent = '활성화했어요. 이제 저장할 수 있어요.';
    } else {
      activateNote.textContent = result.message;
    }
    render(result.status);
  });

  $('check').addEventListener('click', async (event) => {
    licensedNote.classList.remove('ok');
    const status = await busy(event.currentTarget, () => api.checkNow());
    licensedNote.textContent = status.offline ? '라이선스 서버에 연결하지 못했어요.' : '';
    render(status);
  });

  $('deactivate').addEventListener('click', async (event) => {
    if (!window.confirm('이 Mac에서 라이선스를 비활성화할까요? 다른 Mac에서 키를 쓸 수 있게 되고, 이 Mac은 읽기 전용이 돼요.')) return;
    const result = await busy(event.currentTarget, () => api.deactivate());
    licensedNote.classList.remove('ok');
    licensedNote.textContent = result.ok ? '' : result.message;
    render(result.status);
  });

  $('pricing').addEventListener('click', () => { void api.openPricing(); });
  $('close').addEventListener('click', () => { void api.close(); });
  api.onChange(render);
  api.getStatus().then(render);
})();
