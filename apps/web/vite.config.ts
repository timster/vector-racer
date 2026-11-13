import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    // Same origin as the API in development, matching production. Keep the browser's Host header
    // (the string shorthand would rewrite it), so the server's same-origin check sees a match.
    proxy: { '/api': { target: 'http://127.0.0.1:3000', changeOrigin: false } },
  },
});
