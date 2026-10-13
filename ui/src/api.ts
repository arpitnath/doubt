// Thin client over the daemon.
export type Verdict = 'none' | 'understood' | 'doubt';
export type FileKind = 'src' | 'test' | 'docs' | 'config' | 'generated' | 'snapshot' | 'lock';

export interface Commit { sha: string; subject: string; author: string; parents: string[]; merge: boolean }
export interface Chunk { id: string; sha: string; path: string; status: string; adds: number; dels: number; verdict: Verdict }
export interface PrFile { path: string; oldPath?: string; status: string; adds: number; dels: number; oldBlob: string; newBlob: string; kind: FileKind; wsOnly: boolean }
export interface PrState {
  url: string; owner: string; repo: string; number: number; title: string; author: string;
  headSha: string; baseSha: string; baseRef: string; dir: string;
  commits: Commit[]; chunks: Chunk[]; files: PrFile[]; readFiles: Record<string, string>; busy: boolean;
}

export const getPr = (): Promise<PrState> => fetch('/api/pr').then((r) => r.json());
export const getChunkDiff = (chunkId: string): Promise<{ chunk: Chunk; patch: string }> =>
  fetch(`/api/diff?chunk=${encodeURIComponent(chunkId)}`).then((r) => r.json());
export const getFileDiff = (path: string): Promise<{ file: PrFile; patch: string }> =>
  fetch(`/api/diff?path=${encodeURIComponent(path)}`).then((r) => r.json());
export const getTree = (): Promise<{ paths: string[] }> => fetch('/api/tree').then((r) => r.json());
export const getFileAt = (rev: string, path: string, parent = false): Promise<{ contents: string | null }> =>
  fetch(`/api/file?rev=${encodeURIComponent(rev)}&path=${encodeURIComponent(path)}${parent ? '&parent=1' : ''}`).then((r) => r.json());

export type VerdictTarget = { chunkId: string } | { sha: string } | { path: string } | { paths: string[] };
export const setVerdict = (target: VerdictTarget, verdict: Verdict): Promise<{ ok: boolean; readFiles: Record<string, string> }> =>
  fetch('/api/verdict', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...target, verdict }) }).then((r) => r.json());

// fuzzy open, px0-style scoring in miniature: subsequence match, bonus at path boundaries, shorter paths win
export function fuzzy(query: string, paths: string[], limit = 20): string[] {
  const q = query.toLowerCase().replace(/\s+/g, '');
  if (!q) return [];
  const scored: Array<[number, string]> = [];
  for (const p of paths) {
    const lp = p.toLowerCase();
    let qi = 0; let score = 0; let last = -2;
    for (let i = 0; i < lp.length && qi < q.length; i++) {
      if (lp[i] !== q[qi]) continue;
      score += (i === 0 || '/._-'.includes(lp[i - 1])) ? 3 : i === last + 1 ? 2 : 1;
      last = i; qi++;
    }
    if (qi < q.length) continue;
    const base = lp.slice(lp.lastIndexOf('/') + 1);
    if (base.includes(q)) score += 5;
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
