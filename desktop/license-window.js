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
  // 연간 키의 날짜. 서버가 한국 시간 하루 끝까지로 정한다.
  const day = new Intl.DateTimeFormat('ko-KR', { dateStyle: 'long', timeZone: 'Asia/Seoul' });
  const date = (ms) => day.format(new Date(ms));
  const SUPPORT_EMAIL = 'management@heemangstudios.com';

  /** 알림 줄에 글을 넣는다. 글 속 문의 주소는 메일 앱을 여는 링크로 바꾼다. */
  function setNote(note, text) {
    const parts = String(text ?? '').split(SUPPORT_EMAIL);
    note.replaceChildren(parts[0]);
    for (const part of parts.slice(1)) {
      const link = document.createElement('button');
      link.type = 'button';
      link.className = 'link';
      link.textContent = SUPPORT_EMAIL;
      link.addEventListener('click', () => { void api.openSupport?.(); });
      note.append(link, part);
    }
  }

  /** 체험 남은 시간. Studio 의 trialTimeLeft 와 같은 규칙이다. */
  function timeLeft(endsAt) {
    const remaining = Math.max(0, endsAt - Date.now());
    const seconds = Math.ceil(remaining / 1000);
    if (seconds < 3600) {
      const m = Math.floor(seconds / 60);
      const sec = seconds % 60;
      return m > 0 ? (sec > 0 ? `${m}분 ${sec}초` : `${m}분`) : `${sec}초`;
    }
    const minutes = Math.ceil(remaining / 60000);
    const days = Math.floor(minutes / 1440);
    const hours = Math.floor((minutes % 1440) / 60);
    const mins = minutes % 60;
    if (days > 0) return hours > 0 ? `${days}일 ${hours}시간` : `${days}일`;
    return mins > 0 ? `${hours}시간 ${mins}분` : `${hours}시간`;
  }

  function summaryFor(status) {
    const beta = status.license?.tier === 'beta';
    switch (status.state) {
      case 'licensed':
        if (status.license?.paymentFailed && status.license.paymentGraceEndsAt) {
          return [`갱신 결제가 되지 않았어요. ${date(status.license.paymentGraceEndsAt)}까지는 그대로 쓸 수 있고, Groble에서 결제 수단을 바꾸면 같은 키로 이어서 써요.`, true];
        }
        if (status.license?.graceEndsAt && status.license.licenseExpiresAt) {
          return [`${date(status.license.licenseExpiresAt)}에 기간이 끝났어요. 인터넷에 연결해 갱신을 확인해 주세요. ${date(status.license.graceEndsAt)}까지 쓸 수 있어요.`, true];
        }
        return [status.offline ? '라이선스가 활성화되어 있어요. 지금은 오프라인이라 마지막 확인으로 쓰고 있어요.' : '라이선스가 활성화되어 있어요.', false];
      case 'expired':
        return [`${status.license?.licenseExpiresAt ? `${date(status.license.licenseExpiresAt)}에 ` : ''}라이선스 기간이 끝나 읽기 전용이에요. 구독을 갱신하거나 새 키를 넣으면 다시 저장할 수 있어요.`, true];
      case 'trial':
        return [`체험 중이에요. ${timeLeft(status.trial.endsAt)} 남았어요.`, false];
      case 'trial_expired':
        return ['편집하려면 라이선스가 필요합니다.', true];
      case 'revoked':
        return [beta
          ? '베타 테스트 기간이 끝나 키가 해지되었어요. 읽기 전용이에요.'
          : '이 라이선스는 해지되었어요(환불 등). 읽기 전용이에요. 새 키를 넣으면 다시 저장할 수 있어요.', true];
      case 'lease_expired':
        return [`${beta ? 3 : 7}일 넘게 라이선스를 확인하지 못해 읽기 전용이에요. 인터넷에 연결한 뒤 ‘지금 확인’을 눌러 주세요.`, true];
      case 'needs_activation':
        return ['이 기기에서 라이선스를 다시 활성화해야 해요. 키를 다시 넣어 주세요.', true];
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
    // 기간이 끝난 연간 키: 새 키 넣기 아래에 갱신을 바로 확인하는 줄을 둔다.
    const expired = hasLicense && status.state === 'expired';
    // 결제 실패·기간 끝은 Studio 의 연장 안내와 같은 제목을 쓴다.
    const renewal = (status.state === 'licensed' && status.license?.paymentFailed) || (expired && status.license.licenseExpiresAt);
    $('title').textContent = renewal ? '키 만료, 연장할까요?' : showLicensed && status.license.tier === 'beta' ? '베타 테스터 라이선스' : '라이선스';
    $('fix-payment').hidden = !(status.state === 'licensed' && status.license?.paymentFailed);
    $('licensed-section').hidden = !showLicensed;
    $('activate-section').hidden = showLicensed;
    $('renewal-check').hidden = !expired;
    if (hasLicense) {
      $('masked-key').textContent = status.license.maskedKey;
      $('last-check').textContent = when(status.license.lastCheckAt);
      $('lease-expires').textContent = when(status.license.leaseExpiresAt);
      const expiresAt = status.license.licenseExpiresAt;
      $('license-term-label').hidden = !expiresAt;
      $('license-term').hidden = !expiresAt;
      if (expiresAt) {
        $('license-term-label').textContent = status.license.paymentFailed ? '만료일' : status.license.autoRenew === false ? '사용 기한' : '다음 갱신';
        $('license-term').textContent = date(expiresAt);
      }
      // 해지는 요약 줄이 이미 말한다.
      if (status.license.lastError && !showLicensed && !expired && status.state !== 'revoked') setNote(activateNote, status.license.lastError);
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
      setNote(activateNote, result.message);
    }
    render(result.status);
  });

  $('check').addEventListener('click', async (event) => {
    licensedNote.classList.remove('ok');
    const status = await busy(event.currentTarget, () => api.checkNow());
    licensedNote.textContent = status.offline ? '라이선스 서버에 연결하지 못했어요.' : '';
    render(status);
  });

  $('check-renewal').addEventListener('click', async (event) => {
    const status = await busy(event.currentTarget, () => api.checkNow());
    activateNote.classList.remove('ok');
    activateNote.textContent = status.offline ? '라이선스 서버에 연결하지 못했어요.' : status.state === 'expired' ? '아직 갱신되지 않았어요.' : '';
    if (status.state === 'licensed') {
      licensedNote.classList.add('ok');
      licensedNote.textContent = '갱신을 확인했어요. 이제 저장할 수 있어요.';
    }
    render(status);
  });

  $('deactivate').addEventListener('click', async (event) => {
    if (!window.confirm('이 기기에서 라이선스를 비활성화할까요? 다른 기기에서 키를 쓸 수 있게 되고, 이 기기는 읽기 전용이 돼요.')) return;
    const result = await busy(event.currentTarget, () => api.deactivate());
    licensedNote.classList.remove('ok');
    setNote(licensedNote, result.ok ? '' : result.message);
    render(result.status);
  });

  $('pricing').addEventListener('click', () => { void api.openPricing(); });
  for (const id of ['fix-payment', 'fix-lapsed']) $(id).addEventListener('click', () => { void api.openPaymentFix?.(); });
  $('support').addEventListener('click', () => { void api.openSupport?.(); });
  $('close').addEventListener('click', () => { void api.close(); });
  api.onChange(render);
  api.getStatus().then(render);
})();
