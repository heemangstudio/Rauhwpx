import assert from 'node:assert/strict';
import { isMainModule, runStandalone } from './standalone.mjs';

export async function checkProviderUpdates(page, origin, navigate = true) {
  if (navigate) await page.goto(`${origin}/?reset=1`, { waitUntil: 'networkidle0' });
  const result = await page.evaluate(async () => {
    const { createSettingsPanel } = await import('/src/ui/agent-sidebar/settings.ts');
    const { createMockBridge } = await import('/src/sidebar-preview/mock-bridge.ts');
    const original = createMockBridge(() => {}).bridge;
    let statuses = structuredClone(await original.requestAgentSetupStatus());
    Object.assign(statuses.claude, { installed: true, available: true, authenticated: true,
      connected: true, version: '1.0.0', latestVersion: '2.0.0', updateRequired: true });
    let finish;
    let installs = 0;
    const bridge = Object.create(original);
    bridge.requestAgentSetupStatus = async () => structuredClone(statuses);
    bridge.installAgent = () => { installs++; return new Promise(resolve => { finish = resolve; }); };
    const panel = createSettingsPanel({ bridge, updatesApi: null, editorRuntime: { preview() {}, committed() {} },
      getSelection: () => ({ agent: 'claude', model: '', effort: '', permission: 'safe' }),
      applyDefaults() {}, reconnectSession() {} });
    document.body.append(panel.element);
    const emit = () => panel.handleEvent({ type: 'agent-setup-status', statuses: structuredClone(statuses) });
    const tick = () => new Promise(resolve => setTimeout(resolve, 0));
    panel.openAgentSetup('claude');
    const initialChecking = [...document.querySelectorAll('.ag-agent-setup-generic > .ag-agent-setup-pane')]
      .every(pane => pane.hidden);
    await tick(); emit();
    const hippo = document.querySelector('.uh-provider:not([hidden])');
    const hippoOffered = hippo?.textContent.includes('Claude 2.0.0');
    hippo.querySelector('[data-action="download"]').click();
    const update = () => document.querySelector('.ag-agent-setup-update');
    update().click();
    const body = document.querySelector('.ag-agent-setup-body');
    const observer = new MutationObserver(() => {});
    observer.observe(body, { childList: true });
    emit();
    const detachedBody = observer.takeRecords().length > 0;
    observer.disconnect();
    panel.handleEvent({ type: 'agent-setup-progress', agent: 'claude', state: 'done' });
    const prematureReady = !update().disabled;
    const staleStatuses = structuredClone(statuses);
    let releaseRefresh;
    bridge.requestAgentSetupStatus = () => new Promise(resolve => { releaseRefresh = resolve; });
    panel.openAgentSetup('claude'); await tick();
    const reopenedBusy = update().disabled;
    update().click();
    const duplicateInstalls = installs;
    Object.assign(statuses.claude, { version: '2.0.0', updateRequired: false, installing: false });
    emit(); finish(structuredClone(statuses)); await tick();
    releaseRefresh(staleStatuses); await tick();
    const updated = update().hidden && document.querySelector('.ag-agent-setup-card').textContent.includes('2.0.0');
    await new Promise(resolve => setTimeout(resolve, 700));
    const finished = document.querySelector('.ag-agent-setup-progress').hidden;
    bridge.requestAgentSetupStatus = async () => structuredClone(statuses);
    Object.assign(statuses.claude, { latestVersion: '3.0.0', updateRequired: true });
    emit();
    bridge.installAgent = async () => { throw new Error('offline'); };
    update().click(); await tick();
    const retryable = !update().disabled && !document.querySelector('.ag-agent-setup-error').hidden
      && document.querySelector('.ag-agent-setup-progress').hidden;
    panel.dispose(); panel.element.remove();
    return { hippoOffered, initialChecking, detachedBody, prematureReady, reopenedBusy, duplicateInstalls, updated, finished, retryable };
  });
  assert.deepEqual(result, { hippoOffered: true, initialChecking: true, detachedBody: false, prematureReady: false, reopenedBusy: true,
    duplicateInstalls: 1, updated: true, finished: true, retryable: true });
}
if (isMainModule(import.meta)) await runStandalone('Provider update lifecycle', checkProviderUpdates);
