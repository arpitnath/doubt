// The agent panel: your Claude Code sessions as real terminals, and an Updates tray of every doubt
// and where its answer stands. It stays mounted while hidden, so terminals keep running and a doubt
// can always be delivered.
import { useCallback, useEffect, useImperativeHandle, useRef, useState, forwardRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { termColors, type Theme } from './theme';
import { agentSessions, agentTerms, closeAgentTerm, openAgentTerm, type AgentSession, type Doubt, type TermInfo } from './api';

// where a doubt goes: a terminal already open here, a session on disk to resume, or a new one in the PR checkout
export type SendTarget = { kind: 'term'; id: string } | { kind: 'session'; sessionId: string; cwd: string; title: string } | { kind: 'new' };
export interface Comment { path: string; lines?: { start: number; end: number }; question: string; snippet?: string }

export interface AgentHandle {
  /** opens or resumes the target if needed, shows it, and hands it the doubt; the terminal id, or null when it failed */
  deliver(target: SendTarget, pr: string, comment: Comment): Promise<string | null>;
  terms(): TermInfo[];
}

interface Props {
  open: boolean;
  theme: Theme;
  workdir: string;
  workdirLabel: string;
  doubts: Doubt[];
  seen: Set<string>;
  onPickDoubt: (d: Doubt) => void;
  onClose: () => void;
}

export const Agent = forwardRef<AgentHandle, Props>(function Agent({ open, theme, workdir, workdirLabel, doubts, seen, onPickDoubt, onClose }, ref) {
  const [sessions, setSessions] = useState<AgentSession[] | null>(null);
  const [terms, setTerms] = useState<TermInfo[]>([]);
  const termsRef = useRef<TermInfo[]>([]);
  termsRef.current = terms;
  const [active, setActive] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [showList, setShowList] = useState(true);
  const [trayOpen, setTrayOpen] = useState(true);

  useEffect(() => {
    agentTerms().then((r) => { setTerms(r.terms); setActive((a) => (a && r.terms.some((t) => t.id === a) ? a : r.terms[r.terms.length - 1]?.id ?? null)); if (r.terms.length) setShowList(false); });
  }, []);
  useEffect(() => { if (open && sessions === null) agentSessions().then((r) => setSessions(r.sessions)).catch(() => setSessions([])); }, [open, sessions]);

  const openTerm = useCallback(async (sessionId: string | undefined, cwd: string, title: string) => {
    const r = await openAgentTerm({ sessionId, cwd, title });
    setTerms((t) => [...t, r.term]);
    setActive(r.term.id);
    setShowList(false);
    return r.term;
  }, []);

  const close = useCallback(async (id: string) => {
    await closeAgentTerm(id);
    setTerms((t) => t.filter((x) => x.id !== id));
    setActive((a) => (a === id ? null : a));
  }, []);

  useImperativeHandle(ref, () => ({
    async deliver(target, pr, comment) {
      let id: string;
      if (target.kind === 'term') id = target.id;
      else {
        const running = target.kind === 'session' ? termsRef.current.find((t) => t.alive && t.sessionId === target.sessionId) : undefined;
        id = running ? running.id
          : (await (target.kind === 'new' ? openTerm(undefined, workdir, `new · ${workdirLabel}`) : openTerm(target.sessionId, target.cwd, target.title))).id;
      }
      setActive(id);
      setShowList(false);
      const r = await fetch('/api/agent/write', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id, pr, comment }) });
      return r.ok ? id : null;
    },
    terms: () => termsRef.current
  }), [openTerm, workdir, workdirLabel]);

  const visible = (sessions ?? []).filter((s) => !filter || `${s.cwd} ${s.summary} ${s.gitBranch ?? ''}`.toLowerCase().includes(filter.toLowerCase()));
  const tray = doubts.filter((d) => d.path).slice().reverse();
  const unseen = tray.filter((d) => d.answer && !seen.has(d.id)).length;

  return (
    <div className="agent" style={{ display: open ? 'flex' : 'none' }}>
      <div className="agent-head">
        <b>Agent</b>
        <div className="agent-tabs">
          {terms.map((t) => (
            <span key={t.id} className={`agent-tab ${t.id === active && !showList ? 'on' : ''} ${t.alive ? '' : 'dead'}`} onClick={() => { setActive(t.id); setShowList(false); }} title={t.cwd}>
              {t.title}
              <i onClick={(e) => { e.stopPropagation(); void close(t.id); }} title="close">×</i>
            </span>
          ))}
          <span className={`agent-tab ${showList ? 'on' : ''}`} onClick={() => setShowList(true)} title="open a session">+</span>
        </div>
        <button className="agent-close" onClick={onClose} title="hide the panel; sessions keep running">⇥</button>
      </div>

      {tray.length > 0 && (
        <div className="tray">
          <button className="tray-head" onClick={() => setTrayOpen((v) => !v)} aria-expanded={trayOpen}>
            <span>Updates</span>{unseen > 0 && <span className="badge">{unseen} new</span>}<span className="arrow">{trayOpen ? '▾' : '▸'}</span>
          </button>
          {trayOpen && (
            <div className="tray-list">
              {tray.map((d) => {
                const isNew = !!(d.answer && !seen.has(d.id));
                return (
                  <button key={d.id} className={`tray-item ${isNew ? 'new' : ''}`} onClick={() => onPickDoubt(d)} title="open the file at this line">
                    <span className="dot" />
                    <span className="body">
                      <span className="where">{shortPath(d.path!)}{d.lines ? `:${d.lines.start}${d.lines.end !== d.lines.start ? `-${d.lines.end}` : ''}` : ''}</span>
                      <span className="q">{d.question}</span>
                      <span className={`st ${d.resolved ? '' : d.answer ? 'ok' : ''}`}>{d.resolved ? 'resolved' : d.answer ? (d.done ? 'answered' : 'answering…') : d.done ? 'no answer recorded' : 'waiting…'}{d.title ? ` · ${d.title}` : ''}</span>
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}

      {showList || !active ? (
        <div className="agent-list">
          <div className="agent-new">
            <button onClick={() => void openTerm(undefined, workdir, `new · ${workdirLabel}`)}>new session in the PR checkout</button>
          </div>
          <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="filter sessions by path, branch or summary…" />
          {sessions === null ? <div className="muted">loading sessions…</div> : visible.length === 0 ? <div className="muted">no sessions</div> : visible.map((s) => (
            <div key={s.sessionId} className="agent-session" onClick={() => void openTerm(s.sessionId, s.cwd || workdir, s.summary.slice(0, 28) || s.sessionId.slice(0, 8))} title={s.sessionId}>
              <div className="sum">{s.summary || '(no summary)'}</div>
              <div className="meta">{shortCwd(s.cwd)}{s.gitBranch ? ` · ${s.gitBranch}` : ''} · {ago(s.lastModified)} · {Math.round((s.fileSize || 0) / 1024)} KB</div>
            </div>
          ))}
        </div>
      ) : null}

      {terms.map((t) => (
        <div key={t.id} className="agent-term" style={{ display: t.id === active && !showList ? 'block' : 'none' }}>
          <Xterm id={t.id} visible={open && t.id === active && !showList} theme={theme} />
        </div>
      ))}
    </div>
  );
});

function Xterm({ id, visible, theme }: { id: string; visible: boolean; theme: Theme }) {
  const host = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    if (!host.current) return;
    const term = new Terminal({ cursorBlink: true, fontSize: 12, fontFamily: 'ui-monospace, Menlo, monospace', theme: termColors(), scrollback: 5000, allowProposedApi: true });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host.current);
    try { fit.fit(); } catch { /* hidden on first paint */ }
    termRef.current = term;
    fitRef.current = fit;

    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/term?id=${encodeURIComponent(id)}`);
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
    ws.onmessage = (ev) => term.write(typeof ev.data === 'string' ? ev.data : new Uint8Array(ev.data as ArrayBuffer));
    ws.onclose = () => term.write('\r\n[disconnected]\r\n');
    term.onData((d) => { if (ws.readyState === ws.OPEN) ws.send(d); });
    term.onResize(({ cols, rows }) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'resize', cols, rows })); });
    wsRef.current = ws;

    const ro = new ResizeObserver(() => { try { fit.fit(); } catch { /* hidden */ } });
    ro.observe(host.current);
    return () => { ro.disconnect(); ws.close(); term.dispose(); };
  }, [id]);

  useEffect(() => { if (termRef.current) termRef.current.options.theme = termColors(); }, [theme]);

  useEffect(() => {
    if (visible) setTimeout(() => { try { fitRef.current?.fit(); termRef.current?.focus(); } catch { /* not laid out yet */ } }, 30);
  }, [visible]);

  return <div className="xterm-host" ref={host} />;
}

function shortPath(p: string): string {
  return p.split('/').slice(-2).join('/');
}

function shortCwd(cwd?: string): string {
  if (!cwd) return '(no cwd)';
  return cwd.replace(/^\/Users\/[^/]+/, '~');
}

function ago(ms: number): string {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
