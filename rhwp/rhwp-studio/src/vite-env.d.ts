/// <reference types="vite/client" />

declare const __APP_VERSION__: string;
declare const __APP_COMMIT__: string;

declare module 'virtual:pwa-register' {
  export function registerSW(options?: { immediate?: boolean }): (reloadPage?: boolean) => Promise<void>;
}
