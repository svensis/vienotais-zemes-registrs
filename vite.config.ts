import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Vite sits on 5173 and proxies /api to the Express process.
 * That keeps the browser same-origin while the server talks to data.gov.lv.
 *
 * Production on the VPS lives at /hakatons (CFLA already owns /).
 * Build with VITE_BASE=/hakatons/ so assets and the API prefix match.
 */
export default defineConfig({
  plugins: [react()],
  base: process.env.VITE_BASE || '/',
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:5174',
        changeOrigin: true,
      },
    },
  },
});
