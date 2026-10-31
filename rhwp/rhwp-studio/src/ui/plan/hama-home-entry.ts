// 문서 홈 위 막대의 Hama 입구. Pro·기존 라이선스에만 보인다(무료는 입력기의 ↑, Hama 는 이미 쓰는 중).
// 누르면 요금제 카드를 Hama 칸에 맞춰 연다. 결제가 아직 열리지 않았으면 '곧 출시'를 조용히 붙인다.
import './hama-home-entry.css';
import { createHamaMark } from './hama-mark.ts';
import { showsHamaHomeEntry, type PlanStore } from './plan-store.ts';

export function mountHamaHomeEntry(
  slot: HTMLElement,
  { store, open }: { store: PlanStore; open: () => void },
): () => void {
  const entry = document.createElement('button');
  entry.type = 'button';
  entry.className = 'plan-hama-entry';
  entry.hidden = true;
  const name = document.createElement('span');
  name.className = 'plan-hama-name';
  name.textContent = 'Hama';
  const line = document.createElement('span');
  line.className = 'plan-hama-line';
  line.textContent = '문서를 맡겨 보세요';
  const soon = document.createElement('span');
  soon.className = 'plan-hama-soon';
  soon.textContent = '곧 출시';
  entry.append(createHamaMark('plan-hama-mark'), name, line, soon);
  entry.addEventListener('click', open);
  slot.prepend(entry);

  const sync = (): void => {
    const status = store.status();
    entry.hidden = !showsHamaHomeEntry(status);
    soon.hidden = status?.checkout.hamaMonthly.available === true;
    entry.setAttribute('aria-label', soon.hidden ? 'Hama 요금제 보기' : 'Hama 요금제 보기, 곧 출시');
  };
  sync();
  const unsubscribe = store.subscribe(sync);
  return () => {
    unsubscribe();
    entry.remove();
  };
}
