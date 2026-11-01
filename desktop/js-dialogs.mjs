/**
 * Windows·Linux 는 alert()·confirm() 창 제목에 앱 이름을 단다. 앱 이름은 사용자 데이터를 지키려고
 * 'Rauhwpx' 로 남아 있으므로(app-identity.mjs) 프리로드가 두 함수를 이 처리기로 보내고, 여기서
 * 제품 이름을 제목으로 띄운다. macOS 경고창에는 제목이 없어 그대로 둔다.
 */
export const JS_DIALOG_CHANNEL = 'desktop:js-dialog';

export function installJavaScriptDialogs({ ipcMain, dialog, BrowserWindow, title }) {
  ipcMain.on(JS_DIALOG_CHANNEL, (event, kind, message) => {
    const confirm = kind === 'confirm';
    const options = {
      type: 'none',
      title,
      message: String(message ?? ''),
      // noLink 없이 'OK'·'Cancel' 을 주면 Windows 공용 단추가 되어 시스템 언어(확인·취소)로 보인다.
      buttons: confirm ? ['OK', 'Cancel'] : ['OK'],
      defaultId: 0,
      cancelId: confirm ? 1 : 0,
    };
    const window = BrowserWindow.fromWebContents(event.sender);
    const response = window ? dialog.showMessageBoxSync(window, options) : dialog.showMessageBoxSync(options);
    event.returnValue = confirm ? response === 0 : true;
  });
}
