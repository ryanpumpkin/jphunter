import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5174,               // BeyHunter 個 web dev server 佔咗 5173
    proxy: { '/api': 'http://localhost:3000' },
  },
});
