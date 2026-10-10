import {
  consumeCaptureDrafts,
  listCaptureDrafts,
  removeCaptureDraft,
  type DocumentCaptureRecord,
  type DocumentCaptureDraft,
} from '../../agent/agent-context-store.ts';
import type { SidebarBridge } from '../../agent/bridge.ts';
import type { StagedReference } from '../../agent/types.ts';
import { stageInlineReferences } from './reference-library.ts';
import { createIcon } from './icons.ts';
import { listBrowserCaptureDrafts, removeBrowserCaptureDrafts, type BrowserCaptureDraft } from './browser-capture-store.ts';
type CaptureDraft = DocumentCaptureDraft | BrowserCaptureDraft;
function isBrowserDraft(draft: CaptureDraft): draft is BrowserCaptureDraft { return 'kind' in draft && draft.kind === 'browser'; }

export interface CaptureStaging {
  drafts: CaptureDraft[];
  files: StagedReference[];
  context: string;
  controller?: AbortController;
}

/** 문서별 로컬 받은함. 저장·복원은 네트워크를 쓰지 않고 일반 메시지 전송 때만 올린다. */
export function createCaptureInbox(options: {
  bridge: SidebarBridge;
  getContext(): { documentId: string | null; threadId: string };
  onChange(): void;
  onError(message: string): void;
}) {
  const root = document.createElement('div');
  root.className = 'ag-reference-quick-uploads ag-capture-inbox';
  root.setAttribute('aria-label', '저장한 선택 자료');
  let drafts: CaptureDraft[] = [];
  let revision = 0;
  let disposed = false;
  const pending = new Set<AbortController>();
  const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

  function render(): void {
    root.replaceChildren();
    for (const draft of drafts) {
      const chip = document.createElement('span');
      chip.className = 'ag-reference-upload-chip ag-ready ag-capture-pill';
      chip.dataset.captureId = draft.id;
      chip.title = draft.comment;
      const label = document.createElement('span');
      label.className = 'ag-reference-upload-chip-name';
      label.textContent = `${draft.label} · ${draft.comment.replace(/\s+/g, ' ').slice(0, 48)}`;
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'ag-reference-upload-remove';
      remove.setAttribute('aria-label', `${draft.label} 첨부 취소`);
      remove.appendChild(createIcon('close'));
      remove.addEventListener('click', () => {
        revision++;
        for (const controller of pending) controller.abort();
        remove.disabled = true;
        void (isBrowserDraft(draft) ? removeBrowserCaptureDrafts([draft.id]) : removeCaptureDraft(draft.id)).then(() => {
          if (disposed) return;
          drafts = drafts.filter((item) => item.id !== draft.id);
          render();
        }).catch((error) => {
          remove.disabled = false;
          options.onError(errorText(error));
        });
      });
      chip.append(createIcon('document'), label, remove);
      root.appendChild(chip);
    }
    root.hidden = drafts.length === 0;
    options.onChange();
  }

  async function contextChanged(): Promise<void> {
    const seq = ++revision;
    for (const controller of pending) controller.abort();
    drafts = [];
    render();
    const { documentId, threadId } = options.getContext();
    try {
      const [documentDrafts, browserDrafts] = await Promise.all([documentId ? listCaptureDrafts(documentId) : Promise.resolve([]), listBrowserCaptureDrafts(threadId)]);
      const saved: CaptureDraft[] = [...documentDrafts, ...browserDrafts];
      if (disposed || seq !== revision || documentId !== options.getContext().documentId || threadId !== options.getContext().threadId) return;
      drafts = [...new Map([...saved, ...drafts].map((draft) => [draft.id, draft])).values()];
      render();
    } catch (error) {
      if (!disposed && seq === revision) options.onError(errorText(error));
    }
  }

  function queue(draft: CaptureDraft): boolean {
    if (disposed || (isBrowserDraft(draft) ? draft.destination.threadId !== options.getContext().threadId : !draft.documentId || draft.documentId !== options.getContext().documentId)) return false;
    if (!drafts.some((item) => item.id === draft.id)) drafts.push(draft);
    render();
    return true;
  }

  async function discardStaging(staging: CaptureStaging): Promise<void> {
    if (staging.controller) pending.delete(staging.controller);
    await Promise.all(staging.files.map((file) => options.bridge.discardStagedReference(file.scopeId, file.id).catch(() => undefined)));
  }

  async function stage(ordinaryFileCount = 0, requestTextLength = 0): Promise<CaptureStaging> {
    const context = options.getContext();
    if (!drafts.length) return { drafts: [], files: [], context: '' };
    const seq = revision;
    const selectedIds = new Set(drafts.map((draft) => draft.id));
    const [documentDrafts, browserDrafts] = await Promise.all([context.documentId ? listCaptureDrafts(context.documentId) : Promise.resolve([]), listBrowserCaptureDrafts(context.threadId)]);
    const saved: CaptureDraft[] = [...documentDrafts, ...browserDrafts];
    if (disposed || seq !== revision || context.threadId !== options.getContext().threadId) {
      throw new Error('채팅이 바뀌었습니다. 자료를 다시 확인해 주세요.');
    }
    const selected = saved.filter((draft) => selectedIds.has(draft.id));
    if (selected.length !== selectedIds.size) throw new Error('저장한 자료가 바뀌었습니다. 첨부를 다시 확인해 주세요.');
    const imageName = (draft: CaptureDraft, name: string) => `${draft.id}-${name}`;
    const images = selected.flatMap((draft) => draft.files.filter((file) => file.type.startsWith('image/'))
      .map((file) => new File([file], imageName(draft, file.name), { type: file.type, lastModified: file.lastModified })));
    if (images.length + ordinaryFileCount + 1 > 10) {
      throw new Error('한 번에 파일 10개까지 보낼 수 있습니다. 이미지 첨부를 줄여 주세요.');
    }
    const recordName = `selection-comments-${selected[0].id}.json`;
    const rewriteContext = (draft: CaptureDraft, context: string): string => {
      for (const file of draft.files) {
        const name = file.type === 'application/json' ? recordName : imageName(draft, file.name);
        context = context.split(`첨부 파일 ${file.name}`).join(`첨부 파일 ${name}`);
      }
      return context;
    };
    const records = await Promise.all(selected.map(async (draft) => {
      const file = draft.files.find((entry) => entry.type === 'application/json');
      if (!file) throw new Error('선택 자료의 기록을 찾을 수 없습니다.');
      const record = JSON.parse(await file.text()) as DocumentCaptureRecord;
      if (isBrowserDraft(draft)) return { ...record, files: draft.files.filter((entry) => entry.type.startsWith('image/')).map((entry) => ({ name: imageName(draft, entry.name), mimeType: entry.type })) };
      return {
        ...record,
        files: record.files.map((file) => ({ ...file, name: imageName(draft, file.name) })),
        selection: {
          ...record.selection,
          contextBlock: rewriteContext(draft, record.selection.contextBlock),
          items: record.selection.items.map((item) => {
            if (item.kind !== 'object' && item.kind !== 'equation' && item.kind !== 'screenshot') return item;
            return { ...item,
              ...(item.attachmentName ? { attachmentName: imageName(draft, item.attachmentName) } : {}),
              ...(item.kind === 'screenshot' ? { recordAttachmentName: recordName } : {}),
            };
          }),
        },
      };
    }));
    const recordFile = new File([JSON.stringify({ schemaVersion: 1, captures: records }, null, 2)], recordName, { type: 'application/json' });
    const captureContext = selected.map((draft) => {
      const contextBlock = isBrowserDraft(draft)
        ? `[브라우저 자료]
${draft.source.title}
${draft.source.url}
탭 ${draft.source.tabId} · 탐색 ${draft.source.navigationEpoch}
${JSON.stringify(draft.evidence)}
${draft.files.filter((file) => file.type.startsWith('image/')).map((file) => `첨부 파일 ${imageName(draft, file.name)}`).join('\n')}
첨부 파일 ${recordName}`
        : rewriteContext(draft, draft.selection.contextBlock);
      return `${contextBlock}\n\n[저장한 의견]\n${draft.comment}`;
    }).join('\n\n');
    if (captureContext.length + requestTextLength + 2 > 128_000) {
      throw new Error('선택 자료와 의견이 너무 깁니다. 일부 첨부를 나누어 보내 주세요.');
    }
    const controller = new AbortController();
    pending.add(controller);
    try {
      const files = await stageInlineReferences(options.bridge, context.threadId,
        [...images, recordFile], controller.signal);
      const staging = {
        drafts: selected,
        files,
        context: captureContext,
        controller,
      };
      if (disposed || seq !== revision || context.documentId !== options.getContext().documentId
        || context.threadId !== options.getContext().threadId) {
        await discardStaging(staging);
        throw new Error('문서가 바뀌었습니다. 자료를 다시 확인해 주세요.');
      }
      return staging;
    } catch (error) {
      pending.delete(controller);
      throw error;
    }
  }

  async function consume(staging: CaptureStaging): Promise<void> {
    if (staging.controller) pending.delete(staging.controller);
    const ids = staging.drafts.map((draft) => draft.id);
    await Promise.all([consumeCaptureDrafts(staging.drafts.filter((draft) => !isBrowserDraft(draft)).map((draft) => draft.id)), removeBrowserCaptureDrafts(staging.drafts.filter(isBrowserDraft).map((draft) => draft.id))]);
    if (disposed) return;
    drafts = drafts.filter((draft) => !ids.includes(draft.id));
    render();
  }

  root.hidden = true;
  return {
    root, queue, contextChanged, stage, consume, discardStaging,
    hasDrafts: () => drafts.length > 0,
    hasImages: () => drafts.some((draft) => draft.files.some((file) => file.type.startsWith('image/'))),
    dispose() {
      disposed = true;
      revision++;
      for (const controller of pending) controller.abort();
      root.remove();
    },
  };
}
