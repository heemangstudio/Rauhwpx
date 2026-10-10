/**
 * Name Electron uses for the user data folder, the macOS Keychain item
 * ("Rauhwpx Safe Storage" / "Rauhwpx Key"), the Linux keyring entry and the
 * X11 window class. It stays "Rauhwpx" for the whole process so data and
 * secrets written by 2.0.10 and earlier stay readable.
 */
export const INTERNAL_APP_NAME = 'Rauhwpx';

/** Name users see. Pass it explicitly to menus, dialogs and notifications. */
export const PRODUCT_NAME = 'HamaEditor';

/**
 * electron-builder `build.appId`: the macOS bundle id and the Windows
 * AppUserModelId of the installed Start menu shortcut. Windows shows an app's
 * notifications only under this id, so it stays "com.hataewook.rauhwpx" like
 * the other internal identities.
 */
export const APP_ID = 'com.hataewook.rauhwpx';
