// 문서 홈 위 막대의 Rau 입구. Hama 요금제에만 보인다(무료는 입력기의 잠금, Rau 는 이미 쓰는 중).
// 누르면 요금제 카드를 Rau 칸에 맞춰 연다. 결제가 아직 열리지 않았으면 '곧 출시'를 조용히 붙인다.
import './rau-home-entry.css';
import { showsRauHomeEntry, type PlanStore } from './plan-store.ts';

export function mountRauHomeEntry(
  slot: HTMLElement,
  { store, open }: { store: PlanStore; open: () => void },
): () => void {
  const entry = document.createElement('button');
  entry.type = 'button';
  entry.className = 'plan-rau-entry';
  entry.hidden = true;
  const mark = document.createElement('span');
  mark.className = 'plan-rau-mark';
  mark.setAttribute('aria-hidden', 'true');
  const name = document.createElement('span');
  name.className = 'plan-rau-name';
  name.textContent = 'Rau';
  const line = document.createElement('span');
  line.className = 'plan-rau-line';
  line.textContent = 'AI 포함 · Rau 모드';
  const soon = document.createElement('span');
  soon.className = 'plan-rau-soon';
  soon.textContent = '곧 출시';
  entry.append(mark, name, line, soon);
  entry.addEventListener('click', open);
  slot.prepend(entry);

  const sync = (): void => {
    const status = store.status();
    entry.hidden = !showsRauHomeEntry(status);
    soon.hidden = status?.checkout.rauMonthly?.available === true;
    entry.setAttribute('aria-label', soon.hidden ? 'Rau 요금제 보기' : 'Rau 요금제 보기, 곧 출시');
  };
  sync();
  const unsubscribe = store.subscribe(sync);
  return () => {
    unsubscribe();
    entry.remove();
  };
}
