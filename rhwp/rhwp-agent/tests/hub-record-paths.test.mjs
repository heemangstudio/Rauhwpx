// 창마다 만드는 Codex 홈은 Windows 의 260자 경로 제한 안에 들어가야 한다. Codex 는 그 아래에
// SQLite DB 를 두고, Windows SQLite 는 긴 경로를 열지 못해 `<db>-journal` 이 260자를 넘으면
// Codex 가 "failed to initialize sqlite state runtime" 으로 시작하자마자 끝난다.
import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { registerHubSession } from '../../../desktop/agent-hub.mjs';
import { HUB_TEST_LAUNCH_ID, HUB_TEST_TOKEN, startHub } from './hub-harness.mjs';

// 배포 앱의 가장 긴 작업 폴더: 20자 Windows 사용자 이름, 프로필 id 20자, 재시작 epoch 가 붙은 launch id.
const WORST_PRODUCTION_WORK_DIR = path.win32.join(
  'C:\\Users', 'u'.repeat(20), 'AppData\\Roaming\\HamaEditor\\launch-work', 'p'.repeat(20), `${'l'.repeat(36)}-r99`,
);
// Codex 0.164 가 홈에 두는 가장 긴 SQLite 파일 이름의 롤백 저널.
const LONGEST_CODEX_DB_JOURNAL = 'memories_1.sqlite-journal';
const WINDOWS_MAX_PATH = 260;

test('a hub window\'s Codex home leaves room for Codex SQLite journals under the Windows path limit', {
  timeout: 30_000,
}, async (t) => {
  const hub = await startHub(t, { prefix: 'rhwp-hub-record-paths-' });
  const sessionsRoot = path.join(hub.workRoot, 'sessions');
  for (const sessionId of ['window-1', 'w'.repeat(128)]) {
    await registerHubSession({ port: hub.port, token: HUB_TEST_TOKEN, launchId: HUB_TEST_LAUNCH_ID, sessionId });
  }
  const records = readdirSync(sessionsRoot);
  assert.equal(records.length, 2, 'each window gets its own record folder');
  assert.notEqual(records[0], records[1]);
  for (const record of records) {
    const codexHome = path.join(sessionsRoot, record, 'home', '.codex');
    assert.ok(existsSync(codexHome), `the hub prepared ${codexHome}`);
    const relative = path.relative(hub.workRoot, codexHome).split(path.sep);
    const journal = path.win32.join(WORST_PRODUCTION_WORK_DIR, ...relative, LONGEST_CODEX_DB_JOURNAL);
    // MAX_PATH 는 끝의 NUL 을 포함한다.
    assert.ok(journal.length < WINDOWS_MAX_PATH, `${journal.length} chars: ${journal}`);
  }
});
