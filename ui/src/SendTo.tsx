// Send to: where a doubt goes, grouped by what each session will see when it reads files.
import type { AgentSession } from './api';
import type { SendTarget } from './Agent';

const GROUPS: Array<{ group: NonNullable<AgentSession['group']>; label: string }> = [
  { group: 'this-pr', label: 'This PR' },
  { group: 'other-pr', label: 'Other PRs in this repo' },
  { group: 'clone', label: 'Your clone of this repo' }
];

// What each kind of session will see when it reads files, said before the doubt is sent
const NOTES: Record<string, string> = {
  term: 'Open in doubt now.',
  'this-pr': "Runs in this PR's checkout, and keeps what it learned from earlier questions.",
  'other-pr': "Runs in another PR's checkout: the files it reads will not match this diff.",
  clone: 'Runs in your own clone: it reads that branch, not this PR, unless told to.',
  new: "A fresh session in this PR's checkout. It knows nothing yet and reads what it needs."
};

export function SendTo({ value, onChange, sessions, terms }: { value: string; onChange: (v: string) => void; sessions: AgentSession[]; terms: Array<{ id: string; title: string; sessionId?: string }> }) {
  const open = new Set(terms.map((t) => t.sessionId).filter(Boolean));
  const chosen = sessions.find((x) => `session:${x.sessionId}` === value);
  const big = chosen && (chosen.fileSize ?? 0) > 5e6 ? ` ${Math.round((chosen.fileSize ?? 0) / 1e6)} MB of history makes every answer slower and costlier.` : '';
  const note = value === 'new' ? NOTES.new : value.startsWith('term:') ? NOTES.term : chosen ? (NOTES[chosen.group ?? ''] ?? '') + (chosen.group === 'clone' && chosen.gitBranch ? ` (branch ${chosen.gitBranch})` : '') + big : '';
  const warn = !!chosen && (chosen.group === 'other-pr' || chosen.group === 'clone' || !!big);
  const label = (x: AgentSession) => `${(x.summary || '(no summary)').slice(0, 60)} · ${new Date(x.lastModified).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}${x.missing ? ' · folder gone' : ''}`;
  return (
    <div className="sendto">
      <label>Send to
        <select value={value} onChange={(e) => onChange(e.target.value)}>
          {terms.length > 0 && <optgroup label="Open in doubt">{terms.map((t) => <option key={t.id} value={`term:${t.id}`}>{t.title}</option>)}</optgroup>}
          {GROUPS.map((g) => {
            const list = sessions.filter((x) => x.group === g.group && !open.has(x.sessionId));
            return list.length ? <optgroup key={g.group} label={g.label}>{list.map((x) => <option key={x.sessionId} value={`session:${x.sessionId}`} disabled={x.missing}>{label(x)}</option>)}</optgroup> : null;
          })}
          <optgroup label="New"><option value="new">New session in this PR's checkout</option></optgroup>
        </select>
      </label>
      {note && <div className={`note ${warn ? 'warn' : ''}`}>{note}</div>}
    </div>
  );
}

export function toTarget(value: string, sessions: AgentSession[]): SendTarget | null {
  if (value === 'new') return { kind: 'new' };
  if (value.startsWith('term:')) return { kind: 'term', id: value.slice(5) };
  const x = sessions.find((s) => `session:${s.sessionId}` === value);
  return x && x.cwd && !x.missing ? { kind: 'session', sessionId: x.sessionId, cwd: x.cwd, title: (x.summary || x.sessionId).slice(0, 28) } : null;
}
