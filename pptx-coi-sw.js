/* pptx-coi-sw.js — MLApplications
 * Makes the PPTX-to-video pages "cross-origin isolated" so WebAssembly can use several CPU threads
 * (2–4x faster speech generation). It only adds two headers to pages and worker scripts under the
 * "/pptx" path prefix (registered with scope './pptx'), so the rest of the site – and its ads – are untouched.
 *
 *   Cross-Origin-Opener-Policy: same-origin
 *   Cross-Origin-Embedder-Policy: credentialless   (cross-origin files still load, just without cookies)
 *
 * If your web server can send these headers itself for the tool's page, this file is not needed.
 */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (e) => {
  const r = e.request;
  // Only documents and worker scripts need the headers; everything else goes straight to the network.
  if (r.mode !== 'navigate' && r.destination !== 'worker' && r.destination !== 'sharedworker') return;
  if (new URL(r.url).origin !== self.location.origin) return;
  e.respondWith(fetch(r).then((res) => {
    if (!res || res.status === 0 || res.type === 'opaqueredirect') return res;
    const h = new Headers(res.headers);
    h.set('Cross-Origin-Opener-Policy', 'same-origin');
    h.set('Cross-Origin-Embedder-Policy', 'credentialless');
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
  }).catch(() => fetch(r)));
});
