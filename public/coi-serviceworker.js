// Service worker with two jobs:
//
// 1. Cross-origin isolation on hosts without header control (GitHub Pages).
//    It re-serves same-origin responses with
//    Cross-Origin-Embedder-Policy: require-corp and
//    Cross-Origin-Opener-Policy: same-origin added, which is what
//    WebContainers need. ("require-corp" rather than "credentialless" for the
//    broadest browser support.)
//
// 2. New-tab previews. Requests under  <scope>/preview/<hostId>/...  are not
//    sent to the network. They are handed over a BroadcastChannel to the Dock
//    tab with that hostId, which fetches the bytes from inside the container
//    (see src/preview-host.js) and sends them back. Preview responses are
//    deliberately served WITHOUT the isolation headers, so the previewed site
//    behaves like a normal site (cross-origin images, embeds, etc. still work).

const CHANNEL = 'dock-preview';
const ACK_TIMEOUT_MS = 3000;
const RESPONSE_TIMEOUT_MS = 60000;

const SCOPE_PATH = new URL(self.registration.scope).pathname; // e.g. "/wchost2/"
const PREVIEW_PREFIX = SCOPE_PATH + 'preview/';

const HOST_ID = /^[a-z0-9]{6,32}$/;
const SKIPPED_RESPONSE_HEADERS = new Set([
  'content-length', 'content-encoding', 'transfer-encoding', 'connection',
  'keep-alive', 'set-cookie', 'set-cookie2',
]);

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

// "/wchost2/preview/abc123/some/file.css"  ->  { hostId: "abc123", path: "/some/file.css" }
// "/wchost2/preview/abc123"                ->  { hostId: "abc123", path: null }
function parsePreviewPath(pathname) {
  if (!pathname.startsWith(PREVIEW_PREFIX)) return null;
  const rest = pathname.slice(PREVIEW_PREFIX.length);
  const slash = rest.indexOf('/');
  const hostId = slash === -1 ? rest : rest.slice(0, slash);
  if (!HOST_ID.test(hostId)) return null;
  return { hostId, path: slash === -1 ? null : rest.slice(slash) };
}

async function previewHostOfClient(clientId) {
  if (!clientId) return null;
  const client = await self.clients.get(clientId);
  if (!client) return null;
  const parsed = parsePreviewPath(new URL(client.url).pathname);
  return parsed ? parsed.hostId : null;
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function errorPage(status, message) {
  return new Response(
    '<!doctype html><meta charset="utf-8"><title>Dock preview</title>' +
      '<body style="font:16px/1.5 system-ui,sans-serif;max-width:38rem;margin:3rem auto;padding:0 1rem">' +
      '<h1 style="font-size:1.25rem">Dock preview unavailable</h1><p>' + escapeHtml(message) + '</p>',
    { status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } }
  );
}

function buildResponse(msg, method) {
  const status = Number(msg.status);
  if (!Number.isInteger(status) || status < 200 || status > 599) {
    return errorPage(502, 'The server returned an unusable status code.');
  }
  const headers = new Headers();
  for (const [name, value] of msg.headers || []) {
    if (SKIPPED_RESPONSE_HEADERS.has(String(name).toLowerCase())) continue;
    try { headers.append(name, value); } catch { /* skip invalid header */ }
  }
  // Always show what is in the container right now.
  headers.set('cache-control', 'no-store');

  const noBody = method === 'HEAD' || status === 204 || status === 205 || status === 304;
  return new Response(noBody ? null : msg.body, { status, headers });
}

async function proxyToHost(hostId, path, request) {
  const id = crypto.randomUUID();
  const method = request.method;
  const body = method === 'GET' || method === 'HEAD' ? null : await request.arrayBuffer();
  const headers = [];
  request.headers.forEach((value, name) => headers.push([name, value]));

  const channel = new BroadcastChannel(CHANNEL);
  try {
    return await new Promise((resolve) => {
      let timer = setTimeout(
        () => resolve(errorPage(504, 'No open Dock tab answered for this preview. Keep the Dock tab open (the server runs inside it), then reload.')),
        ACK_TIMEOUT_MS
      );
      const finish = (response) => { clearTimeout(timer); resolve(response); };

      channel.onmessage = (event) => {
        const msg = event.data;
        if (!msg || msg.id !== id) return;
        if (msg.type === 'ack') {
          clearTimeout(timer);
          timer = setTimeout(() => resolve(errorPage(504, 'The server took too long to answer.')), RESPONSE_TIMEOUT_MS);
        } else if (msg.type === 'res') {
          finish(buildResponse(msg, method));
        } else if (msg.type === 'err') {
          finish(errorPage(msg.status || 502, msg.message || 'Unknown error.'));
        }
      };

      channel.postMessage({ type: 'req', id, hostId, method, path, headers, body });
    });
  } finally {
    channel.close();
  }
}

async function addIsolationHeaders(request) {
  try {
    const response = await fetch(request);
    if (response.status === 0) return response; // opaque, can't be rewritten
    const headers = new Headers(response.headers);
    headers.set('Cross-Origin-Embedder-Policy', 'require-corp');
    headers.set('Cross-Origin-Opener-Policy', 'same-origin');
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  } catch (err) {
    return new Response(`coi-serviceworker: fetch failed for ${request.url}: ${err}`, { status: 500 });
  }
}

async function handle(event, url, sameOrigin) {
  const { request } = event;

  // 1. A request for the preview itself.
  const direct = sameOrigin ? parsePreviewPath(url.pathname) : null;
  if (direct) {
    if (direct.path === null) {
      const to = new URL(url);
      to.pathname += '/'; // relative links need the trailing slash
      return Response.redirect(to.href, 302);
    }
    return proxyToHost(direct.hostId, direct.path + url.search, request);
  }

  // 2. A sub-resource requested BY a previewed page (not a navigation).
  //    Root-absolute URLs like "/style.css" escape the preview folder, so
  //    route them to the container too; leave cross-origin ones alone.
  if (request.mode !== 'navigate') {
    const clientHost = await previewHostOfClient(event.clientId);
    if (clientHost) {
      return sameOrigin ? proxyToHost(clientHost, url.pathname + url.search, request) : fetch(request);
    }
  }

  // 3. Everything else (Dock itself): add the isolation headers.
  return addIsolationHeaders(request);
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);
  const sameOrigin = url.origin === self.location.origin;

  // Opaque cross-origin requests can't be rewritten; let them through.
  if (request.mode === 'no-cors' && !sameOrigin) return;
  // Known DevTools quirk: this combination throws if re-fetched.
  if (request.cache === 'only-if-cached' && request.mode !== 'same-origin') return;

  event.respondWith(handle(event, url, sameOrigin));
});
