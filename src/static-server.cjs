// Runs INSIDE the WebContainer (plain Node, no dependencies, so no
// `npm install` is needed). A small static file server that follows
// GitHub Pages' conventions:
//   /dir      -> redirects to /dir/ when it's a folder
//   /dir/     -> serves /dir/index.html
//   /page     -> serves /page.html when there is no file or folder named "page"
//   anything missing -> /404.html if present (with status 404), else plain 404
//
// Usage: node static-server.cjs [port]    (serves the current directory)

const http = require('http');
const fs = require('fs');
const path = require('path');

const port = Number(process.argv[2]) || 3000;
const root = process.cwd();

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8', '.xml': 'application/xml; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.avif': 'image/avif', '.ico': 'image/x-icon', '.bmp': 'image/bmp',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg',
  '.mp4': 'video/mp4', '.webm': 'video/webm',
  '.pdf': 'application/pdf', '.wasm': 'application/wasm', '.zip': 'application/zip',
  '.csv': 'text/csv; charset=utf-8', '.webmanifest': 'application/manifest+json',
};

function statOrNull(p) {
  try { return fs.statSync(p); } catch { return null; }
}

function insideRoot(full) {
  return full === root || full.startsWith(root + path.sep);
}

function sendFile(req, res, file, status) {
  const stat = fs.statSync(file);
  res.writeHead(status, {
    'content-type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
    'content-length': stat.size,
    'cache-control': 'no-cache',
  });
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(file).pipe(res);
}

function notFound(req, res) {
  const custom = path.join(root, '404.html');
  const stat = statOrNull(custom);
  if (stat && stat.isFile()) return sendFile(req, res, custom, 404);
  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
  res.end(req.method === 'HEAD' ? undefined : 'Not found');
}

const server = http.createServer((req, res) => {
  const finish = () => console.log(`${req.method} ${req.url} ${res.statusCode}`);
  res.on('finish', finish);

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { allow: 'GET, HEAD' });
    return res.end();
  }

  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch {
    res.writeHead(400);
    return res.end('Bad request');
  }

  // Never expose Dock's own helper files.
  if (pathname === '/node_modules/.dock' || pathname.startsWith('/node_modules/.dock/')) {
    return notFound(req, res);
  }

  const full = path.join(root, pathname);
  if (!insideRoot(full)) return notFound(req, res);

  const stat = statOrNull(full);
  if (stat && stat.isDirectory()) {
    if (!pathname.endsWith('/')) {
      const search = new URL(req.url, 'http://localhost').search;
      res.writeHead(301, { location: pathname + '/' + search });
      return res.end();
    }
    const index = path.join(full, 'index.html');
    const indexStat = statOrNull(index);
    if (indexStat && indexStat.isFile()) return sendFile(req, res, index, 200);
    return notFound(req, res);
  }
  if (stat && stat.isFile()) return sendFile(req, res, full, 200);

  if (!pathname.endsWith('/')) {
    const withHtml = full + '.html';
    const htmlStat = statOrNull(withHtml);
    if (htmlStat && htmlStat.isFile()) return sendFile(req, res, withHtml, 200);
  }
  return notFound(req, res);
});

server.listen(port, () => {
  console.log(`Serving ${root} on port ${port}`);
});
