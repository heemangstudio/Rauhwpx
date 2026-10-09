import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { launchCopyLayoutWorker } from '../copy-layout-worker.mjs';

for (const agent of ['claude', 'codex', 'pi']) {
  test(`${agent} worker launches with private homes, job-bound capability and isolated read roots`, async (t) => {
    const root = await mkdtemp(path.join(tmpdir(), 'copy-layout-worker-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const record = {
      recordRoot: root,
      workDir: path.join(root, 'owner'),
      copyLayoutGeneratedRoot: path.join(root, 'generated'),
      sessionId: 'owner-session',
      documentSnapshotManager: {
        readOnlyRootForChat: (id) => path.join(root, 'snapshot', id),
      },
    };
    const job = {
      jobId: 'job-one',
      agent,
      model: 'model',
      effort: 'high',
      capabilityEpoch: 7,
      workerRole: 'layout',
      binding: { documentId: 'doc-one', digest: 'digest-one' },
    };
    let options, capability;
    const messages = [],
      homes = [];
    const backend = { sendUserMessage: (message) => messages.push(message) };
    const deps = {
      ensureBootWork: async () => {},
      prepareCodexHome: (home) => {
        homes.push(home);
      },
      prepareClaudeHome: (home) => {
        homes.push(home);
      },
      sourceCodexAuthPath: '/credential-source/codex',
      sourceClaudeAuth: '/credential-source/claude',
      MCP_SCRIPT: '/hub/mcp.mjs',
      hubPort: 17700,
      TOKEN: 'parent-token',
      sessions: {
        issue: (token, session, claims) => {
          capability = { token, session, claims };
          return 'job-capability';
        },
      },
      HUB_CAPABILITY_AUDIENCES: { COPY_LAYOUT_WORKER: 'copy-layout-worker' },
      cliSetupStatus: {},
      cliSetup: { envFor: () => ({ fixture: 'provider-env' }) },
      claudeRuntimeEnv: (home) => ({ CLAUDE_HOME: home }),
      CLI_SETUP_AGENTS: ['codex'],
      makeTemplateWorkerEventHandler: () => () => {},
      buildCopyLayoutWorkerPrompt: (data) => JSON.stringify(data),
      piManager: { piBin: '/runtime/pi', rootDir: '/runtime/pi-root', apiKey: () => null },
      piModelConfig: () => null,
      SESSION_FACTORIES: {
        [agent]: (opts) => {
          options = opts;
          return backend;
        },
      },
      unknownAgentError: (name) => new Error(`Unknown agent ${name}`),
    };
    await mkdir(record.workDir);
    await launchCopyLayoutWorker(record, job, deps);
    assert.equal(job.backend, backend);
    assert.equal(options.permissionProfile, 'safe');
    assert.equal(options.toolProfile, 'copy-layout-worker');
    assert.equal(options.agentRole, job.workerRole);
    assert.equal(options.capabilityEpoch, 7);
    assert.equal(options.rootDir, job.jobDir);
    assert.equal(options.workDir, job.jobDir);
    assert.equal(
      path.dirname(job.jobDir),
      path.join(root, 'copy-layout-workspaces'),
    );
    assert(!job.jobDir.startsWith(record.workDir + path.sep));
    assert.deepEqual(options.readOnlyRoots, [
      path.join(root, 'snapshot', job.jobId),
      path.join(root, 'generated', job.jobId),
    ]);
    assert.deepEqual(capability.claims, {
      audience: 'copy-layout-worker',
      resource: job.jobId,
    });
    assert.equal(capability.session, record.sessionId);
    assert.equal(options.token, 'job-capability');
    assert.deepEqual(homes, [
      job.providerHomes.codexHome,
      job.providerHomes.isolatedHome,
    ]);
    for (const directory of [job.jobDir, job.providerRoot]) {
      if (process.platform !== 'win32')
        assert.equal((await stat(directory)).mode & 0o777, 0o700);
    }
    assert.equal(messages.length, 1);
    assert.equal(options.piBin, '/runtime/pi');
    assert.equal(options.piRoot, '/runtime/pi-root');
    assert.equal(options.workflow, 'direct');
    assert.equal(options.phase, 'implementing');
  });
}
