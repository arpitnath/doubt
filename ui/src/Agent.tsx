// The agent sidebar: your Claude Code sessions, and the ones running here as real terminals.
import { useCallback, useEffect, useImperativeHandle, useRef, useState, forwardRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { agentSessions, agentTerms, closeAgentTerm, openAgentTerm, type AgentSession, type TermInfo } from './api';

export interface AgentHandle {
  /** text typed into the active terminal, submitted with Enter; false when no terminal is active */
  send(text: string): Promise<boolean>;
  activeTitle(): string | null;
}

interface Props { workdir: string; workdirLabel: string; onClose: () => void }

export const Agent = forwardRef<AgentHandle, Props>(function Agent({ workdir, workdirLabel, onClose }, ref) {
  const [sessions, setSessions] = useState<AgentSession[] | null>(null);
  const [terms, setTerms] = useState<TermInfo[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [showList, setShowList] = useState(true);

  const refresh = useCallback(() => {
    agentTerms().then((r) => { setTerms(r.terms); setActive((a) => a && r.terms.some((t) => t.id === a) ? a : r.terms[r.terms.length - 1]?.id ?? null); });
  }, []);

  useEffect(() => {
    agentSessions().then((r) => setSessions(r.sessions)).catch(() => setSessions([]));
    refresh();
  }, [refresh]);

  const open = useCallback(async (sessionId: string | undefined, cwd: string, title: string) => {
    const r = await openAgentTerm({ sessionId, cwd, title });
    setTerms((t) => [...t, r.term]);
    setActive(r.term.id);
    setShowList(false);
  }, []);

  const close = useCallback(async (id: string) => {
    await closeAgentTerm(id);
    setTerms((t) => t.filter((x) => x.id !== id));
    setActive((a) => (a === id ? null : a));
  }, []);

  useImperativeHandle(ref, () => ({
    async send(text: string) {
      if (!active) return false;
      const r = await fetch(`/api/agent/write`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: active, text, submit: true }) });
      return r.ok;
    },
    activeTitle() { return terms.find((t) => t.id === active)?.title ?? null; }
  }), [active, terms]);

  const visible = (sessions ?? []).filter((s) => !filter || `${s.cwd} ${s.summary} ${s.gitBranch ?? ''}`.toLowerCase().includes(filter.toLowerCase()));

  return (
    <div className="agent">
      <div className="agent-head">
        <b>Claude</b>
        <div className="agent-tabs">
          {terms.map((t) => (
            <span key={t.id} className={`agent-tab ${t.id === active ? 'on' : ''} ${t.alive ? '' : 'dead'}`} onClick={() => { setActive(t.id); setShowList(false); }} title={t.cwd}>
              {t.title}
              <i onClick={(e) => { e.stopPropagation(); void close(t.id); }} title="close">×</i>
            </span>
          ))}
          <span className={`agent-tab ${showList ? 'on' : ''}`} onClick={() => setShowList(true)}>+</span>
        </div>
        <button className="agent-close" onClick={onClose} title="hide (a)">⇥</button>
      </div>

      {showList || !active ? (
        <div className="agent-list">
          <div className="agent-new">
            <button onClick={() => void open(undefined, workdir, `new · ${workdirLabel}`)}>new session in the PR checkout</button>
          </div>
          <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="filter sessions by path, branch or summary…" />
          {sessions === null ? <div className="muted">loading sessions…</div> : visible.length === 0 ? <div className="muted">no sessions</div> : visible.map((s) => (
            <div key={s.sessionId} className="agent-session" onClick={() => void open(s.sessionId, s.cwd || workdir, s.summary.slice(0, 28) || s.sessionId.slice(0, 8))} title={s.sessionId}>
              <div className="sum">{s.summary || '(no summary)'}</div>
              <div className="meta">{shortCwd(s.cwd)}{s.gitBranch ? ` · ${s.gitBranch}` : ''} · {ago(s.lastModified)} · {Math.round((s.fileSize || 0) / 1024)} KB</div>
            </div>
          ))}
        </div>
      ) : null}

      {terms.map((t) => (
        <div key={t.id} className="agent-term" style={{ display: t.id === active && !showList ? 'block' : 'none' }}>
          <Xterm id={t.id} visible={t.id === active && !showList} />
        </div>
      ))}
    </div>
  );
});

function Xterm({ id, visible }: { id: string; visible: boolean }) {
  const host = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    if (!host.current) return;
    const term = new Terminal({ cursorBlink: true, fontSize: 12, fontFamily: 'ui-monospace, Menlo, monospace', theme: { background: '#0f1115' }, scrollback: 5000, allowProposedApi: true });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host.current);
    fit.fit();
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

  useEffect(() => {
    if (visible) setTimeout(() => { try { fitRef.current?.fit(); termRef.current?.focus(); } catch { /* not laid out yet */ } }, 30);
  }, [visible]);

  return <div className="xterm-host" ref={host} />;
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
