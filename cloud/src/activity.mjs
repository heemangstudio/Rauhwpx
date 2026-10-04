import { closeSync, openSync, rmSync, statSync, utimesSync } from 'node:fs';
import path from 'node:path';
import { ROOM_PROTOCOL_VERSION } from './protocol.mjs';

export const ACTIVITY_STAMP_FILENAME = 'activity.stamp';
const STAMP_THROTTLE_MS = 30_000;
// 청크 사이가 이보다 길면 멈춘 업로드다. 버려진 업로드가 하루 동안 서버를 붙잡으면 안 된다.
const ACTIVE_UPLOAD_WINDOW_MS = 5 * 60 * 1000;
// 워커가 살아 있어도 사용자의 다음 메시지나 결정만 기다리는 단계다. 사용자를 오래 기다리는
// 대화가 호스트를 계속 붙잡지 않도록 유휴로 본다. 호스트가 멈췄다 다시 켜지면
// recoverInterruptedSessions가 다음 메시지를 기다리던 대화는 다시 줄 세우고, 결정을 기다리던
// 턴은 WORKER_REPLACED_UNCERTAIN으로 멈춰 검토 뒤 재개하게 한다.
const USER_WAIT_PHASES = Object.freeze([
  'idle',
  'awaiting-plan-approval',
  'awaiting-question-answer',
  'awaiting-external-effect-approval',
]);

/** 마지막 활동 시각을 `<dataDir>/activity.stamp`의 mtime으로만 남긴다. */
export class ActivityStamp {
  #lastTouchedAt = -Infinity;

  constructor(dataDirectory, { now = Date.now, throttleMs = STAMP_THROTTLE_MS } = {}) {
    this.filename = path.join(dataDirectory, ACTIVITY_STAMP_FILENAME);
    this.now = now;
    this.throttleMs = throttleMs;
  }

  touch() {
    const now = this.now();
    if (now - this.#lastTouchedAt < this.throttleMs) return false;
    this.#lastTouchedAt = now;
    const time = new Date(now);
    try {
      utimesSync(this.filename, time, time);
      return true;
    } catch (error) {
      try {
        // 시각을 직접 지정하는 utimes는 소유자만 할 수 있다. 다른 소유자의 파일은 다시 만든다.
        if (error.code !== 'ENOENT') rmSync(this.filename, { force: true });
        closeSync(openSync(this.filename, 'a', 0o600));
        utimesSync(this.filename, time, time);
        return true;
      } catch {
        // 활동 기록이 실패해도 요청이나 세션 전환은 계속되어야 한다.
        return false;
      }
    }
  }
}

export function readLastActivity(dataDirectory) {
  try {
    return new Date(statSync(path.join(dataDirectory, ACTIVITY_STAMP_FILENAME)).mtimeMs);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

/**
 * 호스트가 스스로 멈춰도 되는지 판단할 근거다. busy는 대기열의 세션, 일하는 중인
 * 세션(사용자 대기 단계가 아니거나 일시정지·인계·종료·절전·방향 전환·완료·설정 재시작
 * 요청이 걸린 세션, 대화형이 아닌 v1 세션 전부), 최근 청크를 받은 업로드 중 하나라도 있을 때다.
 */
export function idleReport(database, { dataDirectory, now = Date.now() }) {
  const phases = USER_WAIT_PHASES.map(() => '?').join(', ');
  const sessions = database.prepare(`
    SELECT
      COALESCE(SUM(status = 'queued'), 0) AS queued,
      COALESCE(SUM(status = 'running' AND (
        protocol_version <> ?
        OR execution_phase NOT IN (${phases})
        OR pause_requested_at IS NOT NULL OR takeover_requested_at IS NOT NULL
        OR end_requested_at IS NOT NULL OR sleep_requested_at IS NOT NULL
        OR redirect_requested_at IS NOT NULL OR finishing_at IS NOT NULL
        OR configuration_restart_requested_at IS NOT NULL
      )), 0) AS running
    FROM sessions
  `).get(ROOM_PROTOCOL_VERSION, ...USER_WAIT_PHASES);
  const uploads = database.prepare(`
    SELECT COUNT(*) AS count FROM uploads WHERE status = 'uploading' AND updated_at >= ?
  `).get(now - ACTIVE_UPLOAD_WINDOW_MS).count;
  const lastActivity = readLastActivity(dataDirectory);
  const runningSessions = Number(sessions.running);
  const queuedSessions = Number(sessions.queued);
  return {
    ok: true,
    busy: runningSessions > 0 || queuedSessions > 0 || uploads > 0,
    runningSessions,
    queuedSessions,
    activeUploads: uploads,
    lastActivityAt: lastActivity ? lastActivity.toISOString() : null,
    idleSeconds: lastActivity ? Math.max(0, Math.floor((now - lastActivity.getTime()) / 1000)) : 0,
  };
}
