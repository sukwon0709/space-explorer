import { defineConfig } from 'vite';

// Relative base so the built app works from any path (GitHub Pages, artifact previews).
export default defineConfig({
  base: './',
  test: { include: ['tests/**/*.test.ts'] },
});
