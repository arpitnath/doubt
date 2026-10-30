// Terminals: Claude Code running in a pseudo-terminal, streamed to the browser over a WebSocket.
// The same architecture as a cloud shell: keystrokes one way, bytes the other. Nothing is
// re-implemented; the CLI is the CLI.
import * as pty from 'node-pty';
import type { WebSocket } from 'ws';
import { accessSync, chmodSync, constants, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { WORK_ROOT } from './state.js';

export interface TermInfo { id: string; sessionId?: string; cwd: string; title: string; startedAt: number; alive: boolean }

interface Term {
  info: TermInfo;
  proc: pty.IPty;
  scrollback: string[]; // ponytail: replay the tail on reconnect; a ring of chunks, not a real buffer
  scrollbackBytes: number;
  sockets: Set<WebSocket>;
  plain: string; // the recent output without escape codes, to tell when the CLI can take typed text
  lastOutput: number;
  queue: Array<{ text: string; submit: boolean }>; // text waiting for the CLI to be ready
}

const SCROLLBACK_MAX = 400 * 1024;
const PLAIN_MAX = 4000;
const QUIET_MS = 400;

const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]/g, '').replace(/\x1b\][^\x07]*(\x07|\x1b\\)/g, '').replace(/\x1b[()][0-9A-Za-z]/g, '');

// Claude Code takes typed text once its input box shows (the ❯ prompt) and its output has gone
// quiet. The folder-trust question uses ❯ too, so the prompt must come after any mention of
// trust; that question is the user's to answer, so text waits behind it rather than answering it.
function ready(t: Term): boolean {
  const prompt = t.plain.lastIndexOf('❯');
  return prompt >= 0 && prompt > t.plain.lastIndexOf('trust') && Date.now() - t.lastOutput >= QUIET_MS;
}
const terms = new Map<string, Term>();

// Running inside a Claude Code session leaks its env into children; a nested claude must not see it.
function cleanEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k === 'CLAUDECODE' || k.startsWith('CLAUDE_CODE_') || k === 'CLAUDE_CONFIG_DIR_INHERITED') continue;
    env[k] = v;
  }
  env.TERM = 'xterm-256color';
  env.COLORTERM = 'truecolor';
  env.LANG = env.LANG || 'en_US.UTF-8';
  return env;
}

// A PR checkout is someone else's code: its .claude/settings.json (hooks, permissions) must not
// configure the reviewer's Claude. Only user settings load there. The user's own projects keep theirs.
function claudeArgs(opts: { sessionId?: string; cwd: string }): string[] {
  const args = opts.sessionId ? ['--resume', opts.sessionId] : [];
  if (opts.cwd.startsWith(`${WORK_ROOT}/`)) args.push('--setting-sources', 'user');
  return args;
}

// node-pty's prebuilt spawn-helper comes out of npm without its exec bit, and every terminal fails to
// start without it. Found wherever npm put node-pty (npx hoists it), fixed once.
let helperChecked = false;
function ensureSpawnHelper(): void {
  if (helperChecked) return;
  helperChecked = true;
  try {
    const helper = join(dirname(createRequire(import.meta.url).resolve('node-pty/package.json')), 'prebuilds', `${process.platform}-${process.arch}`, 'spawn-helper');
    if (!existsSync(helper)) return; // Windows, or built from source
    try { accessSync(helper, constants.X_OK); } catch { chmodSync(helper, 0o755); }
  } catch (err) {
    console.error(`> could not make node-pty's spawn-helper executable: ${err instanceof Error ? err.message : err}`);
  }
}

export function openTerm(opts: { sessionId?: string; cwd: string; title: string }): TermInfo {
  ensureSpawnHelper();
  const id = Math.random().toString(36).slice(2, 10);
  // a login shell so `claude` resolves the way it does in the user's own terminal;
  // arguments go in as "$@", so nothing from the request is ever parsed by the shell
  const proc = pty.spawn(process.env.SHELL || '/bin/zsh', ['-lc', 'exec claude "$@"', 'claude', ...claudeArgs(opts)], { name: 'xterm-256color', cols: 120, rows: 36, cwd: opts.cwd, env: cleanEnv() });
  const term: Term = { info: { id, sessionId: opts.sessionId, cwd: opts.cwd, title: opts.title, startedAt: Date.now(), alive: true }, proc, scrollback: [], scrollbackBytes: 0, sockets: new Set(), plain: '', lastOutput: Date.now(), queue: [] };
  proc.onData((data) => {
    term.plain = (term.plain + stripAnsi(data)).slice(-PLAIN_MAX);
    term.lastOutput = Date.now();
    term.scrollback.push(data);
    term.scrollbackBytes += data.length;
    while (term.scrollbackBytes > SCROLLBACK_MAX && term.scrollback.length > 1) term.scrollbackBytes -= term.scrollback.shift()!.length;
    for (const ws of term.sockets) if (ws.readyState === ws.OPEN) ws.send(data);
  });
  proc.onExit(({ exitCode }) => {
    term.info.alive = false;
    const bye = `\r\n[claude exited with ${exitCode}]\r\n`;
    term.scrollback.push(bye);
    for (const ws of term.sockets) if (ws.readyState === ws.OPEN) { ws.send(bye); ws.close(); }
  });
  terms.set(id, term);
  return term.info;
}

export function getTerm(id: string): TermInfo | undefined {
  return terms.get(id)?.info;
}

export function listTerms(): TermInfo[] {
  return [...terms.values()].map((t) => t.info).sort((a, b) => a.startedAt - b.startedAt);
}

export function closeTerm(id: string): boolean {
  const t = terms.get(id);
  if (!t) return false;
  if (t.info.alive) t.proc.kill();
  for (const ws of t.sockets) ws.close();
  terms.delete(id);
  return true;
}

// Text typed on the user's behalf. Multi-line text goes in as a bracketed paste so the CLI treats
// it as one block, then Enter submits it. With `whenReady`, text sent to a CLI that is still starting
// waits until it can take it, in order.
export function writeTerm(id: string, text: string, submit: boolean, whenReady = false): boolean {
  const t = terms.get(id);
  if (!t || !t.info.alive) return false;
  if (!whenReady || (t.queue.length === 0 && ready(t))) { type(t, text, submit); return true; }
  t.queue.push({ text, submit });
  if (t.queue.length === 1) drain(t);
  return true;
}

function type(t: Term, text: string, submit: boolean): void {
  t.proc.write(text.includes('\n') ? `\x1b[200~${text}\x1b[201~` : text);
  if (submit) setTimeout(() => t.proc.write('\r'), 50); // let the paste land before Enter
}

function drain(t: Term): void {
  const tick = setInterval(() => {
    if (!t.info.alive) { t.queue = []; clearInterval(tick); return; }
    if (!ready(t)) return;
    const next = t.queue.shift();
    if (next) type(t, next.text, next.submit);
    if (!t.queue.length) clearInterval(tick);
  }, 200);
  tick.unref();
}

export function attach(id: string, ws: WebSocket): boolean {
  const t = terms.get(id);
  if (!t) return false;
  t.sockets.add(ws);
  for (const chunk of t.scrollback) ws.send(chunk);
  ws.on('message', (raw) => {
    const msg = raw.toString();
    // a JSON control frame or raw keystrokes
    if (msg.startsWith('{')) {
      try {
        const c = JSON.parse(msg) as { type: string; cols?: number; rows?: number };
        if (c.type === 'resize' && c.cols && c.rows && t.info.alive) t.proc.resize(Math.max(20, c.cols), Math.max(5, c.rows));
      } catch { /* not a control frame */ }
      return;
    }
    if (t.info.alive) t.proc.write(msg);
  });
  ws.on('close', () => t.sockets.delete(ws));
  return true;
}

export function closeAll(): void {
  for (const id of [...terms.keys()]) closeTerm(id);
}
