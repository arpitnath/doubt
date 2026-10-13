import { useCallback, useEffect, useMemo, useState } from 'react';
import { PatchDiff } from '@pierre/diffs/react';
import { getDiff, getPr, setVerdict, type Chunk, type PrState } from './api';

// ponytail: the Claude room is out of the UI for now; the daemon still serves /api/session and /api/doubt.
type View = { kind: 'file'; id: string } | { kind: 'commit'; sha: string };

export function App() {
  const [pr, setPr] = useState<PrState | null>(null);
  const [view, setView] = useState<View | null>(null);
  const [patches, setPatches] = useState<Record<string, string>>({}); // chunk id -> patch, for what is on screen

  useEffect(() => {
    getPr().then((s) => {
      setPr(s);
      const first = s.chunks.find((c) => c.verdict === 'none') ?? s.chunks[0];
      if (first) setView({ kind: 'commit', sha: first.sha });
    });
  }, []);

  // what the center shows: one file, or every file of a commit, in queue order
  const shown: Chunk[] = useMemo(() => {
    if (!pr || !view) return [];
    return view.kind === 'file' ? pr.chunks.filter((c) => c.id === view.id) : pr.chunks.filter((c) => c.sha === view.sha);
  }, [pr, view]);

  useEffect(() => {
    let cancelled = false; // fast j/j: an older response must not land on the newer view
    setPatches({});
    Promise.all(shown.map((c) => getDiff(c.id).then((d) => [c.id, d.patch] as const))).then((pairs) => {
      if (!cancelled) setPatches(Object.fromEntries(pairs));
    });
    return () => { cancelled = true; };
  }, [shown]);

  const commitBySha = useMemo(() => new Map(pr?.commits.map((c) => [c.sha, c]) ?? []), [pr]);

  const move = useCallback((dir: 1 | -1) => {
    if (!pr || !view) return;
    if (view.kind === 'file') {
      const i = pr.chunks.findIndex((c) => c.id === view.id);
      const next = pr.chunks[i + dir];
      if (next) setView({ kind: 'file', id: next.id });
    } else {
      const i = pr.commits.findIndex((c) => c.sha === view.sha);
      const next = pr.commits[i + dir];
      if (next) setView({ kind: 'commit', sha: next.sha });
    }
  }, [pr, view]);

  const nextUnjudged = useCallback((after: View, p: PrState): View | null => {
    if (after.kind === 'file') {
      const i = p.chunks.findIndex((c) => c.id === after.id);
      const n = p.chunks.slice(i + 1).find((c) => c.verdict === 'none') ?? p.chunks.find((c) => c.verdict === 'none' && c.id !== after.id);
      return n ? { kind: 'file', id: n.id } : null;
    }
    const i = p.commits.findIndex((c) => c.sha === after.sha);
    const open = (sha: string) => p.chunks.some((c) => c.sha === sha && c.verdict === 'none');
    const n = p.commits.slice(i + 1).find((c) => open(c.sha)) ?? p.commits.find((c) => c.sha !== after.sha && open(c.sha));
    return n ? { kind: 'commit', sha: n.sha } : null;
  }, []);

  const judge = useCallback(async (verdict: 'understood' | 'none') => {
    if (!pr || !view) return;
    const pick = view.kind === 'file' ? (c: Chunk) => c.id === view.id : (c: Chunk) => c.sha === view.sha;
    await setVerdict(view.kind === 'file' ? { chunkId: view.id } : { sha: view.sha }, verdict);
    const updated = { ...pr, chunks: pr.chunks.map((c) => (pick(c) ? { ...c, verdict } : c)) };
    setPr(updated);
    if (verdict === 'understood') {
      const next = nextUnjudged(view, updated);
      if (next) setView(next);
    }
  }, [pr, view, nextUnjudged]);

  // ---- keys: u understood, x unmark, c commit/file view, j/k move -------------------------------
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === 'u') void judge('understood');
      else if (e.key === 'x') void judge('none');
      else if (e.key === 'c') { if (view?.kind === 'file') setView({ kind: 'commit', sha: shown[0].sha }); else if (view?.kind === 'commit' && shown[0]) setView({ kind: 'file', id: shown[0].id }); }
      else if (e.key === 'j') move(1);
      else if (e.key === 'k') move(-1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [judge, move, view, shown]);

  const options = useMemo(() => ({
    diffStyle: 'split' as const,
    theme: { dark: 'github-dark' as const, light: 'github-light' as const }
  }), []);

  if (!pr) return <div className="main"><div className="empty">loading…</div></div>;

  const judged = pr.chunks.filter((c) => c.verdict !== 'none').length;
  const currentSha = view?.kind === 'commit' ? view.sha : shown[0]?.sha;
  const commit = currentSha ? commitBySha.get(currentSha) : undefined;

  return (
    <div className="app two">
      <div className="top">
        <span className="title">#{pr.number} {pr.title}</span>
        <span className="meta">{pr.owner}/{pr.repo} · {pr.author} · {pr.baseRef} ← {pr.headSha.slice(0, 7)}</span>
        <span className="progress"><b>{judged}</b> / {pr.chunks.length} files read</span>
      </div>

      <div className="queue">
        {pr.commits.map((c) => {
          const mine = pr.chunks.filter((k) => k.sha === c.sha);
          const done = mine.length > 0 && mine.every((k) => k.verdict !== 'none');
          const isCurrent = view?.kind === 'commit' && view.sha === c.sha;
          return (
            <div key={c.sha}>
              <div className={`commit ${isCurrent ? 'current' : ''} ${done ? 'done' : ''}`} onClick={() => setView({ kind: 'commit', sha: c.sha })} title="show every file of this commit">
                <span className="sha">{c.sha.slice(0, 7)}</span>{c.merge ? '⎇ ' : ''}{c.subject}
                <span className="count">{done ? '✓' : `${mine.filter((k) => k.verdict === 'none').length}/${mine.length}`}</span>
              </div>
              {mine.map((k) => (
                <div key={k.id} className={`chunk ${k.verdict} ${view?.kind === 'file' && view.id === k.id ? 'current' : ''}`} onClick={() => setView({ kind: 'file', id: k.id })} title={k.path}>
                  <span className="mark">{k.verdict === 'understood' ? '✓' : ''}</span>
                  <span className="path">{k.path}</span>
                  <span className="stat">+{k.adds}/-{k.dels}</span>
                </div>
              ))}
            </div>
          );
        })}
      </div>

      <div className="main">
        <div className="bar">
          {view?.kind === 'commit' && commit
            ? <><span className="path">{commit.sha.slice(0, 7)} {commit.subject}</span><span>{shown.length} files · {commit.author}</span></>
            : shown[0]
              ? <><span className="path">{shown[0].path}</span><span>{shown[0].sha.slice(0, 7)} · {shown[0].status} · +{shown[0].adds}/-{shown[0].dels}</span></>
              : <span>nothing left to read</span>}
          <span className="keys"><kbd>u</kbd> read &nbsp; <kbd>x</kbd> unmark &nbsp; <kbd>c</kbd> {view?.kind === 'commit' ? 'one file' : 'whole commit'} &nbsp; <kbd>j</kbd>/<kbd>k</kbd> move</span>
        </div>
        <div className="diff">
          {shown.length === 0 && <div className="empty">every file read</div>}
          {shown.map((c) => (
            <div key={c.id} className={`stack ${c.verdict}`}>
              {patches[c.id] !== undefined
                ? <PatchDiff key={c.id} patch={patches[c.id]} options={options} disableWorkerPool />
                : <div className="empty">loading {c.path}…</div>}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
