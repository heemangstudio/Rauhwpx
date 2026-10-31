import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  NSIS_INSTALL_GUID,
  handleStrayUpdateCopy,
  installedExecutable,
  isStrayUpdateCopy,
  parseInstallLocation,
  repairStrayShortcuts,
  shortcutFolders,
} from '../desktop/update-stray-copy.mjs';

const STRAY = 'C:\\Users\\tester\\AppData\\Local\\Temp\\nsf83C2.tmp\\old-install\\HamaEditor.exe';
const INSTALLED = 'C:\\Users\\tester\\AppData\\Local\\Programs\\HamaEditor\\HamaEditor.exe';

test('only a packaged Windows app running from the NSIS uninstaller temp copy counts as stray', () => {
  assert.equal(isStrayUpdateCopy(STRAY, { platform: 'win32', packaged: true }), true);
  assert.equal(isStrayUpdateCopy(STRAY.toLowerCase(), { platform: 'win32', packaged: true }), true);
  assert.equal(isStrayUpdateCopy(INSTALLED, { platform: 'win32', packaged: true }), false);
  assert.equal(isStrayUpdateCopy('D:\\Apps\\old-install\\HamaEditor.exe', { platform: 'win32', packaged: true }), false);
  assert.equal(isStrayUpdateCopy(STRAY, { platform: 'win32', packaged: false }), false);
  assert.equal(isStrayUpdateCopy('/tmp/nsf83C2.tmp/old-install/HamaEditor', { platform: 'darwin', packaged: true }), false);
});

test('the installer GUID the app looks up is the one electron-builder writes', () => {
  const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(NSIS_INSTALL_GUID, packageJson.build.nsis.guid);
});

test('the install location is read from reg query output and a stray path is never returned', async () => {
  const output = `\r\nHKEY_CURRENT_USER\\Software\\${NSIS_INSTALL_GUID}\r\n    InstallLocation    REG_SZ    C:\\Users\\tester\\AppData\\Local\\Programs\\HamaEditor\r\n\r\n`;
  assert.equal(parseInstallLocation(output), 'C:\\Users\\tester\\AppData\\Local\\Programs\\HamaEditor');
  assert.equal(parseInstallLocation('ERROR: The system was unable to find the specified registry key or value.'), null);

  const queried = [];
  const execFileImpl = (_file, args, _options, callback) => {
    queried.push(args[1]);
    if (args[1].startsWith('HKCU')) callback(null, output);
    else callback(new Error('missing'));
  };
  assert.equal(await installedExecutable('HamaEditor.exe', { execFileImpl, exists: (file) => file === INSTALLED, systemRoot: 'C:\\Windows' }), INSTALLED);
  assert.equal(await installedExecutable('HamaEditor.exe', { execFileImpl, exists: () => false, systemRoot: 'C:\\Windows' }), null);
  // 사용자별 설치가 없으면 모든 사용자 설치를 본다.
  assert.equal(queried.at(-1), `HKLM\\Software\\${NSIS_INSTALL_GUID}`);
});

test('the installed app points its own shortcuts that an interrupted update rewrote back at itself', async () => {
  const links = new Map([
    ['C:\\pins\\HamaEditor.lnk', { target: STRAY }],
    ['C:\\pins\\Other.lnk', { target: 'C:\\Users\\tester\\AppData\\Local\\Temp\\nsa1.tmp\\old-install\\Other.exe' }],
    ['C:\\menu\\HamaEditor.lnk', { target: INSTALLED }],
  ]);
  const written = [];
  const shell = {
    readShortcutLink: (file) => {
      if (!links.has(file)) throw new Error('not a shortcut');
      return links.get(file);
    },
    writeShortcutLink: (file, operation, options) => { written.push({ file, operation, options }); return true; },
  };
  const readdirImpl = async (folder) => {
    if (folder === 'C:\\missing') throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    return [...links.keys()].filter((file) => file.startsWith(`${folder}\\`)).map((file) => file.slice(folder.length + 1)).concat(['notes.txt']);
  };
  const repaired = await repairStrayShortcuts({
    shell, execPath: INSTALLED, folders: ['C:\\pins', 'C:\\menu', 'C:\\missing'], readdirImpl, platform: 'win32',
  });
  assert.deepEqual(repaired, ['C:\\pins\\HamaEditor.lnk']);
  assert.deepEqual(written, [{
    file: 'C:\\pins\\HamaEditor.lnk',
    operation: 'update',
    options: { target: INSTALLED, cwd: 'C:\\Users\\tester\\AppData\\Local\\Programs\\HamaEditor', icon: INSTALLED, iconIndex: 0 },
  }]);
  // 임시 사본으로 뜬 앱은 바로가기를 자기에게 돌리지 않는다.
  assert.deepEqual(await repairStrayShortcuts({ shell, execPath: STRAY, folders: ['C:\\pins'], readdirImpl, platform: 'win32' }), []);
  assert.deepEqual(shortcutFolders({ appData: 'C:\\Users\\tester\\AppData\\Roaming', desktop: 'C:\\Users\\tester\\Desktop' }), [
    'C:\\Users\\tester\\AppData\\Roaming\\Microsoft\\Internet Explorer\\Quick Launch\\User Pinned\\TaskBar',
    'C:\\Users\\tester\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs',
    'C:\\Users\\tester\\Desktop',
  ]);
});

function fakeElectron(response) {
  const calls = { exits: [], dialogs: [], opened: [], spawned: [] };
  return {
    calls,
    app: { exit: (code) => calls.exits.push(code) },
    dialog: { showMessageBox: async (options) => { calls.dialogs.push(options); return { response }; } },
    shell: { openExternal: async (url) => { calls.opened.push(url); } },
    spawnImpl: (file, args, options) => {
      calls.spawned.push({ file, args, options });
      return { on() {}, unref() {} };
    },
  };
}

test('a stray copy hands its documents to the installed app and exits without starting anything else', async () => {
  const electron = fakeElectron(0);
  await handleStrayUpdateCopy({
    ...electron,
    execPath: STRAY,
    documentPaths: ['C:\\Users\\tester\\Downloads\\a.hwpx'],
    productName: 'HamaEditor',
    releasesUrl: 'https://example.invalid/releases',
    log: { warn() {} },
    findInstalled: async () => INSTALLED,
  });
  assert.equal(electron.calls.dialogs.length, 1);
  assert.match(electron.calls.dialogs[0].message, /임시 폴더/);
  assert.deepEqual(electron.calls.spawned.map(({ file, args }) => ({ file, args })), [{ file: INSTALLED, args: ['C:\\Users\\tester\\Downloads\\a.hwpx'] }]);
  assert.equal(electron.calls.spawned[0].options.detached, true);
  assert.deepEqual(electron.calls.exits, [0]);
});

test('without an installed copy the stray copy offers the download page, and closing just exits', async () => {
  const download = fakeElectron(0);
  await handleStrayUpdateCopy({
    ...download, execPath: STRAY, productName: 'HamaEditor', releasesUrl: 'https://example.invalid/releases',
    log: { warn() {} }, findInstalled: async () => null,
  });
  assert.deepEqual(download.calls.opened, ['https://example.invalid/releases']);
  assert.deepEqual(download.calls.exits, [0]);

  const closed = fakeElectron(1);
  await handleStrayUpdateCopy({
    ...closed, execPath: STRAY, productName: 'HamaEditor', releasesUrl: 'https://example.invalid/releases',
    log: { warn() {} }, findInstalled: async () => INSTALLED,
  });
  assert.deepEqual(closed.calls.spawned, []);
  assert.deepEqual(closed.calls.opened, []);
  assert.deepEqual(closed.calls.exits, [0]);
});
