import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
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
