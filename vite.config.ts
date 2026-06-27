import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    // Honour PORT when set (e.g. preview tooling) so it can run alongside `tauri dev`.
    port: Number(process.env.PORT) || 5173,
    // Dev-only: lets `npm run dev` (plain browser) reach UQ's timetable without CORS.
    // The packaged Tauri app fetches natively via the HTTP plugin instead.
    proxy: {
      '/uqapi': {
        target: 'https://timetable.my.uq.edu.au/aplus',
        changeOrigin: true,
        secure: true,
        rewrite: (p: string) => p.replace(/^\/uqapi/, ''),
      },
    },
  },
})
