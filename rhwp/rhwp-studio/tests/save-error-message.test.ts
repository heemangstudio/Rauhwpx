import test from 'node:test';
import assert from 'node:assert/strict';

import { describeSaveError } from '../src/command/save-error-message.ts';
import {
  NATIVE_FILE_ACCESS_DENIED_MESSAGE,
  NATIVE_FILE_CONFLICT_MESSAGE,
  NATIVE_FILE_IN_USE_MESSAGE,
  NATIVE_FILE_READ_ONLY_MESSAGE,
} from '../../../desktop/native-file-handles.mjs';

// What the renderer receives when ipcMain.handle rejects.
function ipcError(message: string) {
  return new Error(`Error invoking remote method 'desktop:native-file-write': Error: ${message}`);
}

test('every desktop save refusal reaches the user as an explanation, not the raw IPC text', () => {
  for (const message of [
    NATIVE_FILE_CONFLICT_MESSAGE,
    NATIVE_FILE_READ_ONLY_MESSAGE,
    NATIVE_FILE_IN_USE_MESSAGE,
    NATIVE_FILE_ACCESS_DENIED_MESSAGE,
  ]) {
    const described = describeSaveError(ipcError(message));
    assert.doesNotMatch(described, /invoking remote method/, message);
    assert.match(described, /[가-힣]/, message);
  }
});

test('an unknown save error keeps its original text', () => {
  assert.equal(describeSaveError(new Error('CFB 쓰기 실패: disk full')), 'CFB 쓰기 실패: disk full');
  assert.equal(describeSaveError('plain'), 'plain');
});
