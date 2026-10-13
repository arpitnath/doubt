// Thin client over the daemon. Every PR-scoped call carries the PR key.
export type Verdict = 'none' | 'understood' | 'doubt';
export type FileKind = 'src' | 'test' | 'docs' | 'config' | 'generated' | 'snapshot' | 'lock';

export interface Commit { sha: string; subject: string; author: string; parents: string[]; merge: boolean }
export interface Chunk { id: string; sha: string; path: string; status: string; adds: number; dels: number; verdict: Verdict }
export interface PrFile { path: string; oldPath?: string; status: string; adds: number; dels: number; oldBlob: string; newBlob: string; kind: FileKind; wsOnly: boolean }
export interface PrState {
  url: string; owner: string; repo: string; number: number; title: string; author: string;
  headSha: string; baseSha: string; baseRef: string; dir: string;
  commits: Commit[]; chunks: Chunk[]; files: PrFile[]; readFiles: Record<string, string>; hunkMarks?: Record<string, number[]>;
  prevHeadSha?: string; changedSince?: string[]; busy: boolean;
}
export interface KnownPr { key: string; url: string; owner: string; repo: string; number: number; title: string; author: string; read: number; files: number; open: boolean; updated: number }

const q = (key: string, rest = '') => `?pr=${encodeURIComponent(key)}${rest}`;

async function ok<T>(r: Response): Promise<T> {
  const body = await r.json();
  if (!r.ok) throw new Error(String(body.error || r.statusText));
  return body as T;
}

export const listPrs = (): Promise<{ prs: KnownPr[] }> => fetch('/api/prs').then((r) => ok(r));
export const openPr = (url: string): Promise<{ key: string }> =>
  fetch('/api/open', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url }) }).then((r) => ok(r));

export const getPr = (key: string): Promise<PrState> => fetch(`/api/pr${q(key)}`).then((r) => ok(r));
export const getTree = (key: string): Promise<{ paths: string[] }> => fetch(`/api/tree${q(key)}`).then((r) => ok(r));
export const getChunkDiff = (key: string, chunkId: string): Promise<{ chunk: Chunk; patch: string }> =>
  fetch(`/api/diff${q(key, `&chunk=${encodeURIComponent(chunkId)}`)}`).then((r) => ok(r));
export const getFileDiff = (key: string, path: string, since = false): Promise<{ file: PrFile; patch: string; since: boolean }> =>
  fetch(`/api/diff${q(key, `&path=${encodeURIComponent(path)}${since ? '&since=1' : ''}`)}`).then((r) => ok(r));
export const syncPr = (key: string): Promise<{ changed: boolean; headSha: string; changedSince: string[]; read: number; files: number }> =>
  fetch(`/api/sync${q(key)}`, { method: 'POST' }).then((r) => ok(r));
export const getFileAt = (key: string, rev: string, path: string, parent = false): Promise<{ contents: string | null }> =>
  fetch(`/api/file${q(key, `&rev=${encodeURIComponent(rev)}&path=${encodeURIComponent(path)}${parent ? '&parent=1' : ''}`)}`).then((r) => ok(r));

export interface Hit { path: string; line: number; text: string }
export interface Loc { path: string; line: number; col: number; text?: string }
export const search = (key: string, query: string, regex = false): Promise<{ hits: Hit[] }> =>
  fetch(`/api/search${q(key, `&q=${encodeURIComponent(query)}${regex ? '&re=1' : ''}`)}`).then((r) => ok(r));
export const definitions = (key: string, path: string, line: number, col: number): Promise<{ locs: Loc[] }> =>
  fetch(`/api/def${q(key, `&path=${encodeURIComponent(path)}&line=${line}&col=${col}`)}`).then((r) => ok(r));
export const references = (key: string, path: string, line: number, col: number): Promise<{ locs: Loc[] }> =>
  fetch(`/api/refs${q(key, `&path=${encodeURIComponent(path)}&line=${line}&col=${col}`)}`).then((r) => ok(r));

// symbol outline, px0's regex fallback: no parser, one pattern per language family
export interface Sym { name: string; kind: string; line: number }
export function outline(text: string, path: string): Sym[] {
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
  const lines = text.split('\n');
  const out: Sym[] = [];
  const push = (line: number, kind: string, name?: string) => { if (name) out.push({ name, kind, line }); };
  const KW = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'function', 'constructor']);
  lines.forEach((raw, i) => {
    const line = i + 1;
    let m: RegExpMatchArray | null;
    if (['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'mts', 'cts'].includes(ext)) {
      if ((m = raw.match(/^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/))) push(line, 'fn', m[1]);
      else if ((m = raw.match(/^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/))) push(line, 'class', m[1]);
      else if ((m = raw.match(/^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*(?::\s*[^=]+)?=>/))) push(line, 'fn', m[1]);
      else if ((m = raw.match(/^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:React\.)?(?:memo|forwardRef|createContext|createSlice|styled)\b/))) push(line, 'const', m[1]);
      else if ((m = raw.match(/^\s*(?:export\s+)?interface\s+(\w+)/))) push(line, 'interface', m[1]);
      else if ((m = raw.match(/^\s*(?:export\s+)?type\s+(\w+)\s*(?:<[^>]*>)?\s*=/))) push(line, 'type', m[1]);
      else if ((m = raw.match(/^\s*(?:export\s+)?(?:const\s+)?enum\s+(\w+)/))) push(line, 'enum', m[1]);
      else if ((m = raw.match(/^\s{2,}(?:public\s+|private\s+|protected\s+)?(?:static\s+)?(?:async\s+)?(?:get\s+|set\s+)?([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*(?::\s*[^{]+)?\{\s*$/)) && !KW.has(m[1])) push(line, 'method', m[1]);
      else if ((m = raw.match(/^\s*(?:describe|it|test)(?:\.(?:only|skip|each))?\s*\(\s*(['"`])(.+?)\1/))) push(line, raw.trimStart().startsWith('describe') ? 'suite' : 'test', m[2]);
    } else if (ext === 'py') {
      if ((m = raw.match(/^\s*(?:async\s+)?(def|class)\s+(\w+)/))) push(line, m[1] === 'def' ? 'fn' : 'class', m[2]);
    } else if (ext === 'go') {
      if ((m = raw.match(/^func\s+(?:\([^)]*\)\s*)?(\w+)/))) push(line, 'fn', m[1]);
      else if ((m = raw.match(/^type\s+(\w+)/))) push(line, 'type', m[1]);
    } else if (ext === 'rs') {
      if ((m = raw.match(/^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(fn|struct|enum|trait|impl|mod)\s+(\w+)/))) push(line, m[1], m[2]);
    } else if (['md', 'mdx'].includes(ext)) {
      if ((m = raw.match(/^(#{1,4})\s+(.+)/))) push(line, `h${m[1].length}`, m[2]);
    } else if (['yml', 'yaml'].includes(ext)) {
      if ((m = raw.match(/^([A-Za-z_][\w-]*):\s*$/))) push(line, 'key', m[1]);
    }
  });
  return out;
}

export type VerdictTarget = { chunkId: string } | { sha: string } | { path: string } | { paths: string[] };
export const setVerdict = (key: string, target: VerdictTarget, verdict: Verdict): Promise<{ ok: boolean; readFiles: Record<string, string> }> =>
  fetch(`/api/verdict${q(key)}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...target, verdict }) }).then((r) => ok(r));

export interface HistoryEntry { sha: string; subject: string; author: string; date: string; pr?: number; lines: number }
export const historyOf = (key: string, path: string, start: number, end: number): Promise<{ entries: HistoryEntry[] }> =>
  fetch(`/api/history${q(key, `&path=${encodeURIComponent(path)}&start=${start}&end=${end}`)}`).then((r) => ok(r));
export const setHunk = (key: string, itemKey: string, index: number, read: boolean): Promise<{ ok: boolean; hunkMarks: Record<string, number[]> }> =>
  fetch(`/api/hunk${q(key)}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key: itemKey, index, read }) }).then((r) => ok(r));

// hunks of a unified patch: where each starts on the new side (or the old side for pure deletions)
export interface Hunk { index: number; newStart: number; newCount: number; oldStart: number; oldCount: number }
export function parseHunks(patch: string): Hunk[] {
  const out: Hunk[] = [];
  const re = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(patch))) {
    out.push({ index: out.length, oldStart: Number(m[1]), oldCount: m[2] === undefined ? 1 : Number(m[2]), newStart: Number(m[3]), newCount: m[4] === undefined ? 1 : Number(m[4]) });
  }
  return out;
}

// agent sidebar: sessions on disk, terminals running here
export interface AgentSession { sessionId: string; cwd?: string; gitBranch?: string; summary: string; lastModified: number; fileSize?: number }
export interface TermInfo { id: string; sessionId?: string; cwd: string; title: string; startedAt: number; alive: boolean }
export const agentSessions = (): Promise<{ sessions: AgentSession[] }> => fetch('/api/agent/sessions').then((r) => ok(r));
export const agentTerms = (): Promise<{ terms: TermInfo[] }> => fetch('/api/agent/terms').then((r) => ok(r));
export const openAgentTerm = (body: { sessionId?: string; cwd: string; title: string }): Promise<{ term: TermInfo }> =>
  fetch('/api/agent/open', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => ok(r));
export const closeAgentTerm = (id: string): Promise<unknown> =>
  fetch('/api/agent/close', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id }) }).then((r) => ok(r));

// fuzzy open, px0-style scoring in miniature: subsequence match, bonus at path boundaries, shorter paths win
export function fuzzy(query: string, paths: string[], limit = 20): string[] {
  const qq = query.toLowerCase().replace(/\s+/g, '');
  if (!qq) return [];
  const scored: Array<[number, string]> = [];
  for (const p of paths) {
    const lp = p.toLowerCase();
    let qi = 0; let score = 0; let last = -2;
    for (let i = 0; i < lp.length && qi < qq.length; i++) {
      if (lp[i] !== qq[qi]) continue;
      score += (i === 0 || '/._-'.includes(lp[i - 1])) ? 3 : i === last + 1 ? 2 : 1;
      last = i; qi++;
    }
    if (qi < qq.length) continue;
    const base = lp.slice(lp.lastIndexOf('/') + 1);
    if (base.includes(qq)) score += 5;
    scored.push([score - p.length / 100, p]);
  }
  return scored.sort((a, b) => b[0] - a[0]).slice(0, limit).map(([, p]) => p);
}

// noise: what no human needs to read first
export const isNoise = (f: PrFile): boolean => f.wsOnly || f.kind === 'lock' || f.kind === 'generated' || f.kind === 'snapshot';

// reading order: source, then tests, then docs and config, then the generated tail; tree order inside each
const RANK: Record<FileKind, number> = { src: 0, test: 1, docs: 2, config: 3, snapshot: 4, generated: 5, lock: 6 };
export const readingOrder = (files: PrFile[]): PrFile[] =>
  [...files].sort((a, b) => (RANK[a.kind] - RANK[b.kind]) || (Number(a.wsOnly) - Number(b.wsOnly)) || a.path.localeCompare(b.path));
