import { defineConfig } from 'vite';

// WebContainers boot a real Node.js runtime inside the browser tab using
// SharedArrayBuffer under the hood. Browsers only expose SharedArrayBuffer
// to "cross-origin isolated" pages, which requires these two response
// headers on every document the page depends on. Without them,
// WebContainer.boot() will throw.
const crossOriginIsolationHeaders = {
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Opener-Policy': 'same-origin',
};

export default defineConfig({
  // Relative base so the build works whether it's deployed at a domain
  // root or under a GitHub Pages repo subpath (https://user.github.io/repo/).
  base: './',
  server: {
    headers: crossOriginIsolationHeaders,
  },
  preview: {
    headers: crossOriginIsolationHeaders,
  },
});
