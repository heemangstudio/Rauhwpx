import assert from 'node:assert/strict';
import { resolve } from 'node:path';

export async function checkPlanPreview(page, origin, artifacts) {
  const open = async (query = '') => {
    const params = new URLSearchParams(query);
    if (!params.has('theme')) params.set('theme', 'light');
    if (!params.has('scenario')) params.set('scenario', 'plan');
    if (!params.has('width')) params.set('width', '480');
    await page.goto(`${origin}/?${params}`, { waitUntil: 'networkidle0' });
    await page.waitForFunction(() => window.sidebarPreview && document.querySelector('#agent-sidebar')?.dataset.composerReady === 'true');
  };
  const submit = async (text) => {
    await page.$eval('.ag-input', (input, value) => {
      input.value = value;
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }, text);
    await page.click('.ag-send');
  };
  const latest = () => page.evaluate(() => window.sidebarPreview.bridge.getWorkflowState().latestPlan);

  await open();
  await page.click('#play');
  await page.waitForSelector('.ag-plan-approve:not(:disabled)', { visible: true });
  const original = await latest();
  assert.equal(original.revision, 1);
  assert.equal(original.execution, undefined);
  const todos = await page.$$eval('.ag-todo', nodes => nodes.map(node => node.dataset.status));
  assert.equal(todos.length, original.steps.length + original.validation.length);
  assert(todos.every(status => status === 'pending'));
  assert.match(await page.$eval('.ag-todo-text', node => node.textContent), /사업 개요/);
  assert.equal(await page.$$eval('.ag-plan-source-pill', nodes => nodes.length), 2);
  await (await page.$('.ag-root')).screenshot({ path: resolve(artifacts, 'plan-initial.png') });
  // 계획 칸이 넘쳐도 승인 버튼은 칸 안으로 스크롤해 닿을 수 있어야 한다.
  await page.$eval('.ag-plan-card-slot', node => { node.scrollTop = node.scrollHeight; });
  assert.equal(await page.$eval('.ag-plan-approve', node => {
    const slot = node.closest('.ag-plan-card-slot').getBoundingClientRect();
    const button = node.getBoundingClientRect();
    return node.checkVisibility() && button.top >= slot.top && button.bottom <= slot.bottom;
  }), true);
  await (await page.$('.ag-root')).screenshot({ path: resolve(artifacts, 'plan-actions.png') });
  await page.$eval('.ag-plan-card-slot', node => { node.scrollTop = 0; });

  await submit('첫 단계에서 무엇을 확인하나요?');
  await page.waitForFunction(() => window.sidebarPreview.bridge.isTurnRunning());
  await page.waitForFunction(() => !window.sidebarPreview.bridge.isTurnRunning());
  assert.equal((await latest()).planId, original.planId, 'ordinary plan conversation must preserve the approvable plan');
  await page.click('.ag-plan-revise');
  await submit('일정을 먼저 검토하고 담당자도 확인해 주세요.');
  await page.waitForFunction(id => window.sidebarPreview.bridge.getWorkflowState().latestPlan?.planId !== id
    && window.sidebarPreview.bridge.getWorkflowState().phase === 'awaiting-approval', {}, original.planId);
  const revised = await latest();
  assert.equal(revised.revision, 2);
  assert.equal(revised.previousPlanId, original.planId);
  assert.match(revised.changeSummary, /일정/);
  assert.equal(revised.steps[0].id, 'step-1');
  assert.match(revised.steps[0].title, /일정/, 'revision must move the schedule review first');
  assert.match(await page.$eval('.ag-plan-phase', node => node.textContent), /^v2 · /);
  await (await page.$('.ag-root')).screenshot({ path: resolve(artifacts, 'plan-revised.png') });

  await page.evaluate(() => {
    window.planEvents = [];
    window.planDomStates = [];
    new MutationObserver(() => {
      const statuses = [...document.querySelectorAll('.ag-todo')].map(node => node.dataset.status);
      if (statuses.length) window.planDomStates.push(statuses);
    }).observe(document.querySelector('.ag-root'), { childList: true, subtree: true, attributes: true, attributeFilter: ['data-status'] });
    window.sidebarPreview.bridge.onEvent(event => {
      if (event.type === 'plan-progress') window.planEvents.push(event.latestPlan?.execution);
    });
  });
  await page.click('.ag-plan-approve');
  const stepCount = revised.steps.length;
  await page.waitForFunction(count => {
    const todos = [...document.querySelectorAll('.ag-todo')];
    return todos.length === count && todos.every(node => node.dataset.status === 'pending')
      && document.querySelector('.ag-todo-count')?.textContent === `0/${count}`;
  }, {}, stepCount);
  await page.waitForFunction(() => document.querySelector('.ag-todo[data-status="in-progress"]')?.dataset.stepId === 'step-2');
  // 실행 중 에이전트가 update_todos 로 늘린 할 일도 목록에 나타난다.
  await page.waitForSelector('.ag-todo[data-step-id="todo-1"]');
  await new Promise(resolve => setTimeout(resolve, 350));
  await (await page.$('.ag-root')).screenshot({ path: resolve(artifacts, 'plan-running.png') });
  await page.waitForFunction(() => window.sidebarPreview.snapshot().pendingChanges === 1);
  const execution = (await latest()).execution;
  assert.equal(execution.status, 'awaiting-review');
  assert.equal(execution.steps.length, stepCount + 1);
  assert(execution.steps.every(step => step.status === 'completed'));
  const events = await page.evaluate(() => window.planEvents);
  assert(events.some(event => event.status === 'running' && event.steps.every(step => step.status === 'pending')),
    'checklist must start with pending steps');
  assert(events.some(event => event.steps.some(step => step.status === 'in-progress')),
    'checklist must show work in progress');
  const domStates = await page.evaluate(() => window.planDomStates);
  assert(domStates.some(states => states.length === stepCount && states.every(status => status === 'pending')));
  assert(domStates.some(states => states.includes('in-progress')));
  const finalTodos = await page.$$eval('.ag-todo', nodes => nodes.map(node => node.dataset.status));
  assert.equal(finalTodos.length, stepCount + 1);
  assert(finalTodos.every(status => status === 'completed'));
  assert.equal(await page.$eval('.ag-todo-count', node => node.textContent), `${stepCount + 1}/${stepCount + 1}`);
  assert.equal(await page.$$eval('.ag-review-card .ag-approve', nodes => nodes.length), 1);
  await page.click('.ag-review-card .ag-approve');
  await page.waitForFunction(() => window.sidebarPreview.bridge.getWorkflowState().latestPlan?.execution?.status === 'completed');
  assert.match(await page.$eval('.ag-plan-phase', node => node.textContent), /완료/);

  await open('theme=dark&width=280');
  await page.click('#play');
  await page.waitForSelector('.ag-plan-card', { visible: true });
  assert.equal(await page.$eval('#theme', node => node.value), 'dark');
  // 최소 폭은 입력기 설정 줄(계획 단계 배지 포함)의 글자 폭으로 정해져 글꼴마다 다르다.
  // 280px 요청은 최소 폭 이상으로 붙되 기본 폭(480px)으로 돌아가지 않는다.
  // 첫 측정값이 나중 측정값보다 커서 폭이 최솟값보다 조금 넓게 남을 수 있다.
  const narrow = await page.$eval('.ag-resize-handle', handle => ({
    width: Math.round(handle.closest('.ag-root').getBoundingClientRect().width),
    min: Number(handle.getAttribute('aria-valuemin')),
  }));
  assert(narrow.width >= narrow.min && narrow.width < 400, JSON.stringify(narrow));
  assert.equal(await page.$eval('.ag-root', node => node.scrollWidth > node.clientWidth), false);
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
  assert.equal(await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches), true);
  await (await page.$('.ag-root')).screenshot({ path: resolve(artifacts, 'plan-narrow-dark.png') });
}
