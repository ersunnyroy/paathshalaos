/*
 * The service worker, deliberately small.
 *
 * It does one job: make the app SHELL available with no network, so a teacher
 * standing in a classroom with no signal can still open the register and mark
 * it. The marks themselves are handled by the offline queue in IndexedDB —
 * this file caches no API responses at all, and that is the important half of
 * the design.
 *
 * Caching GET /v1/students would let the app show a roll that looks current and
 * is three weeks old, with no way for the teacher to tell. A register built
 * from a stale roll is worse than one that says it cannot load: it silently
 * omits the children who joined since, and nobody notices until a parent asks
 * why their child was marked absent every day.
 *
 * So: the shell is cached, data is network-only, and anything not cached and
 * not reachable fails honestly.
 */
const SHELL = 'paathshala-shell-v1';

// Navigations only. Next.js serves its own hashed assets which the runtime
// cache picks up; listing them here would go stale on every build.
const PRECACHE = ['/attendance', '/dashboard', '/manifest.webmanifest'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL)
      // addAll rejects the whole batch if any one URL fails, which would leave
      // the worker uninstalled and the app with no offline shell at all.
      .then((cache) => Promise.allSettled(PRECACHE.map((url) => cache.add(url))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k !== SHELL).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Never the API. A cached roll that looks current and is not is worse than
  // an honest failure — see the note at the top.
  if (url.pathname.startsWith('/v1/') || url.pathname.startsWith('/api/')) return;

  // Network first, so a connected teacher always gets today's build, with the
  // cache as the fallback rather than the default.
  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response.ok) {
          const copy = response.clone();
          void caches.open(SHELL).then((cache) => cache.put(request, copy));
        }
        return response;
      })
      .catch(async () => {
        const cached = await caches.match(request);
        if (cached) return cached;
        // A navigation with nothing cached for it still gets the register,
        // which is the one screen that has to work in a basement.
        if (request.mode === 'navigate') {
          const shell = await caches.match('/attendance');
          if (shell) return shell;
        }
        return new Response('Offline, and this page was never cached.', {
          status: 503, headers: { 'content-type': 'text/plain' },
        });
      }),
  );
});
