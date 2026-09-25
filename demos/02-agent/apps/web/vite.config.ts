import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      // 前端一律用**相对路径** `/api/...`，dev 时由 Vite 反代到服务端。
      // 因此不需要 CORS 中间件（spec §12）；将来若改成 express.static 同源部署，
      // 前端代码一行都不用改。
      //
      // 这是整个前端里**唯一**允许出现服务端地址的地方。
      '/api': 'http://127.0.0.1:3000',
    },
  },
});
