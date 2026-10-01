import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

// Build 2 of 2: the content script, bundled as one self-contained IIFE.
export default defineConfig({
  publicDir: false,
  build: {
    outDir: r('./dist'),
    emptyOutDir: false, // keep the popup/background output from build 1
    target: 'es2022',
    minify: false, // readable in DevTools while the selectors are being tuned
    lib: {
      entry: r('./src/content/scanner.ts'),
      formats: ['iife'],
      name: 'FpcScanner',
      fileName: () => 'content/scanner.js',
    },
  },
});
