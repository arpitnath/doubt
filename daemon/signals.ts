// Attention signals: facts about a file's change that deserve a look first. Never a grade.
// Computed once from the PR diff text and the commit chunks; shown as small markers in the tree.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Chunk } from './state.js';

export interface Signal { kind: 'rewritten' | 'tests' | 'deps' | 'todo' | 'dup' | 'sensitive' | 'owners'; note: string }

const DEFAULT_SENSITIVE = ['auth', 'secur', 'permission', 'billing', 'payment', 'licen', 'migrat', 'secret', 'token', 'crypt', 'password', '.github/workflows', 'dockerfile', 'infra', 'deploy'];

// optional repo config: .doubt.json { "sensitive": ["..."] } adds to the defaults
function sensitiveTerms(dir: string): string[] {
  try {
    const cfg = JSON.parse(readFileSync(join(dir, '.doubt.json'), 'utf8')) as { sensitive?: string[] };
    return [...DEFAULT_SENSITIVE, ...(cfg.sensitive ?? [])];
  } catch {
    return DEFAULT_SENSITIVE;
  }
}

// CODEOWNERS: last matching pattern wins, like GitHub
function codeowners(dir: string): Array<{ re: RegExp; owners: string[] }> {
  const file = ['CODEOWNERS', '.github/CODEOWNERS', 'docs/CODEOWNERS'].map((f) => join(dir, f)).find((f) => existsSync(f));
  if (!file) return [];
  const rules: Array<{ re: RegExp; owners: string[] }> = [];
  for (const raw of readFileSync(file, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const [pattern, ...owners] = line.split(/\s+/);
    if (!owners.length) continue;
    let p = pattern;
    const anchored = p.startsWith('/');
    if (anchored) p = p.slice(1);
    const dirOnly = p.endsWith('/');
    if (dirOnly) p = p.slice(0, -1);
    const body = p.split('**').map((seg) => seg.split('*').map((x) => x.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*')).join('.*');
    const re = new RegExp(`${anchored ? '^' : '(^|/)'}${body}${dirOnly ? '/' : '(/|$)'}`);
    rules.push({ re, owners });
  }
  return rules;
}

// per-file sections of a unified diff
function splitDiff(diffText: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  let cur: string[] | null = null;
  for (const line of diffText.split('\n')) {
    const m = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
    if (m) { cur = []; out.set(m[2], cur); continue; }
    if (cur) cur.push(line);
  }
  return out;
}

export function computeSignals(dir: string, diffText: string, chunks: Chunk[]): Record<string, Signal[]> {
  const out: Record<string, Signal[]> = {};
  const add = (path: string, s: Signal) => { (out[path] ??= []).push(s); };
  const sections = splitDiff(diffText);
  const sensitive = sensitiveTerms(dir);
  const owners = codeowners(dir);

  // rewritten: touched by more than one commit inside this PR
  const commitsPer = new Map<string, Set<string>>();
  for (const c of chunks) (commitsPer.get(c.path) ?? commitsPer.set(c.path, new Set()).get(c.path)!).add(c.sha);
  for (const [path, shas] of commitsPer) if (shas.size > 1) add(path, { kind: 'rewritten', note: `touched by ${shas.size} commits in this PR` });

  // windows of added lines, to find the same block added in two places
  const windows = new Map<string, Set<string>>();
  const WINDOW = 5;

  for (const [path, lines] of sections) {
    const added = lines.filter((l) => l.startsWith('+') && !l.startsWith('+++')).map((l) => l.slice(1));
    const removed = lines.filter((l) => l.startsWith('-') && !l.startsWith('---')).map((l) => l.slice(1));
    const lower = path.toLowerCase();

    // tests removed: net loss of test or assertion lines
    const testRe = /\b(it|test|describe|expect|assert[A-Za-z]*)\s*\(/;
    const lost = removed.filter((l) => testRe.test(l)).length - added.filter((l) => testRe.test(l)).length;
    if (lost > 0) add(path, { kind: 'tests', note: `${lost} test or assertion line${lost === 1 ? '' : 's'} removed` });

    // new dependencies in a manifest
    if (/(^|\/)(package\.json|pyproject\.toml|requirements[^/]*\.txt|go\.mod|cargo\.toml|gemfile|composer\.json)$/i.test(lower)) {
      const deps = added.filter((l) => /^\s*"[@\w./-]+":\s*"[^"]+"/.test(l) || /^\s*[\w.-]+\s*(==|>=|~=|\^|@)/.test(l) || /^\s+[\w./-]+\s+v?\d/.test(l)).length;
      if (deps > 0) add(path, { kind: 'deps', note: `${deps} dependency line${deps === 1 ? '' : 's'} added` });
    }

    // TODO / FIXME added
    const todos = added.filter((l) => /\b(TODO|FIXME|XXX|HACK)\b/.test(l)).length;
    if (todos > 0) add(path, { kind: 'todo', note: `${todos} TODO or FIXME added` });

    // duplicate blocks
    const norm = added.map((l) => l.replace(/\s+/g, ' ').trim()).filter((l) => l.length > 12);
    for (let i = 0; i + WINDOW <= norm.length; i++) {
      const key = norm.slice(i, i + WINDOW).join('\n');
      (windows.get(key) ?? windows.set(key, new Set()).get(key)!).add(path);
    }

    // sensitive paths
    const hit = sensitive.find((t) => lower.includes(t.toLowerCase()));
    if (hit) add(path, { kind: 'sensitive', note: `path matches "${hit}"` });

    // owners
    let who: string[] | null = null;
    for (const r of owners) if (r.re.test(path)) who = r.owners;
    if (who) add(path, { kind: 'owners', note: who.join(' ') });
  }

  const dupPaths = new Map<string, Set<string>>();
  for (const [, paths] of windows) {
    if (paths.size < 2) continue;
    for (const p of paths) {
      const set = dupPaths.get(p) ?? dupPaths.set(p, new Set()).get(p)!;
      for (const other of paths) if (other !== p) set.add(other);
    }
  }
  for (const [path, others] of dupPaths) add(path, { kind: 'dup', note: `same block also added in ${[...others].slice(0, 3).join(', ')}` });

  return out;
}
