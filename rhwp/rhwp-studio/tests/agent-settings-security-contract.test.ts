import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
// settings.ts 는 CSS 를 가져오므로 Node 에서 불러올 수 없다 — 계기판 숫자
// 규칙만 css 없는 모듈에서 실제로 검증하고, DOM 계약은 소스 텍스트로 본다.
import {
  formatRelativeTime,
  formatResetAt,
  formatTokens,
  formatUsageAge,
  formatUsageReset,
} from '../src/ui/agent-sidebar/usage-format.ts';
// providers.ts 는 CSS 를 안 가져오므로 표를 텍스트가 아니라 값으로 직접 본다.
import {
  AGENT_LABEL,
  MASK_ICON_AGENTS,
  PROVIDER_ICON_SRC,
  PROVIDER_ORDER,
} from '../src/ui/agent-sidebar/providers.ts';

const readSource = (relativePath: string) => readFileSync(
  new URL(relativePath, import.meta.url),
  'utf8',
).replace(/\r\n/g, '\n');
const source = readSource('../src/ui/agent-sidebar/index.ts');
const settings = readSource('../src/ui/agent-sidebar/settings.ts');
const bridgeSource = readSource('../src/agent/bridge.ts');
const editingSettings = readSource('../src/ui/agent-sidebar/settings-editing.ts');
const settingsCss = readSource('../src/ui/agent-sidebar/settings.css');
const css = readSource('../src/ui/agent-sidebar/agent-sidebar.css');
const buttonCss = readSource('../src/ui/agent-sidebar/sidebar-button-modern.css');
const icons = readSource('../src/ui/agent-sidebar/icons.ts');
const editCommandsSource = readSource('../src/command/commands/edit.ts');
const toolCommandsSource = readSource('../src/command/commands/tool.ts');
const mainSource = readSource('../src/main.ts');

// Navigation, dirty exits and accessibility are exercised in browser tests.
// Keep credential/approval guards until equivalent failure-path coverage exists.
test('템플릿 설정은 추가·이름 변경·교체·확인 삭제를 제공한다', () => {
  assert.match(settings, /templatesSection\.body\.append\(templatesList, templatesStatus, templatesFooter/);
  assert.doesNotMatch(editingSettings, /documentResources/);
  assert.match(settings, /requestTemplateName\('템플릿 추가'/);
  assert.match(settings, /bridge\.addTemplate\(file, name\)/);
  assert.match(settings, /bridge\.renameTemplate\(id, name\)/);
  assert.doesNotMatch(settings, /window\.prompt/);
  assert.match(settings, /bridge\.replaceTemplate\(id, file\)/);
  assert.match(settings, /await confirmSheet\(remove, `“\$\{template\.name\}” 삭제`, undefined, \{ confirmLabel: '삭제', destructive: true \}\)/);
  assert.match(settings, /bridge\.deleteTemplate\(id\)/);
});

test('브라우저 로그인은 인증 주소와 기기 코드를 카드 안에 직접 그린다', () => {
  // 팝업이 막혀도 사용자가 주소를 직접 열 수 있어야 한다.
  assert.match(settings, /const setupLoginBox = el\('div', 'ag-agent-login-box'\)/);
  assert.match(settings, /const setupAuthLink = el\('a', 'ag-agent-login-url'\)/);
  assert.match(settings, /setupAuthLink\.target = '_blank'/);
  assert.match(settings, /setupAuthLink\.rel = 'noopener noreferrer'/);
  // 긴 주소는 잘라 보여주고 전체는 title 로 남긴다.
  assert.match(settings, /setupAuthLink\.title = setupAuthUrl/);
  assert.match(settingsCss, /\.ag-agent-login-url \{[\s\S]*text-overflow: ellipsis/);
  // 열기 버튼은 클릭 핸들러 안에서 바로 창을 연다(제스처 안이라 차단되지 않는다).
  assert.match(
    settings,
    /setupAuthOpen\.addEventListener\('click', \(\) => \{[\s\S]*window\.open\(setupAuthUrl, '_blank', 'noopener,noreferrer'\)/,
  );
  assert.match(settings, /'브라우저에서 열기'/);
  assert.match(settings, /'주소 복사'/);
  assert.match(settings, /'코드 복사'/);
  assert.match(settings, /navigator\.clipboard\.writeText\(text\)/);
  // 보안 컨텍스트가 아니면 navigator.clipboard 가 없어서 textarea 로 넘어가고,
  // 그것마저 막히면 '복사됨' 대신 실패를 알린다.
  assert.match(settings, /if \(navigator\.clipboard\?\.writeText\)/);
  assert.match(settings, /copied = document\.execCommand\('copy'\)/);
  assert.match(settings, /button\.textContent = copied \? '복사됨' : '복사 실패'/);
  assert.match(settings, /const copied = await writeClipboardText\(text\)/);
  // 기기 코드와 안내 문구.
  assert.match(settings, /const setupUserCodeValue = el\('strong', 'ag-agent-login-code-value'\)/);
  assert.match(settings, /if \(setupUserCode\) setupUserCodeValue\.textContent = setupUserCode/);
  assert.match(settings, /'브라우저에서 이 코드를 확인합니다\.'/);
  assert.match(settings, /'브라우저에서 로그인하면 자동으로 완료됩니다\.'/);
  assert.match(settingsCss, /\.ag-agent-login-code-value \{[\s\S]*user-select: all/);
  // 로그인이 도는 동안 취소 버튼이 함께 선다.
  assert.match(settings, /el\('button', 'ag-settings-btn ag-agent-login-cancel', '로그인 취소'\)/);
  assert.match(
    settings,
    /setupLoginCancel\.addEventListener\('click', \(\) => \{\s*if \(setupAgent && setupAuthRunId\) \{\s*abandonedAuthRunIds\.add\(setupAuthRunId\);\s*bridge\.cancelAgentSetup\(setupAgent, setupAuthRunId\);/,
  );
  // 취소하면 방금 누른 버튼이 사라져 포커스가 <body> 로 떨어지고, Esc 를 받는
  // 덮개 밖이라 키보드로 카드를 닫을 수 없게 된다 — 다시 그릴 때 되돌린다.
  assert.match(
    settings,
    /function restoreSetupFocus\(\): void \{[\s\S]*if \(active && active !== document\.body\) return;\s*setupDialog\.focus\(\);/,
  );
  assert.match(settings, /setupCodeSubmit\.disabled = connectionState !== 'connected' \|\| !setupCode\.input\.value\.trim\(\);\s*restoreSetupFocus\(\);/);
  assert.match(settings, /renderPi\(\);\s*restoreSetupFocus\(\);/);
  // 상자는 이 에이전트의 로그인이 진행 중인 동안 선다 — 주소·코드가 아직 없는
  // 시작 직후·키 검사 중에도 대기 문구와 취소 버튼이 보여야 버튼이 멈춰 보이지 않는다.
  assert.match(settings, /const authorizing = setupBusy && setupProgressPercent <= 0 && !supportsTerminalSetup\(setupAgent\);\s*setupLoginBox\.hidden = !authorizing/);
  assert.match(settings, /if \(ev\.authUrl\) setupAuthUrl = ev\.authUrl;\s*if \(ev\.userCode\) setupUserCode = ev\.userCode;/);
  assert.match(settings, /if \(method === 'oauth' && started\.authUrl\) setupAuthUrl = started\.authUrl/);
  // 자동 열기 시도는 그대로 남는다.
  assert.match(settings, /maybeOpenAuthUrl\(ev\.authUrl\)/);
  // claude 인증 코드 입력칸은 로그인 상자 아래에 붙는다.
  assert.match(settings, /setupKeyBox,\s*setupLoginBox,\s*setupCodeBox,/);
  // 로그인이 끝나거나 실패하면 주소·코드를 지운다.
  assert.match(settings, /function clearSetupAuthPrompt\(\): void \{\s*setupTerminal\.close\(\);\s*setupOauthPending = false;\s*setupAuthUrl = null;\s*setupUserCode = null;/);
  assert.match(settings, /if \(ev\.state === 'done'\) clearSetupAuthPrompt\(\)/);
});

test('AI 기본 설정은 Apply 전까지 초안이고 성공 후 사이드바에 알린다', () => {
  assert.match(settings, /createSelect\(\s*'제공자'/);
  assert.match(settings, /createSelect\('모델', \[\]\)/);
  assert.match(settings, /createSelect\('추론 강도', \[\]\)/);
  assert.match(settings, /effortField\.field\.hidden = effortOptions\.length === 0/);
  assert.match(settings, /fillSelect\(effortField\.select, \[\.\.\.effortOptions\]\.reverse\(\)\)/);
  // 줄의 display:flex 가 기본 [hidden] 을 덮으므로 따로 눌러 준다 — 없으면
  // Cursor 처럼 추론 강도가 없는 프로바이더에서 빈 줄이 남는다.
  assert.match(settingsCss, /\.ag-settings-field\[hidden\]\s*\{[^}]*display:\s*none;/s);
  assert.match(settings, /createSelect\('모드', MODE_OPTIONS\.map\(/);
  assert.match(settings, /const select = el\('select', 'ag-settings-select'\)/);
  assert.match(settings, /prefsDraft = normalizeAgentPrefs\(\{ \.\.\.prefsDraft, \.\.\.partial \}\)/);
  assert.match(settings, /const result = trySaveAgentPrefs\(nextPrefs\)/);
  assert.match(settings, /applyDefaults\(result\.value\)/);
  assert.match(settings, /aiStatus\.textContent = 'AI 설정을 적용했습니다\.'/);
  assert.match(settings, /nextPrefs\.defaultMode === 'full'[\s\S]*confirmSheet\(aiStatus, '기본 모드를 전체로', UNRESTRICTED_DEFAULT_WARNING/);
  assert.match(settings, /saveAgentInstructions\(\)[\s\S]*persistPrefs\(nextPrefs\)/);
  assert.match(settings, /agentField\.select\.disabled = aiPrefsSaving/);
  assert.match(settings, /modelField\.select\.disabled = aiPrefsSaving/);
  assert.match(settings, /effortField\.select\.disabled = aiPrefsSaving/);
  assert.match(settings, /modeField\.select\.disabled = aiPrefsSaving/);
  assert.match(
    settings,
    /aiPrefsSaving = true;[\s\S]*try \{[\s\S]*await saveAgentInstructions\(\)[\s\S]*finally \{[\s\S]*aiPrefsSaving = false;/,
  );
});

test('앱 전용 지시는 에이전트 변경안을 사용자 승인 전까지 분리한다', () => {
  assert.match(settings, /createSection\('지시'\)/);
  assert.doesNotMatch(settings, /Rauhwpx 채팅에만 적용됩니다/);
  assert.match(settings, /agent-instructions-draft/);
  assert.match(settings, /bridge\.confirmAgentInstructionsDraft\(draft\)/);
  assert.match(settings, /bridge\.rejectAgentInstructionsDraft\(draft\)/);
  assert.match(settings, /승인 전에는 AGENTS\.md에 저장되지 않습니다/);
  assert.doesNotMatch(settings, /AGENTS\.md · r\$\{/);
  assert.doesNotMatch(settings, /instructionsMeta/);
  assert.doesNotMatch(settings, /연결 후 불러옵니다/);
  assert.match(settingsCss, /\.ag-settings-instructions-proposal/);
});

test('설치만 된 런타임을 연결 상태로 오인하지 않는다', () => {
  assert.match(
    settings,
    /const connected = status\?\.connected === true \|\| status\?\.setupComplete === true\s*\|\| \(available && status\?\.authenticated === true\)/,
  );
  assert.match(settings, /const connected = setup\?\.connected === true \|\| setup\?\.setupComplete === true\s*\|\| \(detected && setup\?\.authenticated === true\)/);
  assert.match(settings, /label = detected \? '로그인 필요' : '연결하기'/);
  assert.match(settings, /const statuses = await bridge\.disconnectAgent\(agent\);[\s\S]*if \(statuses\) setupStatuses = statuses;[\s\S]*renderAgentSetup\(\);/);
});

test('OpenCode 설정은 허브의 터미널 로그인 지원 여부를 따르고 인증을 확인한다', () => {
  assert.match(settings, /setupOauth\.hidden = status\?\.terminalAuthSupported === false/);
  assert.match(settingsCss, /\.ag-agent-auth-card\[hidden\] \{\s*display: none;/);
  assert.match(
    settings,
    /refreshBtn\.addEventListener\('click',[\s\S]{0,160}Promise\.all\(\[refreshProviders\(true\), refreshSetupStatuses\(true\)\]\)/,
  );
  assert.match(bridgeSource, /requestAgentSetupStatus\(refresh = false\)/);
  assert.match(bridgeSource, /type: 'agent-setup-status-request', \.\.\.\(refresh \? \{ refresh: true \} : \{\}\)/);
  assert.match(settings, /agent === 'opencode' \? 'CLI 자격 증명'\s*: status\.authSource === 'local' \? '터미널 로그인' : '웹 계정'/);
  // 설치 감지만으로 완료하지 않고 허브가 확인한 인증 상태를 요구한다.
  assert.match(settings, /\|\| \(available && status\?\.authenticated === true\)/);
  assert.match(settings, /label = detected \? '로그인 필요' : '연결하기'/);
  // 터미널 로그인을 지원하지 않는 런타임은 API 키 입력으로 이동한다.
  assert.match(
    settings,
    /async function startPreferredSetupAuth\(agent: AgentName\): Promise<void> \{\s*setupReauth = true;\s*if \(setupStatuses\?\.\[agent\]\?\.terminalAuthSupported === false\) \{\s*setupKeyBox\.hidden = false;\s*renderAgentSetup\(\);\s*setupKey\.input\.focus\(\);\s*return;\s*\}\s*await startSetupAuth\('oauth'\);/,
  );
  assert.match(settings, /return agent !== null && agent !== 'pi'\s*&& setupStatuses\?\.\[agent\]\?\.terminalAuthSupported !== false/);
  assert.match(settings, /if \(supportsTerminalSetup\(setupAgent\) && method === 'oauth'\) void setupTerminal\.open\(AGENT_LABEL\[setupAgent\]\)/);
  assert.match(settings, /case 'agent-setup-terminal':[\s\S]*if \(setupAuthRunId && ev\.authRunId !== setupAuthRunId\) break;/);
});

test('원격 브라우저 구역은 고급 묶음에 서고, 키는 앱 수명 동안만 허브를 덮는다', () => {
  const bridge = readSource('../src/agent/bridge.ts');
  assert.match(settings, /createSection\('원격 브라우저'\)/);
  assert.match(settings, /advanced\.append\(advancedSummary, browserbaseSection\.root, gitSection\.root\)/);
  // 키 칸은 비밀번호 칸이고 자동완성에 걸리지 않는다.
  assert.match(settings, /createTextField\('Browserbase 키', \{\s*type: 'password',\s*placeholder: 'bb_live_…',\s*autocomplete: 'new-password',\s*\}\)/);
  assert.match(settings, /createTextField\('Gemini 키', \{\s*type: 'password',\s*placeholder: 'AIza…',\s*autocomplete: 'new-password',\s*\}\)/);
  assert.match(settings, /createTextField\('프로젝트 ID', \{ placeholder: '비우면 자동 선택' \}\)/);
  // 적용은 허브 검증을 거치고, 성공한 if (status) 안에서만 보관·칸 비우기가 일어난다.
  const submit = settings.match(
    /async function submitBrowserbase\(\): Promise<void> \{[\s\S]*?\n  async function resetBrowserbase/,
  )?.[0] ?? '';
  const success = submit.match(/if \(status\) \{[\s\S]*?\n    \} else if \(!browserbaseMessage\)/)?.[0] ?? '';
  assert.match(success, /saveBrowserbaseOverride\(\{ \.\.\.override,/);
  assert.match(success, /browserbaseKey\.input\.value = '';/);
  assert.match(success, /browserbaseGemini\.input\.value = '';/);
  assert.doesNotMatch(submit.slice(0, submit.indexOf(success)), /saveBrowserbaseOverride/);
  assert.doesNotMatch(submit.slice(submit.indexOf(success) + success.length), /saveBrowserbaseOverride/);
  // 자동으로 채워진 옛 프로젝트 ID는 새 키와 섞지 않는다.
  assert.match(settings, /browserbaseKey\.input\.addEventListener\('input',[\s\S]*if \(browserbaseProjectAutoFilled\) \{[\s\S]*browserbaseProject\.input\.value = '';/);
  // 되돌리기는 허브가 성공한 뒤에만 브리지와 탭 보관소를 함께 비운다.
  assert.match(settings, /const status = await bridge\.clearBrowserbaseCredentials\(\);[\s\S]*if \(status\) \{\s*clearBrowserbaseOverride\(\);/);
  assert.match(bridge, /const status = await this\.request<BrowserbaseStatus>\([\s\S]*browserbase-credentials-set[\s\S]*if \(status\) this\.browserbaseOverride = candidate;/);
  // 새로고침 뒤에는 보관소의 키를 허브에 다시 심고, 브리지는 연결마다 재전송한다.
  assert.match(settings, /const storedBrowserbase = loadBrowserbaseOverride\(\);\s*if \(storedBrowserbase\) \{[\s\S]*bridge\.setBrowserbaseCredentials\(storedBrowserbase\)/);
  assert.match(bridge, /if \(this\.browserbaseOverride !== null\) \{\s*this\.sendJson\(\{ v: AGENT_PROTOCOL_VERSION, type: 'browserbase-credentials-set', \.\.\.this\.browserbaseOverride \}\);/);
  // 상태 줄은 키 꼬리만 보여 준다 — 키 본문은 허브가 애초에 보내지 않는다.
  assert.match(settings, /키 ····\$\{status\.keyTail \?\? ''\}/);
  assert.match(settings, /case 'browserbase-status':\s*browserbaseStatus = ev\.status;\s*renderBrowserbase\(\);/);
  assert.match(settingsCss, /\.ag-settings-status\.ag-settings-status-warn \{/);
});
