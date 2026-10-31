/**
 * `?home=1`: 문서 홈을 표본 최근 문서로 띄운다. 첫 쪽 그림은 열린 문서처럼 캔버스로 그린 표본 종이다.
 * 위 막대의 Rau 입구는 `plan=` 의 요금제 대역을 따르고(Hama 요금제에만 보인다), 계정 단추는 `account=` 가 있을 때 선다.
 * 문서 열기·만들기 같은 동작은 보고만 한다.
 */
import { createDocumentHome, type DocumentHome } from '../home/document-home.ts';
import type { RecentDoc } from '../recent/recent-store.ts';
import type { DesktopLicenseApi } from '../ui/agent-sidebar/settings-license.ts';
import { mountAccountButton } from '../ui/account/account-button.ts';
import type { AccountStore } from '../ui/account/account-store.ts';
import { mountRauHomeEntry } from '../ui/plan/rau-home-entry.ts';
import type { PlanStore } from '../ui/plan/plan-store.ts';
import { openPlanCard } from '../ui/plan/upgrade-card.ts';
import { sampleRecentDocuments } from './fixtures.ts';

/** 제목 한 줄과 본문 줄이 있는 A4 첫 쪽. 문서마다 줄 길이를 조금씩 달리한다. */
async function samplePage(seed: number): Promise<Blob | null> {
  const canvas = document.createElement('canvas');
  canvas.width = 420;
  canvas.height = 594;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#2b3038';
  ctx.fillRect(56, 70, 150 + (seed % 3) * 40, 14);
  ctx.fillStyle = '#c3c8cf';
  let y = 116;
  for (let line = 0; line < 22; line += 1) {
    if (line % 7 === 6) { y += 14; continue; }
    const width = line % 7 === 5 ? 120 + ((seed + line) % 4) * 30 : 308 - ((seed * 7 + line * 13) % 30);
    ctx.fillRect(56, y, width, 6);
    y += 17;
  }
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
}

export function mountHomeScene(options: {
  plan: PlanStore | null;
  license: DesktopLicenseApi | null;
  account: AccountStore | null;
  report: (message: string) => void;
}): DocumentHome {
  const now = Date.now();
  const rows: RecentDoc[] = sampleRecentDocuments(now).map((doc) => ({
    id: doc.documentId,
    documentId: doc.documentId,
    sourceDigest: `sha256:${doc.documentId}`,
    fileName: doc.fileName,
    sourceFormat: doc.sourceFormat,
    openedAt: doc.openedAt,
  }));
  const live = new Set(rows.map((row) => row.documentId));
  const { report, plan, license, account } = options;
  const home = createDocumentHome({
    listRecent: async () => rows,
    loadWorktrees: async () => ({ trees: [], colorOf: () => '#62b3e2' }),
    listTemplates: async () => [],
    templateBytes: async () => new Uint8Array(),
    liveDocumentIds: () => live,
    liveThumbnail: (documentId) => samplePage(rows.findIndex((row) => row.documentId === documentId)),
    whenIdle: async () => {},
    createBlank: () => report('New document placeholder'),
    createFromTemplate: async () => report('Template placeholder'),
    openFile: () => report('File picker placeholder'),
    openDocument: async () => { report('Open document placeholder'); return 'cancelled'; },
    openWorktree: async () => {},
    canRename: () => false,
    renameDocument: async () => null,
    returnTarget: () => null,
    restoreFocus: () => {},
    openSettings: () => report('Settings placeholder'),
    newChat: () => report('New chat placeholder'),
    mountTopbarTrailing: (slot) => {
      if (plan) mountRauHomeEntry(slot, { store: plan, open: () => { openPlanCard({ store: plan, license, focus: 'rau' }); } });
      if (account) mountAccountButton(slot, { store: account, plan });
    },
    toast: report,
  });
  home.show({ focus: false, instant: true });
  return home;
}
