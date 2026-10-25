/** 문단 보관본은 같은 문서의 해당 문단만 되돌린다. */
import type { HmCore } from './core';
import { extendBridge } from './api';

type CaptureDoc = { captureParagraph(address: string): number; restoreParagraph(id: number, address: string): string; discardParagraphCapture(id: number): boolean };
const address = (section: number, para: number) => JSON.stringify({ section, para, offset: 0 });
export function captureParagraph(core: HmCore, sec: number, para: number): number {
  return core.call(doc => (doc as unknown as CaptureDoc).captureParagraph(address(sec, para)));
}
export function restoreCapturedParagraph(core: HmCore, id: number, sec: number, para: number): void {
  core.mutate(doc => (doc as unknown as CaptureDoc).restoreParagraph(id, address(sec, para)));
}
export function discardParagraphCapture(core: HmCore, id: number): void {
  core.call(doc => (doc as unknown as CaptureDoc).discardParagraphCapture(id));
}
extendBridge({ captureParagraph, restoreCapturedParagraph, discardParagraphCapture });
