import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { PatchDiff, type FileDiffMetadata, type FileDiffLoadedFiles } from '@pierre/diffs/react';
import { getChunkDiff, getFileAt, getFileDiff, getPr, isNoise, readingOrder, setVerdict, type Chunk, type PrFile, type PrState, type VerdictTarget } from './api';
import { Tree } from './Tree';

// ponytail: the Claude room is out of the UI for now; the daemon still serves /api/session and /api/doubt.
type Tab = 'files' | 'commits';
type View = { kind: 'file'; path: string } | { kind: 'commit'; sha: string } | { kind: 'chunk'; id: string };
interface Item { key: string; path: string; oldPath?: string; oldRev: string; newRev: string; read: boolean; status: string; adds: number; dels: number }

export function App() {
  const [pr, setPr] = useState<PrState | null>(null);
  const [tab, setTab] = useState<Tab>('files');
  const [view, setView] = useState<View | null>(null);
  const [patches, setPatches] = useState<Record<string, string>>({});
  const diffRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    getPr().then((s) => {
      setPr(s);
      const order = readingOrder(s.files);
      const first = order.find((f) => s.readFiles[f.path] === undefined && !isNoise(f)) ?? order.find((f) => s.readFiles[f.path] === undefined) ?? order[0];
      if (first) setView({ kind: 'file', path: first.path });
    });
  }, []);

  const ordered = useMemo(() => (pr ? readingOrder(pr.files) : []), [pr]);
  const commitBySha = useMemo(() => new Map(pr?.commits.map((c) => [c.sha, c]) ?? []), [pr]);
  const fileByPath = useMemo(() => new Map(pr?.files.map((f) => [f.path, f]) ?? []), [pr]);
  const isRead = useCallback((path: string) => pr?.readFiles[path] !== undefined, [pr]);

  // what the center shows
  const items: Item[] = useMemo(() => {
    if (!pr || !view) return [];
    if (view.kind === 'file') {
      const f = fileByPath.get(view.path);
      return f ? [{ key: f.path, path: f.path, oldPath: f.oldPath, oldRev: 'base', newRev: 'head', read: isRead(f.path), status: f.status, adds: f.adds, dels: f.dels }] : [];
    }
    const chunks = view.kind === 'chunk' ? pr.chunks.filter((c) => c.id === view.id) : pr.chunks.filter((c) => c.sha === view.sha);
    return chunks.map((c) => ({ key: c.id, path: c.path, oldRev: `${c.sha}^`, newRev: c.sha, read: c.verdict !== 'none', status: c.status, adds: c.adds, dels: c.dels }));
  }, [pr, view, fileByPath, isRead]);

  useEffect(() => {
    let cancelled = false; // fast j/j: an older response must not land on the newer view
    setPatches({});
    const loads = items.map((it) => (it.oldRev === 'base' ? getFileDiff(it.path) : getChunkDiff(it.key)).then((d) => [it.key, d.patch] as const));
    Promise.all(loads).then((pairs) => { if (!cancelled) setPatches(Object.fromEntries(pairs)); });
    diffRef.current?.scrollTo({ top: 0 });
    return () => { cancelled = true; };
  }, [items]);

  // ---- verdicts ----------------------------------------------------------------------------------
  const apply = useCallback(async (target: VerdictTarget, verdict: 'understood' | 'none') => {
    if (!pr) return;
    const r = await setVerdict(target, verdict);
    setPr((p) => {
      if (!p) return p;
      const pick = (c: Chunk) =>
        'chunkId' in target ? c.id === target.chunkId
        : 'sha' in target ? c.sha === target.sha
        : 'path' in target ? c.path === target.path
        : target.paths.includes(c.path);
      return { ...p, chunks: p.chunks.map((c) => (pick(c) ? { ...c, verdict } : c)), readFiles: r.readFiles };
    });
    return r.readFiles;
  }, [pr]);

  const nextFile = useCallback((from: string, readFiles: Record<string, string>): string | null => {
    const i = ordered.findIndex((f) => f.path === from);
    const unread = (f: PrFile) => readFiles[f.path] === undefined && f.path !== from;
    const n = ordered.slice(i + 1).find(unread) ?? ordered.find(unread);
    return n ? n.path : null;
  }, [ordered]);

  const judge = useCallback(async (verdict: 'understood' | 'none') => {
    if (!pr || !view) return;
    if (view.kind === 'file') {
      const readFiles = await apply({ path: view.path }, verdict);
      if (verdict === 'understood' && readFiles) { const n = nextFile(view.path, readFiles); if (n) setView({ kind: 'file', path: n }); }
      return;
    }
    const target: VerdictTarget = view.kind === 'chunk' ? { chunkId: view.id } : { sha: view.sha };
    await apply(target, verdict);
    if (verdict !== 'understood') return;
    setPr((p) => {
      if (!p) return p;
      if (view.kind === 'chunk') {
        const i = p.chunks.findIndex((c) => c.id === view.id);
        const n = p.chunks.slice(i + 1).find((c) => c.verdict === 'none') ?? p.chunks.find((c) => c.verdict === 'none' && c.id !== view.id);
        if (n) setView({ kind: 'chunk', id: n.id });
      } else {
        const i = p.commits.findIndex((c) => c.sha === view.sha);
        const open = (sha: string) => p.chunks.some((c) => c.sha === sha && c.verdict === 'none');
        const n = p.commits.slice(i + 1).find((c) => open(c.sha)) ?? p.commits.find((c) => c.sha !== view.sha && open(c.sha));
        if (n) setView({ kind: 'commit', sha: n.sha });
      }
      return p;
    });
  }, [pr, view, apply, nextFile]);

  const skipNoise = useCallback(async () => {
    if (!pr) return;
    const paths = pr.files.filter((f) => isNoise(f) && !isRead(f.path)).map((f) => f.path);
    if (!paths.length) return;
    const readFiles = await apply({ paths }, 'understood');
    if (view?.kind === 'file' && readFiles && paths.includes(view.path)) { const n = nextFile(view.path, readFiles); if (n) setView({ kind: 'file', path: n }); }
  }, [pr, isRead, apply, view, nextFile]);

  // ---- movement ----------------------------------------------------------------------------------
  const move = useCallback((dir: 1 | -1) => {
    if (!pr || !view) return;
    if (view.kind === 'file') {
      const i = ordered.findIndex((f) => f.path === view.path);
      const n = ordered[i + dir];
      if (n) setView({ kind: 'file', path: n.path });
    } else if (view.kind === 'chunk') {
      const i = pr.chunks.findIndex((c) => c.id === view.id);
      const n = pr.chunks[i + dir];
      if (n) setView({ kind: 'chunk', id: n.id });
    } else {
      const i = pr.commits.findIndex((c) => c.sha === view.sha);
      const n = pr.commits[i + dir];
      if (n) setView({ kind: 'commit', sha: n.sha });
    }
  }, [pr, view, ordered]);

  // [ and ]: jump between stacked file headers inside the scroll pane
  const jumpStack = useCallback((dir: 1 | -1) => {
    const pane = diffRef.current;
    if (!pane) return;
    const tops = [...pane.querySelectorAll<HTMLElement>('.stack')].map((el) => el.offsetTop - pane.offsetTop);
    const cur = pane.scrollTop;
    const next = dir === 1 ? tops.find((t) => t > cur + 4) : [...tops].reverse().find((t) => t < cur - 4);
    if (next !== undefined) pane.scrollTo({ top: next, behavior: 'smooth' });
  }, []);

  const switchTab = useCallback((t: Tab) => {
    if (!pr) return;
    setTab(t);
    if (t === 'files') {
      const path = view && view.kind !== 'commit' ? (view.kind === 'file' ? view.path : pr.chunks.find((c) => c.id === view.id)?.path) : undefined;
      const first = path && fileByPath.has(path) ? path : (ordered.find((f) => !isRead(f.path)) ?? ordered[0])?.path;
      if (first) setView({ kind: 'file', path: first });
    } else {
      const first = pr.chunks.find((c) => c.verdict === 'none') ?? pr.chunks[0];
      if (first) setView({ kind: 'commit', sha: first.sha });
    }
  }, [pr, view, fileByPath, ordered, isRead]);

  // ---- keys ---------------------------------------------------------------------------------------
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === 'u') void judge('understood');
      else if (e.key === 'x') void judge('none');
      else if (e.key === 'n') void skipNoise();
      else if (e.key === 's') switchTab(tab === 'files' ? 'commits' : 'files');
      else if (e.key === 'c' && tab === 'commits') {
        if (view?.kind === 'chunk') { const c = pr?.chunks.find((k) => k.id === view.id); if (c) setView({ kind: 'commit', sha: c.sha }); }
        else if (view?.kind === 'commit') { const c = pr?.chunks.find((k) => k.sha === view.sha); if (c) setView({ kind: 'chunk', id: c.id }); }
      }
      else if (e.key === 'j') move(1);
      else if (e.key === 'k') move(-1);
      else if (e.key === ']') jumpStack(1);
      else if (e.key === '[') jumpStack(-1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [judge, skipNoise, switchTab, move, jumpStack, tab, view, pr]);

  // ---- render -------------------------------------------------------------------------------------
  const baseOptions = useMemo(() => ({
    diffStyle: 'split' as const,
    theme: { dark: 'github-dark' as const, light: 'github-light' as const },
    lineDiffType: 'word' as const,
    stickyHeader: true
  }), []);

  // context expansion: pierre asks for both full sides when a collapsed region is opened
  const loaderFor = useCallback((it: Item) => async (meta: FileDiffMetadata): Promise<FileDiffLoadedFiles> => {
    const oldName = meta.prevName || meta.name;
    const parent = it.oldRev.endsWith('^');
    const [oldSide, newSide] = await Promise.all([
      getFileAt(parent ? it.oldRev.slice(0, -1) : it.oldRev, oldName, parent),
      getFileAt(it.newRev, meta.name)
    ]);
    return { oldFile: { name: oldName, contents: oldSide.contents ?? '' }, newFile: { name: meta.name, contents: newSide.contents ?? '' } };
  }, []);

  if (!pr) return <div className="main"><div className="empty">loading…</div></div>;

  const readCount = Object.keys(pr.readFiles).length;
  const noiseLeft = pr.files.filter((f) => isNoise(f) && !isRead(f.path)).length;
  const commit = view?.kind === 'commit' ? commitBySha.get(view.sha) : undefined;
  const head = items[0];

  return (
    <div className="app two">
      <div className="top">
        <span className="title">#{pr.number} {pr.title}</span>
        <span className="meta">{pr.owner}/{pr.repo} · {pr.author} · {pr.baseRef} ← {pr.headSha.slice(0, 7)}</span>
        <span className="progress"><b>{readCount}</b> / {pr.files.length} files read{noiseLeft ? <> · {noiseLeft} noise, <kbd>n</kbd> skips</> : null}</span>
      </div>

      <div className="queue">
        <div className="tabs">
          <button className={tab === 'files' ? 'on' : ''} onClick={() => switchTab('files')}>Files</button>
          <button className={tab === 'commits' ? 'on' : ''} onClick={() => switchTab('commits')}>Commits</button>
          <span className="hint"><kbd>s</kbd></span>
        </div>
        {tab === 'files' ? (
          <Tree files={pr.files} readFiles={pr.readFiles} current={view?.kind === 'file' ? view.path : null} onPick={(path) => setView({ kind: 'file', path })} />
        ) : (
          pr.commits.map((c) => {
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
                  <div key={k.id} className={`chunk ${k.verdict} ${view?.kind === 'chunk' && view.id === k.id ? 'current' : ''}`} onClick={() => setView({ kind: 'chunk', id: k.id })} title={k.path}>
                    <span className="mark">{k.verdict === 'understood' ? '✓' : ''}</span>
                    <span className="path">{k.path}</span>
                    <span className="stat">+{k.adds}/-{k.dels}</span>
                  </div>
                ))}
              </div>
            );
          })
        )}
      </div>

      <div className="main">
        <div className="bar">
          {commit
            ? <><span className="path">{commit.sha.slice(0, 7)} {commit.subject}</span><span>{items.length} files · {commit.author}</span></>
            : head
              ? <><span className="path">{head.path}</span><span>{head.oldRev === 'base' ? 'vs merge-base' : head.newRev.slice(0, 7)} · {head.status} · +{head.adds}/-{head.dels}{head.read ? ' · read' : ''}</span></>
              : <span>nothing left to read</span>}
          <span className="keys">
            <kbd>u</kbd> read &nbsp; <kbd>x</kbd> unmark &nbsp; <kbd>j</kbd>/<kbd>k</kbd> move
            {tab === 'commits' && <> &nbsp; <kbd>c</kbd> {view?.kind === 'commit' ? 'one file' : 'whole commit'} &nbsp; <kbd>[</kbd>/<kbd>]</kbd> file</>}
          </span>
        </div>
        <div className="diff" ref={diffRef}>
          {items.length === 0 && <div className="empty">every file read</div>}
          {items.map((it) => (
            <div key={it.key} className={`stack ${it.read ? 'understood' : ''}`}>
              {patches[it.key] !== undefined
                ? patches[it.key].trim()
                  ? <PatchDiff key={it.key} patch={patches[it.key]} options={{ ...baseOptions, loadDiffFiles: loaderFor(it) }} disableWorkerPool />
                  : <div className="empty">{it.path}: no textual diff (binary or empty)</div>
                : <div className="empty">loading {it.path}…</div>}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
