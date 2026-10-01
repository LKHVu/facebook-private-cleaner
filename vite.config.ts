import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

// Build 1 of 2: popup + persistent tester (React pages) + background service worker (ES module).
// The content script is built separately (vite.content.config.ts) because
// scripts injected with chrome.scripting.executeScript must be a single
// classic (non-module) file.
export default defineConfig({
  root: r('./src'),
  publicDir: r('./public'), // manifest.json is copied verbatim into dist/
  base: '', // relative asset URLs so the popup works from chrome-extension://
  plugins: [react()],
  // One id per build, shared by the tester and the service worker (src/shared/build.ts).
  define: { __BUILD_ID__: JSON.stringify(new Date().toISOString()) },
  build: {
    outDir: r('./dist'),
    emptyOutDir: true,
    target: 'es2022',
    modulePreload: { polyfill: false },
    rollupOptions: {
      input: {
        popup: r('./src/popup/index.html'),
        tester: r('./src/popup/tester.html'),
        serviceWorker: r('./src/background/serviceWorker.ts'),
      },
      output: {
        entryFileNames: (chunk) =>
          chunk.name === 'serviceWorker' ? 'background/serviceWorker.js' : 'assets/[name]-[hash].js',
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
  },
});
