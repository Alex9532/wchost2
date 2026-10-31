# Dock — a browser-based static site host

Runs a real Node.js environment *inside the browser tab* using StackBlitz's
[WebContainers](https://webcontainers.io), boots a static file server in it
(`serve`, the same idea as GitHub Pages: whatever files exist get served
as-is), and gives you a terminal and file upload UI to drive it.

Nothing is installed on your machine and no server runs anywhere except the
browser tab — closing the tab throws the whole environment away.

## Why this is a project you run, not an in-chat preview

WebContainers need `SharedArrayBuffer`, which browsers only grant to pages
that are **cross-origin isolated** — meaning the page (and everything it
loads) was served with two specific response headers,
`Cross-Origin-Embedder-Policy: require-corp` and
`Cross-Origin-Opener-Policy: same-origin`. That's a property of the HTTP
response, so it can only be set by whatever is actually serving the page.
A chat sandbox can't set those headers, which is why this ships as a small
project for you to run rather than something previewable in-conversation.

## Run it

Requirements: Node.js 18+, and a Chromium-based browser (Chrome, Edge, Brave)
— WebContainers' browser support is strongest there.

```bash
npm install
npm run dev
```

Open the printed `http://localhost:5173` URL. The included `vite.config.js`
already sets the COOP/COEP headers above for its dev server, so no extra
setup is needed locally.

## Using it

- **Upload** — drag a folder (or individual files) onto the drop zone in the
  sidebar, or use the "Upload files" / "Upload folder" buttons. Everything
  lands in the container's root, preserving the folder structure you drop in.
- **Container FS** — the sidebar tree mirrors what's actually inside the
  container. Click the refresh icon after running shell commands that change
  files, since it doesn't auto-poll.
- **Install & start server** — runs `npm install` then `npm run start`
  inside the container (defined in the container's own `package.json`,
  which defaults to serving the current directory on port 3000 via `serve`).
  The preview pane fills in automatically once the container reports the
  server is ready.
- **Terminal** — a real shell (`jsh`) running inside the container. Use it
  for anything the buttons don't cover: `npm install <pkg>`, running a build
  step for a framework (e.g. `npm run build` for a Vite/React app) before
  serving the `dist/` output, inspecting files, etc.

### The three preview buttons

- **⟳ Reload** — reloads the preview pane.
- **↗ Open in new tab** — opens the site in its own browser tab.
- **⤢ Full screen** — expands the preview pane over the whole window (✕ to leave).

StackBlitz's own preview URL can't be opened in a separate tab by apps built
on `@webcontainer/api` (it shows a "connect this tab to its project" screen
that only works with StackBlitz's editor, and browsers partition its storage).
So **↗** doesn't use that URL. Instead:

1. The service worker serves `<this site>/preview/<id>/…` itself.
2. For each request it asks the Dock tab (over a `BroadcastChannel`).
3. The Dock tab asks a tiny Node relay running *inside the container*
   (`src/container-bridge.cjs`) to request the file from the container's
   server on `localhost`, and sends the bytes back.

What that means in practice:

- **Keep the Dock tab open.** The server lives inside it; close it and the
  other tab shows "no open Dock tab answered".
- It needs a service worker, so Dock must be served over **HTTPS or
  `http://localhost`**. Locally, `npm run dev` or any static server on
  localhost is fine. `file://` pages and plain-HTTP LAN addresses can't run
  WebContainers at all. If ↗ can't work, Dock shows a notice saying why.
- It works with any server running in the container, not just the default
  one, because it proxies to whichever port was reported last.
- Not supported in the new tab: WebSockets / live-reload, and links that
  navigate to root-absolute paths (`<a href="/about">`). Root-absolute
  *sub-resources* (`/style.css`, `/app.js`) do work.
- **Trust what you preview.** The new tab shares an origin with Dock (and,
  on GitHub Pages, with every other project site under your `github.io`
  account). Its scripts can read that origin's `localStorage`. The embedded
  preview pane doesn't have this issue because it lives on StackBlitz's origin.

### Hosting something with a build step

If what you're uploading isn't plain static HTML/CSS/JS but a project that
needs building first (React, Vue, a static-site generator...), upload the
whole project, then in the terminal run its install and build commands
yourself, and finally edit the container's `package.json` `start` script (or
just run a serve command directly in the terminal) to point at the build
output directory, e.g. `serve dist -l 3000`.

## Deploying this tool itself

If you want *this tool* reachable at a URL instead of run locally:

```bash
npm run build
```

Deploy the `dist/` folder to any static host. There are two paths depending
on whether the host lets you set response headers:

**Netlify or Vercel (real headers)** — both support custom response headers,
so the deployed page gets genuine COOP/COEP headers, same as local dev:
- `public/_headers` is picked up automatically by Netlify.
- `vercel.json` is picked up automatically by Vercel.

**GitHub Pages (no header support — service worker instead)** — GitHub
Pages won't let you set custom headers at all, so this project also ships
`public/coi-bootstrap.js` and `public/coi-serviceworker.js`, which emulate
the two headers client-side:

1. `coi-bootstrap.js` is a plain blocking `<script>` (loaded before the app)
   that, if the page *isn't* already cross-origin isolated, registers
   `coi-serviceworker.js` and reloads the page once.
2. From then on, that service worker sits between the page and the network:
   it can't change what GitHub's servers actually sent, but it intercepts
   every fetch this page makes — including the top-level document itself,
   once it's in control — and hands back a copy of the response with
   `Cross-Origin-Embedder-Policy: require-corp` and
   `Cross-Origin-Opener-Policy: same-origin` added. The browser only looks
   at the response it receives, so it doesn't matter that a worker, not the
   server, added them.
3. `main.js` checks a flag the bootstrap script sets so it shows "enabling
   isolation, reloading…" instead of a false error during that one reload.

This is a well-established workaround (the pattern behind the
[`coi-serviceworker`](https://github.com/gzuidhof/coi-serviceworker)
project, also used by [WebContainers-on-Pages
demos](https://github.com/garrettmflynn/webcontainers-ghpages)) — not
something specific to this project. A few things worth knowing about it:

- It only works over HTTPS (GitHub Pages is HTTPS by default) or on
  `localhost`.
- Support is strongest in Chromium browsers; it's more inconsistent in
  Firefox and known to be unreliable in Safari. `require-corp` (used here,
  rather than the newer `credentialless` mode) is the more broadly
  supported option of the two.
- If it ever gets stuck after a GitHub Pages deploy, clear it via DevTools
  → Application → Service Workers → Unregister, then reload.

To actually publish: push this repo to GitHub, enable **Pages → Source:
GitHub Actions** in the repo settings, and the included
`.github/workflows/deploy.yml` will build and deploy on every push to
`main`.

Either deployment path gets you the same result: a page where
`window.crossOriginIsolated` is `true`, so `WebContainer.boot()` can run.
