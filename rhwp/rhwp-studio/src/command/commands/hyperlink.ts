import type { CommandDef } from '../types';
import type { HyperlinkEdit } from '@/ui/hyperlink-dialog';
import { HyperlinkDialog, confirmHyperlinkEdit } from '@/ui/hyperlink-dialog';
import { hyperlinkRange, selectedHyperlink, resolveHyperlinkRange, applyHyperlinkFormat, hyperlinkCaretOffset, hyperlinkTextOffset } from '@/core/hyperlink';
import { showToast } from '@/ui/toast';

export const hyperlinkCommand: CommandDef = {
  id: 'insert:hyperlink',
  label: '하이퍼링크',
  icon: 'icon-hyperlink',
  shortcutLabel: 'Ctrl+K+H',
  canExecute: ctx => ctx.hasDocument && ctx.isEditable && !ctx.isFormMode
    && !ctx.inCellSelectionMode && !ctx.inPictureObjectSelection && !ctx.inTableObjectSelection,
  execute(services, params) {
    const ih = services.getInputHandler();
    if (!ih) return;
    try {
      if (!ih.canEditHyperlink()) throw new Error('본문, 표 셀, 글상자의 글자에서 하이퍼링크를 편집해 주세요.');
      const selection = ih.hasSelection() ? structuredClone(ih.getSelection()) : null;
      const range = hyperlinkRange(ih.getCursorPosition(), selection);
      const { target, pos } = range;
      // 링크 범위는 글자 위치다. 캐럿 위치는 여기서 바꾸고, 돌려주는 캐럿은 caretAfter 로 되돌린다.
      const start = hyperlinkTextOffset(services.wasm, target, range.start);
      const end = hyperlinkTextOffset(services.wasm, target, range.end);
      const caretAfter = (text: number) => ({ ...pos, charOffset: hyperlinkCaretOffset(services.wasm, target, text, true) });
      const context = services.wasm.getHyperlinkContext(target);
      const opened = selectedHyperlink(context.links, start, end);
      const canInsertText = !opened && start === end;
      const text = opened?.text ?? Array.from(context.text).slice(start, end).join('');
      const documentInstance = services.wasm.documentInstance;
      const applyEdit = (edit: HyperlinkEdit) => {
        // 다른 문서로 바뀌었으면 적용할 대상이 없다. 같은 문서의 변경은 지금 내용 기준으로 다시 잡는다.
        if (services.wasm.documentInstance !== documentInstance || services.getInputHandler() !== ih) return;
        const current = resolveHyperlinkRange(services.wasm.getHyperlinkContext(target), opened?.fieldId, start, end);
        const { existing } = current;
        const insertText = !existing && current.start === current.end;
        if (edit.kind === 'remove' && !existing) return;
        if (edit.kind === 'save' && existing?.uri === edit.uri && (edit.text === text || existing.text === edit.text)) return;
        if (edit.kind === 'save' && (insertText || edit.text !== text) && (!edit.text.trim() || /[\r\n\t\x00-\x1f\x7f]/.test(edit.text))) {
          throw new Error('표시할 글자를 한 줄로 입력해 주세요.');
        }
        let applied = false;
        ih.executeOperation({
          kind: 'snapshot',
          operationType: 'editHyperlink',
          selectionBefore: selection ? { ...selection, blockPhase: null } : null,
          operation: wasm => {
            switch (edit.kind) {
              case 'remove': {
                if (!existing) return caretAfter(current.end);
                wasm.removeHyperlink(target, existing.fieldId, true);
                applied = true;
                return caretAfter(existing.end);
              }
              case 'save': {
                // 대화상자에서 고친 글자만 반영한다. 그대로 둔 글자는 지금 문서의 글자를 유지한다.
                const newText = edit.text !== text || insertText ? edit.text : null;
                if (existing) {
                  wasm.updateHyperlink(target, existing.fieldId, edit.uri);
                  if (newText !== null) wasm.replaceHyperlinkText(target, existing.fieldId, newText);
                  applied = true;
                  return caretAfter(existing.start + Array.from(newText ?? existing.text).length);
                }
                const linkStart = current.start;
                let linkEnd = current.end;
                if (insertText) {
                  if (target.cellPath.length) {
                    const path = target.cellPath.map(([controlIndex, cellIndex, cellParaIndex]) => ({ controlIndex, cellIndex, cellParaIndex }));
                    wasm.insertTextInCellByPath(target.section, target.para, JSON.stringify(path), linkStart, edit.text);
                  } else {
                    wasm.insertText(target.section, target.para, linkStart, edit.text);
                  }
                  linkEnd = linkStart + Array.from(edit.text).length;
                }
                const fieldId = wasm.insertHyperlink(target, linkStart, linkEnd, edit.uri);
                if (!insertText && newText !== null) {
                  wasm.replaceHyperlinkText(target, fieldId, newText);
                  linkEnd = linkStart + Array.from(newText).length;
                }
                applyHyperlinkFormat(wasm, target, linkStart, linkEnd, '#0000ff');
                applied = true;
                return caretAfter(linkEnd);
              }
              default: {
                const _never: never = edit;
                return _never;
              }
            }
          },
        });
        if (!applied) throw new Error('하이퍼링크를 적용할 수 없습니다. 편집 모드를 확인해 주세요.');
      };
      if (params?.action === 'remove') {
        if (opened) applyEdit({ kind: 'remove' });
        ih.focus();
        return;
      }
      const open = () => {
        const dialog = new HyperlinkDialog({ text, uri: opened?.uri ?? '', existing: !!opened, canInsertText }, applyEdit);
        dialog.afterClose = () => ih.focus();
        dialog.show();
      };
      if (opened && params?.action !== 'edit') confirmHyperlinkEdit(open, () => ih.focus());
      else open();
    } catch (error) {
      showToast({ message: error instanceof Error ? error.message : String(error) });
    }
  },
};

export const editHyperlinkCommand: CommandDef = {
  ...hyperlinkCommand, id: 'hyperlink:edit', label: '하이퍼링크 고치기', shortcutLabel: undefined,
  execute: services => hyperlinkCommand.execute(services, { action: 'edit' }),
};
export const removeHyperlinkCommand: CommandDef = {
  ...hyperlinkCommand, id: 'hyperlink:remove', label: '하이퍼링크 지우기', shortcutLabel: undefined,
  execute: services => hyperlinkCommand.execute(services, { action: 'remove' }),
};
