import { WebContainer } from '@webcontainer/api';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import bridgeSource from './container-bridge.cjs?raw';
import { createPreviewHost } from './preview-host.js';
import staticServerSource from './static-server.cjs?raw';
import { importGitHubRepo } from './github-import.js';

// ---------------------------------------------------------------------------
// Constants / initial in-container filesystem
// ---------------------------------------------------------------------------

const DEFAULT_INDEX_HTML = `<!doctype html>
<html>
  <head><meta charset="utf-8" /><title>Your site</title></head>
  <body style="font-family: system-ui; padding: 3rem; color: #333;">
    <h1>Dock is running</h1>
    <p>Import a GitHub repo or upload your own files from the sidebar,
       then click <strong>Start server</strong>.</p>
  </body>
</html>
`;

// Built-in static server (src/static-server.cjs). It is written into the
// container on demand, so a plain static site needs no package.json and no
// npm install.
const STATIC_SERVER_FILE = 'node_modules/.dock/static-server.cjs';
const STATIC_SERVER_PORT = 3000;

const IGNORED_DIRS = new Set(['node_modules', '.git']);

// ---------------------------------------------------------------------------
// DOM references
// ---------------------------------------------------------------------------

const $ = (sel) => document.querySelector(sel);

const ticker = $('#boot-ticker');
const pidBadge = $('#pid-badge');
const dropzone = $('#dropzone');
const inputFiles = $('#input-files');
const inputFolder = $('#input-folder');
const btnUploadFiles = $('#btn-upload-files');
const btnUploadFolder = $('#btn-upload-folder');
const btnRefreshTree = $('#btn-refresh-tree');
const fileTreeEl = $('#file-tree');
const importInput = $('#import-input');
const btnImport = $('#btn-import');
const importReplace = $('#import-replace');
const importStatus = $('#import-status');
const btnServe = $('#btn-serve');
const btnStopServe = $('#btn-stop-serve');
const previewFrame = $('#preview-frame');
const previewEmpty = $('#preview-empty');
const previewUrlEl = $('#preview-url');
const previewDot = $('.dot-preview');
const btnReloadPreview = $('#btn-reload-preview');
const btnOpenPreview = $('#btn-open-preview');
const btnFullscreenPreview = $('#btn-fullscreen-preview');
const previewPanel = $('.preview-panel');
const previewNotice = $('#preview-notice');
const previewNoticeText = $('#preview-notice-text');
const previewNoticeClose = $('#preview-notice-close');

// ---------------------------------------------------------------------------
// Boot ticker
// ---------------------------------------------------------------------------

function setStep(step, state) {
  const el = ticker.querySelector(`[data-step="${step}"]`);
  if (!el) return;
  el.classList.remove('active', 'done', 'error');
  if (state) el.classList.add(state);
}

// ---------------------------------------------------------------------------
// Terminal
// ---------------------------------------------------------------------------

const term = new Terminal({
  convertEol: true,
  fontFamily: '"IBM Plex Mono", monospace',
  fontSize: 13,
  cursorBlink: true,
  theme: {
    background: '#05070a',
    foreground: '#edeae3',
    cursor: '#e7a33e',
    selectionBackground: '#e7a33e55',
  },
});
const fitAddon = new FitAddon();
term.loadAddon(fitAddon);
term.open(document.getElementById('terminal'));
fitAddon.fit();
window.addEventListener('resize', () => {
  try { fitAddon.fit(); } catch {}
  if (shellProcess) {
    shellProcess.resize({ cols: term.cols, rows: term.rows });
  }
});

function logLine(text) {
  term.write(`\r\n\x1b[90m${text}\x1b[0m\r\n`);
}

let shellProcess = null;
let serverProcess = null;
let webcontainerInstance = null;
let activePort = null; // port of the most recent server the container reported
let previewHost = null;

// Identifies this Dock tab; the new-tab preview URL contains it so the
// service worker knows which tab to ask for files.
const hostId = Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => (b % 36).toString(36)).join('');

// ---------------------------------------------------------------------------
// Boot sequence
// ---------------------------------------------------------------------------

async function boot() {
  if (!window.crossOriginIsolated) {
    if (window.__coiBootstrap && window.__coiBootstrap.pending) {
      // coi-bootstrap.js is registering the COI service worker and will
      // reload this page momentarily so isolation can take effect.
      setStep('boot', 'active');
      logLine('Enabling cross-origin isolation via a service worker — the page will reload automatically…');
      return;
    }
    setStep('boot', 'error');
    logLine(
      'This page is not cross-origin isolated, so the browser will not ' +
      'grant SharedArrayBuffer and WebContainer.boot() will fail. ' +
      'Locally, run this app with `npm run dev` (the Vite config sets the ' +
      'required COOP/COEP headers). On a static host like GitHub Pages, ' +
      'coi-bootstrap.js should have registered a service worker to emulate ' +
      'those headers instead — if you still see this, your browser may not ' +
      'support Service Workers, the page isn\'t served over HTTPS, or the ' +
      'service worker needs to be unregistered and re-registered (DevTools ' +
      '→ Application → Service Workers).'
    );
    return;
  }

  registerPreviewWorker();

  setStep('boot', 'active');
  try {
    webcontainerInstance = await WebContainer.boot();
  } catch (err) {
    setStep('boot', 'error');
    logLine(`Boot failed: ${err.message ?? err}`);
    return;
  }
  setStep('boot', 'done');

  previewHost = createPreviewHost({
    instance: webcontainerInstance,
    bridgeSource,
    hostId,
    getPort: () => activePort,
  });

  setStep('mount', 'active');
  await webcontainerInstance.mount({
    'index.html': { file: { contents: DEFAULT_INDEX_HTML } },
  });
  setStep('mount', 'done');

  webcontainerInstance.on('server-ready', (port, url) => {
    activePort = port;
    hideNotice();
    setStep('serve', 'done');
    previewFrame.src = url;
    previewFrame.classList.remove('hidden');
    previewEmpty.style.display = 'none';
    previewUrlEl.textContent = url;
    previewDot.classList.add('live');
    btnStopServe.disabled = false;
    btnServe.disabled = true;
  });

  webcontainerInstance.on('port', (port, type) => {
    if (type === 'close') {
      if (port === activePort) activePort = null;
      previewDot.classList.remove('live');
    }
  });

  await startShell();
  await refreshTree();
  logLine('Ready. Upload files on the left, then "Install & start server" — or drive npm yourself right here.');
}

async function startShell() {
  shellProcess = await webcontainerInstance.spawn('jsh', {
    terminal: { cols: term.cols, rows: term.rows },
  });
  shellProcess.output.pipeTo(
    new WritableStream({
      write(data) {
        term.write(data);
      },
    })
  );
  const input = shellProcess.input.getWriter();
  term.onData((data) => {
    input.write(data);
  });
  // Whenever the shell writes to the fs, our tree view goes stale —
  // cheap fix is a manual refresh button, but also poll lightly.
}

// ---------------------------------------------------------------------------
// File tree
// ---------------------------------------------------------------------------

async function buildTree(path) {
  const entries = await webcontainerInstance.fs.readdir(path, { withFileTypes: true });
  const items = [];
  for (const entry of entries) {
    if (IGNORED_DIRS.has(entry.name)) continue;
    if (entry.isDirectory()) {
      const children = await buildTree(`${path}/${entry.name}`.replace('//', '/'));
      items.push({ type: 'dir', name: entry.name, children });
    } else {
      items.push({ type: 'file', name: entry.name });
    }
  }
  items.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return items;
}

function renderTree(items) {
  if (items.length === 0) return '';
  const lis = items
    .map((item) => {
      if (item.type === 'dir') {
        return `<li><span class="name-dir">${item.name}</span>${renderTree(item.children)}</li>`;
      }
      return `<li><span class="name-file">${item.name}</span></li>`;
    })
    .join('');
  return `<ul>${lis}</ul>`;
}

async function refreshTree() {
  try {
    const tree = await buildTree('/');
    fileTreeEl.innerHTML = tree.length
      ? renderTree(tree)
      : '<p class="hint muted">Empty.</p>';
  } catch (err) {
    fileTreeEl.innerHTML = `<p class="hint muted">Could not read tree: ${err.message ?? err}</p>`;
  }
}

btnRefreshTree.addEventListener('click', refreshTree);

// ---------------------------------------------------------------------------
// Uploads
// ---------------------------------------------------------------------------

async function ensureDir(path) {
  if (!path || path === '/') return;
  await webcontainerInstance.fs.mkdir(path, { recursive: true });
}

async function writeBytes(relPath, bytes) {
  const clean = relPath.replace(/^\/+/, '');
  const dir = clean.includes('/') ? '/' + clean.slice(0, clean.lastIndexOf('/')) : '';
  if (dir) await ensureDir(dir);
  await webcontainerInstance.fs.writeFile('/' + clean, bytes);
}

async function writeUploadedFile(relPath, file) {
  await writeBytes(relPath, new Uint8Array(await file.arrayBuffer()));
}

async function uploadEntries(entries) {
  logLine(`Writing ${entries.length} file(s)…`);
  for (const { path, file } of entries) {
    await writeUploadedFile(path, file);
  }
  await refreshTree();
  logLine('Upload complete.');
}

btnUploadFiles.addEventListener('click', () => inputFiles.click());
btnUploadFolder.addEventListener('click', () => inputFolder.click());

inputFiles.addEventListener('change', async (e) => {
  const files = Array.from(e.target.files || []);
  await uploadEntries(files.map((f) => ({ path: f.name, file: f })));
  e.target.value = '';
});

inputFolder.addEventListener('change', async (e) => {
  const files = Array.from(e.target.files || []);
  await uploadEntries(
    files.map((f) => ({ path: f.webkitRelativePath || f.name, file: f }))
  );
  e.target.value = '';
});

// Drag & drop, including whole folders via the FileSystem entry API.
['dragenter', 'dragover'].forEach((evt) =>
  dropzone.addEventListener(evt, (e) => {
    e.preventDefault();
    dropzone.classList.add('drag-over');
  })
);
['dragleave', 'drop'].forEach((evt) =>
  dropzone.addEventListener(evt, (e) => {
    e.preventDefault();
    dropzone.classList.remove('drag-over');
  })
);

async function readEntry(entry, prefix, out) {
  if (entry.isFile) {
    const file = await new Promise((res, rej) => entry.file(res, rej));
    out.push({ path: prefix + entry.name, file });
  } else if (entry.isDirectory) {
    const reader = entry.createReader();
    // readEntries must be called repeatedly until it returns [].
    let batch;
    do {
      batch = await new Promise((res, rej) => reader.readEntries(res, rej));
      for (const child of batch) {
        await readEntry(child, `${prefix}${entry.name}/`, out);
      }
    } while (batch.length > 0);
  }
}

dropzone.addEventListener('drop', async (e) => {
  const items = Array.from(e.dataTransfer.items || []);
  const out = [];
  const entryPromises = items
    .map((item) => item.webkitGetAsEntry?.())
    .filter(Boolean)
    .map((entry) => readEntry(entry, '', out));

  if (entryPromises.length > 0) {
    await Promise.all(entryPromises);
    await uploadEntries(out);
  } else {
    // Fallback for browsers without the entry API.
    const files = Array.from(e.dataTransfer.files || []);
    await uploadEntries(files.map((f) => ({ path: f.name, file: f })));
  }
});

// ---------------------------------------------------------------------------
// Import from GitHub
// ---------------------------------------------------------------------------

async function clearFilesystem() {
  stopServer(); // a running server would be serving files that are about to vanish
  const fs = webcontainerInstance.fs;
  for (const name of await fs.readdir('/')) {
    await fs.rm('/' + name, { recursive: true, force: true });
  }
}

function formatBytes(n) {
  return n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;
}

async function runImport() {
  if (!webcontainerInstance) return;
  btnImport.disabled = true;
  importInput.disabled = true;
  importStatus.classList.remove('error');
  importStatus.textContent = 'Looking up repository…';

  try {
    const result = await importGitHubRepo({
      input: importInput.value,
      writeFile: writeBytes,
      prepare: async () => {
        if (importReplace.checked) await clearFilesystem();
      },
      confirmLarge: async ({ count, size }) =>
        window.confirm(`This will download ${count} files (about ${formatBytes(size)}). Continue?`),
      onProgress: ({ phase, done, total }) => {
        importStatus.textContent =
          phase === 'downloading' ? `Downloading ${done} / ${total} files…` : 'Looking up repository…';
      },
    });

    await refreshTree();
    const where = `${result.owner}/${result.repo}@${result.ref}${result.subdir ? '/' + result.subdir : ''}`;
    let message = `Imported ${result.written} file${result.written === 1 ? '' : 's'} from ${where}.`;
    if (result.failed.length) {
      importStatus.classList.add('error');
      message += ` ${result.failed.length} failed: ${result.failed.slice(0, 3).join(', ')}${result.failed.length > 3 ? '…' : ''}`;
    }
    if (result.submodules) message += ` (${result.submodules} submodule${result.submodules === 1 ? '' : 's'} skipped.)`;
    importStatus.textContent = message;
    logLine(message + ' Click "Start server" to preview it.');
  } catch (err) {
    importStatus.classList.add('error');
    importStatus.textContent = String(err.message || err);
  } finally {
    btnImport.disabled = false;
    importInput.disabled = false;
  }
}

btnImport.addEventListener('click', runImport);
importInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') runImport();
});

// ---------------------------------------------------------------------------
// Install & serve
// ---------------------------------------------------------------------------

async function runAndPipe(command, args) {
  logLine(`$ ${command} ${args.join(' ')}`);
  const proc = await webcontainerInstance.spawn(command, args);
  proc.output.pipeTo(new WritableStream({ write: (d) => term.write(d) }));
  return proc;
}

async function readPackageJson() {
  try {
    return JSON.parse(await webcontainerInstance.fs.readFile('/package.json', 'utf-8'));
  } catch {
    return null;
  }
}

// Projects with their own "start" (or "dev") script run that, after an
// `npm install`. Everything else is served by the built-in static server,
// which needs no install and follows GitHub Pages' conventions.
btnServe.addEventListener('click', async () => {
  btnServe.disabled = true;
  try {
    const pkg = await readPackageJson();
    const script = pkg?.scripts?.start ? 'start' : pkg?.scripts?.dev ? 'dev' : null;
    let proc;

    if (script) {
      setStep('install', 'active');
      const install = await runAndPipe('npm', ['install']);
      const installCode = await install.exit;
      if (installCode !== 0) {
        setStep('install', 'error');
        logLine(`npm install exited with code ${installCode}`);
        btnServe.disabled = false;
        return;
      }
      setStep('install', 'done');
      setStep('serve', 'active');
      proc = await runAndPipe('npm', ['run', script]);
    } else {
      setStep('install', 'done'); // nothing to install
      setStep('serve', 'active');
      await webcontainerInstance.fs.mkdir('/node_modules/.dock', { recursive: true });
      await webcontainerInstance.fs.writeFile(`/${STATIC_SERVER_FILE}`, staticServerSource);
      proc = await runAndPipe('node', [STATIC_SERVER_FILE, String(STATIC_SERVER_PORT)]);
    }

    serverProcess = proc;
    pidBadge.textContent = 'server running';
    proc.exit.then((code) => {
      if (serverProcess !== proc) return; // already stopped or replaced
      serverProcess = null;
      if (code !== 0) logLine(`Server process exited with code ${code}`);
      resetPreview();
      btnServe.disabled = false;
    });
  } catch (err) {
    setStep('serve', 'error');
    logLine(`Failed to start server: ${err.message ?? err}`);
    btnServe.disabled = false;
  }
});

function stopServer() {
  if (serverProcess) {
    serverProcess.kill();
    serverProcess = null;
  }
  resetPreview();
  btnServe.disabled = false;
  setStep('serve', null);
  setStep('install', null);
}

btnStopServe.addEventListener('click', stopServer);

function resetPreview() {
  activePort = null;
  hideNotice();
  previewPanel.classList.remove('expanded');
  previewFrame.src = 'about:blank';
  previewFrame.classList.add('hidden');
  previewEmpty.style.display = 'flex';
  previewUrlEl.textContent = 'not running';
  previewDot.classList.remove('live');
  btnStopServe.disabled = true;
  pidBadge.textContent = 'no process';
}

btnReloadPreview.addEventListener('click', () => {
  if (previewFrame.src && previewFrame.src !== 'about:blank') {
    previewFrame.src = previewFrame.src;
  }
});

// ---------------------------------------------------------------------------
// Open in new tab / full screen
// ---------------------------------------------------------------------------

// The container's own preview URL can't be opened in a separate tab (browsers
// partition its storage, and StackBlitz's "connect" page only supports their
// editor). Instead a service worker on THIS site serves the tab, fetching
// files from this Dock tab. See src/preview-host.js.

function registerPreviewWorker() {
  if (!('serviceWorker' in navigator) || !window.isSecureContext) return;
  navigator.serviceWorker
    .register('coi-serviceworker.js', { scope: './' })
    .catch((err) => console.warn('Preview service worker registration failed:', err));
}

function showNotice(message) {
  previewNoticeText.textContent = message;
  previewNotice.hidden = false;
}
function hideNotice() {
  previewNotice.hidden = true;
}
previewNoticeClose.addEventListener('click', hideNotice);

// Returns a human-readable reason the new-tab preview can't work, or null.
function previewProblem() {
  if (!('serviceWorker' in navigator)) {
    return 'Opening in a new tab needs service workers, which this browser or context doesn\'t provide (file:// pages, some private modes). Serve Dock over http://localhost or HTTPS, or use the full-screen button instead.';
  }
  if (!window.isSecureContext) {
    return 'Opening in a new tab needs HTTPS or http://localhost. This page was opened over plain HTTP (for example a LAN address), so service workers are blocked. Use the full-screen button instead.';
  }
  if (!navigator.serviceWorker.controller) {
    return 'The preview service worker isn\'t controlling this page yet. Reload the page once, start the server again, and retry.';
  }
  if (!activePort) {
    return 'Nothing is being served yet. Start the server first, then open it in a new tab.';
  }
  return null;
}

btnOpenPreview.addEventListener('click', () => {
  const problem = previewProblem();
  if (problem) {
    showNotice(problem);
    return;
  }
  hideNotice();
  const url = new URL(`preview/${hostId}/`, document.baseURI).href;
  const tab = window.open(url, '_blank');
  if (!tab) {
    showNotice('Your browser blocked the new tab. Allow pop-ups for this site and try again.');
  }
});

btnFullscreenPreview.addEventListener('click', () => {
  const on = previewPanel.classList.toggle('expanded');
  btnFullscreenPreview.textContent = on ? '✕' : '⤢';
  btnFullscreenPreview.title = on ? 'Exit full screen' : 'Full screen';
});

// ---------------------------------------------------------------------------

boot();
