import path from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { '@': path.resolve(__dirname, './src') },
  },
  // Daemon serves the built UI from ../public on port 4780
  build: { outDir: '../public', emptyOutDir: true },
  server: {
    proxy: {
      '/api': 'http://127.0.0.1:4780',
    },
  },
})
