import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Dev serves from the root so http://localhost:5173/ just works.
// Builds default to the GitHub Pages sub-path; override with SITE_BASE.
export default defineConfig(({ command }) => ({
  plugins: [react()],
  base: process.env.SITE_BASE ?? (command === 'serve' ? '/' : '/codex_claude_bridgectl/'),
  build: { outDir: 'dist', sourcemap: false },
}));
