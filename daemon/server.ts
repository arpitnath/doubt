// doubt daemon. Usage: tsx daemon/server.ts <github-pr-url> [--port 7880] [--no-open]
// Serves the UI from ui/dist, the PR state, per-chunk and per-file diffs, full file contents,
// and streams Claude answers over SSE (the UI does not use those routes right now).
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { parsePrUrl, checkout, commits, commitFiles, fileDiff, fullDiff, commitDiff, prFiles, prFileDiff, fileAt, lsTree, type Commit } from './git.js';
import { ghToken, prMeta } from './github.js';
import { load, save, carryOver, stateKey, WORK_ROOT, type PrState, type Chunk, type Verdict } from './state.js';
import { ask, sessionsFor, shapePrompt, doubtPrompt, commitDoubtPrompt, takePrompt, type AgentEvent } from './agent.js';

const args = process.argv.slice(2);
const prUrl = args.find((a) => a.startsWith('http'));
if (!prUrl) {
  console.error('usage: doubt <github-pr-url> [--port 7880] [--no-open]');
  process.exit(2);
}
const port = Number(args[args.indexOf('--port') + 1]) || 7880;
const noOpen = args.includes('--no-open');

const here = dirname(fileURLToPath(import.meta.url));
const uiDist = join(here, '..', 'ui', 'dist');

// ---- boot: meta, checkout, commits, chunks, files, state ---------------------------------------

const ref = parsePrUrl(prUrl);
console.error(`> PR #${ref.number} ${ref.owner}/${ref.repo}: fetching metadata`);
const meta = await prMeta(ref);
const token = await ghToken();
console.error(`> checking out ${meta.headSha.slice(0, 7)} (${meta.headRef} -> ${meta.baseRef})`);
const co = await checkout({ ref, cloneUrl: meta.cloneUrl, headSha: meta.headSha, baseRef: meta.baseRef, apiBaseSha: meta.baseSha, token, workRoot: WORK_ROOT });

const key = stateKey({ owner: ref.owner, repo: ref.repo, number: ref.number });
const prev = load(key);
let state: PrState;

if (prev && prev.headSha === meta.headSha && prev.files) {
  state = prev;
  console.error(`> resumed: ${Object.keys(state.readFiles).length}/${state.files.length} files read`);
} else {
  const list = await commits(co.dir, co.baseSha, meta.headSha);
  const chunks: Chunk[] = [];
  for (const c of list) {
    for (const f of await commitFiles(co.dir, c)) {
      chunks.push({ id: `${c.sha.slice(0, 7)}:${f.path}`, sha: c.sha, path: f.path, status: f.status, adds: f.adds, dels: f.dels, verdict: 'none' });
    }
  }
  const files = await prFiles(co.dir, co.baseSha, meta.headSha);
  const diffFile = await fullDiff(co.dir, co.baseSha, meta.headSha);
  state = {
    url: prUrl, owner: ref.owner, repo: ref.repo, number: ref.number,
    title: meta.title, author: meta.author,
    headSha: meta.headSha, baseSha: co.baseSha, baseRef: meta.baseRef,
    dir: co.dir, diffFile, commits: list, chunks, files, readFiles: {}, doubts: prev?.doubts ?? [],
    sessionId: prev?.sessionId, forkedFrom: prev?.forkedFrom, shape: prev?.shape
  };
  carryOver(state, prev);
  save(state);
  const kept = Object.keys(state.readFiles).length;
  console.error(`> ${list.length} commits, ${chunks.length} chunks, ${files.length} files${prev ? ` (new head; ${kept} read files carried over)` : ''}`);
}

const commitBySha = new Map<string, Commit>(state.commits.map((c) => [c.sha, c]));
const treePaths = await lsTree(state.dir, state.headSha); // the whole repo at the PR head, for the Repo tab and fuzzy open
let busy = false; // ponytail: one question at a time per PR session; a queue if it ever matters

// ---- helpers ------------------------------------------------------------------------------------

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
}

// Caller has already taken `busy`; this always releases it.
async function streamAgent(res: ServerResponse, events: AsyncGenerator<AgentEvent>, onDone: (ev: Extract<AgentEvent, { type: 'done' }>) => void): Promise<void> {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
  try {
    for await (const ev of events) {
      if (ev.type === 'done') onDone(ev);
      res.write(`data: ${JSON.stringify(ev)}\n\n`);
    }
  } finally {
    busy = false;
    res.end();
  }
}

const MIME: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.wasm': 'application/wasm' };

function serveStatic(res: ServerResponse, path: string): void {
  const index = join(uiDist, 'index.html');
  const file = join(uiDist, path === '/' ? 'index.html' : path);
  const ok = file.startsWith(uiDist) && existsSync(file) && statSync(file).isFile();
  if (!ok) {
    if (!existsSync(index)) {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('doubt daemon is up. Build the UI first: npm run ui:build');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html' }); // SPA fallback
    res.end(readFileSync(index));
    return;
  }
  res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream' });
  res.end(readFileSync(file));
}

const VERDICTS: Verdict[] = ['none', 'understood', 'doubt'];

// ---- routes -------------------------------------------------------------------------------------

async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
  // Only the local page may talk to the API: a DNS-rebinding page arrives with a foreign Host.
  const host = (req.headers.host || '').split(':')[0];
  if (host !== '127.0.0.1' && host !== 'localhost') return json(res, 403, { error: 'local only' });

  const url = new URL(req.url || '/', `http://localhost:${port}`);
  const s = state;

  if (req.method === 'GET' && url.pathname === '/api/pr') return json(res, 200, { ...s, busy });
  if (req.method === 'GET' && url.pathname === '/api/tree') return json(res, 200, { paths: treePaths });

  // one file's diff: within one commit (`chunk`), or PR-wide against the merge-base (`path`)
  if (req.method === 'GET' && url.pathname === '/api/diff') {
    const path = url.searchParams.get('path');
    if (path) {
      const f = s.files.find((x) => x.path === path);
      if (!f) return json(res, 404, { error: 'unknown file' });
      return json(res, 200, { file: f, patch: await prFileDiff(s.dir, s.baseSha, s.headSha, f.path, f.oldPath) });
    }
    const chunk = s.chunks.find((c) => c.id === url.searchParams.get('chunk'));
    if (!chunk) return json(res, 404, { error: 'unknown chunk' });
    const commit = commitBySha.get(chunk.sha);
    if (!commit) return json(res, 404, { error: 'unknown commit' });
    return json(res, 200, { chunk, patch: await fileDiff(s.dir, commit, chunk.path) });
  }

  // full file contents for context expansion: rev is base, head, or a commit sha (+ `parent`)
  if (req.method === 'GET' && url.pathname === '/api/file') {
    const path = url.searchParams.get('path') || '';
    const revParam = url.searchParams.get('rev') || 'head';
    let rev = revParam === 'base' ? s.baseSha : revParam === 'head' ? s.headSha : revParam;
    if (url.searchParams.get('parent') === '1') rev = `${rev}^`;
    if (!path) return json(res, 400, { error: 'path required' });
    const contents = await fileAt(s.dir, rev, path);
    return json(res, 200, { path, rev, contents });
  }

  // verdict on one chunk, every chunk of a commit (`sha`), every chunk of a file (`path`), or many files (`paths`)
  if (req.method === 'POST' && url.pathname === '/api/verdict') {
    const body = await readJson(req);
    if (!VERDICTS.includes(body.verdict as Verdict)) return json(res, 400, { error: 'bad verdict' });
    let targets: Chunk[];
    if (typeof body.sha === 'string') targets = s.chunks.filter((c) => c.sha === body.sha);
    else if (typeof body.path === 'string') targets = s.chunks.filter((c) => c.path === body.path);
    else if (Array.isArray(body.paths)) { const set = new Set(body.paths as string[]); targets = s.chunks.filter((c) => set.has(c.path)); }
    else targets = s.chunks.filter((c) => c.id === body.chunkId);
    if (!targets.length) return json(res, 404, { error: 'nothing matched' });
    for (const c of targets) c.verdict = body.verdict as Verdict;
    save(s);
    return json(res, 200, { ok: true, count: targets.length, readFiles: s.readFiles });
  }

  if (req.method === 'GET' && url.pathname === '/api/sessions') {
    const list = await sessionsFor(s.repo, WORK_ROOT);
    return json(res, 200, list.map((x) => ({ sessionId: x.sessionId, cwd: x.cwd, gitBranch: x.gitBranch, summary: x.summary || x.firstPrompt || '', lastModified: x.lastModified, fileSize: x.fileSize })));
  }

  if (req.method === 'POST' && url.pathname === '/api/session') {
    if (busy) return json(res, 409, { error: 'busy' });
    busy = true; // taken before any await; streamAgent releases it
    try {
      const body = await readJson(req);
      const forkFrom = typeof body.forkFrom === 'string' && body.forkFrom ? body.forkFrom : undefined;
      s.forkedFrom = forkFrom;
      s.sessionId = undefined;
      return await streamAgent(res, ask({ dir: s.dir, message: shapePrompt(s), forkFrom }), (ev) => {
        s.sessionId = ev.sessionId;
        s.shape = ev.text;
        save(s);
      });
    } catch (err) {
      busy = false;
      throw err;
    }
  }

  // One route for three moves: a doubt on a file chunk, a doubt on a whole commit (`sha`, no chunkId),
  // or a "take" (`take: true`): pull the file or commit into the session with no question and no verdict change.
  if (req.method === 'POST' && url.pathname === '/api/doubt') {
    if (busy) return json(res, 409, { error: 'busy' });
    if (!s.sessionId) return json(res, 400, { error: 'no session yet' });
    busy = true;
    try {
      const body = await readJson(req);
      const take = body.take === true;
      const lines = body.lines as { start: number; end: number } | undefined;
      const question = String(body.question || '').trim();
      if (!take && !question) { busy = false; return json(res, 400, { error: 'empty question' }); }

      let message: string;
      let chunkId: string;
      if (typeof body.chunkId === 'string') {
        const chunk = s.chunks.find((c) => c.id === body.chunkId);
        const commit = chunk && commitBySha.get(chunk.sha);
        if (!chunk || !commit) { busy = false; return json(res, 404, { error: 'unknown chunk' }); }
        const diff = await commitDiff(s.dir, commit);
        chunkId = chunk.id;
        message = take ? takePrompt({ chunk }, diff) : doubtPrompt(chunk, lines, question, diff);
        if (!take) chunk.verdict = 'doubt';
      } else if (typeof body.sha === 'string') {
        const commit = commitBySha.get(body.sha);
        const paths = s.chunks.filter((c) => c.sha === body.sha).map((c) => c.path);
        if (!commit || !paths.length) { busy = false; return json(res, 404, { error: 'unknown commit' }); }
        const diff = await commitDiff(s.dir, commit);
        chunkId = `${commit.sha.slice(0, 7)}:*`;
        message = take ? takePrompt({ sha: commit.sha, subject: commit.subject, paths }, diff) : commitDoubtPrompt(commit.sha, commit.subject, question, diff);
        if (!take) for (const c of s.chunks) if (c.sha === body.sha && c.verdict === 'none') c.verdict = 'doubt';
      } else {
        busy = false;
        return json(res, 400, { error: 'chunkId or sha required' });
      }

      const doubt = { id: `${Date.now().toString(36)}`, chunkId, lines, question: take ? '(take)' : question, answer: '', at: Date.now() };
      s.doubts.push(doubt);
      save(s);
      return await streamAgent(res, ask({ dir: s.dir, message, sessionId: s.sessionId }), (ev) => {
        doubt.answer = ev.text;
        save(s);
      });
    } catch (err) {
      busy = false;
      throw err;
    }
  }

  if (req.method === 'GET') return serveStatic(res, url.pathname);
  json(res, 404, { error: 'not found' });
}

const server = createServer((req, res) => {
  route(req, res).catch((err) => {
    console.error(err);
    if (!res.headersSent) json(res, 500, { error: err instanceof Error ? err.message : String(err) });
    else res.end();
  });
});

server.listen(port, '127.0.0.1', () => {
  const url = `http://127.0.0.1:${port}`;
  console.error(`> doubt: ${url}  (${state.title})`);
  if (!noOpen) execFile('open', [url], () => {});
});
