import path from 'node:path';
import fs from 'node:fs/promises';

export async function launchCopyLayoutWorker(record, job, dependencies) {
  const {
    ensureBootWork,
    prepareCodexHome,
    sourceCodexAuthPath,
    prepareClaudeHome,
    sourceClaudeAuth,
    MCP_SCRIPT,
    hubPort,
    sessions,
    TOKEN,
    HUB_CAPABILITY_AUDIENCES,
    cliSetupStatus,
    cliSetup,
    claudeRuntimeEnv,
    CLI_SETUP_AGENTS,
    makeTemplateWorkerEventHandler,
    buildCopyLayoutWorkerPrompt,
    piManager,
    openRouterManager,
    OPENROUTER_AGENTS,
    piModelConfig,
    SESSION_FACTORIES,
    unknownAgentError,
  } = dependencies;
  // The owning chat provider can mutate record.workDir. Keep even the
  // worker's read-only cwd under a sibling hub-owned parent so it cannot be
  // swapped to a symlink/junction before the worker opens files.
  const jobDir = path.join(
    record.recordRoot,
    'copy-layout-workspaces',
    job.jobId,
  );
  const jobGeneratedRoot = path.join(record.copyLayoutGeneratedRoot, job.jobId);
  const jobSnapshotRoot = record.documentSnapshotManager.readOnlyRootForChat(
    job.jobId,
  );
  const providerRoot = path.join(
    record.recordRoot,
    'copy-layout-providers',
    job.jobId,
  );
  const isolatedHome = path.join(providerRoot, 'home');
  const codexHome = path.join(isolatedHome, '.codex');
  job.providerHomes = { isolatedHome, codexHome };
  job.providerRoot = providerRoot;
  await fs.mkdir(jobDir, { recursive: true, mode: 0o700 });
  await fs.mkdir(providerRoot, { recursive: true, mode: 0o700 });
  await ensureBootWork();
  prepareCodexHome(codexHome, sourceCodexAuthPath);
  prepareClaudeHome(isolatedHome, sourceClaudeAuth);
  job.jobDir = jobDir;
  job.generatedRoot = jobGeneratedRoot;
  job.snapshotRoot = jobSnapshotRoot;

  const opts = {
    rootDir: jobDir,
    workDir: jobDir,
    // A background worker can read only its own immutable snapshot and
    // generated candidates, never the owning chat's workspace/downloads.
    readOnlyRoots: [jobSnapshotRoot, jobGeneratedRoot],
    mcpScriptPath: MCP_SCRIPT,
    hubPort,
    token: sessions.issue(TOKEN, record.sessionId, {
      audience: HUB_CAPABILITY_AUDIENCES.COPY_LAYOUT_WORKER,
      resource: job.jobId,
    }),
    sessionId: record.sessionId,
    model: job.model,
    effort: job.effort,
    permissionProfile: 'safe',
    isolatedHome,
    codexHome,
    codexAuthPath: sourceCodexAuthPath,
    codexBin: cliSetupStatus.codex?.installed
      ? cliSetup.binPath('codex')
      : 'codex',
    claudeBin: cliSetupStatus.claude?.installed
      ? cliSetup.binPath('claude')
      : 'claude',
    providerEnv:
      job.agent === 'claude'
        ? claudeRuntimeEnv(isolatedHome)
        : CLI_SETUP_AGENTS.includes(job.agent)
          ? cliSetup.envFor(job.agent)
          : {},
    onEvent: makeTemplateWorkerEventHandler(record, job),
    workflow: 'direct',
    phase: 'implementing',
    capabilityEpoch: job.capabilityEpoch,
    toolProfile: 'copy-layout-worker',
    agentRole: job.workerRole,
    systemPromptOverride: buildCopyLayoutWorkerPrompt({
      jobId: job.jobId,
      binding: job.binding,
      jobDir,
    }),
    piBin: piManager.piBin,
    piRoot: piManager.rootDir,
    openRouterApiKey: openRouterManager(job.agent)?.apiKey() ?? undefined,
    agentName: OPENROUTER_AGENTS.has(job.agent) ? job.agent : 'pi',
    reasoning: OPENROUTER_AGENTS.has(job.agent)
      ? Boolean(piModelConfig(job.model, job.agent)?.reasoning)
      : false,
  };
  const createBackend = SESSION_FACTORIES[job.agent];
  if (!createBackend) throw unknownAgentError(job.agent);
  job.backend = createBackend(opts);
  job.backend.sendUserMessage(
    'Begin the autonomous copy-layout workflow now. Follow the system workflow exactly and do not ask questions.',
  );
}
