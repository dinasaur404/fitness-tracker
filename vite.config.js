import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  root: '.', // Project root
  publicDir: 'public', // Static assets (manifest.json, sw.js, etc.)
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // Copy public assets to dist
    copyPublicDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      // Proxy API requests to wrangler dev
      '/api': {
        target: 'http://localhost:8787',
        changeOrigin: true,
      },
      // Proxy WebSocket connections for chat
      '/agents': {
        target: 'ws://localhost:8787',
        ws: true,
        changeOrigin: true,
      },
      // Proxy OAuth callback
      '/callback': {
        target: 'http://localhost:8787',
        changeOrigin: true,
      },
    },
  },
})
