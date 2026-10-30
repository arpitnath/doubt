// One JSON file per PR under ~/.doubt/state, keyed by repo and number.
// Chunk verdicts are the truth. A file counts as read when every chunk of it is read.
// `readFiles` remembers the blob pair a fully read file had, so after a push only
// files whose content actually changed come back as unread.
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, appendFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Commit, PrFile } from './git.js';

export type Verdict = 'none' | 'understood' | 'doubt';

export interface Chunk {
  id: string; // `${sha7}:${path}`
  sha: string;
  path: string;
  status: string;
  adds: number;
  dels: number;
  verdict: Verdict;
}

export interface Doubt {
  id: string;
  chunkId: string; // legacy from the first version; new doubts use `path`
  path?: string;
  lines?: { start: number; end: number };
  question: string;
  answer: string;
  at: number;
  // anchored answers from a terminal session: which transcript to watch and what to look for in it
  termCwd?: string;
  sessionId?: string;
  marker?: string;
  termStartedAt?: number;
  done?: boolean;
  resolved?: boolean;
}

export interface Signal { kind: 'rewritten' | 'tests' | 'deps' | 'todo' | 'dup' | 'sensitive' | 'owners'; note: string }

export interface PrState {
  url: string;
  owner: string;
  repo: string;
  number: number;
  title: string;
  author: string;
  headSha: string;
  baseSha: string;
  baseRef: string;
  dir: string;
  diffFile: string;
  commits: Commit[];
  chunks: Chunk[];
  files: PrFile[];
  readFiles: Record<string, string>; // path -> `${oldBlob}:${newBlob}` when fully read
  prevHeadSha?: string; // the head before the last sync that changed it; enables per-file interdiff
  changedSince?: string[]; // files whose content changed at that sync
  signals?: Record<string, Signal[]>; // attention markers per file, facts only
  body?: string; // the PR description, as written on GitHub
  doubts: Doubt[];
}

export const DOUBT_HOME = join(homedir(), '.doubt');
export const WORK_ROOT = join(DOUBT_HOME, 'work');
export const STATE_ROOT = join(DOUBT_HOME, 'state');

// What the reviewer did, one JSON line each, so reading can be measured later: where a review
// stopped, time from view to verdict, files settled with no question. Never read by the daemon.
export function logEvent(event: { type: 'open' | 'view' | 'verdict' | 'doubt'; pr: string; [k: string]: unknown }): void {
  try {
    mkdirSync(DOUBT_HOME, { recursive: true });
    appendFileSync(join(DOUBT_HOME, 'events.jsonl'), `${JSON.stringify({ at: Date.now(), ...event })}\n`);
  } catch { /* a lost log line must never fail the request it describes */ }
}

export function stateKey(s: Pick<PrState, 'owner' | 'repo' | 'number'>): string {
  return `${s.owner}-${s.repo}-${s.number}`;
}

export const blobPair = (f: PrFile): string => `${f.oldBlob}:${f.newBlob}`;

export function load(key: string): PrState | null {
  const file = join(STATE_ROOT, `${key}.json`);
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, 'utf8')) as PrState;
}

// Recompute readFiles from chunk verdicts, then persist.
export function save(state: PrState): void {
  const byPath = new Map<string, Chunk[]>();
  for (const c of state.chunks) byPath.set(c.path, [...(byPath.get(c.path) || []), c]);
  const next: Record<string, string> = {};
  for (const f of state.files) {
    const chunks = byPath.get(f.path) || [];
    if (chunks.length && chunks.every((c) => c.verdict !== 'none')) next[f.path] = blobPair(f);
  }
  state.readFiles = next;

  mkdirSync(STATE_ROOT, { recursive: true });
  const file = join(STATE_ROOT, `${stateKey(state)}.json`);
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2));
  renameSync(tmp, file); // ponytail: write-then-rename so a crash never leaves a half file
}

// After a push: a file read before, whose blob pair did not change, stays read.
export function carryOver(fresh: PrState, prev: PrState | null): void {
  if (!prev?.readFiles) return;
  for (const f of fresh.files) {
    if (prev.readFiles[f.path] !== blobPair(f)) continue;
    for (const c of fresh.chunks) if (c.path === f.path && c.verdict === 'none') c.verdict = 'understood';
  }
}
