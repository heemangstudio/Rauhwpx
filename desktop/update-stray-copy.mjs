import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { win32 } from 'node:path';

/**
 * Windows 업데이트의 NSIS 제거기는 예전 설치 파일을 %TEMP%\nsXXXX.tmp\old-install 로 옮긴 뒤 지운다. 그사이
 * 작업 표시줄·시작 메뉴 바로가기로 앱을 열면 Windows 바로가기 추적이 옮겨진 실행 파일을 찾아 그 사본을
 * 띄운다. 사본은 곧 app-update.yml 과 허브 스크립트 같은 파일을 잃고(ENOENT, ERR_MODULE_NOT_FOUND), 단일
 * 인스턴스 잠금까지 쥐어 새로 설치된 앱의 실행을 가로챈다.
 */
const STRAY_COPY_PATH = /[\\/]ns[0-9a-z]+\.tmp[\\/]old-install[\\/]/i;

/** NSIS 가 설치 위치를 적는 레지스트리 키(package.json build.nsis.guid). */
export const NSIS_INSTALL_GUID = '8adf5bd4-cca1-56f0-a142-1db539378c33';

export function isStrayUpdateCopy(execPath, { platform = process.platform, packaged = true } = {}) {
  return packaged && platform === 'win32' && STRAY_COPY_PATH.test(String(execPath ?? ''));
}

/**
 * 업데이트 중에 연 바로가기는 Windows 바로가기 추적이 임시 사본 경로로 고쳐 쓴다. 설치 프로그램은 시작 메뉴·바탕
 * 화면 바로가기를 되돌리지만(build/installer.nsh) 작업 표시줄에 고정한 바로가기는 모른다. 설치된 앱이 뜰 때
 * 이 앱의 실행 파일 이름을 가리키는 그런 바로가기를 지금 실행 파일로 되돌린다. 고친 바로가기 경로를 돌려준다.
 */
export async function repairStrayShortcuts({
  shell,
  execPath = process.execPath,
  folders = [],
  readdirImpl = readdir,
  platform = process.platform,
}) {
  if (platform !== 'win32' || isStrayUpdateCopy(execPath, { platform })) return [];
  const exeName = win32.basename(execPath).toLowerCase();
  const repaired = [];
  for (const folder of folders) {
    let names = [];
    try {
      names = await readdirImpl(folder);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!/\.lnk$/i.test(name)) continue;
      const link = win32.join(folder, name);
      let details;
      try {
        details = shell.readShortcutLink(link);
      } catch {
        continue;
      }
      const target = String(details?.target ?? '');
      if (!STRAY_COPY_PATH.test(target) || win32.basename(target).toLowerCase() !== exeName) continue;
      if (shell.writeShortcutLink(link, 'update', { target: execPath, cwd: win32.dirname(execPath), icon: execPath, iconIndex: 0 })) {
        repaired.push(link);
      }
    }
  }
  return repaired;
}

/** 이 앱의 바로가기가 놓이는 폴더: 작업 표시줄 고정, 시작 메뉴, 바탕 화면. */
export function shortcutFolders({ appData, desktop }) {
  return [
    win32.join(appData, 'Microsoft', 'Internet Explorer', 'Quick Launch', 'User Pinned', 'TaskBar'),
    win32.join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
    desktop,
  ].filter(Boolean);
}

/** `reg query` 출력에서 InstallLocation 값을 꺼낸다. */
export function parseInstallLocation(output) {
  const match = /^\s*InstallLocation\s+REG_(?:EXPAND_)?SZ\s+(.+?)\s*$/im.exec(String(output ?? ''));
  return match ? match[1] : null;
}

function queryInstallLocation(root, { systemRoot, execFileImpl }) {
  const reg = systemRoot ? win32.join(systemRoot, 'System32', 'reg.exe') : 'reg.exe';
  return new Promise((resolve) => {
    execFileImpl(reg, ['query', `${root}\\Software\\${NSIS_INSTALL_GUID}`, '/v', 'InstallLocation'], {
      windowsHide: true,
      timeout: 5000,
    }, (error, stdout) => resolve(error ? null : parseInstallLocation(stdout)));
  });
}

/** 지금 설치된 앱의 실행 파일. 사용자별 설치를 먼저 보고, 모든 사용자 설치를 본다. 없으면 null. */
export async function installedExecutable(exeName, {
  systemRoot = process.env.SystemRoot ?? process.env.WINDIR,
  execFileImpl = execFile,
  exists = existsSync,
  strayExecPath = '',
} = {}) {
  for (const root of ['HKCU', 'HKLM']) {
    const location = await queryInstallLocation(root, { systemRoot, execFileImpl });
    if (!location) continue;
    const candidate = win32.join(location, exeName);
    if (!STRAY_COPY_PATH.test(candidate) && candidate.toLowerCase() !== String(strayExecPath).toLowerCase() && exists(candidate)) {
      return candidate;
    }
  }
  return null;
}

/**
 * 임시 사본으로 떴다. 허브·업데이트·창을 시작하지 않고 알린 뒤 끝낸다. 설치된 앱이 있으면 같은 문서를
 * 넘겨 그 앱을 연다(설치가 아직 끝나지 않았으면 설치 프로그램이 끝에 새 버전을 연다).
 */
export async function handleStrayUpdateCopy({
  app,
  dialog,
  shell,
  execPath = process.execPath,
  documentPaths = [],
  productName,
  releasesUrl,
  log = console,
  findInstalled = (exeName) => installedExecutable(exeName, { strayExecPath: execPath }),
  spawnImpl = spawn,
}) {
  const installed = await findInstalled(win32.basename(execPath)).catch(() => null);
  log.warn?.(`[hamaeditor] started from an interrupted update's temporary copy (${execPath}); installed copy: ${installed ?? 'none'}`);
  const buttons = installed ? [`${productName} 열기`, '닫기'] : ['내려받기 페이지 열기', '닫기'];
  const { response } = await dialog.showMessageBox({
    type: 'warning',
    title: productName,
    message: '업데이트를 마치지 못한 임시 폴더에서 열렸어요.',
    detail: installed
      ? `이 창은 곧 지워질 이전 버전의 임시 사본이라 저장과 AI 기능이 동작하지 않아요. 설치된 ${productName}를 열어 주세요. 업데이트가 아직 설치되는 중이면 끝난 뒤 새 버전이 열려요.`
      : `이 창은 곧 지워질 이전 버전의 임시 사본이에요. 설치된 ${productName}를 찾지 못했어요. 내려받기 페이지에서 다시 설치해 주세요.`,
    buttons,
    defaultId: 0,
    cancelId: 1,
    noLink: true,
  }).catch(() => ({ response: 1 }));
  if (response === 0) {
    try {
      if (installed) {
        const child = spawnImpl(installed, documentPaths, { detached: true, stdio: 'ignore', windowsHide: false });
        child.on?.('error', (error) => log.warn?.('[hamaeditor] could not open the installed copy:', error));
        child.unref?.();
      } else {
        await shell.openExternal(releasesUrl);
      }
    } catch (error) {
      log.warn?.('[hamaeditor] stray update copy recovery failed:', error);
    }
  }
  app.exit(0);
}
