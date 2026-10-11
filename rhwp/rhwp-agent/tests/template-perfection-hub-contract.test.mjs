// 복사 레이아웃 작업자 신원·원본 바인딩, 자격 증명 복사본 보존, 프로세스 정리 실패 시 닫힘 경로는
// 실제 허브로 재현할 작업자·프로세스 트리 장애 하네스가 없어 소스 문자열로 고정합니다.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const server = readFileSync(new URL('../server.mjs', import.meta.url), 'utf8');
const mcp = readFileSync(new URL('../mcp-stdio.mjs', import.meta.url), 'utf8');
const piExtension = readFileSync(new URL('../pi/extension/rhwp.ts', import.meta.url), 'utf8');
const runner = readFileSync(new URL('../copy-layout-runner.mjs', import.meta.url), 'utf8');

test('worker transport remains bound to its authenticated job identity', () => {
  assert.match(mcp, /url\.searchParams\.set\('role', AGENT_ROLE\)/);
  assert.match(mcp, /url\.searchParams\.set\('workerJobId', COPY_LAYOUT_JOB_ID\)/);
  assert.match(piExtension, /RHWP_AGENT_ROLE/);
  assert.match(piExtension, /workerJobId=/);
  assert.match(server, /profile = 'copy-layout-worker'/);
  assert.match(server, /authenticatedUrl\.searchParams\.set\('profile', profile\)/);
  assert.match(server, /requestedAgentRole !== authenticatedWorkerJob\.workerRole/);
  assert.match(server, /ws\.agentRole = authenticatedWorkerJob\?\.workerRole \?\? authenticatedProviderIdentity\.role/);
  assert.match(server, /sock\.copyLayoutJobId/);
  assert.doesNotMatch(server, /workerJobForSocket\(record, sock\)[\s\S]{0,200}sock\.agentRole/);
});

test('worker tools stay bound to the job source, snapshot and artifacts', () => {
  assert.match(server, /COPY_LAYOUT_TOOL_DENIED/);
  assert.match(server, /args\.sourceDocumentId !== workerJob\.binding\.documentId/);
  assert.match(server, /args\.sourceDigest !== workerJob\.binding\.digest/);
  assert.match(server, /documentIdentity: workerJob[\s\S]*workerJob\.binding\.documentId/);
  assert.match(server, /workerJob\.snapshot = Object\.freeze/);
  assert.match(server, /const boundSnapshot = workerJob\.snapshot/);
  assert.match(server, /sourcePath: boundSnapshot\.path/);
  assert.match(server, /COPY_LAYOUT_ARTIFACT_UNBOUND/);
  assert.match(server, /workerJob\.publishedArtifacts\.get\(args\.artifactId\)/);
  assert.match(server, /result\.digest !== workerJob\.binding\.digest/);
  assert.match(server, /workerJob\.snapshot\.checksum !== result\.checksum/);
  assert.match(server, /workerJob\.helperPending > 0/);
  assert.match(server, /workerJob\.generatedCandidates\.size >= COPY_LAYOUT_MAX_ITERATIONS/);
  assert.match(server, /claimCopyLayoutSettlement\(workerJob\)/);
  assert.match(server, /active\.status !== 'completed' && active\.status !== 'failed'/);
  assert.match(server, /workerJob\.snapshotPending/);
  assert.match(server, /claimCopyLayoutSnapshot\(workerJob\)[\s\S]*record\.pendingCalls\.set/);
  // A worker MCP socket that closes mid-materialization must not strand the claim.
  assert.match(server, /'provider-disconnected'\);[\s\S]{0,300}releaseCopyLayoutSnapshot\(record\.templateJobs\.get\(entry\.copyLayoutJobId\)\)/);
  assert.match(server, /claimCopyLayoutPublication\(workerJob, workerCandidate\)[\s\S]*record\.artifactStore\.publish/);
  assert.match(server, /workerJob\.generatedCandidates\.get\(workerCandidate\.iteration\) !== workerCandidate/);
  assert.match(server, /copyLayoutCandidateClaims\(workerJob, published\)/);
  assert.match(server, /candidate_evidence/);
  assert.match(server, /source_renders/);
  assert.match(server, /output_renders/);
  assert.match(server, /COPY_LAYOUT_ITERATIONS_REQUIRED/);
  assert.match(server, /exactJsonArray\(args\.preview\.representativePages/);
  assert.match(server, /counts: completionClaims\.counts/);
  assert.match(server, /preview: completionClaims\.preview/);
  assert.match(server, /MAX_COPY_LAYOUT_JOB_HISTORY = 20/);
  assert.match(server, /cleanupTemplateGeneratedRoot/);
});

test('hub cleanup retains every root that contains a pending credential copyback', () => {
  assert.match(server, /ensureCredentialRetentionRootSync\(WORK_ROOT\)/);
  assert.match(server, /!credentialCopiesSettled \|\| hasPendingCredentialCopybackSync\(record\.recordRoot\)/);
  assert.match(server, /launchCleanupRetentionRequired \|\| hasPendingLaunchCleanupSync\(root\)/);
  assert.match(server, /retainLaunchRootForProcessCleanupSync\(WORK_ROOT/);
  assert.match(server, /if \(!processCleanupSettled\)[\s\S]*retainUncertainProcessCleanup\(record\.recordRoot\)/);
});

test('auxiliary cleanup waits for drained output and retains identity until proven', () => {
  assert.match(server, /auxiliaryProcessCleanups: new Map\(\)/);
  assert.match(
    server,
    /function spawnAuxiliaryProcess[\s\S]*if \(record\.processCleanupUncertain\) throw agentProcessCleanupUncertain\(\)/,
  );
  assert.match(server, /child\.once\('close', cleanup\)/);
  assert.match(server, /terminateAndWaitForProcessTreeExitOutcome\(child\)/);
  assert.match(server, /cleanupProcessOutcome: \(child\) => beginAuxiliaryProcessCleanupOutcome\(record, child\)/);
  assert.doesNotMatch(server, /child\.once\('exit', cleanup\)/);
  assert.match(
    server,
    /outcome !== PROCESS_TREE_CLEANUP_OUTCOME\.PROVEN[\s\S]*record\.processCleanupUncertain = true;[\s\S]*retainUncertainProcessCleanup\(record\.recordRoot\)/,
  );
  assert.match(
    server,
    /outcome === PROCESS_TREE_CLEANUP_OUTCOME\.PROVEN[\s\S]*record\.auxiliaryProcesses\.delete\(child\);[\s\S]*record\.auxiliaryProcessCleanups\.delete\(child\)/,
  );
  assert.match(server, /return beginAuxiliaryProcessCleanupOutcome\(record, child\)[\s\S]*outcome === PROCESS_TREE_CLEANUP_OUTCOME\.PROVEN/);
  assert.match(server, /child\.off\?\.\('close', cleanup\)/);
  assert.doesNotMatch(server, /child\.once\('exit', forget\)/);
  assert.doesNotMatch(server, /record\.auxiliaryProcesses\.clear\(\)/);
});

test('provider replacement and stop fail closed on an unconfirmed process tree', () => {
  assert.match(server, /const retainedUncertainBackends = new Set\(\)/);
  assert.match(server, /const retainedUncertainBrowserbaseSessions = new Set\(\)/);
  assert.match(server, /processCleanupUncertain: false/);
  assert.match(
    server,
    /retainedUncertainBackends\.add\(activeSession\.backend\);[\s\S]*retainUncertainProcessCleanup\(record\.recordRoot\)/,
  );
  assert.match(
    server,
    /retainedUncertainBrowserbaseSessions\.add\(record\.browserbaseSession\);[\s\S]*retainUncertainProcessCleanup\(record\.recordRoot\)/,
  );
  assert.match(server, /Promise\.allSettled\(\[backendExit, browserbaseExit\]\)/);
  assert.doesNotMatch(server, /void record\.browserbaseSession\.cleanup/);
  assert.match(
    server,
    /const browserbaseCleaned = await record\.browserbaseSession\.cleanup\('workflow changed to direct'\)[\s\S]*if \(!browserbaseCleaned\)[\s\S]*sendChatError\(sock, agentProcessCleanupUncertain\(\)/,
  );
  assert.match(server, /error\.code = 'AGENT_PROCESS_CLEANUP_UNCERTAIN'/);
  assert.match(
    server,
    /if \(error\?\.processCleanupUncertain\)[\s\S]*retainedUncertainBrowserbaseSessions\.add\(record\.browserbaseSession\)[\s\S]*retainUncertainProcessCleanup\(record\.recordRoot\)/,
  );
  assert.match(
    server,
    /if \(!await disposeSession\(record\)\) throw agentProcessCleanupUncertain\(\)/,
  );
  assert.match(
    server,
    /const cleaned = await disposeSession\(record\);[\s\S]*throw cleaned \? error : agentProcessCleanupUncertain\(error\)/,
  );
  assert.match(
    server,
    /case 'chat-stop':[\s\S]*if \(!await disposeSession\(record\)\)[\s\S]*sendChatError\(sock, agentProcessCleanupUncertain\(\)/,
  );
});

test('record disposal retains an auxiliary tree whose natural-exit cleanup was unavailable', () => {
  assert.match(server, /let processCleanupSettled = record\.processCleanupUncertain !== true/);
  assert.match(
    server,
    /if \(!processCleanupSettled\) \{[\s\S]*retainUncertainProcessCleanup\(record\.recordRoot\);[\s\S]*return false;[\s\S]*flushProviderCredentialHomes\(record\)/,
  );
});
