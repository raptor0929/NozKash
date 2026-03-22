import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  optimizeDeps: {
    include: ['mcl-wasm'],
  },
  server: {
    proxy: {
      // El RPC oficial no suele permitir CORS desde el navegador; el dev server reenvía
      // POST same-origin → evita net::ERR_FAILED en `npm run dev`.
      '/fuji-rpc': {
        target: 'https://avalanche-fuji.infura.io',
        changeOrigin: true,
        secure: true,
        rewrite: (path) =>
          path.replace(
            /^\/fuji-rpc/,
            '/v3/7026bb4d4e424828bfb0824e61bde166'
          ),
      },
    },
  },
})
