import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  define: {
    // Baked into the bundle so the UI can show its own build time.
    __UI_BUILD_TIME__: JSON.stringify(new Date().toISOString()),
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: './tests/setup.ts'
  },
  server: {
    port: 3000,
    proxy: {
      '/api': {
        target: 'http://localhost:8123',
        changeOrigin: true
      }
    }
  },
  build: {
    outDir: 'dist'
  }
})
