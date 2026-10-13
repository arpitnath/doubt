import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { PatchDiff, type SelectedLineRange } from '@pierre/diffs/react';
import { getDiff, getPr, getSessions, setVerdict, stream, type Chunk, type PrState, type SessionInfo } from './api';

type Msg = { kind: 'shape' | 'q' | 'a' | 'err' | 'take'; text: string; ref?: string };
type Lines = { start: number; end: number };
type View = { kind: 'file'; id: string } | { kind: 'commit'; sha: string };

export function App() {
  const [pr, setPr] = useState<PrState | null>(null);
  const [view, setView] = useState<View | null>(null);
  const [patches, setPatches] = useState<Record<string, string>>({}); // chunk id -> patch, for what is on screen
  const [selection, setSelection] = useState<SelectedLineRange | null>(null);
  const [selectedChunk, setSelectedChunk] = useState<string | null>(null); // which stacked file the selection is in
  const [log, setLog] = useState<Msg[]>([]);
  const [live, setLive] = useState<string>('');
  const [busy, setBusy] = useState(false);
  const [composing, setComposing] = useState(false);
  const [question, setQuestion] = useState('');
  const [sessions, setSessions] = useState<SessionInfo[] | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const logRef = useRef<HTMLDivElement>(null);

  // ---- load ------------------------------------------------------------------------------------
  useEffect(() => {
    getPr().then((s) => {
      setPr(s);
      const first = s.chunks.find((c) => c.verdict === 'none') ?? s.chunks[0];
      if (first) setView({ kind: 'commit', sha: first.sha });
      const restored: Msg[] = [];
      if (s.shape) restored.push({ kind: 'shape', text: s.shape });
      for (const d of s.doubts) {
        const take = d.question === '(take)';
        restored.push({ kind: take ? 'take' : 'q', text: take ? 'take' : d.question, ref: refOfId(s, d.chunkId, d.lines) });
        if (d.answer) restored.push({ kind: 'a', text: d.answer });
      }
      setLog(restored);
      if (!s.sessionId) getSessions().then(setSessions);
    });
  }, []);

  // what the center shows: one file, or every file of a commit, in queue order
  const shown: Chunk[] = useMemo(() => {
    if (!pr || !view) return [];
    return view.kind === 'file' ? pr.chunks.filter((c) => c.id === view.id) : pr.chunks.filter((c) => c.sha === view.sha);
  }, [pr, view]);

  useEffect(() => {
    let cancelled = false; // fast j/j: an older response must not land on the newer view
    setSelection(null);
    setSelectedChunk(null);
    setPatches({});
    Promise.all(shown.map((c) => getDiff(c.id).then((d) => [c.id, d.patch] as const))).then((pairs) => {
      if (!cancelled) setPatches(Object.fromEntries(pairs));
    });
    return () => { cancelled = true; };
  }, [shown]);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [log, live]);

  const commitBySha = useMemo(() => new Map(pr?.commits.map((c) => [c.sha, c]) ?? []), [pr]);
  const currentSha = view?.kind === 'commit' ? view.sha : shown[0]?.sha;
  const anchorChunk: Chunk | null = view?.kind === 'file' ? shown[0] ?? null : shown.find((c) => c.id === selectedChunk) ?? null;
  const lines: Lines | undefined = selection
    ? { start: Math.min(selection.start, selection.end), end: Math.max(selection.start, selection.end) }
    : undefined;

  // ---- actions ---------------------------------------------------------------------------------
  const markChunks = useCallback((pick: (c: Chunk) => boolean, verdict: Chunk['verdict']) => {
    setPr((p) => (p ? { ...p, chunks: p.chunks.map((c) => (pick(c) ? { ...c, verdict } : c)) } : p));
  }, []);

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

  const understood = useCallback(async () => {
    if (!pr || !view) return;
    const pick = view.kind === 'file' ? (c: Chunk) => c.id === view.id : (c: Chunk) => c.sha === view.sha;
    await setVerdict(view.kind === 'file' ? { chunkId: view.id } : { sha: view.sha }, 'understood');
    const updated = { ...pr, chunks: pr.chunks.map((c) => (pick(c) ? { ...c, verdict: 'understood' as const } : c)) };
    setPr(updated);
    const next = nextUnjudged(view, updated);
    if (next) setView(next);
  }, [pr, view, nextUnjudged]);

  const runStream = useCallback(async (path: string, body: unknown, onDone: (text: string, sessionId: string) => void) => {
    setBusy(true);
    setLive('');
    try {
      await stream(path, body, (ev) => {
        if (ev.type === 'text') setLive((t) => t + ev.text);
        if (ev.type === 'done') { onDone(ev.text, ev.sessionId); setLive(''); }
        if (ev.type === 'error') setLog((l) => [...l, { kind: 'err', text: ev.message }]);
      });
    } finally {
      setBusy(false);
      setLive('');
    }
  }, []);

  const startSession = useCallback(async (forkFrom?: string) => {
    if (busy) return;
    setSessions(null);
    await runStream('/api/session', { forkFrom }, (text, sessionId) => {
      setLog((l) => [...l, { kind: 'shape', text }]);
      setPr((p) => (p ? { ...p, sessionId, forkedFrom: forkFrom } : p));
    });
    setPr((p) => { if (p && !p.sessionId) getSessions().then(setSessions); return p; });
  }, [busy, runStream]);

  // the target of d and t: the file the selection is in, else the single shown file, else the whole commit
  const target = useCallback((): { chunkId: string } | { sha: string } | null => {
    if (anchorChunk) return { chunkId: anchorChunk.id };
    if (view?.kind === 'commit') return { sha: view.sha };
    return null;
  }, [anchorChunk, view]);

  const refOfTarget = useCallback((): string => {
    if (!pr) return '';
    if (anchorChunk) return refOf(anchorChunk, lines);
    if (view?.kind === 'commit') return `${view.sha.slice(0, 7)} (whole commit)`;
    return '';
  }, [pr, anchorChunk, lines, view]);

  const sendDoubt = useCallback(async () => {
    const t = target();
    if (!pr || !t || !question.trim() || busy) return;
    const ref = refOfTarget();
    const q = question;
    setLog((l) => [...l, { kind: 'q', text: q, ref }]);
    if ('chunkId' in t) markChunks((c) => c.id === t.chunkId, 'doubt');
    else markChunks((c) => c.sha === t.sha && c.verdict === 'none', 'doubt');
    setComposing(false);
    setQuestion('');
    setSelection(null);
    await runStream('/api/doubt', { ...t, lines, question: q }, (text) => setLog((l) => [...l, { kind: 'a', text }]));
  }, [pr, target, refOfTarget, question, busy, lines, markChunks, runStream]);

  const take = useCallback(async () => {
    const t = target();
    if (!pr || !t || busy || !pr.sessionId) return;
    setLog((l) => [...l, { kind: 'take', text: 'take', ref: refOfTarget() }]);
    await runStream('/api/doubt', { ...t, take: true }, (text) => setLog((l) => [...l, { kind: 'a', text }]));
  }, [pr, target, refOfTarget, busy, runStream]);

  // ---- keys: u understood, d doubt, t take, c commit/file view, j/k move, esc close -------------
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = (e.target as HTMLElement)?.tagName === 'TEXTAREA';
      if (typing) {
        if (e.key === 'Escape') setComposing(false);
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void sendDoubt(); }
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === 'u') void understood();
      else if (e.key === 'd') { if (pr?.sessionId && !busy && target()) { setComposing(true); setTimeout(() => textareaRef.current?.focus(), 0); } }
      else if (e.key === 't') void take();
      else if (e.key === 'c') { if (view?.kind === 'file') setView({ kind: 'commit', sha: shown[0].sha }); else if (view?.kind === 'commit' && shown[0]) setView({ kind: 'file', id: shown[0].id }); }
      else if (e.key === 'j') move(1);
      else if (e.key === 'k') move(-1);
      else if (e.key === 'Escape') setComposing(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [understood, sendDoubt, take, move, pr?.sessionId, busy, target, view, shown]);

  const options = useMemo(() => ({
    diffStyle: 'split' as const,
    theme: { dark: 'github-dark' as const, light: 'github-light' as const },
    enableLineSelection: true
  }), []);

  if (!pr) return <div className="main"><div className="empty">loading…</div></div>;

  const judged = pr.chunks.filter((c) => c.verdict !== 'none').length;
  const commit = currentSha ? commitBySha.get(currentSha) : undefined;

  return (
    <div className="app">
      <div className="top">
        <span className="title">#{pr.number} {pr.title}</span>
        <span className="meta">{pr.owner}/{pr.repo} · {pr.author} · {pr.baseRef} ← {pr.headSha.slice(0, 7)}</span>
        <span className="progress"><b>{judged}</b> / {pr.chunks.length} chunks · {pr.chunks.filter((c) => c.verdict === 'doubt').length} doubts</span>
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
                  <span className="mark">{k.verdict === 'understood' ? '✓' : k.verdict === 'doubt' ? '?' : ''}</span>
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
          <span className="keys"><kbd>u</kbd> understood &nbsp; <kbd>d</kbd> doubt &nbsp; <kbd>t</kbd> take &nbsp; <kbd>c</kbd> {view?.kind === 'commit' ? 'one file' : 'whole commit'} &nbsp; <kbd>j</kbd>/<kbd>k</kbd> move</span>
        </div>
        <div className="diff">
          {shown.length === 0 && <div className="empty">all chunks judged</div>}
          {shown.map((c) => (
            <div key={c.id} className={`stack ${c.verdict}`} onMouseDown={() => setSelectedChunk(c.id)}>
              {patches[c.id] !== undefined
                ? <PatchDiff
                    key={c.id}
                    patch={patches[c.id]}
                    options={{ ...options, onLineSelectionEnd: (range: SelectedLineRange | null) => { setSelectedChunk(c.id); setSelection(range); } }}
                    selectedLines={selectedChunk === c.id ? selection : null}
                    disableWorkerPool
                  />
                : <div className="empty">loading {c.path}…</div>}
            </div>
          ))}
        </div>
      </div>

      <div className="room">
        <div className="head">
          <b>Claude</b>
          {pr.sessionId ? <span>session {pr.sessionId.slice(0, 8)}{pr.forkedFrom ? ` · fork of ${pr.forkedFrom.slice(0, 8)}` : ''}</span> : <span>no session yet</span>}
        </div>

        {!pr.sessionId ? (
          <div className="picker">
            <div>Start the PR session. Fork one that already knows this repo, or start fresh.</div>
            <button onClick={() => startSession()} disabled={busy}>Fresh session</button>
            {sessions === null ? <div className="thinking">{busy ? 'reading the PR…' : 'loading sessions…'}</div> : sessions.map((s) => (
              <div key={s.sessionId} className="s" onClick={() => startSession(s.sessionId)}>
                <div className="cwd">{s.cwd || '(no cwd)'} · {s.gitBranch || ''} · {new Date(s.lastModified).toLocaleDateString()} · {Math.round((s.fileSize || 0) / 1024)} KB</div>
                <div className="sum">{s.summary.slice(0, 120)}</div>
              </div>
            ))}
            {live && <div className="msg shape">{live}</div>}
            {log.filter((m) => m.kind === 'err').map((m, i) => <div key={i} className="msg err">{m.text}</div>)}
          </div>
        ) : (
          <>
            <div className="log" ref={logRef}>
              {log.map((m, i) => (
                <div key={i} className={`msg ${m.kind}`}>
                  {m.ref && <span className="ref">{m.ref}</span>}
                  {m.kind === 'take' ? 'taken into context' : m.text}
                </div>
              ))}
              {live && <div className="msg a">{live}</div>}
              {busy && !live && <div className="thinking">thinking…</div>}
            </div>
            {composing && (
              <div className="compose">
                <div className="ref">{refOfTarget()}</div>
                <textarea ref={textareaRef} rows={3} value={question} onChange={(e) => setQuestion(e.target.value)} placeholder="What do you not get here?" />
                <div className="hint"><kbd>enter</kbd> send · <kbd>esc</kbd> cancel · select lines in a diff first to anchor the doubt to them</div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function refOf(chunk: Chunk, lines?: Lines): string {
  return `${chunk.sha.slice(0, 7)} ${chunk.path}${lines ? `:${lines.start}-${lines.end}` : ''}`;
}

function refOfId(s: PrState, chunkId: string, lines?: Lines): string {
  if (chunkId.endsWith(':*')) return `${chunkId.slice(0, 7)} (whole commit)`;
  const c = s.chunks.find((k) => k.id === chunkId);
  return c ? refOf(c, lines) : chunkId;
}
