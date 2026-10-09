// One JSON file per PR under ~/.doubt/state, keyed by repo, number and head SHA.
// A force-push changes the key, which is the right behaviour: the queue starts over.
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Commit } from './git.js';

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
  chunkId: string;
  lines?: { start: number; end: number };
  question: string;
  answer: string;
  at: number;
}

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
  sessionId?: string;
  forkedFrom?: string;
  shape?: string;
  commits: Commit[];
  chunks: Chunk[];
  doubts: Doubt[];
}

export const DOUBT_HOME = join(homedir(), '.doubt');
export const WORK_ROOT = join(DOUBT_HOME, 'work');
const STATE_ROOT = join(DOUBT_HOME, 'state');

export function stateKey(s: Pick<PrState, 'owner' | 'repo' | 'number' | 'headSha'>): string {
  return `${s.owner}-${s.repo}-${s.number}-${s.headSha.slice(0, 7)}`;
}

export function load(key: string): PrState | null {
  const file = join(STATE_ROOT, `${key}.json`);
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, 'utf8')) as PrState;
}

export function save(state: PrState): void {
  mkdirSync(STATE_ROOT, { recursive: true });
  const file = join(STATE_ROOT, `${stateKey(state)}.json`);
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2));
  renameSync(tmp, file); // ponytail: write-then-rename so a crash never leaves a half file
}
