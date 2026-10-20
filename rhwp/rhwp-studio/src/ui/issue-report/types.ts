/** 메인이 시트를 띄우기 전에 찍은 창 전체와, 이 보고에 실을 앱 정보·진단 기록. */
export interface IssueReportPreparation {
  screenshot: { bytes: Uint8Array; width: number; height: number } | null;
  meta: Record<string, unknown>;
  log: string;
}

export interface IssueReportDraft {
  message: string;
  email?: string;
  /** 렌더러가 아는 정보(공급자·모델·모드·문서 형식 등). 메인 정보가 같은 키를 덮는다. */
  meta: Record<string, unknown>;
  screenshot?: { mime: 'image/png' | 'image/jpeg'; bytes: Uint8Array; blurred: boolean };
  chat?: string;
  document?: { name: string; bytes: Uint8Array };
}

export type IssueReportFailureCode =
  | 'rate_limited'
  | 'busy'
  | 'too_large'
  | 'invalid'
  | 'rejected'
  | 'offline'
  | 'timeout'
  | 'server';

export type IssueReportResult =
  | { ok: true; id: string }
  | { ok: false; code: IssueReportFailureCode; status?: number; field?: string };

export interface DesktopIssueReportApi {
  prepare(): Promise<IssueReportPreparation>;
  submit(draft: IssueReportDraft): Promise<IssueReportResult>;
}
