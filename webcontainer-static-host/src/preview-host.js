// Page side of "open preview in a new tab".
//
// Flow for every request the new tab makes under  <base>/preview/<hostId>/ :
//
//   new tab ──fetch──▶ service worker ──BroadcastChannel──▶ THIS (Dock tab)
//        ◀──Response──            ◀──────── bytes ────────      │ stdin/stdout
//                                                              ▼
//                                          container-bridge.cjs (in the container)
//                                                              │ http://localhost:<port>
//                                                              ▼
//                                                       your static server
//
// The Dock tab has to stay open: the server lives inside it.

const CHANNEL = 'dock-preview';
const MARK = '@@DOCK@@';
const BRIDGE_DIR = 'node_modules/.dock';
const BRIDGE_FILE = `${BRIDGE_DIR}/bridge.cjs`;
const BRIDGE_TIMEOUT_MS = 30000;

function toBase64(arrayBuffer) {
  const bytes = new Uint8Array(arrayBuffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

function fromBase64(b64) {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out.buffer;
}

export function createPreviewHost({ instance, bridgeSource, hostId, getPort }) {
  const channel = new BroadcastChannel(CHANNEL);
  let bridgePromise = null;
  let nextId = 0;

  async function startBridge() {
    await instance.fs.mkdir(`/${BRIDGE_DIR}`, { recursive: true });
    await instance.fs.writeFile(`/${BRIDGE_FILE}`, bridgeSource);

    const proc = await instance.spawn('node', [BRIDGE_FILE]);
    const writer = proc.input.getWriter();
    const pending = new Map();
    let buffer = '';

    proc.output
      .pipeTo(
        new WritableStream({
          write(chunk) {
            buffer += chunk;
            let nl;
            while ((nl = buffer.indexOf('\n')) >= 0) {
              const line = buffer.slice(0, nl).replace(/\r$/, '');
              buffer = buffer.slice(nl + 1);
              if (!line.startsWith(MARK)) continue; // ignore stray output
              let msg;
              try {
                msg = JSON.parse(line.slice(MARK.length));
              } catch {
                continue;
              }
              const waiter = pending.get(msg.id);
              if (waiter) {
                pending.delete(msg.id);
                waiter.resolve(msg);
              }
            }
          },
        })
      )
      .catch(() => {});

    proc.exit.then(() => {
      bridgePromise = null;
      for (const waiter of pending.values()) waiter.reject(new Error('The in-container bridge stopped.'));
      pending.clear();
    });

    return { proc, writer, pending };
  }

  function ensureBridge() {
    if (!bridgePromise) {
      bridgePromise = startBridge().catch((err) => {
        bridgePromise = null;
        throw err;
      });
    }
    return bridgePromise;
  }

  async function bridgeFetch({ port, method, path, headers, body }) {
    const { writer, pending } = await ensureBridge();
    const id = ++nextId;

    const reply = new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (pending.delete(id)) reject(new Error('The server did not answer in time.'));
      }, BRIDGE_TIMEOUT_MS);
    });

    await writer.write(
      JSON.stringify({ id, port, method, path, headers, body: body ? toBase64(body) : null }) + '\n'
    );
    return reply;
  }

  channel.onmessage = async (event) => {
    const msg = event.data;
    if (!msg || msg.type !== 'req' || msg.hostId !== hostId) return;

    // Tell the service worker a Dock tab owns this preview, so it keeps waiting.
    channel.postMessage({ type: 'ack', id: msg.id });

    const port = getPort();
    if (!port) {
      channel.postMessage({
        type: 'err',
        id: msg.id,
        status: 503,
        message: 'No server is running in the Dock tab right now. Start it there, then reload this page.',
      });
      return;
    }

    try {
      const res = await bridgeFetch({
        port,
        method: msg.method,
        path: msg.path,
        headers: msg.headers,
        body: msg.body,
      });
      if (res.error) {
        channel.postMessage({ type: 'err', id: msg.id, status: 502, message: res.error });
        return;
      }
      channel.postMessage({
        type: 'res',
        id: msg.id,
        status: res.status,
        headers: res.headers,
        body: fromBase64(res.body),
      });
    } catch (err) {
      channel.postMessage({
        type: 'err',
        id: msg.id,
        status: 502,
        message: String((err && err.message) || err),
      });
    }
  };

  return {
    close() {
      channel.close();
    },
  };
}
