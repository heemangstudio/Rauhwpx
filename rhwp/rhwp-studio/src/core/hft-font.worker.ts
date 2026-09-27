/// <reference lib="webworker" />
/**
 * 한컴 HFT 가족 변환 Worker. 수 MB짜리 outline 변환을 메인 스레드 밖에서 하고
 * 결과 바이트는 복사 없이 넘긴다(transfer).
 */
import { convertHftFamilyToOpenType } from './hft-font.ts';
import type { HftFamilyWorkerRequest, HftFamilyWorkerResponse } from './hft-family.ts';

const scope = self as unknown as DedicatedWorkerGlobalScope;

scope.onmessage = (event: MessageEvent<HftFamilyWorkerRequest>) => {
  const { id, files, family } = event.data;
  try {
    const bytes = convertHftFamilyToOpenType(files, family);
    scope.postMessage({ id, ok: true, bytes } satisfies HftFamilyWorkerResponse, [bytes]);
  } catch (error) {
    scope.postMessage({
      id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    } satisfies HftFamilyWorkerResponse);
  }
};
