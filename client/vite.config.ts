import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  // Read .env files so `npm run dev` works with zero configuration:
  // VITE_SIGNALING_URL falls back to the local proxy below.
  const env = loadEnv(mode, process.cwd(), '');

  const target = env.VITE_SIGNALING_URL || 'http://localhost:4000';

  return {
    plugins: [react(), tailwindcss()],
    server: {
      // In development, forward API + WebSocket traffic to the signaling server
      // so the app runs on a single origin (no CORS / no mixed-content issues).
      proxy: {
        '/api': { target, changeOrigin: true },
        '/socket.io': { target, ws: true, changeOrigin: true },
      },
    },
    preview: {
      port: 4173,
    },
    build: {
      sourcemap: false,
      chunkSizeWarningLimit: 700,
      rollupOptions: {
        output: {
          // Socket.io + React are the long-lived chunks; keeping them split
          // lets the browser cache them across releases.
          manualChunks(id: string) {
            if (id.includes('node_modules/socket.io-client') || id.includes('node_modules/engine.io-client')) {
              return 'signaling';
            }
            if (
              id.includes('node_modules/react-dom') ||
              id.includes('node_modules/react/') ||
              id.includes('node_modules/scheduler')
            ) {
              return 'react';
            }
            return undefined;
          },
        },
      },
    },
  };
});
