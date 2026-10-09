import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { PatchDiff, type SelectedLineRange } from '@pierre/diffs/react';
import { getDiff, getPr, getSessions, setVerdict, stream, type Chunk, type PrState, type SessionInfo } from './api';

type Msg = { kind: 'shape' | 'q' | 'a' | 'err'; text: string; ref?: string };
type Lines = { start: number; end: number };

export function App() {
  const [pr, setPr] = useState<PrState | null>(null);
  const [current, setCurrent] = useState<string | null>(null);
  const [patch, setPatch] = useState<string>('');
  const [selection, setSelection] = useState<SelectedLineRange | null>(null);
  const [log, setLog] = useState<Msg[]>([]);
  const [live, setLive] = useState<string>(''); // text streaming in right now
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
      setCurrent(first?.id ?? null);
      const restored: Msg[] = [];
      if (s.shape) restored.push({ kind: 'shape', text: s.shape });
      for (const d of s.doubts) {
        restored.push({ kind: 'q', text: d.question, ref: refOf(s.chunks.find((c) => c.id === d.chunkId), d.lines) });
        if (d.answer) restored.push({ kind: 'a', text: d.answer });
      }
      setLog(restored);
      if (!s.sessionId) getSessions().then(setSessions);
    });
  }, []);

  useEffect(() => {
    if (!current) return;
    let cancelled = false; // j/j fast: the older response must not land on the newer chunk
    setSelection(null);
    setPatch('');
    getDiff(current).then((d) => { if (!cancelled) setPatch(d.patch); });
    return () => { cancelled = true; };
  }, [current]);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [log, live]);

  const chunk = useMemo(() => pr?.chunks.find((c) => c.id === current) ?? null, [pr, current]);
  const commitBySha = useMemo(() => new Map(pr?.commits.map((c) => [c.sha, c]) ?? []), [pr]);
  const lines: Lines | undefined = selection
    ? { start: Math.min(selection.start, selection.end), end: Math.max(selection.start, selection.end) }
    : undefined;

  const options = useMemo(() => ({
    diffStyle: 'split' as const,
    theme: { dark: 'github-dark' as const, light: 'github-light' as const },
    enableLineSelection: true,
    onLineSelectionEnd: (range: SelectedLineRange | null) => setSelection(range)
  }), []);

  // ---- actions ---------------------------------------------------------------------------------
  const move = useCallback((dir: 1 | -1) => {
    if (!pr || !current) return;
    const i = pr.chunks.findIndex((c) => c.id === current);
    const next = pr.chunks[i + dir];
    if (next) setCurrent(next.id);
  }, [pr, current]);

  const markChunk = useCallback((id: string, verdict: Chunk['verdict']) => {
    setPr((p) => (p ? { ...p, chunks: p.chunks.map((c) => (c.id === id ? { ...c, verdict } : c)) } : p));
  }, []);

  const understood = useCallback(async () => {
    if (!pr || !chunk) return;
    await setVerdict(chunk.id, 'understood');
    markChunk(chunk.id, 'understood');
    const i = pr.chunks.findIndex((c) => c.id === chunk.id);
    const next = pr.chunks.slice(i + 1).find((c) => c.verdict === 'none') ?? pr.chunks.find((c) => c.verdict === 'none' && c.id !== chunk.id);
    if (next) setCurrent(next.id);
  }, [pr, chunk, markChunk]);

  const startSession = useCallback(async (forkFrom?: string) => {
    if (busy) return;
    setBusy(true);
    setSessions(null);
    setLive('');
    try {
      await stream('/api/session', { forkFrom }, (ev) => {
        if (ev.type === 'text') setLive((t) => t + ev.text);
        if (ev.type === 'done') { setLog((l) => [...l, { kind: 'shape', text: ev.text }]); setLive(''); setPr((p) => (p ? { ...p, sessionId: ev.sessionId, forkedFrom: forkFrom } : p)); }
        if (ev.type === 'error') { setLog((l) => [...l, { kind: 'err', text: ev.message }]); getSessions().then(setSessions); }
      });
    } finally {
      setBusy(false);
      setLive('');
    }
  }, [busy]);

  const sendDoubt = useCallback(async () => {
    if (!pr || !chunk || !question.trim() || busy) return;
    const ref = refOf(chunk, lines);
    const q = question;
    setLog((l) => [...l, { kind: 'q', text: q, ref }]);
    markChunk(chunk.id, 'doubt');
    setComposing(false);
    setQuestion('');
    setSelection(null);
    setBusy(true);
    setLive('');
    try {
      await stream('/api/doubt', { chunkId: chunk.id, lines, question: q }, (ev) => {
        if (ev.type === 'text') setLive((t) => t + ev.text);
        if (ev.type === 'done') { setLog((l) => [...l, { kind: 'a', text: ev.text }]); setLive(''); }
        if (ev.type === 'error') setLog((l) => [...l, { kind: 'err', text: ev.message }]);
      });
    } finally {
      setBusy(false);
      setLive('');
    }
  }, [pr, chunk, question, lines, busy, markChunk]);

  // ---- keys: u understood, d doubt, j/k move, esc close -----------------------------------------
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
      else if (e.key === 'd') { if (pr?.sessionId && !busy) { setComposing(true); setTimeout(() => textareaRef.current?.focus(), 0); } }
      else if (e.key === 'j') move(1);
      else if (e.key === 'k') move(-1);
      else if (e.key === 'Escape') setComposing(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [understood, sendDoubt, move, pr?.sessionId, busy]);

  if (!pr) return <div className="main"><div className="empty">loading…</div></div>;

  const judged = pr.chunks.filter((c) => c.verdict !== 'none').length;

  return (
    <div className="app">
      <div className="top">
        <span className="title">#{pr.number} {pr.title}</span>
        <span className="meta">{pr.owner}/{pr.repo} · {pr.author} · {pr.baseRef} ← {pr.headSha.slice(0, 7)}</span>
        <span className="progress"><b>{judged}</b> / {pr.chunks.length} chunks · {pr.chunks.filter((c) => c.verdict === 'doubt').length} doubts</span>
      </div>

      <div className="queue">
        {pr.commits.map((c) => (
          <div key={c.sha}>
            <div className="commit"><span className="sha">{c.sha.slice(0, 7)}</span>{c.merge ? '⎇ ' : ''}{c.subject}</div>
            {pr.chunks.filter((k) => k.sha === c.sha).map((k) => (
              <div key={k.id} className={`chunk ${k.verdict} ${k.id === current ? 'current' : ''}`} onClick={() => setCurrent(k.id)} title={k.path}>
                <span className="mark">{k.verdict === 'understood' ? '✓' : k.verdict === 'doubt' ? '?' : ''}</span>
                <span className="path">{k.path}</span>
                <span className="stat">+{k.adds}/-{k.dels}</span>
              </div>
            ))}
          </div>
        ))}
      </div>

      <div className="main">
        <div className="bar">
          {chunk ? <>
            <span className="path">{chunk.path}</span>
            <span>{commitBySha.get(chunk.sha)?.sha.slice(0, 7)} · {chunk.status} · +{chunk.adds}/-{chunk.dels}</span>
          </> : <span>no chunk</span>}
          <span className="keys"><kbd>u</kbd> understood &nbsp; <kbd>d</kbd> doubt &nbsp; <kbd>j</kbd>/<kbd>k</kbd> move</span>
        </div>
        <div className="diff">
          {chunk && patch
            ? <PatchDiff key={chunk.id} patch={patch} options={options} selectedLines={selection} disableWorkerPool />
            : <div className="empty">{chunk ? 'loading diff…' : 'all chunks judged'}</div>}
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
                  {m.text}
                </div>
              ))}
              {live && <div className="msg a">{live}</div>}
              {busy && !live && <div className="thinking">thinking…</div>}
            </div>
            {composing && chunk && (
              <div className="compose">
                <div className="ref">{refOf(chunk, lines)}</div>
                <textarea ref={textareaRef} rows={3} value={question} onChange={(e) => setQuestion(e.target.value)} placeholder="What do you not get about this chunk?" />
                <div className="hint"><kbd>enter</kbd> send · <kbd>esc</kbd> cancel · select lines in the diff first to anchor the doubt</div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function refOf(chunk: Chunk | undefined, lines?: Lines): string {
  if (!chunk) return '';
  return `${chunk.sha.slice(0, 7)} ${chunk.path}${lines ? `:${lines.start}-${lines.end}` : ''}`;
}
