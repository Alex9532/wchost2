// Runs INSIDE the WebContainer (plain Node, CommonJS). Dock writes this file
// into the container and spawns it. It is a tiny HTTP relay:
//
//   stdin  : one JSON request per line  {id, port, method, path, headers, body(base64|null)}
//   stdout : one line per response       @@DOCK@@{id, status, headers, body(base64)}
//                                        @@DOCK@@{id, error}
//
// Why it exists: the container's real preview URL only works inside an
// iframe of the Dock page (browsers partition its storage otherwise), so a
// separate tab can't reach it. Inside the container, though, servers ARE
// reachable on localhost — so this process makes the request from in there
// and hands the bytes back over stdio.

const http = require('http');

const MARK = '@@DOCK@@';

// Request headers that must not be forwarded as-is.
const DROP_REQUEST_HEADERS = new Set([
  'host', 'connection', 'content-length', 'accept-encoding', 'keep-alive',
  'transfer-encoding', 'upgrade', 'if-none-match', 'if-modified-since', 'range',
  'if-range',
]);

function send(obj) {
  process.stdout.write(MARK + JSON.stringify(obj) + '\n');
}

function handle(line) {
  let req;
  try {
    req = JSON.parse(line);
  } catch {
    return;
  }

  const headers = {};
  for (const [name, value] of req.headers || []) {
    if (!DROP_REQUEST_HEADERS.has(String(name).toLowerCase())) headers[name] = value;
  }
  // Ask for uncompressed bytes so what we relay is exactly what the page gets.
  headers['accept-encoding'] = 'identity';

  const body = req.body ? Buffer.from(req.body, 'base64') : null;
  if (body) headers['content-length'] = String(body.length);

  const upstream = http.request(
    { host: 'localhost', port: req.port, method: req.method, path: req.path, headers },
    (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const pairs = [];
        for (const [name, value] of Object.entries(res.headers)) {
          if (Array.isArray(value)) value.forEach((v) => pairs.push([name, v]));
          else pairs.push([name, String(value)]);
        }
        send({
          id: req.id,
          status: res.statusCode,
          headers: pairs,
          body: Buffer.concat(chunks).toString('base64'),
        });
      });
      res.on('error', (err) => send({ id: req.id, error: String(err && err.message || err) }));
    }
  );

  upstream.on('error', (err) => send({ id: req.id, error: String(err && err.message || err) }));
  if (body) upstream.write(body);
  upstream.end();
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let nl;
  while ((nl = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, nl);
    buffer = buffer.slice(nl + 1);
    if (line.trim()) handle(line);
  }
});
