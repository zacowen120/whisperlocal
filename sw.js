// The Whisperer service worker: network-first so the daily scout's fresh build shows,
// cache fallback so the app still opens offline.
//
// ⚠️ 2026-07-20: "network-first" was NOT enough on its own, and it cost a real debugging session. A plain
// fetch(request) is still served by the BROWSER's own HTTP cache, and GitHub Pages sends a max-age on the
// page, so the installed PWA kept showing a build that was already superseded. Zac was looking at fixes that
// had genuinely shipped and reasonably concluded they were broken. The HTML must therefore be fetched with
// cache:'reload', which forces a real trip to the network and bypasses the HTTP cache.
//
// PHOTOS ARE DELIBERATELY LEFT ALONE. img/<hash>.jpg filenames are content-hashed, so a given URL can never
// change meaning. They are the big, slow part of the app (~70 MB), and re-validating them would make every
// launch crawl for no benefit. Freshness is only ever a question for the HTML.
//
// Bump CACHE on any change here, the activate handler purges every other cache name.
const CACHE = 'whisperer-v13';
const SHELL = ['./', './index.html', './manifest.webmanifest', './icon-192.png', './icon-512.png', './icon-180.png', './favicon.ico'];

// The app is ONE html file, so "is this the page" is the only freshness question there is.
function isPage(req) {
  if (req.mode === 'navigate') return true;
  const p = new URL(req.url).pathname;
  return p.endsWith('/') || p.endsWith('/index.html');
}

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  if (url.origin !== self.location.origin) return;   // never touch anything cross origin (the NWS live temp call)

  const page = isPage(e.request);
  // cache:'reload' ONLY for the page. A fresh Request is built rather than passing init alongside an existing
  // Request, because the cache mode of an already constructed Request cannot be overridden by fetch's init.
  const hit = page ? fetch(new Request(url.href, { cache: 'reload', credentials: 'same-origin' })) : fetch(e.request);

  e.respondWith(
    hit
      .then((res) => {
        // Only ever cache a real response. Caching an error page would serve that error back offline forever.
        if (res && res.ok) {
          const copy = res.clone();
          const write = caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {});
          // waitUntil, NOT fire and forget. respondWith resolves the moment `res` is returned below, so without
          // this the browser is free to decide the fetch event is finished and suspend the worker before the
          // write lands, which iOS does eagerly. The online path would still be correct, but the OFFLINE copy
          // could sit one revision behind forever despite the phone having been online the whole time.
          // Guarded, and the guard matters more than it looks: waitUntil throws InvalidStateError once the event
          // is no longer active, and an uncaught throw here escapes into the .catch below, which would DISCARD the
          // good network response we already have and serve the stale cached copy instead . the exact "shipped
          // work looks broken" failure this whole change exists to stop.
          // Honest about what the catch does NOT do: it stops the throw, it does not restore the lifetime
          // guarantee. On that path the write is an orphaned promise that may or may not finish before the worker
          // sleeps. Worst case is an offline copy one revision behind, never a wrong response.
          // The clean version, next time this file is touched: call waitUntil ONCE, synchronously, at the top of
          // the fetch handler with a promise resolved later, so it can never be too late to call. Not done now
          // because every exit path would have to resolve it, and a missed path pins the worker awake for good.
          try { e.waitUntil(write); } catch (err) { /* too late to extend the event; the write races the worker */ }
        }
        return res;
      })
      .catch(() => caches.match(e.request).then((r) => r || caches.match('./index.html')))
  );
});
