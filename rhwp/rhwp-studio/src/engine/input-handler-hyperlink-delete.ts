import { hyperlinkTarget } from '@/core/hyperlink';
import type { DocumentPosition } from '@/core/types';
import type { WasmBridge } from '@/core/wasm-bridge';
import type { OperationDescriptor } from './command';
import { confirmHyperlinkDelete } from '@/ui/hyperlink-delete-dialog';
import { showToast } from '@/ui/toast';

type DeleteHost = {
  wasm: WasmBridge;
  canEditHyperlink?(): boolean;
  isFormMode?(): boolean;
  isActive?(): boolean;
  focusTextarea(): void;
  executeOperation(operation: OperationDescriptor): unknown;
};
const pending = new WeakSet<DeleteHost>();

export function tryConfirmDeleteHyperlink(
  self: DeleteHost, position: DocumentPosition, direction: 'forward' | 'backward' = 'forward',
): boolean {
  if (pending.has(self)) return true;
  const canEdit = () => !!self.canEditHyperlink?.() && !self.isFormMode?.() && self.isActive?.() !== false;
  if (!canEdit()) return false;
  const pos = structuredClone(position);
  const deleteOffset = pos.charOffset - (direction === 'backward' ? 1 : 0);
  if (deleteOffset < 0) return false;
  let target, context;
  try {
    target = hyperlinkTarget(pos);
    context = self.wasm.getHyperlinkContext(target);
  } catch { return false; }
  const link = context.links.find(item => item.start <= deleteOffset && deleteOffset < item.end);
  if (!link) return false;
  const documentInstance = self.wasm.documentInstance;
  const finish = () => { pending.delete(self); self.focusTextarea(); };
  pending.add(self);
  confirmHyperlinkDelete(() => {
    try {
      // 확인하는 사이 같은 문서가 바뀌었으면 같은 링크를 지금 위치에서 다시 찾는다.
      if (self.wasm.documentInstance !== documentInstance) return;
      const current = self.wasm.getHyperlinkContext(target).links.find(item => item.fieldId === link.fieldId);
      if (!current) return;
      self.executeOperation({
        kind: 'snapshot', operationType: 'deleteHyperlink', selectionBefore: null,
        operation: wasm => {
          wasm.removeHyperlink(target, current.fieldId);
          if (target.cellPath.length) {
            const path = JSON.stringify(target.cellPath.map(([controlIndex, cellIndex, cellParaIndex]) =>
              ({ controlIndex, cellIndex, cellParaIndex })));
            wasm.deleteTextInCellByPath(target.section, target.para, path, current.start, current.end - current.start);
          } else {
            wasm.deleteText(target.section, target.para, current.start, current.end - current.start);
          }
          return { ...pos, charOffset: current.start };
        },
      });
    } catch (error) {
      showToast({ message: error instanceof Error ? error.message : String(error) });
    } finally { finish(); }
  }, finish);
  return true;
}
