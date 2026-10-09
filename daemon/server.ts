// doubt daemon. Usage: tsx daemon/server.ts <github-pr-url> [--port 7880] [--no-open]
// Serves the UI from ui/dist, the PR state, per-chunk diffs, and streams Claude answers over SSE.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { join, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { parsePrUrl, checkout, commits, commitFiles, fileDiff, fullDiff, type Commit } from './git.js';
import { ghToken, prMeta } from './github.js';
import { load, save, stateKey, WORK_ROOT, type PrState, type Chunk, type Verdict } from './state.js';
import { ask, sessionsFor, shapePrompt, doubtPrompt, type AgentEvent } from './agent.js';

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

// ---- boot: meta, checkout, commits, chunks, state ---------------------------------------------

const ref = parsePrUrl(prUrl);
console.error(`> PR #${ref.number} ${ref.owner}/${ref.repo}: fetching metadata`);
const meta = await prMeta(ref);
const token = await ghToken();
console.error(`> checking out ${meta.headSha.slice(0, 7)} (${meta.headRef} -> ${meta.baseRef})`);
const co = await checkout({ ref, cloneUrl: meta.cloneUrl, headSha: meta.headSha, baseRef: meta.baseRef, token, workRoot: WORK_ROOT });

const key = stateKey({ owner: ref.owner, repo: ref.repo, number: ref.number, headSha: meta.headSha });
let state: PrState | null = load(key);

if (!state) {
  const list = await commits(co.dir, co.baseSha, meta.headSha);
  const chunks: Chunk[] = [];
  for (const c of list) {
    for (const f of await commitFiles(co.dir, c)) {
      chunks.push({ id: `${c.sha.slice(0, 7)}:${f.path}`, sha: c.sha, path: f.path, status: f.status, adds: f.adds, dels: f.dels, verdict: 'none' });
    }
  }
  const diffFile = await fullDiff(co.dir, co.baseSha, meta.headSha);
  state = {
    url: prUrl, owner: ref.owner, repo: ref.repo, number: ref.number,
    title: meta.title, author: meta.author,
    headSha: meta.headSha, baseSha: co.baseSha, baseRef: meta.baseRef,
    dir: co.dir, diffFile, commits: list, chunks, doubts: []
  };
  save(state);
  console.error(`> ${list.length} commits, ${chunks.length} chunks`);
} else {
  console.error(`> resumed state: ${state.chunks.filter((c) => c.verdict !== 'none').length}/${state.chunks.length} chunks judged`);
}

const commitBySha = new Map<string, Commit>(state.commits.map((c) => [c.sha, c]));
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

async function streamAgent(res: ServerResponse, events: AsyncGenerator<AgentEvent>, onDone: (ev: Extract<AgentEvent, { type: 'done' }>) => void): Promise<void> {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
  busy = true;
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
  const file = join(uiDist, path === '/' ? 'index.html' : path);
  if (!file.startsWith(uiDist) || !existsSync(file)) {
    if (!existsSync(join(uiDist, 'index.html'))) {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('doubt daemon is up. Build the UI first: npm run ui:build');
      return;
    }
    // SPA fallback
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(readFileSync(join(uiDist, 'index.html')));
    return;
  }
  res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream' });
  res.end(readFileSync(file));
}

// ---- routes -------------------------------------------------------------------------------------

async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url || '/', `http://localhost:${port}`);
  const s = state as PrState;

  if (req.method === 'GET' && url.pathname === '/api/pr') return json(res, 200, { ...s, busy });

  if (req.method === 'GET' && url.pathname === '/api/diff') {
    const chunk = s.chunks.find((c) => c.id === url.searchParams.get('chunk'));
    if (!chunk) return json(res, 404, { error: 'unknown chunk' });
    const commit = commitBySha.get(chunk.sha);
    if (!commit) return json(res, 404, { error: 'unknown commit' });
    return json(res, 200, { chunk, patch: await fileDiff(s.dir, commit, chunk.path) });
  }

  if (req.method === 'POST' && url.pathname === '/api/verdict') {
    const body = await readJson(req);
    const chunk = s.chunks.find((c) => c.id === body.chunkId);
    if (!chunk) return json(res, 404, { error: 'unknown chunk' });
    chunk.verdict = body.verdict as Verdict;
    save(s);
    return json(res, 200, { ok: true });
  }

  if (req.method === 'GET' && url.pathname === '/api/sessions') {
    const list = await sessionsFor(s.repo, WORK_ROOT);
    return json(res, 200, list.map((x) => ({ sessionId: x.sessionId, cwd: x.cwd, gitBranch: x.gitBranch, summary: x.summary || x.firstPrompt || '', lastModified: x.lastModified, fileSize: x.fileSize })));
  }

  if (req.method === 'POST' && url.pathname === '/api/session') {
    if (busy) return json(res, 409, { error: 'busy' });
    const body = await readJson(req);
    const forkFrom = typeof body.forkFrom === 'string' && body.forkFrom ? body.forkFrom : undefined;
    s.forkedFrom = forkFrom;
    s.sessionId = undefined;
    return streamAgent(res, ask({ dir: s.dir, message: shapePrompt(s), forkFrom }), (ev) => {
      s.sessionId = ev.sessionId;
      s.shape = ev.text;
      save(s);
    });
  }

  if (req.method === 'POST' && url.pathname === '/api/doubt') {
    if (busy) return json(res, 409, { error: 'busy' });
    if (!s.sessionId) return json(res, 400, { error: 'no session yet' });
    const body = await readJson(req);
    const chunk = s.chunks.find((c) => c.id === body.chunkId);
    if (!chunk) return json(res, 404, { error: 'unknown chunk' });
    const lines = body.lines as { start: number; end: number } | undefined;
    const question = String(body.question || '').trim();
    if (!question) return json(res, 400, { error: 'empty question' });
    chunk.verdict = 'doubt';
    const doubt = { id: `${Date.now().toString(36)}`, chunkId: chunk.id, lines, question, answer: '', at: Date.now() };
    s.doubts.push(doubt);
    save(s);
    return streamAgent(res, ask({ dir: s.dir, message: doubtPrompt(chunk, lines, question), sessionId: s.sessionId }), (ev) => {
      doubt.answer = ev.text;
      save(s);
    });
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
  console.error(`> doubt: ${url}  (${state?.title})`);
  if (!noOpen) execFile('open', [url], () => {});
});
