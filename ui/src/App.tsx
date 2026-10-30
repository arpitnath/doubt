import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { PatchDiff, File as PierreFile, type DiffLineAnnotation, type FileDiffMetadata, type FileDiffLoadedFiles, type SelectedLineRange } from '@pierre/diffs/react';
import { agentSessions, definitions, fuzzy, hoverAt, getChunkDiff, getFileAt, getFileDiff, getPr, getTree, historyOf, resolveDoubt, syncPr, isNoise, outline, parseHunks, readingOrder, references, search, setVerdict, type AgentSession, type Chunk, type Doubt, type HoverInfo, type Hunk, type Loc, type PrFile, type PrState, type VerdictTarget } from './api';
import { Tree } from './Tree';
import { Landing } from './Landing';
import { Agent, type AgentHandle } from './Agent';
import { marked } from 'marked';
import { THEMES, applyTheme, readTheme, type Theme } from './theme';
import { Palette, type PaletteMode, type PaletteState, type Row } from './Palette';
import { HoverCard } from './HoverCard';
import { SendTo, toTarget } from './SendTo';

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
interface Token { lineNumber: number; lineCharStart: number; tokenText: string; tokenElement: HTMLElement }

// The name under the pointer inside a highlighted token. The highlighter merges same-colored text
// into one token ("{ useState, useEffect }"); code is monospaced, so x gives the character.
function nameUnder(p: Token, clientX: number): { name: string; col: number; x: number; y: number } | null {
  const r = p.tokenElement.getBoundingClientRect();
  const w = r.width / Math.max(1, p.tokenText.length);
  const i = Math.floor((clientX - r.left) / w);
  for (const m of p.tokenText.matchAll(/[A-Za-z_$][\w$]*/g)) {
    if (i >= m.index! && i < m.index! + m[0].length) return { name: m[0], col: p.lineCharStart + m.index!, x: r.left + m.index! * w, y: r.bottom + 6 };
  }
  return null;
}
type View = { kind: 'file'; path: string } | { kind: 'commit'; sha: string } | { kind: 'chunk'; id: string } | { kind: 'repo'; path: string };
interface Item { key: string; path: string; oldPath?: string; oldRev: string; newRev: string; read: boolean; status: string; adds: number; dels: number }

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
  const [palette, setPalette] = useState<PaletteState | null>(null);
  const [agentOpen, setAgentOpen] = useState(false);
  const [comment, setComment] = useState<string | null>(null); // the review comment being written, null when closed
  const [cursor, setCursor] = useState<{ key: string; hunk: number } | null>(null); // the hunk last jumped to
  const [since, setSince] = useState(false); // interdiff: only what changed since the previous head
  const [showDesc, setShowDesc] = useState(false);
  const [uiTheme, setUiTheme] = useState<Theme>(readTheme);
  useEffect(() => applyTheme(uiTheme), [uiTheme]);
  const [openAnswers, setOpenAnswers] = useState<Set<string>>(new Set()); // doubt ids whose inline answer is expanded
  const [sendTo, setSendTo] = useState('new'); // 'term:<id>' | 'session:<id>' | 'new'
  const [sendSessions, setSendSessions] = useState<AgentSession[]>([]);
  const [seen, setSeen] = useState<Set<string> | null>(null); // answers already looked at; null until loaded
  const [hover, setHover] = useState<{ name: string; x: number; y: number; info: HoverInfo | null } | null>(null);
  const hoverCache = useRef(new Map<string, HoverInfo | null>());
  const hoverTimer = useRef<number | undefined>(undefined);
  const [picked, setPicked] = useState<{ key: string; path: string; line: number; col: number; text: string } | null>(null); // the name last clicked in the code
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

  // every action the screen offers, for ⌘K; buttons stay the primary way, this is the fast one
  const actions = (): Row[] => {
    if (!pr) return [];
    const shownRead = items.length > 0 && items.every((i) => i.read);
    const noise = pr.files.filter((f) => isNoise(f) && !isRead(f.path)).length;
    const list: Array<Row | false> = [
      view?.kind !== 'repo' && items.length > 0 && { label: shownRead ? 'Mark unread' : 'Mark read, open the next unread', terms: 'mark read unread understood', hint: 'u', run: () => void judge(shownRead ? 'none' : 'understood') },
      { label: 'Next file', hint: 'j', run: () => move(1) },
      { label: 'Previous file', hint: 'k', run: () => move(-1) },
      { label: split && !fullFile ? 'Show unified' : 'Show split', terms: 'layout split unified side by side', run: () => { setSplit(!(split && !fullFile)); setFullFile(false); } },
      { label: fullFile ? 'Show the changes only' : 'Show the whole file', terms: 'scope whole file changes only', run: () => setFullFile((v) => !v) },
      { label: 'Search the repo for text…', run: () => { setPaletteIdx(0); setPalette({ mode: 'search', query: '', rows: [] }); } },
      { label: 'Outline of this file…', run: () => void openPalette('outline') },
      { label: showDesc ? 'Hide the PR description' : 'Show the PR description', terms: 'description body', run: () => setShowDesc((x) => !x) },
      { label: 'Sync with GitHub', run: () => void sync() },
      { label: agentOpen ? 'Hide the agent panel' : 'Show the agent panel', terms: 'agent claude session terminal', run: () => setAgentOpen((v) => !v) },
      noise > 0 && { label: `Skip ${noise} noise file${noise === 1 ? '' : 's'}`, run: () => void skipNoise() },
      { label: 'Go to Changes', run: () => switchTab('files') },
      { label: 'Go to Commits', run: () => switchTab('commits') },
      { label: 'Go to Repo', run: () => switchTab('repo') },
      { label: 'Go to Doubts', run: () => switchTab('doubts') },
      { label: `Theme: switch to ${THEMES[(THEMES.indexOf(uiTheme) + 1) % THEMES.length]}`, terms: 'theme dark dim light', run: () => setUiTheme((t) => THEMES[(THEMES.indexOf(t) + 1) % THEMES.length]) },
      { label: 'All pull requests', run: () => { window.location.hash = '#/'; } }
    ];
    return list.filter((r): r is Row => !!r).map((r) => ({ ...r, kind: 'action' }));
  };

  let paletteRows: Row[] = [];
  if (palette?.mode === 'all') {
    const qq = palette.query.trim().toLowerCase();
    const acts = actions().filter((a) => !qq || `${a.label} ${a.terms ?? ''}`.toLowerCase().includes(qq));
    // files this PR changes come first: in a review they are what you are looking for
    const matches = fuzzy(palette.query, tree, 60);
    const ranked = [...matches.filter((p) => fileByPath.has(p)), ...matches.filter((p) => !fileByPath.has(p))].slice(0, 20);
    const files: Row[] = ranked.map((p) => ({ kind: fileByPath.get(p)?.status ?? 'file', label: p.slice(p.lastIndexOf('/') + 1), sub: p.slice(0, Math.max(0, p.lastIndexOf('/'))), path: p }));
    paletteRows = qq ? [...acts.slice(0, 5), ...files] : acts;
  } else if (palette?.mode === 'outline') {
    const qq = palette.query.toLowerCase();
    paletteRows = palette.rows.filter((r) => !qq || r.label.toLowerCase().includes(qq));
  } else if (palette) {
    paletteRows = palette.rows;
  }

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
    if (r.run) r.run();
    else if (r.path && (r.line !== undefined || palette?.mode === 'all')) openPath(r.path, r.line);
  }, [openPath, palette?.mode]);

  // ---- code intelligence: cmd-click a token for its definition, shift-cmd-click for references --
  const showLocs = useCallback((title: string, locs: Loc[]) => {
    if (locs.length === 0) { setToast(`${title}: nothing found`); return; }
    if (locs.length === 1) { openPath(locs[0].path, locs[0].line); return; }
    setPaletteIdx(0);
    setPalette({ mode: 'locs', query: '', title, rows: locs.map((l) => ({ label: l.text || '', sub: l.path, line: l.line, path: l.path })) });
  }, [openPath]);

  const lookup = useCallback((path: string, line: number, col: number, wantRefs: boolean) => {
    setToast(wantRefs ? 'finding references…' : 'finding definition…');
    (wantRefs ? references(prKey, path, line, col) : definitions(prKey, path, line, col))
      .then((r) => { setToast(null); showLocs(wantRefs ? 'references' : 'definition', r.locs); })
      .catch((err) => setToast(err instanceof Error ? err.message : String(err)));
  }, [prKey, showLocs]);

  // hover a name: after a short pause, TypeScript's answers about it, cached per head and position;
  // the name is found under the pointer, inside a merged token too
  const hoverAtPointer = useRef<{ el: HTMLElement; move: (e: MouseEvent) => void; shown: string } | null>(null);
  const prHead = pr?.headSha ?? '';
  const tokenEnter = useCallback((path: string, p: Token, ev?: PointerEvent) => {
    if (hoverAtPointer.current) hoverAtPointer.current.el.removeEventListener('mousemove', hoverAtPointer.current.move);
    const show = (clientX: number) => {
      const hit = nameUnder(p, clientX);
      const k = hit ? `${prHead}:${path}:${p.lineNumber}:${hit.col}` : ''; // answers belong to one head
      if (hoverAtPointer.current && hoverAtPointer.current.shown === k) return;
      if (hoverAtPointer.current) hoverAtPointer.current.shown = k;
      window.clearTimeout(hoverTimer.current);
      if (!hit) { hoverTimer.current = window.setTimeout(() => setHover(null), 200); return; }
      hoverTimer.current = window.setTimeout(() => {
        const at = { name: hit.name, x: hit.x, y: hit.y };
        if (hoverCache.current.has(k)) { const info = hoverCache.current.get(k)!; setHover(info ? { ...at, info } : null); return; }
        setHover({ ...at, info: null });
        hoverAt(prKey, path, p.lineNumber, hit.col).then((res) => {
          hoverCache.current.set(k, res.hover);
          setHover((h) => (h && h.name === at.name && h.x === at.x && h.y === at.y ? (res.hover ? { ...at, info: res.hover } : null) : h));
        }).catch(() => setHover(null));
      }, 300);
    };
    const move = (e: MouseEvent) => show(e.clientX);
    p.tokenElement.addEventListener('mousemove', move);
    hoverAtPointer.current = { el: p.tokenElement, move, shown: '' };
    if (ev) show(ev.clientX);
  }, [prKey, prHead]);
  const tokenLeave = useCallback(() => {
    if (hoverAtPointer.current) { hoverAtPointer.current.el.removeEventListener('mousemove', hoverAtPointer.current.move); hoverAtPointer.current = null; }
    window.clearTimeout(hoverTimer.current);
    hoverTimer.current = window.setTimeout(() => setHover(null), 200); // time to move onto the card
  }, []);

  // a plain click on a name remembers it for the line bar; ⌘-click goes to its definition, ⌘⌥-click lists its references
  const tokenClick = useCallback((key: string, path: string, p: Token, ev: MouseEvent) => {
    const hit = nameUnder(p, ev.clientX);
    if (!hit) return;
    if (!(ev.metaKey || ev.ctrlKey)) { setPicked({ key, path, line: p.lineNumber, col: hit.col, text: hit.name }); return; }
    ev.preventDefault();
    lookup(path, p.lineNumber, hit.col, ev.altKey); // not shift: shift+click is pierre's range selection
  }, [lookup]);

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
    try {
      await navigator.clipboard.writeText(text);
      setToast(`copied ${withContext ? 'with context' : ref}`);
    } catch {
      setToast(`the browser blocked the clipboard: ${ref}`); // say so, and show the ref so it can be copied by hand
    }
  }, [focus, sel, textOf]);

  // hunks per shown item, from the patch text, so navigation and marks never depend on pierre's DOM
  const hunksOf = useMemo(() => {
    const m = new Map<string, Hunk[]>();
    for (const it of items) if (patches[it.key] !== undefined) m.set(it.key, parseHunks(patches[it.key]));
    return m;
  }, [items, patches]);
  const flatHunks = useMemo(() => items.flatMap((it) => (hunksOf.get(it.key) ?? []).map((h) => ({ key: it.key, hunk: h }))), [items, hunksOf]);

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
    if (!pr || !commentTarget || !comment?.trim() || !agentRef.current) return;
    const { path, rev, range } = commentTarget;
    const body = await textOf(rev, path);
    const snippet = range ? body.split('\n').slice(range.start - 1, range.end).join('\n') : undefined;
    const target = toTarget(sendTo, sendSessions);
    if (!target) { setToast('that session is no longer there: pick another'); return; }
    setAgentOpen(true);
    const termId = await agentRef.current.deliver(target, prKey, { path, lines: range ?? undefined, question: comment.trim(), snippet });
    if (!termId) { setToast('could not reach that session'); return; }
    const next = target.kind === 'new' ? `term:${termId}` : sendTo; // a new session is the default from now on
    setSendTo(next);
    try { localStorage.setItem(`doubt.sendto.${prKey}`, next); } catch { /* storage blocked: default next time */ }
    setToast(target.kind === 'new' ? 'starting a session in the PR checkout; the doubt goes in once it is ready' : 'sent');
    setComment(null);
    const fresh = await getPr(prKey);
    setPr((p) => (p ? { ...p, doubts: fresh.doubts } : p));
  }, [pr, prKey, commentTarget, comment, textOf, sendTo, sendSessions]);

  // Ask a doubt: the sessions to choose from, grouped by what they see, and last time's choice if it still exists
  const startDoubt = useCallback(async () => {
    setComment('');
    setTimeout(() => commentRef.current?.focus(), 0);
    const { sessions } = await agentSessions(prKey).catch(() => ({ sessions: [] as AgentSession[] }));
    const mine = sessions.filter((x) => x.group && x.group !== 'other');
    setSendSessions(mine);
    const terms = agentRef.current?.terms().filter((t) => t.alive) ?? [];
    let remembered: string | null = null;
    try { remembered = localStorage.getItem(`doubt.sendto.${prKey}`); } catch { /* storage blocked */ }
    const exists = (v: string | null) => !!v && (v === 'new' || (v.startsWith('term:') && terms.some((t) => `term:${t.id}` === v)) || (v.startsWith('session:') && mine.some((x) => `session:${x.sessionId}` === v && !x.missing)));
    const newestHere = mine.find((x) => x.group === 'this-pr' && !x.missing);
    setSendTo(exists(remembered) ? remembered! : newestHere ? `session:${newestHere.sessionId}` : 'new');
  }, [prKey]);

  // answers seen: loaded per PR; the first time, every answer already there counts as seen
  useEffect(() => {
    if (!pr || seen) return;
    let ids: string[] | null = null;
    try { ids = JSON.parse(localStorage.getItem(`doubt.seen.${prKey}`) ?? 'null'); } catch { /* storage blocked */ }
    setSeen(new Set(ids ?? pr.doubts.filter((d) => d.answer).map((d) => d.id)));
  }, [pr, seen, prKey]);
  useEffect(() => { if (seen) try { localStorage.setItem(`doubt.seen.${prKey}`, JSON.stringify([...seen])); } catch { /* storage blocked */ } }, [seen, prKey]);
  // an answer that lands on the file being read counts as seen; elsewhere it waits in the tray
  const shownPaths = items.map((i) => i.path).join('|');
  useEffect(() => {
    if (!pr || !seen) return;
    const fresh = pr.doubts.filter((d) => d.answer && !seen.has(d.id) && d.path && shownPaths.split('|').includes(d.path));
    if (fresh.length) setSeen((s) => new Set([...(s ?? []), ...fresh.map((d) => d.id)]));
  }, [pr, seen, shownPaths]);
  const unseen = (pr?.doubts ?? []).filter((d) => d.path && d.answer && seen && !seen.has(d.id)).length;

  const pickDoubt = useCallback((d: Doubt) => {
    if (d.path) openPath(d.path, d.lines?.start);
    setOpenAnswers((s) => new Set(s).add(d.id));
    setSeen((s) => new Set([...(s ?? []), d.id]));
  }, [openPath]);

  // the line bar: what can be done with the selected lines, said in words; the doubt box opens in its place
  function lineBar() {
    if (!commentTarget?.range) return null;
    const { path, range } = commentTarget;
    const where = range.start === range.end ? `${path}:${range.start}` : `${path}:${range.start}-${range.end}`;
    if (comment !== null) {
      return (
        <div className="linebar composer" onClick={(e) => e.stopPropagation()}>
          <label>Your doubt on <code>{where}</code>. The file, lines and code go with it.
            <textarea ref={commentRef} autoFocus rows={3} value={comment} onChange={(e) => setComment(e.target.value)} placeholder="What don't you get about these lines?" />
          </label>
          <SendTo value={sendTo} onChange={setSendTo} sessions={sendSessions} terms={agentRef.current?.terms().filter((t) => t.alive) ?? []} />
          <div className="row">
            <span className="to"><kbd>⌘</kbd><kbd>enter</kbd> sends · <kbd>esc</kbd> cancels</span>
            <button onClick={() => setComment(null)}>Cancel</button>
            <button className="primary" onClick={() => void sendComment()}>{sendTo === 'new' ? 'Start session and send' : 'Send'}</button>
          </div>
        </div>
      );
    }
    const name = picked && picked.key === sel?.key && picked.line >= range.start && picked.line <= range.end ? picked : null;
    return (
      <div className="linebar" onClick={(e) => e.stopPropagation()}>
        <button className="primary" onClick={() => void startDoubt()}>Ask a doubt</button>
        {name
          ? <>
            <button onClick={() => lookup(name.path, name.line, name.col, false)} title="⌘-click a name does this too">Go to definition of <code>{name.text}</code></button>
            <button onClick={() => lookup(name.path, name.line, name.col, true)} title="⌘⌥-click a name does this too">Who uses <code>{name.text}</code></button>
          </>
          : <span className="hint">click a name in the line for its definition and uses</span>}
        <button onClick={() => void showHistory()}>Who touched this</button>
        <button onClick={() => void copyRef(false)}>Copy ref</button>
        <button onClick={() => void copyRef(true)} title="the lines with three lines of context, fenced">Copy with code</button>
        <button className="x" onClick={() => { setSel(null); setPicked(null); }} aria-label="close">✕</button>
      </div>
    );
  }

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
      if (mod && (e.key === 'k' || e.key === 'K')) { e.preventDefault(); void openPalette('all'); return; }
      if (mod || e.altKey) return;
      if (e.key === 'Escape') { setSel(null); setPicked(null); }
      else if (e.key === ' ' || e.code === 'Space') { e.preventDefault(); stepHunk(e.shiftKey ? -1 : 1); }
      else if (e.key === 'u') void judge('understood');
      else if (e.key === 'j') move(1);
      else if (e.key === 'k') move(-1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [judge, move, openPalette, pickRow, sendComment, comment, stepHunk, palette, paletteRows, paletteIdx]);

  // ---- render -------------------------------------------------------------------------------------
  const theme = useMemo(() => ({ dark: 'github-dark' as const, light: 'github-light' as const }), []);
  const themeType = uiTheme === 'light' ? 'light' as const : 'dark' as const; // dim keeps the dark syntax colors

  const diffOptionsFor = useCallback((it: Item) => ({
    diffStyle: (fullFile ? 'unified' : split ? 'split' : 'unified') as 'split' | 'unified',
    theme,
    themeType,
    lineDiffType: 'word' as const,
    stickyHeader: true,
    expandUnchanged: fullFile,
    enableLineSelection: true,
    enableGutterUtility: true,
    onGutterUtilityClick: (range: SelectedLineRange) => { setSel({ key: it.key, range }); setComment(null); },
    onLineClick: (p: { lineNumber: number; annotationSide: 'deletions' | 'additions'; event: PointerEvent }) => {
      if (p.event.shiftKey || p.event.metaKey || p.event.ctrlKey) return; // a range or a jump, not a pick
      setSel({ key: it.key, range: { start: p.lineNumber, end: p.lineNumber, side: p.annotationSide } });
      setComment(null);
    },
    onLineSelectionEnd: (range: SelectedLineRange | null) => setSel(range ? { key: it.key, range } : null),
    onTokenClick: (p: Token & { side?: 'deletions' | 'additions' }, ev: MouseEvent) => {
      if (p.side === 'deletions') return; // definitions resolve against the new side only
      tokenClick(it.key, it.path, p, ev);
    },
    // hover answers are about the PR head, so the old side of a diff gets none
    onTokenEnter: (p: Token & { side?: 'deletions' | 'additions' }, ev: PointerEvent) => { if (p.side !== 'deletions') tokenEnter(it.path, p, ev); },
    onTokenLeave: () => tokenLeave(),
    loadDiffFiles: loaderFor(it)
  }), [fullFile, split, theme, themeType, tokenClick, tokenEnter, tokenLeave]); // eslint-disable-line react-hooks/exhaustive-deps

  const fileOptionsFor = useCallback((path: string) => ({
    theme,
    themeType,
    stickyHeader: true,
    enableLineSelection: true,
    enableGutterUtility: true,
    onGutterUtilityClick: (range: SelectedLineRange) => { setSel({ key: path, range }); setComment(null); },
    onLineClick: (p: { lineNumber: number; event: PointerEvent }) => {
      if (p.event.shiftKey || p.event.metaKey || p.event.ctrlKey) return;
      setSel({ key: path, range: { start: p.lineNumber, end: p.lineNumber } });
      setComment(null);
    },
    onLineSelectionEnd: (range: SelectedLineRange | null) => setSel(range ? { key: path, range } : null),
    onTokenClick: (p: Token, ev: MouseEvent) => tokenClick(path, path, p, ev),
    onTokenEnter: (p: Token, ev: PointerEvent) => tokenEnter(path, p, ev),
    onTokenLeave: () => tokenLeave()
  }), [theme, themeType, tokenClick, tokenEnter, tokenLeave]);

  type Ann = { doubt?: string; bar?: boolean };
  const annotationsFor = useCallback((it: Item): DiffLineAnnotation<Ann>[] => {
    const answers = (pr?.doubts ?? [])
      .filter((d) => d.path === it.path && d.lines && !d.resolved)
      .map((d) => ({ side: 'additions' as const, lineNumber: d.lines!.end, metadata: { doubt: d.id } }));
    if (sel?.key !== it.key) return answers;
    const end = Math.max(sel.range.start, sel.range.end);
    return [...answers, { side: sel.range.endSide ?? sel.range.side ?? 'additions', lineNumber: end, metadata: { bar: true } }];
  }, [pr?.doubts, sel]);

  const renderAnn = useCallback((a: { metadata: Ann }) => {
    if (a.metadata.bar) return lineBar();
    const d = pr?.doubts.find((x) => x.id === a.metadata.doubt);
    if (!d) return null;
    const open = openAnswers.has(d.id);
    return (
      <div className={`answer ${open ? 'open' : ''}`} onClick={() => setOpenAnswers((s) => { const n = new Set(s); n.has(d.id) ? n.delete(d.id) : n.add(d.id); return n; })}>
        <div className="q">you: {d.question}</div>
        {d.answer ? d.answer : <span className="wait">{d.done ? 'no answer' : 'waiting for the session…'}</span>}
      </div>
    );
  }, [pr?.doubts, openAnswers, lineBar]); // eslint-disable-line react-hooks/exhaustive-deps

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
        <span className="progress" title={`${readCount} of ${pr.files.length} files read`}>
          <span className="pbar"><i style={{ width: `${pr.files.length ? Math.round((readCount / pr.files.length) * 100) : 0}%` }} /></span>
          <b>{readCount}</b> of {pr.files.length} read
        </span>
        <button className={showDesc ? 'on' : ''} onClick={() => setShowDesc((x) => !x)} title="the PR description, above the diff">Description</button>
        <button onClick={() => void sync()} title="refetch the PR head; files you read stay read unless their content changed">
          Sync{changedSet.size ? <span className="badge" title={`changed since ${pr.prevHeadSha?.slice(0, 7)}`}>{changedSet.size} changed</span> : null}
        </button>
        <button className={agentOpen ? 'on' : ''} onClick={() => setAgentOpen((v) => !v)} title="your Claude Code sessions, as terminals, and the answers to your doubts">Agent{unseen ? <span className="badge">{unseen} new</span> : null}</button>
        <button className="cmdk" onClick={() => void openPalette('all')} title="open a file, search the repo, run any action">Open, search, actions… <kbd>⌘K</kbd></button>
        <button className="theme" onClick={() => setUiTheme((t) => THEMES[(THEMES.indexOf(t) + 1) % THEMES.length])} title="switch theme: dark, dim, light">Theme: {uiTheme}</button>
      </div>

      <div className="queue">
        <div className="tabs">
          <button className={tab === 'files' ? 'on' : ''} onClick={() => switchTab('files')}>Changes</button>
          <button className={tab === 'commits' ? 'on' : ''} onClick={() => switchTab('commits')}>Commits</button>
          <button className={tab === 'repo' ? 'on' : ''} onClick={() => switchTab('repo')}>Repo</button>
          <button className={tab === 'doubts' ? 'on' : ''} onClick={() => switchTab('doubts')}>Doubts{pr.doubts.filter((d) => d.path && !d.resolved).length ? ` ${pr.doubts.filter((d) => d.path && !d.resolved).length}` : ''}</button>

        </div>
        {tab === 'files' && noiseLeft > 0 && (
          <div className="treebar"><button onClick={() => void skipNoise()} title="lockfiles, generated files, snapshots and whitespace-only changes">Skip {noiseLeft} noise file{noiseLeft === 1 ? '' : 's'}</button></div>
        )}
        {tab === 'files' && <Tree paths={pr.files.map((f) => f.path)} meta={fileByPath} readFiles={pr.readFiles} changed={changedSet} signals={pr.signals} current={currentPath} onPick={(p) => openPath(p)} />}
        {tab === 'repo' && (tree.length ? <Tree paths={tree} meta={fileByPath} readFiles={pr.readFiles} current={currentPath} onPick={(p) => openPath(p)} repo /> : <div className="empty">loading tree…</div>)}
        {tab === 'doubts' && (
          <div className="doubts">
            {pr.doubts.filter((d) => d.path).length === 0 && <div className="empty">no doubts yet: click a line, then Ask a doubt</div>}
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
          {view?.kind !== 'repo' && (
            <span className="nav">
              <button onClick={() => move(-1)} title="previous (k)" aria-label="previous">‹</button>
              <button onClick={() => move(1)} title="next (j)" aria-label="next">›</button>
            </span>
          )}
          {view?.kind === 'repo'
            ? <><span className="path">{view.path}</span><span className="meta2">at PR head · not changed by this PR</span></>
            : commit
              ? <><span className="path">{commit.sha.slice(0, 7)} {commit.subject}</span><span className="meta2">{items.length} files · {commit.author}</span></>
              : head
                ? <><span className="path">{head.path}</span><span className="meta2">{head.oldRev === 'base' ? (since && changedSet.has(head.path) ? `since ${pr.prevHeadSha?.slice(0, 7)}` : 'vs merge-base') : head.newRev.slice(0, 7)} · {head.status} · +{head.adds}/-{head.dels}</span></>
                : <span>nothing left to read</span>}
          <span className="keys">
            {flatHunks.length ? <span className="hunkpos" title="space / shift+space">change {cursor ? flatHunks.findIndex((x) => x.key === cursor.key && x.hunk.index === cursor.hunk) + 1 : 0}/{flatHunks.length}</span> : null}
            {head && head.oldRev === 'base' && changedSet.has(head.path) && (
              <span className="seg" role="group" aria-label="what to show of a file that changed since your read">
                <button className={since ? '' : 'on'} onClick={() => setSince(false)}>Whole diff</button>
                <button className={since ? 'on' : ''} onClick={() => setSince(true)} title={`only what changed since ${pr.prevHeadSha?.slice(0, 7)}`}>Since your read</button>
              </span>
            )}
            {view?.kind !== 'repo' && head && (
              <>
                <span className="seg" role="group" aria-label="layout">
                  <button className={split && !fullFile ? '' : 'on'} onClick={() => setSplit(false)}>Unified</button>
                  <button className={split && !fullFile ? 'on' : ''} onClick={() => { setSplit(true); setFullFile(false); }} title="side by side">Split</button>
                </span>
                <span className="seg" role="group" aria-label="scope">
                  <button className={fullFile ? '' : 'on'} onClick={() => setFullFile(false)}>Changes</button>
                  <button className={fullFile ? 'on' : ''} onClick={() => setFullFile(true)} title="the whole file with the changes inline">Whole file</button>
                </span>
                <button className={`markread ${items.every((i) => i.read) ? 'done' : ''}`} onClick={() => void judge(items.every((i) => i.read) ? 'none' : 'understood')} title={items.every((i) => i.read) ? 'mark unread' : 'mark read and open the next unread (u)'}>
                  {items.every((i) => i.read) ? '✓ Read' : commit ? 'Mark commit read' : 'Mark read'}
                </button>
              </>
            )}
          </span>
        </div>
        {head && (pr.signals?.[head.path] ?? []).length > 0 && (
            <div className="sigline">{(pr.signals?.[head.path] ?? []).map((x) => {
              const note = x.kind === 'owners' ? x.note.split(' ').slice(0, 2).join(' ') + (x.note.split(' ').length > 2 ? ` +${x.note.split(' ').length - 2}` : '') : x.note;
              return <span key={x.kind} title={x.note}><b>{x.kind}</b> {note} &nbsp;</span>;
            })}</div>
          )}
        {showDesc && (
          <div className="desc">
            {pr.body?.trim()
              ? <div dangerouslySetInnerHTML={{ __html: marked.parse(pr.body, { async: false }) as string }} />
              : <div className="empty">this PR has no description</div>}
          </div>
        )}
        <div className="diff" ref={diffRef}>
          {view?.kind === 'repo' && (repoFile
            ? <div className="stack"><PierreFile<Ann> file={{ name: repoFile.path, contents: repoFile.contents }} options={fileOptionsFor(repoFile.path)} selectedLines={sel?.key === repoFile.path ? sel.range : null} lineAnnotations={sel?.key === repoFile.path ? [{ lineNumber: Math.max(sel.range.start, sel.range.end), metadata: { bar: true } }] : []} renderAnnotation={renderAnn} disableWorkerPool /></div>
            : <div className="empty">loading {view.path}…</div>)}
          {view?.kind !== 'repo' && items.length === 0 && <div className="empty">every file read</div>}
          {items.map((it) => (
            <div key={it.key} className={`stack ${it.read ? 'understood' : ''}`} data-key={it.key}>
              {patches[it.key] !== undefined
                ? patches[it.key].trim()
                  ? <PatchDiff<Ann> key={`${it.key}:${fullFile}:${split}:${themeType}`} patch={patches[it.key]} options={diffOptionsFor(it)} selectedLines={sel?.key === it.key ? sel.range : null} lineAnnotations={annotationsFor(it)} renderAnnotation={renderAnn} disableWorkerPool />
                  : <div className="empty">{it.path}: no textual diff (binary or empty)</div>
                : <div className="empty">loading {it.path}…</div>}
            </div>
          ))}
        </div>
        <div className="keyhints"><span><kbd>j</kbd> <kbd>k</kbd> next / previous</span><span><kbd>space</kbd> next change</span><span><kbd>u</kbd> mark read</span><span><kbd>⌘K</kbd> everything else</span><span><kbd>esc</kbd> close</span></div>
      </div>

      {palette && (
        <Palette palette={palette} rows={paletteRows} index={paletteIdx} fileCount={tree.length} onIndex={setPaletteIdx} onClose={() => setPalette(null)} onPick={pickRow}
          onQuery={(v) => { setPalette((p) => (p ? { ...p, query: v } : p)); setPaletteIdx(0); }} />
      )}
      <Agent ref={agentRef} open={agentOpen} theme={uiTheme} workdir={pr.dir} workdirLabel={`${pr.repo}#${pr.number}`} doubts={pr.doubts} seen={seen ?? new Set()} onPickDoubt={pickDoubt} onClose={() => setAgentOpen(false)} />

      {hover && (
        <HoverCard info={hover.info} name={hover.name} x={hover.x} y={hover.y} onOpen={(p, l) => { setHover(null); openPath(p, l); }}
          onEnter={() => window.clearTimeout(hoverTimer.current)} onLeave={tokenLeave} />
      )}
      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}

