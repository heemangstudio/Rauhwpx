import './version-merge-preparation.css';

export type MergePreparation =
  | { kind: 'cancel' | 'stash' | 'commit' }
  | { kind: 'branch'; name: string };

/** Native modal keeps keyboard focus and document input inside this decision. */
export function prepareUncommittedMerge(currentBranch: string): Promise<MergePreparation> {
  return new Promise((resolve) => {
    const copy = {
      title: '병합 전 내 변경 보관',
      lead: '아직 커밋하지 않은 변경이 있습니다. 보관 방법을 선택하세요.',
      stash: ['잠시 보관 (stash)', '병합한 뒤 보관한 변경을 다시 적용할 수 있습니다.'],
      commit: ['현재 브랜치에 커밋', `${currentBranch}에 커밋하고 충돌을 검토합니다.`],
      branch: ['새 브랜치에 커밋', '내 변경은 새 브랜치에 남고, 문서는 마지막 커밋으로 돌아간 뒤 병합합니다.'],
    };
    const dialog = document.createElement('dialog');
    dialog.className = 'version-merge-preparation';
    dialog.setAttribute('aria-labelledby', 'version-merge-preparation-title');
    const form = document.createElement('form');
    form.innerHTML = `
      <h2 id="version-merge-preparation-title"></h2>
      <p class="version-merge-lead"></p>
      <label><input type="radio" name="choice" value="stash" checked><span><span class="version-merge-option"></span><small></small></span></label>
      <label><input type="radio" name="choice" value="commit"><span><span class="version-merge-option"></span><small></small></span></label>
      <label><input type="radio" name="choice" value="branch"><span><span class="version-merge-option"></span><small></small></span></label>
      <input class="version-merge-branch-name" aria-label="새 브랜치 이름" placeholder="새 브랜치 이름" maxlength="64" hidden>
      <footer><button type="button" data-choice="cancel">취소</button><button type="submit">계속</button></footer>`;
    form.querySelector('h2')!.textContent = copy.title;
    form.querySelector('.version-merge-lead')!.textContent = copy.lead;
    for (const kind of ['stash', 'commit', 'branch'] as const) {
      const option = form.querySelector(`input[value="${kind}"] + span`)!;
      option.querySelector('.version-merge-option')!.textContent = copy[kind][0];
      option.querySelector('small')!.textContent = copy[kind][1];
    }
    const branchInput = form.querySelector<HTMLInputElement>('.version-merge-branch-name')!;
    const choice = () => form.querySelector<HTMLInputElement>('input[name="choice"]:checked')!.value;
    form.addEventListener('change', () => {
      branchInput.hidden = choice() !== 'branch';
      branchInput.required = !branchInput.hidden;
      if (!branchInput.hidden) branchInput.focus();
    });
    let settled = false;
    const finish = (result: MergePreparation) => {
      if (settled) return;
      settled = true;
      dialog.close();
      dialog.remove();
      resolve(result);
    };
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const kind = choice();
      if (kind === 'branch') {
        if (!branchInput.value.trim()) return branchInput.focus();
        finish({ kind, name: branchInput.value.trim() });
      } else if (kind === 'stash' || kind === 'commit') finish({ kind });
    });
    form.querySelector('[data-choice="cancel"]')!.addEventListener('click', () => finish({ kind: 'cancel' }));
    dialog.addEventListener('cancel', (event) => { event.preventDefault(); finish({ kind: 'cancel' }); });
    dialog.addEventListener('close', () => finish({ kind: 'cancel' }));
    dialog.append(form);
    document.body.append(dialog);
    dialog.showModal();
  });
}
