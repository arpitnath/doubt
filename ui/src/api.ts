// Thin client over the daemon. SSE over POST is read with fetch + a stream reader,
// since EventSource only does GET.
export type Verdict = 'none' | 'understood' | 'doubt';

export interface Commit { sha: string; subject: string; author: string; parents: string[]; merge: boolean }
export interface Chunk { id: string; sha: string; path: string; status: string; adds: number; dels: number; verdict: Verdict }
export interface Doubt { id: string; chunkId: string; lines?: { start: number; end: number }; question: string; answer: string; at: number }
export interface PrState {
  url: string; owner: string; repo: string; number: number; title: string; author: string;
  headSha: string; baseSha: string; baseRef: string; dir: string;
  sessionId?: string; forkedFrom?: string; shape?: string;
  commits: Commit[]; chunks: Chunk[]; doubts: Doubt[]; busy: boolean;
}
export interface SessionInfo { sessionId: string; cwd?: string; gitBranch?: string; summary: string; lastModified: number; fileSize?: number }
export type AgentEvent =
  | { type: 'session'; id: string }
  | { type: 'text'; text: string }
  | { type: 'done'; text: string; sessionId: string }
  | { type: 'error'; message: string };

export const getPr = (): Promise<PrState> => fetch('/api/pr').then((r) => r.json());
export const getDiff = (chunkId: string): Promise<{ chunk: Chunk; patch: string }> =>
  fetch(`/api/diff?chunk=${encodeURIComponent(chunkId)}`).then((r) => r.json());
export const getSessions = (): Promise<SessionInfo[]> => fetch('/api/sessions').then((r) => r.json());
export const setVerdict = (chunkId: string, verdict: Verdict): Promise<unknown> =>
  fetch('/api/verdict', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chunkId, verdict }) });

export async function stream(path: string, body: unknown, onEvent: (ev: AgentEvent) => void): Promise<void> {
  try {
    const res = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    if (!res.ok || !res.body) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      onEvent({ type: 'error', message: String(err.error || res.statusText) });
      return;
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const frame = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const line = frame.split('\n').find((l) => l.startsWith('data: '));
        if (line) onEvent(JSON.parse(line.slice(6)) as AgentEvent);
      }
    }
  } catch (err) {
    onEvent({ type: 'error', message: err instanceof Error ? err.message : String(err) });
  }
}
