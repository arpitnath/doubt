// Git layer: every operation is a git child process plus string splitting.
// Checkout and auth approach ported from px0 (MIT, github.com/px0-ai/px0) pr.go.
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, mkdirSync, appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const execFile = promisify(execFileCb);
const MAX_BUFFER = 64 * 1024 * 1024; // ponytail: a single file diff is KBs; 64MB is the ceiling, not a design

export interface PrRef { owner: string; repo: string; number: number }

export interface Commit {
  sha: string;
  subject: string;
  author: string;
  parents: string[];
  merge: boolean;
}

export interface ChangedFile { path: string; status: string; adds: number; dels: number }

export function parsePrUrl(url: string): PrRef {
  const m = url.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
  if (!m) throw new Error(`not a GitHub PR url: ${url}`);
  return { owner: m[1], repo: m[2].replace(/\.git$/, ''), number: Number(m[3]) };
}

// Token travels to git through config env vars, never argv or the URL (px0 pr.go:255-267).
export function authEnv(token: string): NodeJS.ProcessEnv {
  if (!token) return {};
  const basic = Buffer.from(`x-access-token:${token}`).toString('base64');
  return {
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basic}`
  };
}

export async function git(dir: string, args: string[], env: NodeJS.ProcessEnv = {}): Promise<string> {
  const { stdout } = await execFile('git', ['-C', dir, '--literal-pathspecs', ...args], {
    maxBuffer: MAX_BUFFER,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...env }
  });
  return stdout;
}

export interface CheckoutInput {
  ref: PrRef;
  cloneUrl: string; // base repo; GitHub serves refs/pull/N/head there even for forks
  headSha: string;
  baseRef: string;
  apiBaseSha?: string; // GitHub's base commit; used when the PR is already merged into baseRef
  token: string;
  workRoot: string;
}

export interface Checkout { dir: string; baseSha: string }

export async function checkout(input: CheckoutInput): Promise<Checkout> {
  const { ref, cloneUrl, headSha, baseRef, apiBaseSha, token, workRoot } = input;
  const dir = join(workRoot, `${ref.owner}-${ref.repo}-${ref.number}`);
  const env = authEnv(token);
  mkdirSync(workRoot, { recursive: true });

  if (!existsSync(join(dir, '.git'))) {
    await execFile('git', ['clone', '--quiet', '--filter=blob:none', '--no-checkout', cloneUrl, dir], {
      maxBuffer: MAX_BUFFER,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...env }
    });
  }

  // '+' so a force-pushed head or a rewritten base still fetches on a reused work dir.
  await git(dir, ['fetch', '--quiet', 'origin', `+refs/pull/${ref.number}/head:refs/doubt/pr`, `+${baseRef}:refs/doubt/base`], env);
  await git(dir, ['checkout', '--quiet', '--detach', headSha]);
  let baseSha = (await git(dir, ['merge-base', 'HEAD', 'refs/doubt/base'])).trim();
  // A merged PR is an ancestor of its base branch, so the merge-base is the head itself and the diff
  // would be empty. GitHub's base.sha is the base the PR was compared against; it is reachable from
  // the fetched branch, so merge-base against it recovers the PR's own diff.
  if (baseSha === headSha && apiBaseSha) {
    try { baseSha = (await git(dir, ['merge-base', 'HEAD', apiBaseSha])).trim(); } catch { /* keep headSha; the PR shows empty */ }
  }

  // Keep our scratch files out of git status without touching the repo's .gitignore.
  const exclude = join(dir, '.git', 'info', 'exclude');
  mkdirSync(join(dir, '.git', 'info'), { recursive: true });
  const current = existsSync(exclude) ? readFileSync(exclude, 'utf8') : '';
  if (!current.includes('.doubt/')) appendFileSync(exclude, '\n.doubt/\n');

  return { dir, baseSha };
}

export async function commits(dir: string, baseSha: string, headSha: string): Promise<Commit[]> {
  // --topo-order so a parent never trails its child when commit dates are skewed
  const out = await git(dir, ['log', '--reverse', '--topo-order', '--format=%H%x1f%s%x1f%an%x1f%P%x1e', `${baseSha}..${headSha}`]);
  return out
    .split('\x1e')
    .map((r) => r.trim())
    .filter(Boolean)
    .map((r) => {
      const [sha, subject, author, parents] = r.split('\x1f');
      const p = parents ? parents.split(' ').filter(Boolean) : [];
      return { sha, subject, author, parents: p, merge: p.length > 1 };
    });
}

// A merge commit shows only its conflict-resolution lines (git show --remerge-diff, git >= 2.36).
// A normal commit shows the diff it made against its parent (px0 git.go:855 flags).
function diffArgs(commit: Commit, extra: string[]): string[] {
  return commit.merge
    ? ['show', '--remerge-diff', '--format=', ...extra, commit.sha]
    : ['diff-tree', '--no-commit-id', '-r', '--root', ...extra, commit.sha];
}

// --numstat -z: "adds\tdels\tpath\0", or for a rename "adds\tdels\t\0old\0new\0".
function parseNumstat(out: string): Map<string, { adds: number; dels: number }> {
  const counts = new Map<string, { adds: number; dels: number }>();
  const parts = out.split('\0');
  for (let i = 0; i < parts.length; i++) {
    const rec = parts[i];
    if (!rec) continue;
    const [a, d, p] = rec.split('\t');
    const path = p === '' ? parts[(i += 2)] : p;
    if (path) counts.set(path, { adds: Number(a) || 0, dels: Number(d) || 0 });
  }
  return counts;
}

export async function commitFiles(dir: string, commit: Commit): Promise<ChangedFile[]> {
  const names = await git(dir, diffArgs(commit, ['--name-status', '-z']));
  const counts = parseNumstat(await git(dir, diffArgs(commit, ['--numstat', '-z'])));

  const files: ChangedFile[] = [];
  const parts = names.split('\0').filter(Boolean);
  for (let i = 0; i < parts.length; i++) {
    const status = parts[i];
    // renames and copies carry two paths: R100\0old\0new
    const path = status.startsWith('R') || status.startsWith('C') ? parts[(i += 2)] : parts[++i];
    if (!path) continue;
    const c = counts.get(path) || { adds: 0, dels: 0 };
    files.push({ path, status: status[0], adds: c.adds, dels: c.dels });
  }
  return files;
}

export async function fileDiff(dir: string, commit: Commit, path: string): Promise<string> {
  // the path limiter must follow the sha, so this does not go through diffArgs
  return git(dir, commit.merge
    ? ['show', '--remerge-diff', '--format=', '-p', '--no-color', commit.sha, '--', path]
    : ['diff-tree', '--no-commit-id', '-r', '--root', '-p', '--no-color', commit.sha, '--', path]);
}

// The session has no shell, so every diff it may need is written where it can Read it.
export async function commitDiff(dir: string, commit: Commit): Promise<string> {
  const scratch = join(dir, '.doubt', 'commits');
  mkdirSync(scratch, { recursive: true });
  const file = join(scratch, `${commit.sha.slice(0, 7)}.diff`);
  if (!existsSync(file)) writeFileSync(file, await git(dir, diffArgs(commit, ['-p', '--no-color'])));
  return file;
}

// ---- PR-wide (merge-base..head) ---------------------------------------------------------------

export type FileKind = 'src' | 'test' | 'docs' | 'config' | 'generated' | 'snapshot' | 'lock';

// ponytail: path heuristics, no AST. Good enough to park what no human needs to read first.
export function kindOf(path: string): FileKind {
  const p = path.toLowerCase();
  const base = p.slice(p.lastIndexOf('/') + 1);
  if (/^(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|cargo\.lock|go\.sum|poetry\.lock|gemfile\.lock|composer\.lock)$/.test(base)) return 'lock';
  if (/\.snap$|__snapshots__\//.test(p)) return 'snapshot';
  if (/(^|\/)(dist|build|out|\.next|coverage|vendor)\/|\.min\.(js|css)$|\.generated\.|\.pb\.go$|_pb2\.py$|\.d\.ts$/.test(p)) return 'generated';
  if (/\.(md|mdx|rst|txt)$|(^|\/)\.changeset\/|(^|\/)docs?\//.test(p)) return 'docs';
  if (/\.(spec|test)\.[cm]?[jt]sx?$|(^|\/)(tests?|__tests__|e2e|spec|fixtures?)\//.test(p)) return 'test';
  if (/\.(json|ya?ml|toml|ini|env|cfg|conf)$|(^|\/)\.[^/]+$|(^|\/)(config|\.github|\.vscode)\//.test(p)) return 'config';
  return 'src';
}

export interface PrFile {
  path: string;
  oldPath?: string; // renames
  status: string; // A M D R C
  adds: number;
  dels: number;
  oldBlob: string;
  newBlob: string;
  kind: FileKind;
  wsOnly: boolean; // the change disappears under -w
}

export async function prFiles(dir: string, baseSha: string, headSha: string): Promise<PrFile[]> {
  const raw = await git(dir, ['diff-tree', '-r', '-z', '--raw', '-M', baseSha, headSha]);
  const counts = parseNumstat(await git(dir, ['diff-tree', '-r', '-z', '--numstat', '-M', baseSha, headSha]));
  const wsCounts = parseNumstat(await git(dir, ['diff-tree', '-r', '-z', '--numstat', '-w', '-M', baseSha, headSha]));

  const files: PrFile[] = [];
  const parts = raw.split('\0');
  for (let i = 0; i < parts.length; i++) {
    const rec = parts[i];
    if (!rec.startsWith(':')) continue;
    const [, , oldBlob, newBlob, st] = rec.slice(1).split(' ');
    const status = st[0];
    let oldPath: string | undefined;
    let path: string;
    if (status === 'R' || status === 'C') { oldPath = parts[++i]; path = parts[++i]; } else { path = parts[++i]; }
    if (!path) continue;
    const c = counts.get(path) || { adds: 0, dels: 0 };
    const w = wsCounts.get(path);
    const wsOnly = c.adds + c.dels > 0 && (!w || w.adds + w.dels === 0);
    files.push({ path, oldPath, status, adds: c.adds, dels: c.dels, oldBlob, newBlob, kind: kindOf(path), wsOnly });
  }
  return files;
}

export async function prFileDiff(dir: string, baseSha: string, headSha: string, path: string, oldPath?: string): Promise<string> {
  const paths = oldPath && oldPath !== path ? [oldPath, path] : [path];
  return git(dir, ['diff', '--no-color', '-M', baseSha, headSha, '--', ...paths]);
}

export interface Hit { path: string; line: number; text: string }

// workspace search, px0's Cmd+Shift+F: git grep over the checked-out revision, capped
export async function grep(dir: string, rev: string, query: string, regex: boolean, limit = 500): Promise<Hit[]> {
  let out = '';
  try {
    out = await git(dir, ['grep', '-n', '-I', '--no-color', '-i', regex ? '-E' : '-F', '-e', query, rev, '--', '.']);
  } catch (err) {
    // git grep exits 1 when nothing matches
    if ((err as { code?: number }).code === 1) return [];
    throw err;
  }
  const hits: Hit[] = [];
  for (const line of out.split('\n')) {
    if (!line) continue;
    // "<rev>:<path>:<line>:<text>"; the path may itself contain ':' so split from the left twice after the rev
    const afterRev = line.slice(rev.length + 1);
    const m = afterRev.match(/^(.*?):(\d+):(.*)$/);
    if (!m) continue;
    hits.push({ path: m[1], line: Number(m[2]), text: m[3].slice(0, 200) });
    if (hits.length >= limit) break;
  }
  return hits;
}

// every path in the tree at a revision; tree objects are present even in a blob-filtered clone
export async function lsTree(dir: string, rev: string): Promise<string[]> {
  const out = await git(dir, ['ls-tree', '-r', '-z', '--name-only', rev]);
  return out.split('\0').filter(Boolean);
}

export async function fileAt(dir: string, rev: string, path: string): Promise<string | null> {
  try {
    return await git(dir, ['show', `${rev}:${path}`]);
  } catch {
    return null; // absent on that side
  }
}

export async function fullDiff(dir: string, baseSha: string, headSha: string): Promise<string> {
  const text = await git(dir, ['diff', '--no-color', baseSha, headSha]);
  const scratch = join(dir, '.doubt');
  mkdirSync(scratch, { recursive: true });
  const file = join(scratch, 'pr.diff');
  writeFileSync(file, text);
  return file;
}
