import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// base must match the GitHub Pages sub-path: https://<user>.github.io/<repo>/
export default defineConfig({
  plugins: [react()],
  base: process.env.SITE_BASE ?? '/codex_claude_bridgectl/',
  build: { outDir: 'dist', sourcemap: false },
});
