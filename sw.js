// Bump this cache version and the visible application version on every deploy.
const CACHE_NAME = "sheetmusic-2.1.1";
const APP_SHELL = [
  "./index.html",
  "./style.css",
  "./manifest.json",
  "./js/app.js",
  "./js/annotate.js",
  "./js/db.js",
  "./js/library.js",
  "./js/metronome.js",
  "./js/viewer.js",
  "./icons/icon.svg",
  "./icons/icon-180.png",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/icon-512-maskable.png",
  "./pdfjs/pdf.mjs",
  "./pdfjs/pdf.worker.mjs"
];
const OPTIONAL_ICONS = new Set([
  "./icons/icon-180.png",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/icon-512-maskable.png"
]);

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    for (const path of APP_SHELL) {
      const url = new URL(path, self.registration.scope);
      try {
        const response = await fetch(new Request(url.href, { cache: "reload" }));
        if (!response.ok) throw new Error(`Could not cache ${path}: ${response.status}`);
        await cache.put(url.href, response);
      } catch (error) {
        if (!OPTIONAL_ICONS.has(path)) throw error;
        console.warn(`Optional icon is not available yet: ${path}`);
      }
    }
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const oldCaches = await caches.keys();
    await Promise.all(oldCaches
      .filter((name) => name.startsWith("sheetmusic-") && name !== CACHE_NAME)
      .map((name) => caches.delete(name)));
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  const scopeUrl = new URL(self.registration.scope);
  const requestUrl = new URL(event.request.url);
  if (
    requestUrl.origin !== scopeUrl.origin ||
    !requestUrl.pathname.startsWith(scopeUrl.pathname)
  ) return;

  if (event.request.mode === "navigate") {
    event.respondWith((async () => {
      const appUrl = new URL("./index.html", self.registration.scope);
      const cached = await caches.match(event.request) || await caches.match(appUrl.href);
      if (cached) return cached;
      try {
        return await fetch(event.request);
      } catch {
        return Response.error();
      }
    })());
    return;
  }

  event.respondWith((async () => {
    const cached = await caches.match(event.request);
    if (cached) return cached;
    return fetch(event.request);
  })());
});
