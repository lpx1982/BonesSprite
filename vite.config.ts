import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@engine': path.resolve(__dirname, './src/engine'),
      '@editor': path.resolve(__dirname, './src/editor'),
      '@exporters': path.resolve(__dirname, './src/exporters'),
      '@psd': path.resolve(__dirname, './src/psd'),
    },
  },
  server: { port: 5173, open: true },
});
