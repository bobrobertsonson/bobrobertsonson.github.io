// Precache the whole app so it opens offline. Bumped automatically when any file changes.
const CACHE = 'ab-48591623aa';
const FILES = ["./", "index.html", "manifest.webmanifest", "assets/bench.webp", "assets/steel.webp", "assets/rustframe.png", "assets/alu.webp", "assets/vpad-a-off.webp", "assets/vpad-a-on.webp", "assets/vpad-b-off.webp", "assets/vpad-b-on.webp", "assets/vknob-strip.webp", "js/dsp.js", "js/export.js", "js/app.js", "js/mp3-worker.js", "vendor/lame.min.js", "vendor/lamejs-LICENSE", "fonts/barlow-condensed-latin-500-normal.woff2", "fonts/barlow-condensed-latin-600-normal.woff2", "fonts/barlow-condensed-latin-700-normal.woff2", "fonts/doto-latin-700-normal.woff2", "fonts/LICENSE-barlow.txt", "fonts/LICENSE-doto.txt", "icons/icon-1024.png", "icons/icon-512.png", "icons/icon-192.png", "icons/icon-180.png", "icons/icon-32.png", "icons/icon-maskable-512.png"];
self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  e.respondWith(caches.match(e.request, {ignoreSearch: true}).then(hit => hit || fetch(e.request)));
});
