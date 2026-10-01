import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

export default defineConfig({
  plugins: [vue()],
  server: {
    // dev proxy → the demo Fastify app (default port)
    proxy: {
      '/api': 'http://127.0.0.1:8790',
      '/ws': { target: 'ws://127.0.0.1:8790', ws: true },
      '/mcp': 'http://127.0.0.1:8790',
    },
  },
  build: { outDir: 'dist' },
});
