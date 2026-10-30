// Answers anchored to lines come from the session's transcript on disk, never from the terminal
// stream. Claude Code appends every message to ~/.claude/projects/<encoded cwd>/<session>.jsonl.
// After a comment is sent, we find the user turn that carries it and take the assistant text that
// follows, up to the end of that turn: the CLI's turn_duration record, or the next user turn.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');

export function projectDir(cwd: string): string {
  // the CLI's own encoding: every non-alphanumeric character becomes '-'
  return join(CONFIG_DIR, 'projects', cwd.replace(/[^A-Za-z0-9]/g, '-'));
}

// the transcript for a known session id, or the newest transcript in the cwd's project dir created after `since`
export function transcriptFor(cwd: string, sessionId: string | undefined, since: number): string | null {
  const dir = projectDir(cwd);
  if (!existsSync(dir)) return null;
  if (sessionId) {
    const f = join(dir, `${sessionId}.jsonl`);
    return existsSync(f) ? f : null;
  }
  const candidates = readdirSync(dir).filter((f) => f.endsWith('.jsonl')).map((f) => ({ f: join(dir, f), m: statSync(join(dir, f)).mtimeMs, c: statSync(join(dir, f)).birthtimeMs }));
  const fresh = candidates.filter((c) => c.c >= since - 5000).sort((a, b) => b.m - a.m);
  return fresh[0]?.f ?? null;
}

interface Turn { type: string; text: string; uuid: string; parentUuid?: string; timestamp?: string }

function turns(file: string): Turn[] {
  const out: Turn[] = [];
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line) continue;
    try {
      const o = JSON.parse(line) as { type?: string; subtype?: string; uuid?: string; parentUuid?: string; timestamp?: string; message?: { role?: string; content?: unknown } };
      if (o.type === 'system' && o.subtype === 'turn_duration') { out.push({ type: 'end', text: '', uuid: o.uuid || '' }); continue; }
      if (o.type !== 'user' && o.type !== 'assistant') continue;
      const c = o.message?.content;
      const text = typeof c === 'string' ? c : Array.isArray(c) ? (c as Array<{ type?: string; text?: string }>).filter((b) => b.type === 'text' && b.text).map((b) => b.text).join('\n') : '';
      out.push({ type: o.type, text, uuid: o.uuid || '', parentUuid: o.parentUuid, timestamp: o.timestamp });
    } catch { /* partial line while the CLI is writing */ }
  }
  return out;
}

// the assistant's reply to the user turn containing `marker`; null until it exists, '' while still streaming
export function answerTo(file: string, marker: string): { text: string; done: boolean } | null {
  const all = turns(file);
  const i = all.findIndex((t) => t.type === 'user' && t.text.includes(marker));
  if (i < 0) return null;
  const parts: string[] = [];
  let done = false;
  for (let j = i + 1; j < all.length; j++) {
    const t = all[j];
    if (t.type === 'end') { done = true; break; } // the CLI closed the turn
    if (t.type === 'user') {
      // tool results also arrive as user turns; a real user turn with prose ends the answer
      if (t.text.trim().length > 0 && !t.text.startsWith('<')) { done = true; break; }
      continue;
    }
    if (t.text) parts.push(t.text);
  }
  return { text: parts.join('\n\n').trim(), done };
}

export function sessionIdOf(file: string): string | undefined {
  const m = file.match(/([0-9a-f-]{36})\.jsonl$/);
  return m?.[1];
}
