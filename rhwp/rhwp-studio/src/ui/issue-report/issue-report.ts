/**
 * 문제 보고 흐름(데스크톱 전용). 시트를 띄우기 전에 창 전체를 찍고 문서 쪽을 흐린 뒤, 사용자가 쓴 글과
 * 고른 첨부(대화·문서)를 메인에 넘긴다. 메인이 설치 id·진단 기록을 붙여 site-api 로 보낸다.
 */
import { showToast } from '../toast.ts';
import { focusOpenIssueReport, openIssueReportSheet } from './issue-report-sheet.ts';
import { prepareScreenshot, screenshotForUpload, visibleDocumentRects, type PreparedScreenshot } from './screenshot.ts';
import type { DesktopIssueReportApi, IssueReportDraft } from './types.ts';

export const REPORT_ISSUE_COMMAND = 'help:report-issue';
export const ISSUE_REPORT_DOCUMENT_MAX_BYTES = 20 * 1024 * 1024;
const EMAIL_STORAGE_KEY = 'rhwp-issue-report-email';

export interface IssueReportChatSnapshot {
  provider: string;
  model: string;
  effort?: string;
  agentMode: string;
  hubConnection?: string;
  /** 보이는 대화 기록. 대화가 없으면 null. */
  transcript: string | null;
}

export interface IssueReportDocument {
  name: string;
  format: string;
  pageCount: number;
  /** 저장 형식 그대로의 바이트. */
  export(): Uint8Array;
}

export interface IssueReportHost {
  api: DesktopIssueReportApi;
  chat(): IssueReportChatSnapshot | null;
  document(): IssueReportDocument | null;
  /** 커밋·확대율 같은 렌더러 정보. */
  meta(): Record<string, unknown>;
}

let starting = false;
/** 보내지 않고 닫은 글과 이메일. 이 페이지에서 다음에 열 때 다시 채운다. */
let carried: { message: string; email: string } | null = null;

function frames(count: number): Promise<void> {
  return new Promise((resolve) => {
    // 가려진 창은 rAF 를 미룬다. 오래 기다리지 않는다.
    const timer = window.setTimeout(resolve, 120);
    const step = (left: number) => {
      if (left <= 0) {
        window.clearTimeout(timer);
        resolve();
        return;
      }
      requestAnimationFrame(() => step(left - 1));
    };
    step(count);
  });
}

function safe<T>(read: () => T): T | null {
  try {
    return read();
  } catch (error) {
    console.warn('[issue-report] 정보를 읽지 못했습니다:', error);
    return null;
  }
}

function storedEmail(): string {
  try {
    return localStorage.getItem(EMAIL_STORAGE_KEY) ?? '';
  } catch {
    return '';
  }
}

function rememberEmail(email: string): void {
  try {
    if (email) localStorage.setItem(EMAIL_STORAGE_KEY, email);
  } catch {
    // 저장소를 못 써도 보고는 이미 갔다.
  }
}

/** '보낼 정보' 에 보이는 글. 키: 값 줄 뒤에 진단 기록이 온다. */
export function describeReportInfo(meta: Record<string, unknown>, log: string): string {
  const lines: string[] = [];
  const add = (prefix: string, value: unknown) => {
    if (value === undefined || value === null || value === '') return;
    if (typeof value === 'object' && !Array.isArray(value)) {
      for (const [key, inner] of Object.entries(value as Record<string, unknown>)) add(`${prefix}.${key}`, inner);
      return;
    }
    lines.push(`${prefix}: ${String(value)}`);
  };
  for (const [key, value] of Object.entries(meta)) add(key, value);
  return `${lines.join('\n')}\n\n${log.trim() || '(진단 기록 없음)'}`;
}

function fileNameFor(document: IssueReportDocument): string {
  const extension = `.${document.format}`;
  return document.name.toLowerCase().endsWith(extension) ? document.name : `${document.name}${extension}`;
}

export async function startIssueReport(host: IssueReportHost): Promise<void> {
  if (focusOpenIssueReport() || starting) return;
  starting = true;
  try {
    // 팔레트·메뉴·토스트 단추가 지운 화면이 그려진 뒤에 찍는다.
    await frames(2);
    const chat = safe(() => host.chat());
    const doc = safe(() => host.document());
    const rendererMeta: Record<string, unknown> = {
      ...(safe(() => host.meta()) ?? {}),
      ...(chat ? {
        provider: chat.provider,
        model: chat.model,
        ...(chat.effort ? { effort: chat.effort } : {}),
        agentMode: chat.agentMode,
        ...(chat.hubConnection ? { hubConnection: chat.hubConnection } : {}),
      } : {}),
      ...(doc ? { document: { format: doc.format, pages: doc.pageCount } } : {}),
    };

    // 메인이 찍는 순간에 가깝게, 부르기 직전과 돌아온 직후에 잰다. 그 사이 스크롤했어도 두 자리를 모두 흐린다.
    const rects = visibleDocumentRects();
    const cssWidth = window.innerWidth;
    let prepared;
    try {
      prepared = await host.api.prepare();
      rects.push(...visibleDocumentRects());
    } catch (error) {
      console.warn('[issue-report] 준비 실패:', error);
      showToast({ message: '문제 보고를 열지 못했습니다.', durationMs: 4000 });
      return;
    }
    let screenshot: PreparedScreenshot | null = null;
    if (prepared.screenshot) {
      try {
        screenshot = await prepareScreenshot(prepared.screenshot.bytes, rects, cssWidth);
      } catch (error) {
        console.warn('[issue-report] 스크린숏을 준비하지 못했습니다:', error);
      }
    }

    openIssueReportSheet({
      screenshot,
      info: describeReportInfo({ ...rendererMeta, ...prepared.meta }, prepared.log),
      message: carried?.message ?? '',
      email: carried?.email || storedEmail(),
      chatAvailable: Boolean(chat?.transcript),
      documentAvailable: Boolean(doc),
      async loadDocument() {
        if (!doc) return { reason: '열린 문서 없음' };
        // 체크 표시가 먼저 그려지게 한 뒤 내보낸다(큰 문서는 잠깐 걸린다).
        await frames(1);
        try {
          const bytes = doc.export();
          if (bytes.byteLength > ISSUE_REPORT_DOCUMENT_MAX_BYTES) return { reason: '20MB 초과' };
          return { name: fileNameFor(doc), bytes };
        } catch (error) {
          console.warn('[issue-report] 문서를 내보내지 못했습니다:', error);
          return { reason: '내보내기 실패' };
        }
      },
      async submit(form) {
        const draft: IssueReportDraft = { message: form.message, meta: rendererMeta };
        if (form.email) draft.email = form.email;
        if (screenshot) {
          const blurred = screenshot.hasBlur && !form.unblur;
          const upload = await screenshotForUpload(blurred ? screenshot.blurred : screenshot.sharp);
          draft.screenshot = { ...upload, blurred };
        }
        if (form.includeChat && chat?.transcript) draft.chat = chat.transcript;
        if (form.document) draft.document = form.document;
        const result = await host.api.submit(draft);
        if (result.ok) rememberEmail(form.email);
        return result;
      },
      onClose({ sent, message, email }) {
        carried = sent ? null : { message, email };
        if (sent) showToast({ message: '문제 보고를 보냈습니다.', durationMs: 3200 });
      },
    });
  } finally {
    starting = false;
  }
}
