// First-hour risk check, run once and keep as a record:
// 1. does the SDK launch its bundled claude binary from a tsx process?
// 2. does a forked session read files from its new cwd, not the original?
import { query, listSessions } from '@anthropic-ai/claude-agent-sdk';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const a = mkdtempSync(join(tmpdir(), 'doubt-a-'));
const b = mkdtempSync(join(tmpdir(), 'doubt-b-'));
writeFileSync(join(a, 'MARKER.txt'), 'alpha-7731\n');
writeFileSync(join(b, 'MARKER.txt'), 'bravo-2208\n');

async function run(prompt: string, options: Record<string, unknown>) {
  let sessionId = '';
  let result = '';
  for await (const m of query({ prompt, options: { permissionMode: 'plan', maxTurns: 3, allowedTools: ['Read'], ...options } })) {
    if (m.type === 'system' && m.subtype === 'init') sessionId = m.session_id;
    if (m.type === 'result') { sessionId = m.session_id; result = 'result' in m ? String(m.result) : m.subtype; }
  }
  return { sessionId, result };
}

const t0 = Date.now();
const first = await run('Read MARKER.txt in the current directory and reply with only its contents.', { cwd: a });
console.log('1. launch ok, session', first.sessionId, 'in', Date.now() - t0, 'ms ->', first.result.trim());

const fork = await run('Read MARKER.txt in the current directory again and reply with only its contents.', { cwd: b, resume: first.sessionId, forkSession: true });
console.log('2. fork session', fork.sessionId, '->', fork.result.trim(), fork.result.includes('bravo') ? '(reads from new cwd: OK)' : '(READ OLD CWD: PROBLEM)');

const original = await run('Reply with only the contents of MARKER.txt you read earlier.', { cwd: a, resume: first.sessionId });
console.log('3. original untouched ->', original.result.trim(), original.result.includes('alpha') ? '(OK)' : '(CONTAMINATED)');

const listed = await listSessions({ dir: a, limit: 5 });
console.log('4. listSessions for dir a:', listed.map((s) => ({ id: s.sessionId.slice(0, 8), cwd: s.cwd, summary: (s.summary || s.firstPrompt || '').slice(0, 40) })));
