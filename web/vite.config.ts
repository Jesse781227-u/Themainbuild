import path from 'node:path';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import {defineConfig} from 'vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {alias: {'@': path.resolve(process.cwd(), 'src')}},
  build: {outDir: './dist', emptyOutDir: true},
  server: {host: '0.0.0.0', port: 5173, strictPort: true}
});
