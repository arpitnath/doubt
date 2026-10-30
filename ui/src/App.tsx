import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { PatchDiff, File as PierreFile, type DiffLineAnnotation, type FileDiffMetadata, type FileDiffLoadedFiles, type SelectedLineRange } from '@pierre/diffs/react';
import { definitions, fuzzy, getChunkDiff, getFileAt, getFileDiff, getPr, getTree, historyOf, resolveDoubt, syncPr, isNoise, outline, parseHunks, readingOrder, references, search, setHunk, setVerdict, type Chunk, type Hunk, type Loc, type PrFile, type PrState, type VerdictTarget } from './api';
import { Tree } from './Tree';
import { Landing } from './Landing';
import { Agent, type AgentHandle } from './Agent';
import { marked } from 'marked';

// hash routing, nothing more: #/ is the landing page, #/pr/<key> is a review
function useHash(): string {
  const [hash, setHash] = useState(window.location.hash);
  useEffect(() => {
    const on = () => setHash(window.location.hash);
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return hash;
}

export function App() {
  const hash = useHash();
  const m = hash.match(/^#\/pr\/(.+)$/);
  if (!m) return <Landing onOpen={(key) => { window.location.hash = `#/pr/${key}`; }} />;
  return <Review key={m[1]} prKey={decodeURIComponent(m[1])} />;
}

type Tab = 'files' | 'commits' | 'repo' | 'doubts';
type View = { kind: 'file'; path: string } | { kind: 'commit'; sha: string } | { kind: 'chunk'; id: string } | { kind: 'repo'; path: string };
interface Item { key: string; path: string; oldPath?: string; oldRev: string; newRev: string; read: boolean; status: string; adds: number; dels: number }
type PaletteMode = 'open' | 'search' | 'outline' | 'locs' | 'history';
interface Row { label: string; sub?: string; kind?: string; line?: number; path: string }

function Review({ prKey }: { prKey: string }) {
  const [pr, setPr] = useState<PrState | null>(null);
  const [tree, setTree] = useState<string[]>([]);
  const [tab, setTab] = useState<Tab>('files');
  const [view, setView] = useState<View | null>(null);
  const [patches, setPatches] = useState<Record<string, string>>({});
  const [repoFile, setRepoFile] = useState<{ path: string; contents: string } | null>(null);
  const [fullFile, setFullFile] = useState(false); // Zed-style: whole file with inline hunks
  const [split, setSplit] = useState(true);
  const [jump, setJump] = useState<{ path: string; line: number } | null>(null); // land here once rendered
  const [sel, setSel] = useState<{ key: string; range: SelectedLineRange } | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [palette, setPalette] = useState<{ mode: PaletteMode; query: string; rows: Row[]; title?: string } | null>(null);
  const [agentOpen, setAgentOpen] = useState(false);
  const [comment, setComment] = useState<string | null>(null); // the review comment being written, null when closed
  const [cursor, setCursor] = useState<{ key: string; hunk: number } | null>(null); // the hunk last jumped to
  const [since, setSince] = useState(false); // interdiff: only what changed since the previous head
  const [showDesc, setShowDesc] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [openAnswers, setOpenAnswers] = useState<Set<string>>(new Set()); // doubt ids whose inline answer is expanded
  const changedSet = useMemo(() => new Set(pr?.changedSince ?? []), [pr?.changedSince]);
  const agentRef = useRef<AgentHandle>(null);
  const commentRef = useRef<HTMLTextAreaElement>(null);
  const [paletteIdx, setPaletteIdx] = useState(0);
  const diffRef = useRef<HTMLDivElement>(null);
  const textCache = useRef(new Map<string, string>()); // `${rev}:${path}` -> contents

  useEffect(() => {
    getPr(prKey).then((s) => {
      setPr(s);
      const order = readingOrder(s.files);
      const first = order.find((f) => s.readFiles[f.path] === undefined && !isNoise(f)) ?? order.find((f) => s.readFiles[f.path] === undefined) ?? order[0];
      if (first) setView({ kind: 'file', path: first.path });
    });
    getTree(prKey).then((t) => setTree(t.paths));
  }, [prKey]);

  // while an answer is pending, refresh the doubts from the daemon, which reads the session transcript
  const pending = (pr?.doubts ?? []).some((d) => d.path && !d.done);
  useEffect(() => {
    if (!pending) return;
    const t = setInterval(() => getPr(prKey).then((s) => setPr((p) => (p ? { ...p, doubts: s.doubts } : p))), 2000);
    return () => clearInterval(t);
  }, [pending, prKey]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 1800);
    return () => clearTimeout(t);
  }, [toast]);

  const ordered = useMemo(() => (pr ? readingOrder(pr.files) : []), [pr]);
  const commitBySha = useMemo(() => new Map(pr?.commits.map((c) => [c.sha, c]) ?? []), [pr]);
  const fileByPath = useMemo(() => new Map(pr?.files.map((f) => [f.path, f]) ?? []), [pr]);
  const isRead = useCallback((path: string) => pr?.readFiles[path] !== undefined, [pr]);

  // what the center shows
  const items: Item[] = useMemo(() => {
    if (!pr || !view || view.kind === 'repo') return [];
    if (view.kind === 'file') {
      const f = fileByPath.get(view.path);
      return f ? [{ key: f.path, path: f.path, oldPath: f.oldPath, oldRev: 'base', newRev: 'head', read: isRead(f.path), status: f.status, adds: f.adds, dels: f.dels }] : [];
    }
    const chunks = view.kind === 'chunk' ? pr.chunks.filter((c) => c.id === view.id) : pr.chunks.filter((c) => c.sha === view.sha);
    return chunks.map((c) => ({ key: c.id, path: c.path, oldRev: `${c.sha}^`, newRev: c.sha, read: c.verdict !== 'none', status: c.status, adds: c.adds, dels: c.dels }));
  }, [pr, view, fileByPath, isRead]);

  const itemsKey = items.map((it) => it.key).join('|'); // reload only when what is shown changes, not when a flag on it does
  useEffect(() => {
    let cancelled = false; // fast j/j: an older response must not land on the newer view
    setPatches({});
    setRepoFile(null);
    setSel(null);
    setCursor(null);
    if (view?.kind === 'repo') {
      getFileAt(prKey, 'head', view.path).then((r) => { if (!cancelled) setRepoFile({ path: view.path, contents: r.contents ?? '' }); });
    } else {
      const loads = items.map((it) => (it.oldRev === 'base' ? getFileDiff(prKey, it.path, since && changedSet.has(it.path)) : getChunkDiff(prKey, it.key)).then((d) => [it.key, d.patch] as const));
      Promise.all(loads).then((pairs) => { if (!cancelled) setPatches(Object.fromEntries(pairs)); });
    }
    if (!jump) diffRef.current?.scrollTo({ top: 0 });
    return () => { cancelled = true; };
  }, [itemsKey, view?.kind, view?.kind === 'repo' ? view.path : '', prKey, since]); // eslint-disable-line react-hooks/exhaustive-deps

  // land on a line once the target has rendered: pierre marks rows with data-line
  useEffect(() => {
    if (!jump) return;
    const rendered = view?.kind === 'repo' ? repoFile?.path === jump.path : items.some((it) => it.path === jump.path && patches[it.key] !== undefined);
    if (!rendered) return;
    const t = setTimeout(() => {
      const pane = diffRef.current;
      const rows = pane ? [...pane.querySelectorAll<HTMLElement>(`[data-line="${jump.line}"]`)] : [];
      const el = rows[rows.length - 1]; // the new side comes last in a split row
      if (el) el.scrollIntoView({ block: 'center' });
      const key = view?.kind === 'repo' ? jump.path : items.find((it) => it.path === jump.path)?.key;
      if (key) setSel({ key, range: { start: jump.line, end: jump.line, side: 'additions' } });
      setJump(null);
    }, 60);
    return () => clearTimeout(t);
  }, [jump, patches, repoFile, items, view]);

  // text of a file at a revision, cached: outline, copy with context and definitions all need it
  const textOf = useCallback(async (rev: string, path: string): Promise<string> => {
    const k = `${rev}:${path}`;
    const have = textCache.current.get(k);
    if (have !== undefined) return have;
    const r = await getFileAt(prKey, rev, path);
    const text = r.contents ?? '';
    textCache.current.set(k, text);
    return text;
  }, [prKey]);

  // the file the reader is "in": the selection's item, else the single shown file, else the repo file
  const focus = useMemo((): { path: string; rev: string; key: string } | null => {
    if (view?.kind === 'repo') return { path: view.path, rev: 'head', key: view.path };
    const it = (sel && items.find((i) => i.key === sel.key)) ?? (items.length === 1 ? items[0] : undefined);
    return it ? { path: it.path, rev: it.newRev, key: it.key } : null;
  }, [view, sel, items]);

  // ---- verdicts ----------------------------------------------------------------------------------
  const apply = useCallback(async (target: VerdictTarget, verdict: 'understood' | 'none') => {
    if (!pr) return;
    const r = await setVerdict(prKey, target, verdict);
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
  }, [pr, prKey]);

  const nextFile = useCallback((from: string, readFiles: Record<string, string>): string | null => {
    const i = ordered.findIndex((f) => f.path === from);
    const unread = (f: PrFile) => readFiles[f.path] === undefined && f.path !== from;
    const n = ordered.slice(i + 1).find(unread) ?? ordered.find(unread);
    return n ? n.path : null;
  }, [ordered]);

  const judge = useCallback(async (verdict: 'understood' | 'none') => {
    if (!pr || !view || view.kind === 'repo') return;
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
    } else if (view.kind === 'commit') {
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

  // open any path: a changed file shows its PR diff, anything else shows the file at the PR head
  const openPath = useCallback((path: string, line?: number) => {
    if (line) setJump({ path, line });
    if (fileByPath.has(path)) { setView({ kind: 'file', path }); if (tab === 'commits') setTab('files'); }
    else { setView({ kind: 'repo', path }); setTab('repo'); }
  }, [fileByPath, tab]);

  const switchTab = useCallback((t: Tab) => {
    if (!pr) return;
    setTab(t);
    if (t === 'doubts') return;
    if (t === 'commits') {
      const first = pr.chunks.find((c) => c.verdict === 'none') ?? pr.chunks[0];
      if (first) setView({ kind: 'commit', sha: first.sha });
    } else if (t === 'files' && view?.kind !== 'file') {
      const path = view?.kind === 'chunk' ? pr.chunks.find((c) => c.id === view.id)?.path : view?.kind === 'repo' ? view.path : undefined;
      const first = path && fileByPath.has(path) ? path : (ordered.find((f) => !isRead(f.path)) ?? ordered[0])?.path;
      if (first) setView({ kind: 'file', path: first });
    }
  }, [pr, view, fileByPath, ordered, isRead]);

  // ---- palette: open, search, outline, locations ------------------------------------------------
  const openPalette = useCallback(async (mode: PaletteMode) => {
    setPaletteIdx(0);
    if (mode === 'outline') {
      if (!focus) { setToast('no file in focus'); return; }
      const text = await textOf(focus.rev, focus.path);
      const syms = outline(text, focus.path);
      setPalette({ mode, query: '', title: focus.path, rows: syms.map((s) => ({ label: s.name, kind: s.kind, line: s.line, path: focus.path })) });
      return;
    }
    setPalette({ mode, query: '', rows: [] });
  }, [focus, textOf]);

  const paletteRows = useMemo((): Row[] => {
    if (!palette) return [];
    if (palette.mode === 'open') return fuzzy(palette.query, tree).map((p) => ({ label: p.slice(p.lastIndexOf('/') + 1), sub: p.slice(0, Math.max(0, p.lastIndexOf('/'))), path: p }));
    if (palette.mode === 'outline') {
      const qq = palette.query.toLowerCase();
      return palette.rows.filter((r) => !qq || r.label.toLowerCase().includes(qq));
    }
    return palette.rows;
  }, [palette, tree]);

  // search as you type, debounced, newest query wins
  useEffect(() => {
    if (!palette || palette.mode !== 'search') return;
    const qq = palette.query;
    if (qq.trim().length < 2) { setPalette((p) => (p ? { ...p, rows: [] } : p)); return; }
    const t = setTimeout(() => {
      search(prKey, qq).then((r) => setPalette((p) => (p && p.mode === 'search' && p.query === qq ? { ...p, rows: r.hits.map((h) => ({ label: h.text.trim(), sub: h.path, line: h.line, path: h.path })) } : p)));
    }, 180);
    return () => clearTimeout(t);
  }, [palette?.query, palette?.mode, prKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const pickRow = useCallback((r: Row) => {
    setPalette(null);
    if (r.line !== undefined || palette?.mode === 'open') openPath(r.path, r.line);
  }, [openPath, palette?.mode]);

  // ---- code intelligence: cmd-click a token for its definition, shift-cmd-click for references --
  const showLocs = useCallback((title: string, locs: Loc[]) => {
    if (locs.length === 0) { setToast(`${title}: nothing found`); return; }
    if (locs.length === 1) { openPath(locs[0].path, locs[0].line); return; }
    setPaletteIdx(0);
    setPalette({ mode: 'locs', query: '', title, rows: locs.map((l) => ({ label: l.text || '', sub: l.path, line: l.line, path: l.path })) });
  }, [openPath]);

  const tokenClick = useCallback((path: string, line: number, col: number, ev: MouseEvent) => {
    if (!(ev.metaKey || ev.ctrlKey)) return;
    ev.preventDefault();
    const wantRefs = ev.altKey; // not shift: shift+click is pierre's range selection
    setToast(wantRefs ? 'finding references…' : 'finding definition…');
    (wantRefs ? references(prKey, path, line, col) : definitions(prKey, path, line, col))
      .then((r) => { setToast(null); showLocs(wantRefs ? 'references' : 'definition', r.locs); })
      .catch((err) => setToast(err instanceof Error ? err.message : String(err)));
  }, [prKey, showLocs]);

  // ---- copy reference / copy with context (px0's Alt+C / Alt+A) ----------------------------------
  const copyRef = useCallback(async (withContext: boolean) => {
    if (!focus) { setToast('select lines first'); return; }
    const range = sel && sel.key === focus.key ? { start: Math.min(sel.range.start, sel.range.end), end: Math.max(sel.range.start, sel.range.end) } : null;
    const ref = range ? (range.start === range.end ? `${focus.path}:${range.start}` : `${focus.path}:${range.start}-${range.end}`) : focus.path;
    let text = ref;
    if (withContext) {
      const body = await textOf(focus.rev, focus.path);
      const lines = body.split('\n');
      const a = range ? Math.max(1, range.start - 3) : 1;
      const b = range ? Math.min(lines.length, range.end + 3) : Math.min(lines.length, 60);
      text = `\`\`\`\n// ${ref}\n${lines.slice(a - 1, b).join('\n')}\n\`\`\``;
    }
    await navigator.clipboard.writeText(text);
    setToast(`copied ${withContext ? 'with context' : ref}`);
  }, [focus, sel, textOf]);

  // hunks per shown item, from the patch text, so navigation and marks never depend on pierre's DOM
  const hunksOf = useMemo(() => {
    const m = new Map<string, Hunk[]>();
    for (const it of items) if (patches[it.key] !== undefined) m.set(it.key, parseHunks(patches[it.key]));
    return m;
  }, [items, patches]);
  const flatHunks = useMemo(() => items.flatMap((it) => (hunksOf.get(it.key) ?? []).map((h) => ({ key: it.key, hunk: h }))), [items, hunksOf]);
  const hunkMarks = pr?.hunkMarks ?? {};
  const isHunkRead = useCallback((key: string, index: number) => (hunkMarks[key] ?? []).includes(index), [hunkMarks]);

  const scrollToHunk = useCallback((key: string, h: Hunk) => {
    const pane = diffRef.current;
    if (!pane) return;
    const stack = [...pane.querySelectorAll<HTMLElement>('.stack')].find((el) => el.dataset.key === key);
    const line = h.newCount > 0 ? h.newStart : h.oldStart;
    const rows = stack ? [...stack.querySelectorAll<HTMLElement>(`[data-line="${line}"]`)] : [];
    const el = h.newCount > 0 ? rows[rows.length - 1] : rows[0];
    if (el) el.scrollIntoView({ block: 'start' });
    else stack?.scrollIntoView({ block: 'start' });
    setCursor({ key, hunk: h.index });
  }, []);

  // space / shift+space: next and previous hunk across everything shown
  const stepHunk = useCallback((dir: 1 | -1) => {
    if (!flatHunks.length) return;
    const i = cursor ? flatHunks.findIndex((x) => x.key === cursor.key && x.hunk.index === cursor.hunk) : -1;
    const next = flatHunks[Math.min(Math.max(i + dir, 0), flatHunks.length - 1)];
    if (next) scrollToHunk(next.key, next.hunk);
  }, [flatHunks, cursor, scrollToHunk]);

  // m: toggle the current hunk read; when every hunk of a file is read, the file is read
  const toggleHunk = useCallback(async () => {
    const cur = cursor ?? (sel ? { key: sel.key, hunk: (hunksOf.get(sel.key) ?? []).find((h) => Math.min(sel.range.start, sel.range.end) >= h.newStart && Math.max(sel.range.start, sel.range.end) < h.newStart + Math.max(1, h.newCount))?.index ?? -1 } : null);
    if (!cur || cur.hunk < 0) { setToast('no hunk under the cursor: space to jump to one'); return; }
    const read = !isHunkRead(cur.key, cur.hunk);
    const r = await setHunk(prKey, cur.key, cur.hunk, read);
    setPr((p) => (p ? { ...p, hunkMarks: r.hunkMarks } : p));
    const all = hunksOf.get(cur.key) ?? [];
    if (read && all.length && all.every((h) => (r.hunkMarks[cur.key] ?? []).includes(h.index))) {
      const it = items.find((x) => x.key === cur.key);
      if (it) await apply(it.oldRev === 'base' ? { path: it.path } : { chunkId: it.key }, 'understood');
      setToast('every hunk read: file marked read');
    }
  }, [cursor, sel, hunksOf, isHunkRead, prKey, items, apply]);

  // b: who last touched the selected lines, or the current hunk
  const showHistory = useCallback(async () => {
    if (!focus) { setToast('open a file first'); return; }
    let range = sel && sel.key === focus.key ? { start: Math.min(sel.range.start, sel.range.end), end: Math.max(sel.range.start, sel.range.end) } : null;
    if (!range && cursor && cursor.key === focus.key) { const h = (hunksOf.get(focus.key) ?? [])[cursor.hunk]; if (h && h.newCount > 0) range = { start: h.newStart, end: h.newStart + h.newCount - 1 }; }
    if (!range) { setToast('select lines or jump to a hunk first'); return; }
    const r = await historyOf(prKey, focus.path, range.start, range.end);
    setPaletteIdx(0);
    setPalette({ mode: 'history', query: '', title: `${focus.path}:${range.start}-${range.end}`, rows: r.entries.map((e) => ({ label: e.subject, sub: `${e.author} · ${e.date} · ${e.lines} line${e.lines === 1 ? '' : 's'}`, kind: e.pr ? `#${e.pr}` : e.sha.slice(0, 7), path: focus.path })) });
  }, [focus, sel, cursor, hunksOf, prKey]);

  // ---- review comment to the active agent session (GitHub's gesture, the agent as recipient) --
  const commentTarget = useMemo(() => {
    if (!focus) return null;
    const range = sel && sel.key === focus.key ? { start: Math.min(sel.range.start, sel.range.end), end: Math.max(sel.range.start, sel.range.end) } : null;
    return { path: focus.path, rev: focus.rev, range };
  }, [focus, sel]);

  const sendComment = useCallback(async () => {
    if (!pr || !commentTarget || !comment?.trim()) return;
    if (!agentRef.current?.activeTitle()) { setToast('open a session first (a)'); return; }
    const { path, rev, range } = commentTarget;
    const body = await textOf(rev, path);
    const snippet = range ? body.split('\n').slice(range.start - 1, range.end).join('\n') : undefined;
    const ok = await agentRef.current.send(prKey, { path, lines: range ?? undefined, question: comment.trim(), snippet });
    setToast(ok ? `sent to ${agentRef.current.activeTitle()}` : 'no active terminal');
    setComment(null);
    const fresh = await getPr(prKey);
    setPr((p) => (p ? { ...p, doubts: fresh.doubts } : p));
  }, [pr, prKey, commentTarget, comment, textOf]);

  // ---- sync on demand: refetch the head, keep marks for untouched files, show what changed -------
  const sync = useCallback(async () => {
    setToast('syncing…');
    try {
      const r = await syncPr(prKey);
      if (!r.changed) { setToast('head unchanged'); return; }
      const fresh = await getPr(prKey);
      setPr(fresh);
      setSince(true);
      setToast(`new head ${r.headSha.slice(0, 7)}: ${r.changedSince.length} file${r.changedSince.length === 1 ? '' : 's'} changed, ${r.read} still read`);
      const first = readingOrder(fresh.files).find((f) => r.changedSince.includes(f.path));
      if (first) setView({ kind: 'file', path: first.path });
    } catch (err) {
      setToast(err instanceof Error ? err.message : String(err));
    }
  }, [prKey]);

  // ---- keys ---------------------------------------------------------------------------------------
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      const typing = tag === 'INPUT' || tag === 'TEXTAREA' || !!(e.target as HTMLElement)?.closest?.('.xterm');
      if (comment !== null) {
        if (e.key === 'Escape') setComment(null);
        else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void sendComment(); }
        return;
      }
      if (palette) {
        if (e.key === 'Escape') setPalette(null);
        else if (e.key === 'ArrowDown') { e.preventDefault(); setPaletteIdx((i) => Math.min(i + 1, Math.max(0, paletteRows.length - 1))); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); setPaletteIdx((i) => Math.max(i - 1, 0)); }
        else if (e.key === 'Enter') { const r = paletteRows[paletteIdx]; if (r) pickRow(r); }
        return;
      }
      if (typing) return;
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key === 'p') { e.preventDefault(); void openPalette('open'); return; }
      if (mod && e.shiftKey && (e.key === 'f' || e.key === 'F')) { e.preventDefault(); void openPalette('search'); return; }
      if (mod && e.shiftKey && (e.key === 'o' || e.key === 'O')) { e.preventDefault(); void openPalette('outline'); return; }
      if (mod || e.altKey) return;
      if (e.key === 'a') { e.preventDefault(); setAgentOpen((v) => !v); }
      else if (e.key === 'd') { e.preventDefault(); if (!commentTarget) { setToast('open a file first'); return; } setComment(''); setTimeout(() => commentRef.current?.focus(), 0); }
      else if (e.key === 'p') { e.preventDefault(); void openPalette('open'); } // preventDefault: the p must not land in the input that autofocuses
      else if (e.key === 'g') { e.preventDefault(); void openPalette('search'); }
      else if (e.key === 'o') { e.preventDefault(); void openPalette('outline'); }
      else if (e.key === ' ' || e.code === 'Space') { e.preventDefault(); stepHunk(e.shiftKey ? -1 : 1); }
      else if (e.key === 'm') void toggleHunk();
      else if (e.key === 'b') void showHistory();
      else if (e.key === 'r') void sync();
      else if (e.key === 'i') { if (pr?.prevHeadSha) setSince((v) => !v); else setToast('no previous head yet: nothing to compare since'); }
      else if (e.key === 'y') void copyRef(false);
      else if (e.key === 'Y') void copyRef(true);
      else if (e.key === 'u') void judge('understood');
      else if (e.key === 'x') void judge('none');
      else if (e.key === 'n') void skipNoise();
      else if (e.key === 'e') setFullFile((v) => !v);
      else if (e.key === 'w') setSplit((v) => !v);
      else if (e.key === 's') switchTab(tab === 'files' ? 'commits' : tab === 'commits' ? 'repo' : tab === 'repo' ? 'doubts' : 'files');
      else if (e.key === 'v') setShowDesc((x) => !x);
      else if (e.key === '?') setShowHelp((x) => !x);
      else if (e.key === 'Escape') setShowHelp(false);
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
  }, [judge, skipNoise, switchTab, move, jumpStack, openPalette, pickRow, copyRef, sendComment, commentTarget, comment, stepHunk, toggleHunk, showHistory, sync, tab, view, pr, palette, paletteRows, paletteIdx]);

  // ---- render -------------------------------------------------------------------------------------
  const theme = useMemo(() => ({ dark: 'github-dark' as const, light: 'github-light' as const }), []);

  const diffOptionsFor = useCallback((it: Item) => ({
    diffStyle: (fullFile ? 'unified' : split ? 'split' : 'unified') as 'split' | 'unified',
    theme,
    lineDiffType: 'word' as const,
    stickyHeader: true,
    expandUnchanged: fullFile,
    enableLineSelection: true,
    onLineSelectionEnd: (range: SelectedLineRange | null) => setSel(range ? { key: it.key, range } : null),
    onTokenClick: (p: { lineNumber: number; lineCharStart: number; side?: 'deletions' | 'additions' }, ev: MouseEvent) => {
      if (p.side === 'deletions') return; // definitions resolve against the new side only
      tokenClick(it.path, p.lineNumber, p.lineCharStart, ev);
    },
    loadDiffFiles: loaderFor(it)
  }), [fullFile, split, theme, tokenClick]); // eslint-disable-line react-hooks/exhaustive-deps

  const fileOptionsFor = useCallback((path: string) => ({
    theme,
    stickyHeader: true,
    enableLineSelection: true,
    onLineSelectionEnd: (range: SelectedLineRange | null) => setSel(range ? { key: path, range } : null),
    onTokenClick: (p: { lineNumber: number; lineCharStart: number }, ev: MouseEvent) => tokenClick(path, p.lineNumber, p.lineCharStart, ev)
  }), [theme, tokenClick]);

  type Ann = { hunk?: number; doubt?: string };
  const annotationsFor = useCallback((it: Item): DiffLineAnnotation<Ann>[] => {
    const hunks: DiffLineAnnotation<Ann>[] = (hunksOf.get(it.key) ?? []).filter((h) => isHunkRead(it.key, h.index)).map((h) => (
      h.newCount > 0 ? { side: 'additions' as const, lineNumber: h.newStart, metadata: { hunk: h.index } } : { side: 'deletions' as const, lineNumber: h.oldStart, metadata: { hunk: h.index } }
    ));
    const answers: DiffLineAnnotation<Ann>[] = (pr?.doubts ?? [])
      .filter((d) => d.path === it.path && d.lines && !d.resolved)
      .map((d) => ({ side: 'additions' as const, lineNumber: d.lines!.end, metadata: { doubt: d.id } }));
    return [...hunks, ...answers];
  }, [hunksOf, isHunkRead, pr?.doubts]);

  const renderAnn = useCallback((a: DiffLineAnnotation<Ann>) => {
    if (a.metadata.hunk !== undefined) return <div className="hunk-read">✓ hunk read</div>;
    const d = pr?.doubts.find((x) => x.id === a.metadata.doubt);
    if (!d) return null;
    const open = openAnswers.has(d.id);
    return (
      <div className={`answer ${open ? 'open' : ''}`} onClick={() => setOpenAnswers((s) => { const n = new Set(s); n.has(d.id) ? n.delete(d.id) : n.add(d.id); return n; })}>
        <div className="q">you: {d.question}</div>
        {d.answer ? d.answer : <span className="wait">{d.done ? 'no answer' : 'waiting for the session…'}</span>}
      </div>
    );
  }, [pr?.doubts, openAnswers]);

  // context expansion: pierre asks for both full sides when a collapsed region is opened, or at once in full-file mode
  function loaderFor(it: Item) {
    return async (meta: FileDiffMetadata): Promise<FileDiffLoadedFiles> => {
      const oldName = meta.prevName || meta.name;
      const parent = it.oldRev.endsWith('^');
      const [oldText, newText] = await Promise.all([
        getFileAt(prKey, parent ? it.oldRev.slice(0, -1) : it.oldRev, oldName, parent).then((r) => r.contents ?? ''),
        textOf(it.newRev, meta.name)
      ]);
      return { oldFile: { name: oldName, contents: oldText }, newFile: { name: meta.name, contents: newText } };
    };
  }

  if (!pr) return <div className="main"><div className="empty">loading…</div></div>;

  const readCount = Object.keys(pr.readFiles).length;
  const noiseLeft = pr.files.filter((f) => isNoise(f) && !isRead(f.path)).length;
  const commit = view?.kind === 'commit' ? commitBySha.get(view.sha) : undefined;
  const head = items[0];
  const currentPath = view?.kind === 'file' || view?.kind === 'repo' ? view.path : null;

  return (
    <div className={`app ${agentOpen ? 'three' : 'two'}`} tabIndex={-1} ref={(el) => { if (el && !el.contains(document.activeElement)) el.focus(); }} style={{ outline: 'none' }}>
      <div className="top">
        <a className="home" href="#/" title="all pull requests">doubt</a>
        <span className="title">#{pr.number} {pr.title}</span>
        <span className="meta">{pr.owner}/{pr.repo} · {pr.author} · {pr.baseRef} ← {pr.headSha.slice(0, 7)}</span>
        <span className="progress"><b>{readCount}</b> / {pr.files.length} files read{noiseLeft ? <> · {noiseLeft} noise, <kbd>n</kbd> skips</> : null}{changedSet.size ? <> · {changedSet.size} changed since {pr.prevHeadSha?.slice(0, 7)}</> : null} · <kbd>r</kbd> sync</span>
      </div>

      <div className="queue">
        <div className="tabs">
          <button className={tab === 'files' ? 'on' : ''} onClick={() => switchTab('files')}>Changes</button>
          <button className={tab === 'commits' ? 'on' : ''} onClick={() => switchTab('commits')}>Commits</button>
          <button className={tab === 'repo' ? 'on' : ''} onClick={() => switchTab('repo')}>Repo</button>
          <button className={tab === 'doubts' ? 'on' : ''} onClick={() => switchTab('doubts')}>Doubts{pr.doubts.filter((d) => d.path && !d.resolved).length ? ` ${pr.doubts.filter((d) => d.path && !d.resolved).length}` : ''}</button>

        </div>
        {tab === 'files' && <Tree paths={pr.files.map((f) => f.path)} meta={fileByPath} readFiles={pr.readFiles} changed={changedSet} signals={pr.signals} current={currentPath} onPick={(p) => openPath(p)} />}
        {tab === 'repo' && (tree.length ? <Tree paths={tree} meta={fileByPath} readFiles={pr.readFiles} current={currentPath} onPick={(p) => openPath(p)} repo /> : <div className="empty">loading tree…</div>)}
        {tab === 'doubts' && (
          <div className="doubts">
            {pr.doubts.filter((d) => d.path).length === 0 && <div className="empty">no doubts yet: select lines, <kbd>d</kbd>, write, <kbd>⌘enter</kbd></div>}
            {[...pr.doubts].filter((d) => d.path).reverse().map((d) => (
              <div key={d.id} className={`doubt ${d.resolved ? 'resolved' : ''} ${openAnswers.has(d.id) ? 'open' : ''}`} onClick={() => { openPath(d.path!, d.lines?.start); setOpenAnswers((s) => new Set(s).add(d.id)); }}>
                <div className="where">
                  <input type="checkbox" checked={!!d.resolved} title="resolved: I understand this now" onClick={(e) => e.stopPropagation()} onChange={async (e) => { await resolveDoubt(prKey, d.id, e.target.checked); setPr((p) => (p ? { ...p, doubts: p.doubts.map((x) => (x.id === d.id ? { ...x, resolved: e.target.checked } : x)) } : p)); }} />
                  <span>{d.path}{d.lines ? `:${d.lines.start}${d.lines.end !== d.lines.start ? `-${d.lines.end}` : ''}` : ''}</span>
                </div>
                <div className="q">{d.question}</div>
                {d.answer ? <div className="a">{d.answer}</div> : <div className="wait">{d.done ? 'no answer recorded' : 'waiting for the session…'}</div>}
              </div>
            ))}
          </div>
        )}
        {tab === 'commits' && pr.commits.map((c) => {
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
        })}
      </div>

      <div className="main" onMouseDown={(e) => { if (!(e.target as HTMLElement).closest('input,textarea')) (e.currentTarget.closest('.app') as HTMLElement | null)?.focus(); }}>
        <div className="bar">
          {view?.kind === 'repo'
            ? <><span className="path">{view.path}</span><span className="meta2">at PR head · not changed by this PR</span></>
            : commit
              ? <><span className="path">{commit.sha.slice(0, 7)} {commit.subject}</span><span className="meta2">{items.length} files · {commit.author}</span></>
              : head
                ? <><span className="path">{head.path}</span><span className="meta2">{head.oldRev === 'base' ? (since && changedSet.has(head.path) ? `since ${pr.prevHeadSha?.slice(0, 7)}` : 'vs merge-base') : head.newRev.slice(0, 7)} · {head.status} · +{head.adds}/-{head.dels}{head.read ? ' · read' : ''}{changedSet.has(head.path) ? <> · changed since your read, <kbd>i</kbd> {since ? 'whole diff' : 'only what changed'}</> : null}</span></>
                : <span>nothing left to read</span>}
          {head && (pr.signals?.[head.path] ?? []).length > 0 && (
            <span className="sigline">{(pr.signals?.[head.path] ?? []).map((x) => {
              const note = x.kind === 'owners' ? x.note.split(' ').slice(0, 2).join(' ') + (x.note.split(' ').length > 2 ? ` +${x.note.split(' ').length - 2}` : '') : x.note;
              return <span key={x.kind} title={x.note}><b>{x.kind}</b> {note} &nbsp;</span>;
            })}</span>
          )}
          <span className="keys">
            {flatHunks.length ? <span className="hunkpos">hunk {cursor ? flatHunks.findIndex((x) => x.key === cursor.key && x.hunk.index === cursor.hunk) + 1 : 0}/{flatHunks.length}</span> : null}
            <kbd>?</kbd> keys
          </span>
        </div>
        {showDesc && (
          <div className="desc">
            {pr.body?.trim()
              ? <div dangerouslySetInnerHTML={{ __html: marked.parse(pr.body, { async: false }) as string }} />
              : <div className="empty">this PR has no description</div>}
          </div>
        )}
        <div className="diff" ref={diffRef}>
          {view?.kind === 'repo' && (repoFile
            ? <div className="stack"><PierreFile file={{ name: repoFile.path, contents: repoFile.contents }} options={fileOptionsFor(repoFile.path)} selectedLines={sel?.key === repoFile.path ? sel.range : null} disableWorkerPool /></div>
            : <div className="empty">loading {view.path}…</div>)}
          {view?.kind !== 'repo' && items.length === 0 && <div className="empty">every file read</div>}
          {items.map((it) => (
            <div key={it.key} className={`stack ${it.read ? 'understood' : ''}`} data-key={it.key}>
              {patches[it.key] !== undefined
                ? patches[it.key].trim()
                  ? <PatchDiff<Ann> key={`${it.key}:${fullFile}:${split}`} patch={patches[it.key]} options={diffOptionsFor(it)} selectedLines={sel?.key === it.key ? sel.range : null} lineAnnotations={annotationsFor(it)} renderAnnotation={renderAnn} disableWorkerPool />
                  : <div className="empty">{it.path}: no textual diff (binary or empty)</div>
                : <div className="empty">loading {it.path}…</div>}
            </div>
          ))}
        </div>
      </div>

      {palette && (
        <div className="palette" onClick={() => setPalette(null)}>
          <div className="box" onClick={(e) => e.stopPropagation()}>
            <div className="mode">
              <span><b>{palette.mode === 'open' ? 'open file' : palette.mode === 'search' ? 'search repo' : palette.mode === 'outline' ? 'outline' : palette.mode === 'history' ? 'history' : palette.title}</b></span>
              {palette.mode === 'history' && <span>{palette.title} · who last touched these lines, at the PR head</span>}
              {palette.mode === 'outline' && <span>{palette.title}</span>}
              {palette.mode === 'locs' && <span>{palette.rows.length} places</span>}
              {palette.mode === 'search' && <span>{palette.rows.length ? `${palette.rows.length} hits` : 'git grep, case-insensitive'}</span>}
            </div>
            {palette.mode !== 'locs' && palette.mode !== 'history' && (
              <input autoFocus value={palette.query} placeholder={palette.mode === 'open' ? 'file name…' : palette.mode === 'search' ? 'text to find…' : 'symbol…'} onChange={(e) => { const v = e.target.value; setPalette((p) => (p ? { ...p, query: v } : p)); setPaletteIdx(0); }} />
            )}
            <div className="list">
              {paletteRows.length === 0
                ? <div className="none">{palette.mode === 'open' ? `${tree.length} files in the repo` : palette.mode === 'outline' ? 'no symbols found' : palette.query.length < 2 ? 'type at least two characters' : 'no match'}</div>
                : paletteRows.map((r, i) => (
                  <div key={`${r.path}:${r.line ?? ''}:${i}`} className={`row ${i === paletteIdx ? 'on' : ''}`} onMouseEnter={() => setPaletteIdx(i)} onClick={() => pickRow(r)}>
                    {r.kind && <span className="kind">{r.kind}</span>}
                    {palette.mode === 'open' && <span className="st">{fileByPath.get(r.path)?.status ?? ''}</span>}
                    <span className={palette.mode === 'open' ? '' : 'text'}>{r.label}</span>
                    {r.sub !== undefined && <span className="dir">{r.sub}</span>}
                    {r.line !== undefined && <span className="line">{r.line}</span>}
                  </div>
                ))}
            </div>
          </div>
        </div>
      )}
      {agentOpen && <Agent ref={agentRef} workdir={pr.dir} workdirLabel={`${pr.repo}#${pr.number}`} onClose={() => setAgentOpen(false)} />}

      {comment !== null && commentTarget && (
        <div className="comment" style={{ right: agentOpen ? 540 : 24, bottom: 24 }}>
          <div className="ref">{commentTarget.range ? `${commentTarget.path}:${commentTarget.range.start}-${commentTarget.range.end}` : commentTarget.path}</div>
          <textarea ref={commentRef} rows={4} value={comment} onChange={(e) => setComment(e.target.value)} placeholder="what should the agent look at here?" />
          <div className="to">to <b>{agentRef.current?.activeTitle() ?? 'no session open, press a'}</b> · <kbd>⌘</kbd><kbd>enter</kbd> send · <kbd>esc</kbd> cancel</div>
        </div>
      )}
      {showHelp && (
        <div className="palette" onClick={() => setShowHelp(false)}>
          <div className="box help" onClick={(e) => e.stopPropagation()}>
            <div className="mode"><span><b>keys</b></span><span>press <kbd>?</kbd> or <kbd>esc</kbd> to close</span></div>
            <div className="cols">
              <div>
                <h4>read</h4>
                <div><kbd>u</kbd> read the shown file or commit, next unread</div>
                <div><kbd>x</kbd> unmark</div>
                <div><kbd>n</kbd> mark every noise file read</div>
                <div><kbd>space</kbd> / <kbd>⇧space</kbd> next / previous hunk</div>
                <div><kbd>m</kbd> mark the current hunk read</div>
                <div><kbd>j</kbd> / <kbd>k</kbd> next / previous file or commit</div>
                <div><kbd>[</kbd> / <kbd>]</kbd> files inside a stacked commit</div>
                <h4>view</h4>
                <div><kbd>e</kbd> whole file with inline hunks, or hunks only</div>
                <div><kbd>w</kbd> split or unified</div>
                <div><kbd>c</kbd> in Commits: whole commit or one file</div>
                <div><kbd>v</kbd> PR description</div>
                <div><kbd>i</kbd> only what changed since the previous head</div>
                <div><kbd>s</kbd> cycle Changes, Commits, Repo, Doubts</div>
              </div>
              <div>
                <h4>find</h4>
                <div><kbd>p</kbd> open any file by name</div>
                <div><kbd>g</kbd> search the repo</div>
                <div><kbd>o</kbd> outline of the file in focus</div>
                <div><kbd>b</kbd> who last touched the selected lines</div>
                <div><kbd>⌘</kbd>click go to definition · <kbd>⌘⌥</kbd>click references</div>
                <h4>take out</h4>
                <div><kbd>y</kbd> copy path:line · <kbd>Y</kbd> copy with context</div>
                <h4>agent</h4>
                <div><kbd>a</kbd> agent sidebar: your Claude Code sessions, as terminals</div>
                <div><kbd>d</kbd> review comment on the selected lines, <kbd>⌘enter</kbd> sends</div>
                <h4>sync</h4>
                <div><kbd>r</kbd> refetch the head, keep marks for untouched files</div>
              </div>
            </div>
          </div>
        </div>
      )}
      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
