/**
 * 저장 직렬화.
 *
 * 키보드 디스패치는 e.repeat 를 거르지 않고 async 커맨드를 기다리지 않으므로, Ctrl+S 를
 * 누르고 있거나 두 번 누르면 같은 파일 핸들에 쓰기가 겹친다. 먼저 만든 오래된 바이트가
 * 나중에 끝나 최신 저장을 덮을 수 있다. 저장은 한 번에 하나만 실행한다.
 *
 * - 일반 저장(Ctrl+S, 닫기 전 저장): 진행 중인 저장을 기다린다. 그 저장이 성공했고
 *   그사이 들어온 편집으로 문서가 아직 dirty 일 때만 한 번 더 저장한다. 기다리는 요청은
 *   모두 같은 후속 저장 하나를 공유한다.
 * - 대화상자가 필요한 저장(다른 이름으로, 형식 지정, 기록 포함): 진행 중이면 'busy'.
 */

export type SaveOutcome = 'saved' | 'cancelled' | 'failed' | 'unsupported';

export class SaveSession {
  private active: Promise<SaveOutcome> | null = null;
  private followUp: Promise<SaveOutcome> | null = null;

  /** 일반 저장. 진행 중인 저장이 있으면 합류하고, 필요할 때만 한 번 더 저장한다. */
  save(run: () => Promise<SaveOutcome>, isDirty: () => boolean): Promise<SaveOutcome> {
    if (!this.active) return this.start(run);
    if (!this.followUp) {
      this.followUp = (async () => {
        let previous: SaveOutcome = 'saved';
        // 기다리는 동안 다른 저장이 먼저 시작됐다면 그것까지 기다린다.
        while (this.active) previous = await this.active;
        this.followUp = null;
        // 취소·실패한 저장을 곧바로 다시 실행하면 대화상자·오류가 반복된다. 그 결과를 돌려준다.
        if (previous !== 'saved') return previous;
        if (!isDirty()) return 'saved';
        return this.start(run);
      })();
    }
    return this.followUp;
  }

  /** 다른 이름으로 저장처럼 사용자 선택이 필요한 저장. 진행 중인 저장이 있으면 실행하지 않는다. */
  exclusive(run: () => Promise<SaveOutcome>): Promise<SaveOutcome | 'busy'> {
    if (this.active) return Promise.resolve('busy');
    return this.start(run);
  }

  private start(run: () => Promise<SaveOutcome>): Promise<SaveOutcome> {
    // 예외가 나도 active 가 풀리도록 결과를 항상 SaveOutcome 으로 정리한다.
    const job: Promise<SaveOutcome> = Promise.resolve()
      .then(run)
      .catch((error: unknown) => {
        console.error('[save-session] 저장 실패:', error);
        return 'failed' as const;
      });
    const tracked = job.finally(() => {
      if (this.active === tracked) this.active = null;
    });
    this.active = tracked;
    return tracked;
  }
}
