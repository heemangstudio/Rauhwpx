import type { AgentEditLock } from './agent-prefs.ts';
import type { AgentEditingLease, AgentName, AgentPhase, AgentWorkflow } from './types.ts';

export interface AgentEditingActivity {
  turnRunning: boolean;
  activeToolRequests: number;
  agent: AgentName;
  workflow?: AgentWorkflow;
  phase?: AgentPhase;
  waitingForUser?: boolean;
  /** 사용자 편집을 막는 방식(설정). 없으면 always — 일하는 내내 막는다. */
  editLock?: AgentEditLock;
  /** 문서 쓰기 도구가 도는 중이거나, 마지막 쓰기 뒤 editLock 초가 아직 지나지 않았다. */
  editing?: boolean;
}

/**
 * 바로 실행과 승인 후 구현은 사용자 편집을 잠그고, 구상·질문·승인 대기 중에는
 * 사용자가 문서를 계속 고칠 수 있다. switching 은 실행 전환 창이라 잠근다.
 */
export function planModeAllowsUserEditing(
  workflow: AgentWorkflow | undefined,
  phase: AgentPhase | undefined,
): boolean {
  return workflow === 'question'
    || (workflow === 'plan' && (phase === 'planning' || phase === 'awaiting-approval'));
}

/**
 * 문서를 쓰는 단계(에이전트·전체·승인된 계획 실행)에서 언제 사용자 편집을 막는지는 설정이 정한다 — always 는 일하는
 * 내내, 초를 고르면 에이전트가 문서를 고치는 동안과 그 뒤 그 초만큼, off 는 막지 않는다. 대화만 하는 동안은 막지 않는다.
 */
export function deriveAgentEditingLease(activity: AgentEditingActivity): AgentEditingLease {
  const busy = activity.turnRunning || activity.activeToolRequests > 0;
  const switching = activity.workflow === 'plan' && activity.phase === 'switching';
  const writing = busy && !planModeAllowsUserEditing(activity.workflow, activity.phase);
  const lock = activity.editLock ?? 'always';
  const locked = lock === 'always' ? writing : lock !== 'off' && writing && activity.editing === true;
  return {
    active: switching || locked,
    agent: activity.agent,
    ...(activity.waitingForUser === true ? { waitingForUser: true } : {}),
  };
}

