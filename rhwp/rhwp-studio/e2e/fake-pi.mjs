/**
 * E2E 공용: 턴을 끝내지 않고 살아만 있는 가짜 Pi CLI.
 *
 * 허브가 Pi 를 설정 완료로 보게 하는 RHWP_PI_DIR 루트를 만든다. 사이드바의 개인 기본값을
 * Pi / mock-model 로 두면 첫 메시지가 이 프로세스로 가고, 허브의 턴은 열린 채로 남는다.
 * 호출한 쪽이 끝나면 반환된 루트를 지운다.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function prepareFakePi(prefix = 'rhwp-e2e-pi-') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const packageDir = path.join(root, 'prefix', 'node_modules', '@earendil-works', 'pi-coding-agent');
  const binDir = path.join(root, 'prefix', 'node_modules', '.bin');
  fs.mkdirSync(packageDir, { recursive: true });
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(path.join(packageDir, 'package.json'), JSON.stringify({ version: '0.0.0-e2e' }));
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({
    version: 1,
    installedVersion: '0.0.0-e2e',
    keyTail: null,
    models: [{
      id: 'mock-model', name: 'Mock model', reasoning: false, supportsImages: false,
      efforts: [], defaultEffort: null, contextLength: 8_192,
      pricing: { prompt: 0, completion: 0 },
    }],
    defaultModelId: 'mock-model',
    setupComplete: true,
  }));
  const agentDir = path.join(root, 'agent');
  fs.mkdirSync(agentDir, { recursive: true });
  fs.writeFileSync(path.join(agentDir, 'models.json'), JSON.stringify({
    providers: { openrouter: { apiKey: 'e2e-placeholder-key' } },
  }));
  const fake = path.join(binDir, process.platform === 'win32' ? 'pi.cmd' : 'pi');
  if (process.platform === 'win32') {
    fs.writeFileSync(fake, '@echo off\r\nnode -e "setInterval(() =^> {}, 1000)"\r\n');
  } else {
    fs.writeFileSync(fake, `#!/bin/sh\nexec "${process.execPath}" -e 'setInterval(() => {}, 1000)'\n`, { mode: 0o755 });
  }
  return root;
}

/** 새 채팅이 이 가짜 Pi 로 시작하도록 사이드바의 개인 기본값을 심는다. 다시 불러온 뒤부터 적용된다. */
export function seedFakePiPrefs(page) {
  return page.evaluate(() => localStorage.setItem('rhwp-agent-prefs', JSON.stringify({
    defaultAgent: 'pi', defaultModel: 'mock-model', defaultEffort: '', defaultMode: 'agent',
  })));
}
