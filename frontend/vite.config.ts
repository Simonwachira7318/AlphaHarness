import path from 'node:path'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig, loadEnv } from 'vite'

// The repository-root .env the backend reads too, so AH_PORT and AH_UI_PORT move both halves.
const ROOT = path.resolve(import.meta.dirname, '..')

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, ROOT, 'AH_')
  const apiPort = env['AH_PORT'] || '8005'
  // The backend runs as a separate process. Proxying /api and /ws in dev means the
  // frontend never needs CORS or credentials of its own.
  const backend = process.env['VITE_BACKEND_URL'] ?? `http://127.0.0.1:${apiPort}`

  return {
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: { '@': path.resolve(import.meta.dirname, 'src') },
    },
    // Only AH_PORT reaches the browser, for the "start the backend" hint; the rest of the
    // file stays server-side.
    envDir: ROOT,
    envPrefix: ['VITE_', 'AH_PORT'],
    // Built into the backend package, which serves it: `uvx alpha-harness` needs no Node.
    build: {
      outDir: path.resolve(import.meta.dirname, '../backend/src/alpha_harness/web'),
      emptyOutDir: true,
      // Screens are already lazy. Splitting the framework out of the entry as well cost 24 kB
      // gzipped more on first load for chunks that cache across wheel upgrades — worth it
      // over a network, worth nothing from 127.0.0.1. The warning is written for a CDN.
      chunkSizeWarningLimit: 700,
    },
    server: {
      port: Number(env['AH_UI_PORT'] || 5175),
      // Fail loudly rather than drift to a port the backend's CORS list does not name.
      strictPort: true,
      proxy: {
        '/api': { target: backend, changeOrigin: true },
        '/ws': { target: backend, ws: true, changeOrigin: true },
        '/openapi.json': { target: backend, changeOrigin: true },
      },
    },
  }
})
