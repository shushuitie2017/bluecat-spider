import { defineConfig } from 'vite';

// Single-page Vite app. `base: './'` makes the production build path-relative, so
// the contents of `dist/` can be dropped onto any static host (GitHub Pages, itch.io,
// a plain folder) and just work — no server config required.
export default defineConfig({
  base: './',
  build: {
    target: 'es2020',
    outDir: 'dist',
  },
});
