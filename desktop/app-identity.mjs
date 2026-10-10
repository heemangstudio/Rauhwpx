/**
 * Name Electron uses for the user data folder, the macOS Keychain item
 * ("Rauhwpx Safe Storage" / "Rauhwpx Key"), the Linux keyring entry and the
 * X11 window class. It stays "Rauhwpx" for the whole process so data and
 * secrets written by 2.0.10 and earlier stay readable.
 */
export const INTERNAL_APP_NAME = 'Rauhwpx';

/** Name users see. Pass it explicitly to menus, dialogs and notifications. */
export const PRODUCT_NAME = 'HamaEditor';
