// 앱이 싣고 다니는 Pi 리소스의 단일 출처. 부모와 하위 에이전트 스폰이 모두 이 플래그를 쓴다.
//
// 확장과 스킬은 앱 번들 안(asarUnpacked)의 이 파일 옆에 있다. 매 스폰마다 경로를 명시적으로 넘기고,
// 사용자의 Pi 설정(~/.pi/agent, ~/.agents/skills, 프로젝트 .pi/, AGENTS.md/CLAUDE.md, Pi 내장 확장)과
// 예전 허브가 데이터 폴더에 남긴 파일은 하나도 읽지 않는다.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PI_DIR = path.dirname(fileURLToPath(import.meta.url));

export const PI_EXTENSION_PATH = path.join(PI_DIR, 'extension', 'rhwp.ts');
export const PI_SUBAGENT_EXTENSION_PATH = path.join(PI_DIR, 'extension', 'subagents.ts');
export const PI_SKILLS_DIR = path.join(PI_DIR, 'skills');

/** 번들 리소스만 싣는 pi 인자. --no-extensions 는 설정의 extensions 와 내장 확장(mcp 등)을 끄고 -e 만 남긴다. */
export function piResourceArgs() {
  return [
    '--no-extensions',
    '-e', PI_EXTENSION_PATH,
    '-e', PI_SUBAGENT_EXTENSION_PATH,
    '--no-skills',
    '--skill', PI_SKILLS_DIR,
    '--no-prompt-templates',
    '--no-themes',
    '--no-context-files',
    // 프로젝트 로컬 파일(.pi/settings.json, .pi/extensions, .pi/SYSTEM.md 등)을 이번 실행에서 무시한다.
    '--no-approve',
  ];
}
