// 집중 모드 턴 레일 — node sidebar-preview/check.mjs scroll-rail
import assert from 'node:assert/strict';

const tick = (index) => `.ag-scroll-rail-tick:nth-child(${index + 1})`;

/** 턴 하나가 대화 영역 안에 들어와 있는가. */
function turnInView(page, index) {
  return page.evaluate((at) => {
    const messages = document.querySelector('.ag-messages');
    const user = messages.querySelectorAll(':scope > .ag-msg-user')[at];
    const view = messages.getBoundingClientRect();
    const box = user.getBoundingClientRect();
    return box.top >= view.top && box.bottom <= view.bottom;
  }, index);
}

export async function checkChatScrollRail({ page, origin, open, screenshot }) {
  await open('reset=1&chats=long&fullscreen=1');
  await page.waitForSelector('.ag-scroll-rail:not([hidden])', { visible: true });
  const counts = await page.evaluate(() => ({
    ticks: document.querySelectorAll('.ag-scroll-rail-tick').length,
    turns: document.querySelectorAll('.ag-messages > .ag-msg-user').length,
    tabbable: [...document.querySelectorAll('.ag-scroll-rail-tick')].filter((node) => node.tabIndex === 0).length,
  }));
  assert.equal(counts.turns, 18, 'the long chat restores 18 turns');
  assert.equal(counts.ticks, counts.turns, 'one tick per user turn');
  assert.equal(counts.tabbable, 1, 'one tick is tabbable');
  await screenshot('scroll-rail-light');

  // 올리면 요청과 답변 첫머리가 카드에 뜬다.
  const target = 3;
  assert.equal(await turnInView(page, target), false, 'the target turn starts out of view');
  await page.hover(tick(target));
  await page.waitForSelector('.ag-scroll-rail-peek.ag-scroll-rail-open');
  const peek = await page.evaluate(() => ({
    prompt: document.querySelector('.ag-scroll-rail-prompt').textContent,
    reply: document.querySelector('.ag-scroll-rail-reply').textContent,
    near: [...document.querySelectorAll('.ag-scroll-rail-tick')].map((node) => node.dataset.near ?? null),
  }));
  assert.match(peek.prompt, /추진 일정 표의 날짜를 분기별로/);
  assert.match(peek.reply, /2027년 1분기부터/);
  assert.equal(peek.near[target], '0', 'the hovered tick grows the most');
  await screenshot('scroll-rail-hover-light');

  // 누르면 그 요청으로 스크롤하고, 그 눈금이 보이는 턴으로 밝아진다.
  await page.click(tick(target));
  await page.waitForFunction((selector) => document.querySelector(selector).hasAttribute('data-current'), {}, tick(target));
  assert.equal(await turnInView(page, target), true, 'the clicked turn is in view');

  // 레일을 떠나면 카드가 거둬진다.
  await page.mouse.move(400, 400);
  await page.waitForSelector('.ag-scroll-rail-peek:not(.ag-scroll-rail-open)');

  // 키보드: End 로 마지막 눈금, Enter 로 그 턴.
  await page.focus(tick(target));
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => {
    const ticks = document.querySelectorAll('.ag-scroll-rail-tick');
    return ticks[ticks.length - 1].hasAttribute('data-current');
  });

  await page.goto(`${origin}/?theme=dark&chats=long&fullscreen=1&width=480`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('.ag-scroll-rail:not([hidden])', { visible: true });
  await page.hover(tick(8));
  await page.waitForSelector('.ag-scroll-rail-peek.ag-scroll-rail-open');
  await screenshot('scroll-rail-hover-dark');

  // 사이드바 모드에는 레일이 없다.
  await open('chats=long');
  await page.waitForSelector('.ag-messages > .ag-msg-user');
  assert.equal(await page.$('.ag-scroll-rail:not([hidden])'), null, 'no rail in sidebar mode');
  await screenshot('scroll-rail-sidebar');
}
