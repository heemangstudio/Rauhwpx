/**
 * requestId 로 짝을 맞추는 요청/응답 대기표.
 *
 * 허브 응답은 언제든 오지 않을 수 있으므로(허브 재시작·CLI 실패) 모든
 * 대기는 타임아웃을 갖고 null 로 안착한다 — 던지지 않는다. 사이드바가
 * `await` 한 값이 null 이면 "지금은 알 수 없다"는 뜻이다.
 *
 * bridge.ts 는 WebSocket·DOM 에 묶여 있어 Node 테스트에서 인스턴스화할 수
 * 없으므로, 짝 맞추기 규칙만 이 모듈로 떼어 직접 검증한다. 답을 잃은 뒤의
 * 처리(설치 답이 없을 때의 판단, 끊긴 동안 놓친 로그인 터미널 다시 받기)도 여기 둔다.
 */
import type { AgentName, AgentSetupStatus } from './types.ts';

interface PendingEntry {
  settle: (value: unknown) => void;
  timer: ReturnType<typeof setTimeout> | null;
  timeoutMs: number;
}

export class PendingRequestRegistry {
  private entries = new Map<string, PendingEntry>();

  /** 대기 중인 요청 수 (테스트·누수 확인용). */
  get size(): number {
    return this.entries.size;
  }

  /**
   * requestId 하나를 대기표에 올린다. timeoutMs 안에 settle 되지 않으면
   * null 로 안착한다. 같은 requestId 가 이미 있으면 앞의 대기는 null 로 닫는다.
   */
  create<T>(requestId: string, timeoutMs: number): Promise<T | null> {
    this.settle(requestId, null);
    return new Promise<T | null>((resolve) => {
      const entry: PendingEntry = {
        settle: (value: unknown) => resolve(value as T | null),
        timer: null,
        timeoutMs,
      };
      this.entries.set(requestId, entry);
      this.arm(requestId, entry);
    });
  }

  /**
   * 허브가 아직 이 요청을 처리하고 있다는 신호(진행 프레임)를 받았다 — 타임아웃을 처음부터 다시 잰다.
   * 설치처럼 오래 걸리는 요청이 진행 중인데도 클라이언트 쪽에서 먼저 null 로 끝나지 않게 한다.
   * 모르는 requestId 면 false.
   */
  touch(requestId: string): boolean {
    const entry = this.entries.get(requestId);
    if (!entry) return false;
    this.arm(requestId, entry);
    return true;
  }

  private arm(requestId: string, entry: PendingEntry): void {
    if (entry.timer !== null) clearTimeout(entry.timer);
    entry.timer = null;
    if (entry.timeoutMs <= 0) return;
    entry.timer = setTimeout(() => {
      if (this.entries.get(requestId) !== entry) return;
      this.entries.delete(requestId);
      entry.settle(null);
    }, entry.timeoutMs);
  }

  /** 대기 중이면 값으로 안착시키고 true. 모르는 requestId 면 false. */
  settle(requestId: string, value: unknown): boolean {
    const entry = this.entries.get(requestId);
    if (!entry) return false;
    this.entries.delete(requestId);
    if (entry.timer !== null) clearTimeout(entry.timer);
    entry.settle(value);
    return true;
  }

  /** 연결이 끊기거나 dispose 될 때 — 모든 대기를 null 로 닫는다. */
  cancelAll(): void {
    const pending = [...this.entries.values()];
    this.entries.clear();
    for (const entry of pending) {
      if (entry.timer !== null) clearTimeout(entry.timer);
      entry.settle(null);
    }
  }
}

/**
 * 설치 요청이 답 없이(null) 끝났을 때, 다시 읽은 허브 상태로 실제 결과를 정한다. 시간 초과·끊김이면
 * 허브는 아직 설치 중이거나 이미 끝냈을 수 있다 — 그때 '설치 실패' 를 띄우면 곧 오는 완료 방송에 뒤집힌다.
 */
export function installOutcomeFromStatus(
  status: Pick<AgentSetupStatus, 'installing' | 'installed' | 'updateRequired'> | null | undefined,
): 'installing' | 'installed' | 'failed' {
  if (status?.installing === true) return 'installing';
  if (status?.installed === true && status.updateRequired !== true) return 'installed';
  return 'failed';
}

/**
 * 설정 창 로그인 터미널의 화면 다시 받기. 허브는 끊긴 동안의 터미널 프레임을 버린다 — 같은 로그인(authRunId)
 * 그대로 다시 붙으면 화면이 낡은 채 남으므로, 다음 상태에서 스냅샷(reset)을 한 번 다시 청한다.
 */
export class SetupTerminalResync {
  private stale = false;
  private readonly resume: (agent: AgentName, authRunId: string) => void;

  constructor(resume: (agent: AgentName, authRunId: string) => void) {
    this.resume = resume;
  }

  /** 연결 상태가 바뀌었다. 터미널 로그인이 열려 있는 동안 연결을 잃으면 다시 받을 표시를 한다. */
  connection(state: 'connecting' | 'connected' | 'disconnected' | 'replaced', terminalRunOpen: boolean): void {
    if (state !== 'connected' && terminalRunOpen) this.stale = true;
  }

  /**
   * 허브 상태가 이 창의 로그인이 살아 있다고 알렸다. 앞서 보던 로그인과 다르거나 끊겼다 다시 붙었으면
   * 화면을 다시 청한다. 청했으면 true.
   */
  sync(agent: AgentName, previousRunId: string | null, authRunId: string): boolean {
    if (previousRunId === authRunId && !this.stale) return false;
    this.stale = false;
    this.resume(agent, authRunId);
    return true;
  }

  /** 로그인 창을 닫았다 — 다음 로그인은 새로 시작한다. */
  reset(): void {
    this.stale = false;
  }
}
