// GitHub layer: gh does auth and the REST call. Nothing else is needed for the PoC.
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import type { PrRef } from './git.js';

const execFile = promisify(execFileCb);
const TIMEOUT = 30 * 1000; // gh answers in about a second; this only stops a hung call

export interface PrMeta {
  title: string;
  author: string;
  state: string;
  merged: boolean;
  baseRef: string;
  baseSha: string; // the base commit GitHub compares against; the only usable base once the PR is merged
  headRef: string;
  headSha: string;
  cloneUrl: string;
  body: string;
}

export async function ghToken(): Promise<string> {
  try {
    const { stdout } = await execFile('gh', ['auth', 'token'], { timeout: TIMEOUT });
    return stdout.trim();
  } catch {
    return process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '';
  }
}

export async function prMeta(ref: PrRef): Promise<PrMeta> {
  const jq = '{title, author: .user.login, state, merged, baseRef: .base.ref, baseSha: .base.sha, headRef: .head.ref, headSha: .head.sha, cloneUrl: .base.repo.clone_url, body: (.body // "")}';
  const { stdout } = await execFile('gh', ['api', `repos/${ref.owner}/${ref.repo}/pulls/${ref.number}`, '--jq', jq], { maxBuffer: 1024 * 1024, timeout: TIMEOUT });
  return JSON.parse(stdout) as PrMeta;
}
