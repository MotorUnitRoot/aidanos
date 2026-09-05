/* AidanOS shell cache — offline chrome; /api/* network-first */
const CACHE = "aidanos-shell-v1";
const SHELL = [
  "/",
  "/index.html",
  "/app.js",
  "/day.css",
  "/styles.css",
  "/manifest.webmanifest",
  "/icon-180.png",
  "/icon-192.png",
  "/apple-touch-icon.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  if (url.pathname.startsWith("/api/")) {
    event.respondWith(fetch(req).catch(() => caches.match(req)));
    return;
  }

  event.respondWith(
    caches.match(req).then((hit) => {
      const net = fetch(req)
        .then((res) => {
          if (
            res &&
            res.ok &&
            (url.pathname === "/" ||
              SHELL.includes(url.pathname) ||
              url.pathname.endsWith(".css") ||
              url.pathname.endsWith(".js") ||
              url.pathname.endsWith(".webmanifest") ||
              url.pathname.endsWith(".png"))
          ) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy));
          }
          return res;
        })
        .catch(() => hit);
      return hit || net;
    })
  );
});
