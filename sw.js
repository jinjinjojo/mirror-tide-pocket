/* Tide Pocket service worker. Pages: network first, the saved copy when offline. Files under /pw, /prism, /tp: saved copy first, refreshed behind.
 * NOAA answers are not cached here (live.js keeps the last one per station). __V__ is set by jobs/pwa.mjs at build time. */
const V = "tp-__V__", SHELL = ["/", "/offline.html", "/manifest.webmanifest", "/tp/live.js", "/tp/offline.js", "/tp/sun.js", "/tp/windows.js", "/tp/calc.js", "/tp/names.js", "/tp/pro.js", "/tp/alarm.js", "/tp/tp.css", "/tp/stations.json", "/tp/icon-192.png"];
self.addEventListener("install", (e) => { e.waitUntil(caches.open(V).then((c) => Promise.allSettled(SHELL.map((u) => c.add(u)))).then(() => self.skipWaiting())); });
self.addEventListener("activate", (e) => { e.waitUntil(caches.keys().then((k) => Promise.all(k.filter((x) => x.startsWith("tp-") && x !== V).map((x) => caches.delete(x)))).then(() => self.clients.claim())); });
self.addEventListener("fetch", (e) => {
  const r = e.request, u = new URL(r.url);
  if (r.method !== "GET" || u.origin !== location.origin) return;
  const asset = /^\/(pw|prism|tp|pw-data)\//.test(u.pathname) || /\.(css|js|woff2|svg|png|json)$/.test(u.pathname);
  if (asset) {
    e.respondWith(caches.open(V).then(async (c) => { const hit = await c.match(r), net = fetch(r).then((x) => { if (x.ok) c.put(r, x.clone()); return x; }).catch(() => hit); return hit || net; }));
  } else {
    e.respondWith(fetch(r).then((x) => { if (x.ok) caches.open(V).then((c) => c.put(r, x.clone())); return x; }).catch(async () => (await caches.match(r)) || (r.mode === "navigate" ? caches.match("/offline.html") : Response.error())));
  }
});
