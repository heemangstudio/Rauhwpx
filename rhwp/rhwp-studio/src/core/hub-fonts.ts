/**
 * 로컬 에이전트 허브가 내주는 글꼴 색인 host.
 *
 * 허브는 데스크톱 앱과 같은 색인기로 자기 PC의 OS·Office·한컴 글꼴을 훑는다. 브라우저는
 * 폴더 선택이나 권한 요청 없이 그 색인을 받아 데스크톱과 같은 매칭·등록 경로를 쓴다.
 * 허브가 원격 PC에서 돌면 그 PC의 글꼴이므로, 설치 글꼴 전체를 다룬다고 보지 않는다.
 */
import type { SystemFontHost, SystemFontIndex } from './desktop-fonts.ts';

export interface HubFontAccessLike {
  baseUrl: string;
  sessionId: string;
  token: string;
}

export interface HubFontHostOptions {
  /** 허브 세션이 준비되면 주소와 capability를 돌려준다. 준비 전에는 null. */
  access: () => HubFontAccessLike | null;
  /** 세션 준비를 기다리는 최대 시간 */
  waitMs?: number;
  fetch?: typeof fetch;
}

const DEFAULT_WAIT_MS = 4000;
const POLL_MS = 100;

function isLoopbackUrl(baseUrl: string): boolean {
  try {
    const host = new URL(baseUrl).hostname.replace(/^\[|\]$/g, '');
    return host === '127.0.0.1' || host === 'localhost' || host === '::1';
  } catch {
    return false;
  }
}

async function waitForAccess(options: HubFontHostOptions): Promise<HubFontAccessLike> {
  const deadline = Date.now() + (options.waitMs ?? DEFAULT_WAIT_MS);
  for (;;) {
    const access = options.access();
    if (access) return access;
    if (Date.now() >= deadline) throw new Error('agent hub session is not ready');
    await new Promise(resolve => setTimeout(resolve, POLL_MS));
  }
}

function fontUrl(access: HubFontAccessLike, pathname: string, params: Record<string, string> = {}): string {
  const url = new URL(pathname, `${access.baseUrl}/`);
  url.searchParams.set('sessionId', access.sessionId);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return url.toString();
}

export function createHubFontHost(options: HubFontHostOptions): SystemFontHost {
  const doFetch = options.fetch ?? ((input, init) => fetch(input, init));
  const request = async (pathname: string, params?: Record<string, string>): Promise<Response> => {
    const access = await waitForAccess(options);
    const response = await doFetch(fontUrl(access, pathname, params), {
      headers: { Authorization: `Bearer ${access.token}` },
      cache: 'no-store',
    });
    if (!response.ok) {
      // 409는 색인 뒤 파일이 바뀐 경우다. 'stale'로 알려 다음 준비 때 색인을 다시 받게 한다.
      throw new Error(response.status === 409
        ? `stale: agent hub font ${pathname}`
        : `agent hub fonts ${pathname}: HTTP ${response.status}`);
    }
    return response;
  };
  const host: SystemFontHost = {
    kind: 'hub',
    // 처음 주소를 받기 전에는 로컬로 본다. list()가 끝나면 실제 주소로 바로잡는다.
    coversSystem: true,
    async list(listOptions = {}) {
      const response = await request('/fonts/index', listOptions.refresh ? { refresh: '1' } : undefined);
      const index = await response.json() as SystemFontIndex;
      const access = options.access();
      host.coversSystem = access ? isLoopbackUrl(access.baseUrl) : false;
      return index;
    },
    async read(id) {
      const response = await request(`/fonts/faces/${encodeURIComponent(id)}`);
      return new Uint8Array(await response.arrayBuffer());
    },
  };
  return host;
}
