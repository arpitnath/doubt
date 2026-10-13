// doubt daemon. Usage: tsx daemon/server.ts [github-pr-url] [--port 7880] [--no-open]
// Runs once. PRs are opened from the page (POST /api/open) and kept side by side; every route
// takes `pr=<key>`. Serves the UI from ui/dist, state, diffs, file contents, and streams Claude
// answers over SSE (the UI does not use those routes right now).
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { parsePrUrl, checkout, commits, commitFiles, fileDiff, fullDiff, commitDiff, prFiles, prFileDiff, fileAt, lsTree, grep, history, type Commit } from './git.js';
import { Lang } from './lang.js';
import { WebSocketServer } from 'ws';
import { listSessions } from '@anthropic-ai/claude-agent-sdk';
import { openTerm, listTerms, closeTerm, writeTerm, attach, closeAll } from './term.js';
import { ghToken, prMeta } from './github.js';
import { load, save, carryOver, stateKey, WORK_ROOT, STATE_ROOT, type PrState, type Chunk, type Verdict } from './state.js';
import { ask, sessionsFor, shapePrompt, doubtPrompt, commitDoubtPrompt, takePrompt, type AgentEvent } from './agent.js';

const args = process.argv.slice(2);
const bootUrl = args.find((a) => a.startsWith('http'));
const port = Number(args[args.indexOf('--port') + 1]) || 7880;
const noOpen = args.includes('--no-open');

const here = dirname(fileURLToPath(import.meta.url));
const uiDist = join(here, '..', 'ui', 'dist');

// ---- open PRs -----------------------------------------------------------------------------------

interface Open { state: PrState; commitBySha: Map<string, Commit>; treePaths: string[]; busy: boolean; openedAt: number; lang?: Lang }
const open = new Map<string, Open>();
const opening = new Map<string, Promise<Open>>(); // ponytail: a double paste must not clone twice

async function openPr(url: string, force = false): Promise<Open> {
  const ref = parsePrUrl(url);
  const key = stateKey({ owner: ref.owner, repo: ref.repo, number: ref.number });
  const have = open.get(key);
  if (have && !force) return have;
  const inflight = opening.get(key);
  if (inflight) return inflight;

  const p = (async () => {
    console.error(`> PR #${ref.number} ${ref.owner}/${ref.repo}: fetching metadata`);
    const meta = await prMeta(ref);
    const token = await ghToken();
    console.error(`> checking out ${meta.headSha.slice(0, 7)} (${meta.headRef} -> ${meta.baseRef})`);
    const co = await checkout({ ref, cloneUrl: meta.cloneUrl, headSha: meta.headSha, baseRef: meta.baseRef, apiBaseSha: meta.baseSha, token, workRoot: WORK_ROOT });

    const prev = have?.state ?? load(key);
    let state: PrState;
    if (prev && prev.headSha === meta.headSha && prev.files) {
      state = prev;
      console.error(`> ${force ? 'synced, head unchanged' : 'resumed'}: ${Object.keys(state.readFiles).length}/${state.files.length} files read`);
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
      // which files actually changed content since the previous head, for the "new" badge and the interdiff
      const prevPair = new Map((prev?.files ?? []).map((f) => [f.path, `${f.oldBlob}:${f.newBlob}`]));
      const changedSince = prev ? files.filter((f) => prevPair.get(f.path) !== `${f.oldBlob}:${f.newBlob}`).map((f) => f.path) : [];
      state = {
        url, owner: ref.owner, repo: ref.repo, number: ref.number,
        title: meta.title, author: meta.author,
        headSha: meta.headSha, baseSha: co.baseSha, baseRef: meta.baseRef,
        dir: co.dir, diffFile, commits: list, chunks, files, readFiles: {}, doubts: prev?.doubts ?? [],
        hunkMarks: {}, prevHeadSha: prev?.headSha, changedSince,
        sessionId: prev?.sessionId, forkedFrom: prev?.forkedFrom, shape: prev?.shape
      };
      carryOver(state, prev);
      save(state);
      console.error(`> ${list.length} commits, ${chunks.length} chunks, ${files.length} files${prev ? ` (new head; ${changedSince.length} changed, ${Object.keys(state.readFiles).length} read files carried over)` : ''}`);
    }

    const o: Open = { state, commitBySha: new Map(state.commits.map((c) => [c.sha, c])), treePaths: await lsTree(state.dir, state.headSha), busy: false, openedAt: have?.openedAt ?? Date.now(), lang: state.headSha === have?.state.headSha ? have?.lang : undefined };
    open.set(key, o);
    return o;
  })();

  opening.set(key, p);
  try { return await p; } finally { opening.delete(key); }
}

// everything we have ever opened: in memory first, then state files on disk
function knownPrs(): Array<{ key: string; url: string; owner: string; repo: string; number: number; title: string; author: string; read: number; files: number; open: boolean; updated: number }> {
  const out = new Map<string, ReturnType<typeof knownPrs>[number]>();
  const add = (s: PrState, isOpen: boolean, updated: number) => {
    const key = stateKey(s);
    const prev = out.get(key);
    if (prev && !isOpen && prev.updated > updated) return; // an older state file for the same PR loses
    out.set(key, { key, url: s.url, owner: s.owner, repo: s.repo, number: s.number, title: s.title, author: s.author, read: Object.keys(s.readFiles || {}).length, files: (s.files || []).length, open: isOpen, updated });
  };
  if (existsSync(STATE_ROOT)) {
    for (const f of readdirSync(STATE_ROOT)) {
      if (!f.endsWith('.json')) continue;
      try { add(JSON.parse(readFileSync(join(STATE_ROOT, f), 'utf8')) as PrState, false, statSync(join(STATE_ROOT, f)).mtimeMs); } catch { /* skip a bad file */ }
    }
  }
  for (const [, o] of open) add(o.state, true, o.openedAt);
  return [...out.values()].sort((a, b) => b.updated - a.updated);
}

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

// Caller has already taken `o.busy`; this always releases it.
async function streamAgent(o: Open, res: ServerResponse, events: AsyncGenerator<AgentEvent>, onDone: (ev: Extract<AgentEvent, { type: 'done' }>) => void): Promise<void> {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
  try {
    for await (const ev of events) {
      if (ev.type === 'done') onDone(ev);
      res.write(`data: ${JSON.stringify(ev)}\n\n`);
    }
  } finally {
    o.busy = false;
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
    res.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-cache' }); // SPA fallback; never a stale shell after a rebuild
    res.end(readFileSync(index));
    return;
  }
  res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream', 'cache-control': file.endsWith('index.html') ? 'no-cache' : 'public, max-age=31536000, immutable' });
  res.end(readFileSync(file));
}

const VERDICTS: Verdict[] = ['none', 'understood', 'doubt'];

// ---- routes -------------------------------------------------------------------------------------

async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
  // Only the local page may talk to the API: a DNS-rebinding page arrives with a foreign Host.
  const host = (req.headers.host || '').split(':')[0];
  if (host !== '127.0.0.1' && host !== 'localhost') return json(res, 403, { error: 'local only' });

  const url = new URL(req.url || '/', `http://localhost:${port}`);

  if (req.method === 'GET' && url.pathname === '/api/prs') return json(res, 200, { prs: knownPrs() });

  if (req.method === 'POST' && url.pathname === '/api/open') {
    const body = await readJson(req);
    const target = String(body.url || '').trim();
    if (!/github\.com\/[^/]+\/[^/]+\/pull\/\d+/.test(target)) return json(res, 400, { error: 'paste a GitHub pull request URL' });
    const o = await openPr(target);
    return json(res, 200, { key: stateKey(o.state) });
  }

  // ---- agent sidebar: sessions on disk, terminals running here --------------------------------
  if (req.method === 'GET' && url.pathname === '/api/agent/sessions') {
    const all = await listSessions({ limit: 300 });
    const sessions = all
      .filter((x) => !(x.cwd || '').startsWith(WORK_ROOT) || true)
      .map((x) => ({ sessionId: x.sessionId, cwd: x.cwd, gitBranch: x.gitBranch, summary: x.customTitle || x.summary || x.firstPrompt || '', lastModified: x.lastModified, fileSize: x.fileSize }))
      .sort((a, b) => b.lastModified - a.lastModified);
    return json(res, 200, { sessions });
  }
  if (req.method === 'GET' && url.pathname === '/api/agent/terms') return json(res, 200, { terms: listTerms() });
  if (req.method === 'POST' && url.pathname === '/api/agent/open') {
    const body = await readJson(req);
    const cwd = String(body.cwd || '');
    if (!cwd || !existsSync(cwd)) return json(res, 400, { error: 'cwd does not exist' });
    const sessionId = typeof body.sessionId === 'string' && body.sessionId ? body.sessionId : undefined;
    return json(res, 200, { term: openTerm({ sessionId, cwd, title: String(body.title || (sessionId ? sessionId.slice(0, 8) : 'new')) }) });
  }
  if (req.method === 'POST' && url.pathname === '/api/agent/close') {
    const body = await readJson(req);
    return json(res, 200, { ok: closeTerm(String(body.id || '')) });
  }
  if (req.method === 'POST' && url.pathname === '/api/agent/write') {
    const body = await readJson(req);
    const ok = writeTerm(String(body.id || ''), String(body.text || ''), body.submit !== false);
    return ok ? json(res, 200, { ok: true }) : json(res, 404, { error: 'no such terminal, or it exited' });
  }

  if (!url.pathname.startsWith('/api/')) return req.method === 'GET' ? serveStatic(res, url.pathname) : json(res, 404, { error: 'not found' });

  const o = open.get(url.searchParams.get('pr') || '');
  if (!o) return json(res, 404, { error: 'pr not open' });
  const s = o.state;

  if (req.method === 'GET' && url.pathname === '/api/pr') return json(res, 200, { ...s, busy: o.busy });

  // on-demand sync: refetch the head; a new head rebuilds, keeps marks for untouched files, records what changed
  if (req.method === 'POST' && url.pathname === '/api/sync') {
    const before = s.headSha;
    const n = await openPr(s.url, true);
    const changed = n.state.headSha !== before;
    return json(res, 200, { changed, headSha: n.state.headSha, changedSince: changed ? n.state.changedSince ?? [] : [], read: Object.keys(n.state.readFiles).length, files: n.state.files.length });
  }
  if (req.method === 'GET' && url.pathname === '/api/tree') return json(res, 200, { paths: o.treePaths });

  // workspace search over the PR head
  if (req.method === 'GET' && url.pathname === '/api/search') {
    const q = url.searchParams.get('q') || '';
    if (q.length < 2) return json(res, 200, { hits: [] });
    return json(res, 200, { hits: await grep(s.dir, s.headSha, q, url.searchParams.get('re') === '1') });
  }

  // who last touched these lines, from blame on the PR head
  if (req.method === 'GET' && url.pathname === '/api/history') {
    const path = url.searchParams.get('path') || '';
    const start = Number(url.searchParams.get('start')) || 1;
    const end = Number(url.searchParams.get('end')) || start;
    const rev = url.searchParams.get('rev') === 'base' ? s.baseSha : s.headSha;
    if (!path) return json(res, 400, { error: 'path required' });
    return json(res, 200, { entries: await history(s.dir, rev, path, start, end) });
  }

  // hunk marks: finer than a file, for big files read across sittings
  if (req.method === 'POST' && url.pathname === '/api/hunk') {
    const body = await readJson(req);
    const key = String(body.key || '');
    const index = Number(body.index);
    if (!key || !Number.isInteger(index)) return json(res, 400, { error: 'key and index required' });
    const marks = (s.hunkMarks ??= {});
    const set = new Set(marks[key] ?? []);
    body.read === false ? set.delete(index) : set.add(index);
    marks[key] = [...set].sort((a, b) => a - b);
    save(s);
    return json(res, 200, { ok: true, hunkMarks: marks });
  }

  // go to definition / find references, TypeScript and JavaScript only; the service builds on first use
  if (req.method === 'GET' && (url.pathname === '/api/def' || url.pathname === '/api/refs')) {
    const path = url.searchParams.get('path') || '';
    const line = Number(url.searchParams.get('line'));
    const col = Number(url.searchParams.get('col'));
    if (!path || !line) return json(res, 400, { error: 'path and line required' });
    if (!o.lang) { console.error(`> building language service for ${s.owner}/${s.repo}#${s.number}`); o.lang = new Lang(s.dir, o.treePaths); }
    const locs = url.pathname === '/api/def' ? o.lang.definitions(path, line, col) : o.lang.references(path, line, col);
    return json(res, 200, { locs });
  }

  // one file's diff: within one commit (`chunk`), or PR-wide against the merge-base (`path`)
  if (req.method === 'GET' && url.pathname === '/api/diff') {
    const path = url.searchParams.get('path');
    if (path) {
      const f = s.files.find((x) => x.path === path);
      if (!f) return json(res, 404, { error: 'unknown file' });
      // since=1: only what changed between the previous head and this one, for a file that came back unread
      if (url.searchParams.get('since') === '1' && s.prevHeadSha) {
        try { return json(res, 200, { file: f, since: true, patch: await prFileDiff(s.dir, s.prevHeadSha, s.headSha, f.path, f.oldPath) }); }
        catch { /* previous head gone (gc, or a stale record): fall back to the whole diff */ }
      }
      return json(res, 200, { file: f, since: false, patch: await prFileDiff(s.dir, s.baseSha, s.headSha, f.path, f.oldPath) });
    }
    const chunk = s.chunks.find((c) => c.id === url.searchParams.get('chunk'));
    if (!chunk) return json(res, 404, { error: 'unknown chunk' });
    const commit = o.commitBySha.get(chunk.sha);
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
    if (o.busy) return json(res, 409, { error: 'busy' });
    o.busy = true; // taken before any await; streamAgent releases it
    try {
      const body = await readJson(req);
      const forkFrom = typeof body.forkFrom === 'string' && body.forkFrom ? body.forkFrom : undefined;
      s.forkedFrom = forkFrom;
      s.sessionId = undefined;
      return await streamAgent(o, res, ask({ dir: s.dir, message: shapePrompt(s), forkFrom }), (ev) => {
        s.sessionId = ev.sessionId;
        s.shape = ev.text;
        save(s);
      });
    } catch (err) {
      o.busy = false;
      throw err;
    }
  }

  // One route for three moves: a doubt on a file chunk, a doubt on a whole commit (`sha`, no chunkId),
  // or a "take" (`take: true`): pull the file or commit into the session with no question and no verdict change.
  if (req.method === 'POST' && url.pathname === '/api/doubt') {
    if (o.busy) return json(res, 409, { error: 'busy' });
    if (!s.sessionId) return json(res, 400, { error: 'no session yet' });
    o.busy = true;
    try {
      const body = await readJson(req);
      const take = body.take === true;
      const lines = body.lines as { start: number; end: number } | undefined;
      const question = String(body.question || '').trim();
      if (!take && !question) { o.busy = false; return json(res, 400, { error: 'empty question' }); }

      let message: string;
      let chunkId: string;
      if (typeof body.chunkId === 'string') {
        const chunk = s.chunks.find((c) => c.id === body.chunkId);
        const commit = chunk && o.commitBySha.get(chunk.sha);
        if (!chunk || !commit) { o.busy = false; return json(res, 404, { error: 'unknown chunk' }); }
        const diff = await commitDiff(s.dir, commit);
        chunkId = chunk.id;
        message = take ? takePrompt({ chunk }, diff) : doubtPrompt(chunk, lines, question, diff);
        if (!take) chunk.verdict = 'doubt';
      } else if (typeof body.sha === 'string') {
        const commit = o.commitBySha.get(body.sha);
        const paths = s.chunks.filter((c) => c.sha === body.sha).map((c) => c.path);
        if (!commit || !paths.length) { o.busy = false; return json(res, 404, { error: 'unknown commit' }); }
        const diff = await commitDiff(s.dir, commit);
        chunkId = `${commit.sha.slice(0, 7)}:*`;
        message = take ? takePrompt({ sha: commit.sha, subject: commit.subject, paths }, diff) : commitDoubtPrompt(commit.sha, commit.subject, question, diff);
        if (!take) for (const c of s.chunks) if (c.sha === body.sha && c.verdict === 'none') c.verdict = 'doubt';
      } else {
        o.busy = false;
        return json(res, 400, { error: 'chunkId or sha required' });
      }

      const doubt = { id: `${Date.now().toString(36)}`, chunkId, lines, question: take ? '(take)' : question, answer: '', at: Date.now() };
      s.doubts.push(doubt);
      save(s);
      return await streamAgent(o, res, ask({ dir: s.dir, message, sessionId: s.sessionId }), (ev) => {
        doubt.answer = ev.text;
        save(s);
      });
    } catch (err) {
      o.busy = false;
      throw err;
    }
  }

  json(res, 404, { error: 'not found' });
}

const server = createServer((req, res) => {
  route(req, res).catch((err) => {
    console.error(err);
    if (!res.headersSent) json(res, 500, { error: err instanceof Error ? err.message : String(err) });
    else res.end();
  });
});

const wss = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, socket, head) => {
  const host = (req.headers.host || '').split(':')[0];
  const url = new URL(req.url || '/', `http://localhost:${port}`);
  if ((host !== '127.0.0.1' && host !== 'localhost') || url.pathname !== '/ws/term') { socket.destroy(); return; }
  wss.handleUpgrade(req, socket, head, (ws) => {
    if (!attach(url.searchParams.get('id') || '', ws)) ws.close();
  });
});
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => { closeAll(); process.exit(0); });

server.listen(port, '127.0.0.1', async () => {
  const base = `http://127.0.0.1:${port}`;
  let target = base;
  if (bootUrl) {
    try { target = `${base}/#/pr/${stateKey((await openPr(bootUrl)).state)}`; } catch (err) { console.error(err); }
  }
  console.error(`> doubt: ${target}`);
  if (!noOpen) execFile('open', [target], () => {});
});
