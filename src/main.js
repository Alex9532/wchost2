import { WebContainer } from '@webcontainer/api';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';

// ---------------------------------------------------------------------------
// Constants / initial in-container filesystem
// ---------------------------------------------------------------------------

const DEFAULT_INDEX_HTML = `<!doctype html>
<html>
  <head><meta charset="utf-8" /><title>Your site</title></head>
  <body style="font-family: system-ui; padding: 3rem; color: #333;">
    <h1>Upload your static site</h1>
    <p>Replace these files (via the sidebar) with your own HTML/CSS/JS,
       then click <strong>Install &amp; start server</strong>.</p>
  </body>
</html>
`;

const DEFAULT_PACKAGE_JSON = JSON.stringify(
  {
    name: 'static-site',
    private: true,
    version: '0.0.0',
    scripts: {
      // "serve" mirrors what GitHub Pages does: it hands back whatever
      // static files exist in the directory, as-is, with no build step.
      start: 'serve . -l 3000',
    },
    devDependencies: {
      serve: '^14.2.1',
    },
  },
  null,
  2
);

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
const btnServe = $('#btn-serve');
const btnStopServe = $('#btn-stop-serve');
const previewFrame = $('#preview-frame');
const previewEmpty = $('#preview-empty');
const previewUrlEl = $('#preview-url');
const previewDot = $('.dot-preview');
const btnReloadPreview = $('#btn-reload-preview');
const btnOpenPreview = $('#btn-open-preview');

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

  setStep('boot', 'active');
  try {
    webcontainerInstance = await WebContainer.boot();
  } catch (err) {
    setStep('boot', 'error');
    logLine(`Boot failed: ${err.message ?? err}`);
    return;
  }
  setStep('boot', 'done');

  setStep('mount', 'active');
  await webcontainerInstance.mount({
    'index.html': { file: { contents: DEFAULT_INDEX_HTML } },
    'package.json': { file: { contents: DEFAULT_PACKAGE_JSON } },
  });
  setStep('mount', 'done');

  webcontainerInstance.on('server-ready', (port, url) => {
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

async function writeUploadedFile(relPath, file) {
  const clean = relPath.replace(/^\/+/, '');
  const dir = clean.includes('/') ? '/' + clean.slice(0, clean.lastIndexOf('/')) : '';
  if (dir) await ensureDir(dir);
  const buffer = new Uint8Array(await file.arrayBuffer());
  await webcontainerInstance.fs.writeFile('/' + clean, buffer);
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
// Install & serve
// ---------------------------------------------------------------------------

async function runAndPipe(command, args) {
  logLine(`$ ${command} ${args.join(' ')}`);
  const proc = await webcontainerInstance.spawn(command, args);
  proc.output.pipeTo(new WritableStream({ write: (d) => term.write(d) }));
  return proc;
}

btnServe.addEventListener('click', async () => {
  btnServe.disabled = true;
  setStep('install', 'active');
  try {
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

    serverProcess = await runAndPipe('npm', ['run', 'start']);
    pidBadge.textContent = 'server running';
    serverProcess.exit.then((code) => {
      pidBadge.textContent = 'no process';
      if (code !== 0) {
        logLine(`Server process exited with code ${code}`);
      }
      resetPreview();
    });
  } catch (err) {
    setStep('serve', 'error');
    logLine(`Failed to start server: ${err.message ?? err}`);
    btnServe.disabled = false;
  }
});

btnStopServe.addEventListener('click', () => {
  if (serverProcess) {
    serverProcess.kill();
    serverProcess = null;
  }
  resetPreview();
  btnServe.disabled = false;
  setStep('serve', null);
  setStep('install', null);
});

function resetPreview() {
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
btnOpenPreview.addEventListener('click', () => {
  if (previewFrame.src && previewFrame.src !== 'about:blank') {
    window.open(previewFrame.src, '_blank');
  }
});

// ---------------------------------------------------------------------------

boot();
