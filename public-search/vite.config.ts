import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

const clientRoot = fileURLToPath(new URL('./client', import.meta.url))
const publicSearchOrigin = String(process.env.PUBLIC_SEARCH_ORIGIN || '').trim()
const publicSearchProxyToken = String(process.env.PUBLIC_SEARCH_PROXY_TOKEN || '').trim()

let publicSearchProxyHeaders: Record<string, string> | undefined
if (publicSearchOrigin && publicSearchProxyToken) {
  try {
    const origin = new URL(publicSearchOrigin)
    if (origin.username || origin.password || !['http:', 'https:'].includes(origin.protocol)) throw new Error('invalid origin')
    publicSearchProxyHeaders = {
      host: origin.host,
      origin: origin.origin,
      'x-public-search-token': publicSearchProxyToken,
      'x-real-ip': '127.0.0.1'
    }
  } catch {
    // Keep the development proxy unauthenticated when configuration is absent or invalid;
    // the public API must reject those requests instead of receiving guessed credentials.
    publicSearchProxyHeaders = undefined
  }
}

export default defineConfig({
  root: clientRoot,
  plugins: [vue()],
  publicDir: false,
  build: {
    outDir: '../../dist-public/client',
    emptyOutDir: true,
    sourcemap: false
  },
  server: {
    host: '127.0.0.1',
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:3100',
        changeOrigin: false,
        ...(publicSearchProxyHeaders ? { headers: publicSearchProxyHeaders } : {})
      }
    }
  }
})
