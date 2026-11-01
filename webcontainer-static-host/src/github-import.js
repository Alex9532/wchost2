// Import a public GitHub repo (or one folder of it) into the container.
//
// Why not just download the repo's .zip? codeload.github.com only allows
// cross-origin reads from github's own domains, so a browser page can't fetch
// it. What does allow it: the REST API (for the file list) and
// raw.githubusercontent.com (for file contents). That costs one API call per
// import; file contents don't count against the API rate limit.
//
// Public repos only. Unauthenticated API access is limited to 60 requests per
// hour per IP address.

const API = 'https://api.github.com';
const RAW = 'https://raw.githubusercontent.com';

const OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/;
const REPO_RE = /^[A-Za-z0-9._-]+$/;

const CONCURRENCY = 8;
const LARGE_FILE_COUNT = 1500;
const LARGE_TOTAL_BYTES = 30 * 1024 * 1024;
const MAX_TOTAL_BYTES = 250 * 1024 * 1024;

/**
 * Accepts:  owner/repo   owner/repo#branch   github.com/owner/repo
 *           https://github.com/owner/repo(.git)
 *           https://github.com/owner/repo/tree/<branch>/<folder>
 *           git@github.com:owner/repo.git
 * Returns { owner, repo, ref, subdir, treeSegments }.
 *  - ref is null when the default branch should be used.
 *  - treeSegments is set for /tree/ links: the branch name and folder can't be
 *    told apart when a branch contains "/", so the importer tries a few splits.
 */
export function parseGitHubInput(input) {
  let text = String(input || '').trim();
  if (!text) throw new Error('Enter a repository, like owner/repo or a github.com link.');

  let ref = null;
  const hash = text.indexOf('#');
  if (hash > -1) {
    ref = text.slice(hash + 1).trim() || null;
    text = text.slice(0, hash);
  }
  text = text.split('?')[0];

  text = text
    .replace(/^git@github\.com:/i, '')
    .replace(/^(https?:\/\/)?(www\.)?github\.com\//i, '')
    .replace(/^\/+|\/+$/g, '');

  const parts = text.split('/').filter(Boolean);
  if (parts.length < 2) {
    throw new Error('That doesn\'t look like a GitHub repo. Try owner/repo or a github.com link.');
  }

  const owner = parts[0];
  const repo = parts[1].replace(/\.git$/i, '');
  if (!OWNER_RE.test(owner) || !REPO_RE.test(repo)) {
    throw new Error('That doesn\'t look like a valid GitHub owner/repo name.');
  }

  const rest = parts.slice(2);
  let subdir = '';
  let treeSegments = null;

  if (rest[0] === 'tree' && rest.length > 1) {
    treeSegments = rest.slice(1).map(decodeURIComponent);
  } else if (rest[0] === 'blob') {
    throw new Error('That link points at a single file. Link to the repo or a folder (…/tree/…) instead.');
  } else if (rest.length > 0) {
    throw new Error('Use a repo link, or a folder link that contains /tree/<branch>/…');
  }

  return { owner, repo, ref, subdir, treeSegments };
}

class GitHubError extends Error {
  constructor(message, kind) {
    super(message);
    this.kind = kind;
  }
}

async function fetchTree(fetchImpl, owner, repo, ref) {
  const url = `${API}/repos/${owner}/${repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`;
  const res = await fetchImpl(url, { headers: { Accept: 'application/vnd.github+json' } });

  if (res.status === 404) throw new GitHubError('not found', 'not-found');
  if (res.status === 409) throw new GitHubError('That repository is empty.', 'empty');
  if (res.status === 403 || res.status === 429) {
    const remaining = res.headers.get('x-ratelimit-remaining');
    const reset = Number(res.headers.get('x-ratelimit-reset'));
    if (remaining === '0' || res.status === 429) {
      const minutes = reset ? Math.max(1, Math.ceil((reset * 1000 - Date.now()) / 60000)) : null;
      throw new GitHubError(
        'GitHub\'s anonymous API limit (60 requests/hour per IP address) has been reached' +
          (minutes ? `. It resets in about ${minutes} minute${minutes === 1 ? '' : 's'}.` : '.'),
        'rate-limit'
      );
    }
    throw new GitHubError('GitHub refused the request (is the repository private?).', 'forbidden');
  }
  if (!res.ok) throw new GitHubError(`GitHub returned HTTP ${res.status}.`, 'http');
  return res.json();
}

async function defaultBranch(fetchImpl, owner, repo) {
  const res = await fetchImpl(`${API}/repos/${owner}/${repo}`, {
    headers: { Accept: 'application/vnd.github+json' },
  });
  if (!res.ok) return null;
  const json = await res.json();
  return json.default_branch || null;
}

/** Resolve which branch/folder to use and return the repo's file list. */
export async function listRepoFiles(parsed, fetchImpl = fetch) {
  const { owner, repo } = parsed;
  let { ref, subdir } = parsed;
  let tree = null;

  const notFound = () =>
    new Error(`Couldn't find ${owner}/${repo}${ref ? ` on "${ref}"` : ''}. Check the name and branch — only public repositories work.`);

  if (parsed.treeSegments) {
    // /tree/<branch…>/<folder…> — try the shortest branch name first.
    const segs = parsed.treeSegments;
    let lastErr = null;
    for (let i = 1; i <= Math.min(3, segs.length); i++) {
      const candidate = segs.slice(0, i).join('/');
      try {
        tree = await fetchTree(fetchImpl, owner, repo, candidate);
        ref = candidate;
        subdir = segs.slice(i).join('/');
        break;
      } catch (err) {
        lastErr = err;
        if (err.kind !== 'not-found') throw err;
      }
    }
    if (!tree) throw lastErr && lastErr.kind === 'not-found' ? notFound() : lastErr;
  } else {
    try {
      tree = await fetchTree(fetchImpl, owner, repo, ref || 'HEAD');
      ref = ref || 'HEAD';
    } catch (err) {
      if (err.kind !== 'not-found') throw err;
      if (ref) throw notFound();
      // "HEAD" wasn't accepted — fall back to asking for the default branch.
      const branch = await defaultBranch(fetchImpl, owner, repo);
      if (!branch) throw notFound();
      tree = await fetchTree(fetchImpl, owner, repo, branch);
      ref = branch;
    }
  }

  if (tree.truncated) {
    throw new Error('This repository is too large for GitHub to list in one go. Try importing a sub-folder (…/tree/<branch>/<folder>).');
  }

  const prefix = subdir ? subdir.replace(/^\/+|\/+$/g, '') + '/' : '';
  const files = [];
  let submodules = 0;
  for (const entry of tree.tree || []) {
    if (entry.type === 'commit') { submodules++; continue; }
    if (entry.type !== 'blob') continue;
    if (prefix && !entry.path.startsWith(prefix)) continue;
    files.push({ path: entry.path, rel: entry.path.slice(prefix.length), size: entry.size || 0 });
  }

  if (prefix && files.length === 0) {
    throw new Error(`The folder "${prefix.slice(0, -1)}" has no files on "${ref}".`);
  }
  if (files.length === 0) throw new Error('That repository has no files.');

  return { owner, repo, ref, subdir: prefix.slice(0, -1), files, submodules };
}

async function pool(items, limit, worker) {
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      await worker(items[index], index);
    }
  });
  await Promise.all(runners);
}

async function downloadFile(fetchImpl, owner, repo, ref, path) {
  const encodedPath = path.split('/').map(encodeURIComponent).join('/');
  // Branch names may contain "/" (feature/x); GitHub's own links leave those unencoded.
  const encodedRef = ref.split('/').map(encodeURIComponent).join('/');
  const url = `${RAW}/${owner}/${repo}/${encodedRef}/${encodedPath}`;
  let lastError;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetchImpl(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return new Uint8Array(await res.arrayBuffer());
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError;
}

/**
 * input         what the user typed
 * writeFile     async (relativePath, Uint8Array) => void
 * prepare       optional async hook run after the file list is known and
 *               confirmed, right before downloading (used to empty the fs, so a
 *               failed lookup never wipes anything)
 * confirmLarge  optional async ({count, size}) => boolean
 * onProgress    optional ({phase, done, total}) => void
 */
export async function importGitHubRepo({
  input,
  writeFile,
  prepare,
  confirmLarge,
  onProgress = () => {},
  fetchImpl = fetch,
}) {
  const parsed = parseGitHubInput(input);

  onProgress({ phase: 'listing', done: 0, total: 0 });
  const listing = await listRepoFiles(parsed, fetchImpl);
  const { owner, repo, ref, files } = listing;

  const totalBytes = files.reduce((sum, f) => sum + f.size, 0);
  if (totalBytes > MAX_TOTAL_BYTES) {
    throw new Error(`That's about ${Math.round(totalBytes / 1048576)} MB — too much for the browser. Try a sub-folder.`);
  }
  if (confirmLarge && (files.length > LARGE_FILE_COUNT || totalBytes > LARGE_TOTAL_BYTES)) {
    const go = await confirmLarge({ count: files.length, size: totalBytes });
    if (!go) throw new Error('Import cancelled.');
  }

  if (prepare) await prepare();

  let done = 0;
  const failed = [];
  onProgress({ phase: 'downloading', done, total: files.length });

  await pool(files, CONCURRENCY, async (file) => {
    try {
      const bytes = await downloadFile(fetchImpl, owner, repo, ref, file.path);
      await writeFile(file.rel, bytes);
    } catch {
      failed.push(file.rel);
    }
    done++;
    onProgress({ phase: 'downloading', done, total: files.length });
  });

  return {
    owner,
    repo,
    ref,
    subdir: listing.subdir,
    total: files.length,
    written: files.length - failed.length,
    failed,
    submodules: listing.submodules,
  };
}
