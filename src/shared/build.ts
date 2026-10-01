/**
 * Identifies one `npm run build` of the popup / tester / service worker (vite.config.ts defines
 * __BUILD_ID__). Chrome keeps running an already-started service worker after dist/ is rebuilt
 * until the extension is reloaded, while a reopened tester window loads the new files at once:
 * comparing the two ids exposes that mix, and a cleanup run refuses to start with it.
 */
declare const __BUILD_ID__: string;

export const BUILD_ID: string = typeof __BUILD_ID__ === 'string' ? __BUILD_ID__ : 'dev';
