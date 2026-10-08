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
  server: {
    port: 5173,
    open: true,
    // 监听所有网卡（0.0.0.0 / ::），允许局域网访问
    host: true,
    // Vite 严格 host 检查白名单：允许任意 Host header（解决 LAN 访问被拒）
    allowedHosts: true,
  },
});
