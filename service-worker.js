const CACHE_NAME = "lantern-table-shell-v2";
const APP_SHELL = [
  "/",
  "/manifest.webmanifest",
  "/assets/app.css?v=glow-pointer-1",
  "/assets/dnd-fx.css",
  "/assets/app.js?v=dm-faro-1",
  "/assets/dnd-fx.js?v=pointer-perf-1",
  "/assets/pwa.js",
  "/assets/logo.svg",
  "/assets/apple-touch-icon.png",
  "/assets/pwa-192.png",
  "/assets/pwa-512.png"
];

self.addEventListener("install", event => {
  event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(APP_SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith("lantern-table-shell-") && key !== CACHE_NAME).map(key => caches.delete(key)))).then(() => self.clients.claim()));
});

self.addEventListener("fetch", event => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== self.location.origin || url.pathname.startsWith("/api/") || url.pathname.startsWith("/auth/") || url.pathname.startsWith("/ws/") || url.pathname === "/run" || url.pathname === "/run.sh" || url.pathname.startsWith("/download/")) return;

  if (request.mode === "navigate") {
    event.respondWith(fetch(request).then(response => {
      if (response.ok && (url.pathname === "/" || url.pathname === "/index.html")) caches.open(CACHE_NAME).then(cache => cache.put("/", response.clone()));
      return response;
    }).catch(async () => (await caches.match("/")) || Response.error()));
    return;
  }

  if (url.pathname.startsWith("/assets/")) {
    event.respondWith(fetch(request).then(response => {
      if (response.ok) caches.open(CACHE_NAME).then(cache => cache.put(request, response.clone()));
      return response;
    }).catch(async () => (await caches.match(request)) || Response.error()));
  }
});
