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
  token: string;
  workRoot: string;
}

export interface Checkout { dir: string; baseSha: string }

export async function checkout(input: CheckoutInput): Promise<Checkout> {
  const { ref, cloneUrl, headSha, baseRef, token, workRoot } = input;
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
  const baseSha = (await git(dir, ['merge-base', 'HEAD', 'refs/doubt/base'])).trim();

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

export async function fullDiff(dir: string, baseSha: string, headSha: string): Promise<string> {
  const text = await git(dir, ['diff', '--no-color', baseSha, headSha]);
  const scratch = join(dir, '.doubt');
  mkdirSync(scratch, { recursive: true });
  const file = join(scratch, 'pr.diff');
  writeFileSync(file, text);
  return file;
}
