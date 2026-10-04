import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

/** Emit a service worker that precaches every built asset (offline POS). */
function serviceWorker() {
  return {
    name: 'pos-service-worker',
    apply: 'build',
    generateBundle(_opts, bundle) {
      const files = Object.keys(bundle).filter((f) => !f.endsWith('.map'));
      const version = Date.now().toString(36);
      const src = `// generated at build time
const CACHE = 'pos-shell-${version}';
const PRECACHE = ${JSON.stringify(['/', '/index.html', ...files.map((f) => '/' + f)])};
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(PRECACHE)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/socket.io/')) return;
  if (e.request.mode === 'navigate') {
    // network first for the app shell, fall back to cache when offline
    e.respondWith(fetch(e.request).then((r) => { const copy = r.clone(); caches.open(CACHE).then((c) => c.put('/index.html', copy)); return r; })
      .catch(() => caches.match('/index.html')));
    return;
  }
  e.respondWith(caches.match(e.request).then((hit) => hit || fetch(e.request).then((r) => {
    if (r.ok && url.pathname.startsWith('/assets/')) { const copy = r.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); }
    return r;
  })));
});
`;
      this.emitFile({ type: 'asset', fileName: 'sw.js', source: src });
    },
  };
}

export default defineConfig({
  root: here,
  plugins: [react(), serviceWorker()],
  resolve: { alias: { '@shared': path.resolve(here, '../shared') } },
  server: {
    port: 5173,
    fs: { allow: [path.resolve(here, '..')] },
    proxy: { '/api': 'http://localhost:3000', '/socket.io': { target: 'ws://localhost:3000', ws: true } },
  },
  build: { outDir: path.resolve(here, 'dist'), emptyOutDir: true, chunkSizeWarningLimit: 1500 },
});
