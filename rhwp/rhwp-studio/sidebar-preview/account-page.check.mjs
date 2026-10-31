// 계정: 문서 홈 위 막대의 계정 단추가 계정 페이지를 열고 닫는다. 로그인(브라우저 기다림 → 로그인),
// 기기 고르기, 이름·사진 바꾸기, 키 등록 오류, 계정 삭제 확인, 로그아웃 상태의 결제가 로그인으로 가는 길.
import assert from 'node:assert/strict';

const calls = (page) => page.evaluate(() => [...window.sidebarPreview.account.calls]);
const pageState = (page) => page.$eval('.acct-page', (node) => node.dataset.state);
const waitState = (page, state, timeout = 6000) =>
  page.waitForFunction((s) => document.querySelector('.acct-page')?.dataset.state === s, { timeout }, state);
const openFromButton = async (page) => {
  await page.click('.acct-button');
  await page.waitForSelector('.acct-page.acct-page-open', { visible: true });
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
};
const sectionError = (page, section) =>
  page.$eval(`[data-section="${section}"]`, (node) => [...node.querySelectorAll('.acct-error')].find((line) => !line.hidden)?.textContent ?? '');

export async function checkAccountPage({ page, open, screenshot }) {
  // 로그아웃: 단추는 사람 모양과 '로그인'. 누르면 로그인만 있는 페이지가 열리고 Esc 로 닫힌다.
  await open('reset=1&home=1&account=signed-out');
  await page.waitForSelector('#document-home .acct-button', { visible: true });
  assert.equal(await page.$eval('.acct-button .acct-avatar', (node) => node.dataset.kind), 'person');
  assert.equal(await page.$eval('.acct-button-label', (node) => node.textContent), '로그인');
  await openFromButton(page);
  assert.equal(await pageState(page), 'signed_out');
  assert.equal(await page.$eval('[data-provider="google"]', (node) => node.checkVisibility()), true);
  assert.equal(await page.$eval('[data-provider="kakao"]', (node) => node.checkVisibility()), false, 'Kakao waits for the server');
  assert.equal(await page.$eval('.acct-signed', (node) => node.checkVisibility()), false, 'nothing else while signed out');
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.querySelector('.acct-page'));
  assert.equal(await page.evaluate(() => document.activeElement?.classList.contains('acct-button')), true, 'focus returns');

  // 이메일로 로그인: 브라우저를 기다리는 동안 취소가 있고, 끝나면 프로필이 된다.
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('rhwp:open-account', { detail: { section: 'sign-in' } })));
  await page.waitForSelector('.acct-page.acct-page-open .acct-signin-email input', { visible: true });
  // 페이지가 첫 칸에 초점을 준 뒤에 적는다.
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await page.type('.acct-page .acct-signin-email input', 'jiwoo@example.com');
  await page.click('.acct-page .acct-signin-email button[type="submit"]');
  await waitState(page, 'signing_in');
  assert.equal(await page.$eval('.acct-signin-wait', (node) => node.checkVisibility()), true);
  await waitState(page, 'signed_in');
  assert.ok((await calls(page)).includes('signIn:email:jiwoo@example.com'), 'the email is passed as the login hint');
  await page.waitForFunction(() => document.querySelector('.acct-button .acct-avatar')?.dataset.kind === 'image');
  assert.equal(await page.$eval('.acct-button-label', (node) => node.textContent), '김지우', 'the button shows the name');
  await page.click('.acct-back');
  await page.waitForFunction(() => !document.querySelector('.acct-page'));

  // 여섯째 기기: 기기 하나를 빼면 로그인이 이어진다.
  await open('reset=1&home=1&account=signed-out');
  await openFromButton(page);
  await page.type('.acct-page .acct-signin-email input', 'limit@example.com');
  await page.click('.acct-page .acct-signin-email button[type="submit"]');
  await waitState(page, 'choose_device');
  assert.equal(await page.$$eval('.acct-signin-choose .acct-device', (rows) => rows.length), 5);
  await page.click('.acct-signin-choose [data-device-id="dev-office"] .acct-device-remove');
  await page.click('.acct-signin-choose [data-device-id="dev-office"] .acct-device-confirm');
  await waitState(page, 'signed_in');
  assert.ok((await calls(page)).includes('replaceDevice:dev-office'));
  assert.equal(await page.$('.acct-signed .acct-device-list [data-device-id="dev-office"]'), null, 'the removed device is gone');

  // 이름: 비우면 막고, 새 이름은 저장된다.
  await open('reset=1&home=1&account=pro');
  await openFromButton(page);
  await screenshot('account-page-pro');
  await page.click('.acct-name-edit');
  await page.$eval('.acct-name-input', (input) => { input.value = '   '; });
  await page.click('.acct-name-form button[type="submit"]');
  await page.waitForFunction(() => [...document.querySelectorAll('.acct-profile .acct-error')].some((line) => !line.hidden));
  assert.equal((await calls(page)).some((call) => call.startsWith('updateName')), false, 'an empty name never reaches the server');
  await page.$eval('.acct-name-input', (input) => { input.value = ''; });
  await page.type('.acct-name-input', '새 이름');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.querySelector('.acct-name')?.textContent === '새 이름' && !document.querySelector('.acct-name-form')?.checkVisibility());
  await page.waitForFunction(() => document.querySelector('.acct-button-label')?.textContent === '새 이름');
  // 긴 이름은 단추에서 말줄임표로 끊기고, 온전한 이름은 title 에 남는다.
  await page.click('.acct-name-edit');
  await page.$eval('.acct-name-input', (input) => { input.value = ''; });
  await page.type('.acct-name-input', '아주아주긴이름을가진사람의계정이름입니다정말로');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.querySelector('.acct-button')?.title.startsWith('아주아주긴이름을가진사람의계정이름입니다정말로 · '));
  const label = await page.$eval('.acct-button-label', (node) => ({ width: node.getBoundingClientRect().width, clipped: node.scrollWidth > node.clientWidth }));
  assert.ok(label.width <= 141 && label.clipped, `long names are truncated (${JSON.stringify(label)})`);

  // 사진: 고른 그림의 가운데를 512px 로 줄여 1 MiB 안으로 올린다.
  await page.evaluate(async () => {
    const canvas = document.createElement('canvas');
    canvas.width = 1600;
    canvas.height = 1000;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#2b6cb0';
    ctx.fillRect(0, 0, 1600, 1000);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
    const transfer = new DataTransfer();
    transfer.items.add(new File([blob], 'photo.png', { type: 'image/png' }));
    const input = document.querySelector('.acct-file');
    input.files = transfer.files;
    input.dispatchEvent(new Event('change'));
  });
  await page.waitForFunction(() => window.sidebarPreview.account.calls.some((call) => call.startsWith('setAvatar:')));
  const upload = (await calls(page)).find((call) => call.startsWith('setAvatar:'));
  const [, type, size] = upload.split(':');
  assert.match(type, /^image\/(webp|jpeg)$/);
  assert.ok(Number(size) > 0 && Number(size) <= 1024 * 1024, `upload is within 1 MiB (${size})`);
  await page.waitForFunction(() => {
    const img = document.querySelector('.acct-profile .acct-avatar img');
    return img?.complete && img.naturalWidth === 512 && img.naturalHeight === 512;
  });

  // 키 등록: 서버 오류 글을 그 칸 옆에 그대로 보인다.
  await page.type('.acct-key-input', 'HAMA-FAIL0-00000-00000-00000-00000');
  await page.click('.acct-redeem button[type="submit"]');
  await page.waitForFunction(() => [...document.querySelectorAll('[data-section="licenses"] .acct-error')].some((line) => !line.hidden));
  assert.equal(await sectionError(page, 'licenses'), '라이선스 키를 찾을 수 없어요.');

  // 계정 삭제: 이메일을 그대로 적어야 열리고, 켜진 구독은 구독 관리를 권한다.
  await page.click('.acct-exit .acct-btn-danger-quiet');
  await page.waitForSelector('.acct-delete-sheet', { visible: true });
  const confirmDisabled = () => page.$eval('.acct-delete-confirm', (node) => node.disabled);
  assert.equal(await confirmDisabled(), true);
  await page.type('.acct-delete-input', 'jiwoo@example.co');
  assert.equal(await confirmDisabled(), true, 'a near-miss stays locked');
  await page.type('.acct-delete-input', 'm');
  assert.equal(await confirmDisabled(), false);
  await screenshot('account-delete-confirm');
  await page.click('.acct-delete-confirm');
  await page.waitForSelector('.acct-delete-manage:not([hidden])');
  assert.match(await page.$eval('.acct-delete-sheet .acct-error', (node) => node.textContent), /구독이 아직 켜져 있어요/);
  assert.ok((await calls(page)).includes('deleteAccount:jiwoo@example.com'));
  await page.click('.acct-delete-manage button');
  await page.waitForFunction(() => window.sidebarPreview.account.calls.includes('openManage'));
  // 시트가 떠 있는 동안 Esc 는 시트만 닫는다.
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.querySelector('.acct-delete-sheet'));
  assert.ok(await page.$('.acct-page'), 'the page stays open under the sheet');

  // 로그아웃 상태의 결제: 카드가 닫히고 로그인으로 간 뒤, 로그인하면 같은 칸의 카드로 돌아온다.
  await open('reset=1&home=1&account=signed-out');
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('rhwp:open-plan-card', { detail: { focus: 'pro' } })));
  await page.waitForSelector('.ag-pricing-card', { visible: true });
  await page.click('.ag-pricing-col[data-plan="pro"] [data-sku="proMonthly"]');
  await page.waitForSelector('.acct-page.acct-page-open', { visible: true });
  await page.waitForFunction(() => !document.querySelector('.ag-pricing-card'));
  assert.deepEqual(await page.evaluate(() => window.sidebarPreview.plan.checkouts), [], 'no checkout while signed out');
  await page.click('.acct-page [data-provider="google"]');
  await page.waitForFunction(() => !document.querySelector('.acct-page'), { timeout: 6000 });
  await page.waitForSelector('.ag-pricing-col[data-plan="pro"][data-focus="true"]', { visible: true });
  await page.click('.ag-pricing-col[data-plan="hama"] [data-sku="hamaMonthly"]');
  await page.waitForSelector('.ag-pricing-card[data-view="waiting"]');
  assert.deepEqual(await page.evaluate(() => window.sidebarPreview.plan.checkouts), ['hamaMonthly']);

  // 계정 페이지의 Hama 자리: 연간을 누르면 그 자리에서 결제 확인을 기다린다.
  await open('reset=1&home=1&account=pro&checkoutHold=1');
  await openFromButton(page);
  await page.click('.acct-hama-offer [data-sku="hamaYearly"]');
  await page.waitForSelector('.acct-hama-offer .acct-offer-wait', { visible: true });
  assert.deepEqual(await page.evaluate(() => window.sidebarPreview.plan.checkouts), ['hamaYearly']);
}
