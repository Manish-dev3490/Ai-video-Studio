import {defineConfig} from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {port: 5173, strictPort: true, proxy: {'/api': {target: process.env.API_PROXY_TARGET || `http://127.0.0.1:${process.env.API_PORT || 4100}`, changeOrigin: false}}},
  preview: {port: 4173, strictPort: true},
  build: {sourcemap: false},
});
