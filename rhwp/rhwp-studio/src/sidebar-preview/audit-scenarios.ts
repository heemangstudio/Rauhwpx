export interface AuditScenario {
  id: string;
  group: string;
  title: string;
  hint: string;
  params: Readonly<Record<string, string>>;
}

const scene = (id: string, group: string, title: string, hint: string, params: Record<string, string>): AuditScenario =>
  ({ id, group, title, hint, params });

export const auditScenarios: readonly AuditScenario[] = [
  scene('chat-empty', 'Conversation', 'New conversation', 'Inspect the empty state, composer, provider controls, and keyboard focus.', {}),
  scene('chat-no-document', 'Conversation', 'No document open', 'Inspect document guidance and available composer actions.', { document: 'empty' }),
  scene('chat-response', 'Conversation', 'Markdown response', 'Inspect response typography, message spacing, and composer layout.', { scenario: 'chat', play: '1' }),
  scene('chat-rich', 'Conversation', 'Rich Markdown response', 'Inspect headings, lists, tables, code, citations, and overflow.', { scenario: 'rich', play: '1' }),
  scene('chat-plan', 'Conversation', 'Plan approval', 'Inspect approval, revision, and long plan scrolling.', { scenario: 'plan', play: '1' }),
  scene('plan-run-modes', 'Agent modes', 'Plan approval actions', 'Inspect 에이전트로 실행 beside the red 전체 접근으로 실행 and 수정 요청.', { mode: 'plan', scenario: 'plan', play: '1', surface: 'plan-actions' }),
  scene('chat-question', 'Conversation', 'Question and answers', 'Inspect selectable answers, free text, and submission.', { scenario: 'question', play: '1' }),
  scene('chat-question-held', 'Conversation', 'Question held while typing', 'A question arrived while the composer had focus and text. Inspect the one-line strip; click it, or move focus out of the composer, to open the question.',
    { scenario: 'chat', play: '1', hold: '1', questionHeld: '1' }),
  scene('chat-review', 'Conversation', 'Document change review', 'Inspect pending changes and accept/reject controls.', { scenario: 'review', play: '1' }),
  scene('chat-changes-full', 'Conversation', 'Full-screen changes', 'Inspect applied text, table, and image changes beside the conversation.',
    { scenario: 'review', review: 'full', play: '1', surface: 'changes' }),
  scene('chat-fleet', 'Conversation', 'Tools and subagents', 'Expand tool activity and inspect subagent progress.', { scenario: 'fleet', play: '1', hold: '1' }),
  scene('chat-error', 'Conversation', 'Failed turn', 'Inspect error text and recovery actions.', { scenario: 'error', play: '1' }),
  scene('chat-streaming', 'Conversation', 'Streaming response', 'Inspect the active turn, stop control, and composer while work is running.', { scenario: 'chat', play: '1', hold: '1' }),
  scene('panel-skills', 'Panels and menus', 'Skills library', 'Inspect search, enable toggles, editing, and creation.', { surface: 'skills' }),
  scene('panel-references', 'Panels and menus', 'Reference library', 'Inspect file search, attachment controls, and reference details.', { surface: 'references' }),
  scene('panel-threads', 'Panels and menus', 'Conversation library', 'Inspect thread navigation and conversation actions.', { surface: 'threads', chats: 'sample' }),
  scene('menu-provider', 'Panels and menus', 'Provider picker', 'Inspect provider choices, readiness, and selection.', { surface: 'provider-picker' }),
  scene('menu-model', 'Panels and menus', 'Model picker', 'Inspect model names, selected state, and scrolling.', { surface: 'model-picker' }),
  scene('menu-effort', 'Panels and menus', 'Reasoning effort', 'Inspect available effort levels and selection.', { surface: 'effort-picker' }),
  scene('mode-chat', 'Agent modes', '채팅 mode', 'Inspect the blue mode chip in the composer.', { mode: 'chat' }),
  scene('mode-plan', 'Agent modes', '플랜 mode', 'Inspect the charcoal mode chip in the composer.', { mode: 'plan' }),
  scene('mode-agent', 'Agent modes', '에이전트 mode', 'Inspect the default ink mode chip in the composer.', { mode: 'agent' }),
  scene('mode-full', 'Agent modes', '전체 mode', 'Inspect the red mode chip in the composer.', { mode: 'full' }),
  scene('menu-mode', 'Agent modes', 'Mode menu', 'Inspect the four modes, their colors, and keyboard focus.', { surface: 'mode-menu' }),
  scene('mode-locked', 'Agent modes', 'Locked to 채팅', 'Another chat of this document is editing. Inspect the disabled modes and their tooltip.', { parallel: 'locked', scenario: 'chat', surface: 'mode-menu' }),
  scene('connection-ready', 'Connection and setup', 'Connected service', 'Inspect provider readiness and normal composer state.', { connection: 'connected' }),
  scene('connection-connecting', 'Connection and setup', 'Connecting service', 'Inspect the connecting indicator and disabled actions.', { connection: 'connecting' }),
  scene('connection-offline', 'Connection and setup', 'Disconnected service', 'Inspect offline guidance and reconnect controls.', { connection: 'disconnected' }),
  scene('connection-replaced', 'Connection and setup', 'Replaced session', 'Inspect the session replacement message and recovery.', { connection: 'replaced' }),
  scene('provider-setup', 'Connection and setup', 'Provider installation', 'Inspect uninstalled providers, login prompts, and setup controls.', { services: 'setup', page: 'settings', destination: 'ai', surface: 'provider-setup' }),
  scene('setup-claude', 'Connection and setup', 'Claude setup', 'Inspect Claude installation, authentication, and setup guidance.', { services: 'setup', page: 'settings', destination: 'ai', surface: 'provider-setup', provider: 'claude' }),
  scene('setup-claude-terminal', 'Connection and setup', 'Claude login terminal', 'Use Enter to step through login; cancel to use an API key.', { services: 'setup', page: 'settings', destination: 'ai', surface: 'provider-setup', provider: 'claude', terminal: '1' }),
  scene('setup-pi', 'Connection and setup', 'Pi setup', 'Inspect Pi installation, authentication, and setup guidance.', { services: 'setup', page: 'settings', destination: 'ai', surface: 'provider-setup', provider: 'pi' }),
  scene('browserbase-ready', 'Connection and setup', 'Browserbase connected', 'Inspect the connected browser service and account controls.', { page: 'settings', destination: 'ai', browserbase: 'ready' }),
  scene('browserbase-setup', 'Connection and setup', 'Browserbase setup', 'Inspect browser service configuration and sign-in guidance.', { page: 'settings', destination: 'ai', browserbase: 'setup' }),
  scene('browserbase-error', 'Connection and setup', 'Browserbase failure', 'Inspect browser service error feedback and recovery controls.', { page: 'settings', destination: 'ai', browserbase: 'error' }),
  scene('first-run', 'Connection and setup', 'First-run wizard', 'Inspect step navigation, provider setup, and writing calibration.', { 'initial-setup': '1', services: 'setup' }),
  scene('settings-editing', 'Settings', 'Editing preferences', 'Inspect preference groups, draft changes, apply, and cancel.', { page: 'settings', destination: 'editing' }),
  scene('settings-ai', 'Settings', 'AI preferences', 'Inspect model defaults, instructions, and calibration controls.', { page: 'settings', destination: 'ai' }),
  scene('settings-accounts', 'Settings', 'AI accounts and connections', 'Inspect account details, provider cards, and usage plans.', { page: 'settings', destination: 'ai' }),
  scene('settings-expanded', 'Settings', 'Full-screen settings', 'Inspect navigation, content width, and the return control.', { page: 'settings', destination: 'editing', fullscreen: '1' }),
  scene('versions-linear', 'Document history', 'Version timeline', 'Select checkpoints and inspect details and restore actions.', { page: 'versions' }),
  scene('versions-branches', 'Document history', 'Branches and merges', 'Inspect graph lanes, branch switching, tags, and shelves.', { page: 'versions', history: 'branches' }),
  scene('versions-empty', 'Document history', 'History without a document', 'Inspect the empty history state and its guidance.', { page: 'versions', document: 'empty' }),
];

const reviewedKey = 'sidebar-preview-audit-reviewed-v1';

/** A scene link starts clean, preserving only the current viewing preferences. */
export function auditScenarioUrl(scenario: AuditScenario, params: URLSearchParams): string {
  const url = new URL(location.pathname, location.origin);
  for (const key of ['theme', 'width']) {
    const value = params.get(key);
    if (value) url.searchParams.set(key, value);
  }
  for (const [key, value] of Object.entries(scenario.params)) url.searchParams.set(key, value);
  url.searchParams.set('audit', '1');
  url.searchParams.set('auditScene', scenario.id);
  return url.href;
}

export function mountAuditNavigator(container: HTMLElement, params: URLSearchParams): void {
  const reviewed = new Set<string>();
  try {
    const saved: unknown = JSON.parse(sessionStorage.getItem(reviewedKey) ?? '[]');
    if (Array.isArray(saved)) for (const id of saved) if (typeof id === 'string') reviewed.add(id);
  } catch { /* Review navigation remains available when storage is disabled. */ }
  const currentId = params.get('auditScene') ?? 'chat-empty';
  const nav = document.createElement('nav');
  nav.className = 'audit-navigator';
  nav.setAttribute('aria-label', 'Sidebar audit scenes');
  const heading = document.createElement('h2');
  heading.className = 'audit-heading';
  heading.textContent = 'Sidebar audit';
  const progress = document.createElement('p');
  progress.className = 'audit-progress';
  const updateProgress = () => {
    progress.textContent = `${auditScenarios.filter((item) => reviewed.has(item.id)).length} / ${auditScenarios.length} reviewed`;
  };
  updateProgress();
  const label = document.createElement('label');
  label.className = 'audit-search-label';
  label.textContent = 'Find a scene';
  const search = document.createElement('input');
  search.type = 'search';
  search.className = 'audit-search';
  search.placeholder = 'Search scenes…';
  label.append(search);
  const controls = document.createElement('div');
  controls.className = 'audit-pagination';
  const list = document.createElement('div');
  list.className = 'audit-groups';
  const link = (item: AuditScenario, title: string) => {
    const anchor = document.createElement('a');
    anchor.href = auditScenarioUrl(item, params);
    anchor.dataset.previewNavigation = 'true';
    anchor.textContent = title;
    return anchor;
  };
  const render = () => {
    const query = search.value.trim().toLowerCase();
    const visible = auditScenarios.filter((item) => `${item.group} ${item.title} ${item.hint}`.toLowerCase().includes(query));
    controls.replaceChildren();
    const currentIndex = visible.findIndex((item) => item.id === currentId);
    const previous = visible[currentIndex - 1];
    const next = visible[currentIndex + 1];
    for (const [item, title] of [[previous, 'Previous'], [next, 'Next']] as const) {
      if (item) controls.append(link(item, title));
      else {
        const disabled = document.createElement('span');
        disabled.textContent = title;
        disabled.setAttribute('aria-disabled', 'true');
        controls.append(disabled);
      }
    }
    list.replaceChildren();
    if (!visible.length) {
      const empty = document.createElement('p');
      empty.className = 'audit-empty';
      empty.textContent = 'No scenes match your search.';
      list.append(empty);
    }
    for (const group of new Set(visible.map((item) => item.group))) {
      const section = document.createElement('section');
      section.className = 'audit-group';
      const title = document.createElement('h3');
      title.textContent = group;
      const items = document.createElement('ul');
      for (const item of visible.filter((entry) => entry.group === group)) {
        const row = document.createElement('li');
        row.className = 'audit-scene';
        row.classList.toggle('audit-scene-current', item.id === currentId);
        const anchor = link(item, item.title);
        anchor.className = 'audit-scene-link';
        if (item.id === currentId) anchor.setAttribute('aria-current', 'page');
        const hint = document.createElement('small');
        hint.className = 'audit-hint';
        hint.textContent = item.hint;
        anchor.append(hint);
        const check = document.createElement('input');
        check.type = 'checkbox';
        check.className = 'audit-reviewed';
        check.checked = reviewed.has(item.id);
        check.setAttribute('aria-label', `Mark ${item.title} reviewed`);
        check.addEventListener('change', () => {
          if (check.checked) reviewed.add(item.id);
          else reviewed.delete(item.id);
          try { sessionStorage.setItem(reviewedKey, JSON.stringify([...reviewed])); } catch { /* Keep the in-memory checklist usable. */ }
          updateProgress();
        });
        row.append(check, anchor);
        items.append(row);
      }
      section.append(title, items);
      list.append(section);
    }
  };
  search.addEventListener('input', render);
  nav.append(heading, progress, label, controls, list);
  container.append(nav);
  render();
}
