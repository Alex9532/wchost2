// Emulates the Cross-Origin-Opener-Policy / Cross-Origin-Embedder-Policy
// response headers that WebContainers need, for hosts (GitHub Pages, etc.)
// that don't let you configure real HTTP response headers.
//
// It works because a service worker sits between the network and the page:
// it can't change what the server sent, but it CAN intercept every fetch
// this page makes (including the top-level document itself, once the
// worker is controlling the page) and hand back a modified Response with
// the two headers added. The browser only cares that the *response it
// receives* carries the headers — it doesn't know or care that a worker
// added them client-side.
//
// "require-corp" (rather than "credentialless") is used deliberately: it's
// the mode with the broadest, most reliable browser support.

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (event) => {
  const { request } = event;

  // Cross-origin, opaque requests can't have their headers read or
  // rewritten — let those pass through untouched.
  if (request.mode === 'no-cors' && new URL(request.url).origin !== self.location.origin) {
    return;
  }

  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response.status === 0) return response; // opaque response, leave as-is

        const headers = new Headers(response.headers);
        headers.set('Cross-Origin-Embedder-Policy', 'require-corp');
        headers.set('Cross-Origin-Opener-Policy', 'same-origin');

        return new Response(response.body, {
          status: response.status,
          statusText: response.statusText,
          headers,
        });
      })
      .catch(
        (err) =>
          new Response(`coi-serviceworker: fetch failed for ${request.url}: ${err}`, {
            status: 500,
          })
      )
  );
});
