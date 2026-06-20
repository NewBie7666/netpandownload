import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  plugins: [vue()],
  server: {
    host: '127.0.0.1',
    port: 5183,
    proxy: {
      '/api': 'http://127.0.0.1:5190'
    }
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true
  }
})
