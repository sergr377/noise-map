import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root: 'web',
  // One .env at the repo root, shared with the server rather than duplicated.
  envDir: '..',
  plugins: [react()],
  build: {
    outDir: '../dist-web',
    emptyOutDir: true,
    // The Yandex Maps bootstrap uses top-level await.
    target: 'esnext',
  },
  server: {
    // 5173 is taken by the unrelated project sitting next to this one.
    port: 5174,
    // Same-origin in dev, so the API needs no CORS handling from the browser.
    proxy: {
      '/api': {
        target: 'http://localhost:8787',
        changeOrigin: true,
      },
    },
  },
});
