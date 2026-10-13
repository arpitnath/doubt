// The first screen: paste a PR URL, or go back to one opened before.
import { useEffect, useState } from 'react';
import { listPrs, openPr, type KnownPr } from './api';

export function Landing({ onOpen }: { onOpen: (key: string) => void }) {
  const [prs, setPrs] = useState<KnownPr[]>([]);
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState<string | null>(null); // the url being opened
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { listPrs().then((r) => setPrs(r.prs)).catch(() => {}); }, []);

  const go = async (target: string) => {
    if (busy) return;
    setError(null);
    setBusy(target);
    try {
      const r = await openPr(target);
      onOpen(r.key);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(null);
    }
  };

  return (
    <div className="landing">
      <div className="box">
        <h1>doubt</h1>
        <p className="sub">Read a pull request one piece at a time. Mark what you understood. Nothing leaves this machine.</p>
        <form onSubmit={(e) => { e.preventDefault(); void go(url); }}>
          <input autoFocus value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://github.com/owner/repo/pull/123" disabled={busy !== null} />
          <button type="submit" disabled={busy !== null || !url.trim()}>{busy ? 'opening…' : 'open'}</button>
        </form>
        {busy && <p className="muted">First time on a repo clones it blob-filtered; 20 to 40 seconds. Later opens take a few.</p>}
        {error && <p className="err">{error}</p>}
        {prs.length > 0 && (
          <div className="recent">
            <div className="label">opened before</div>
            {prs.map((p) => (
              <div key={p.key} className={`pr ${busy === p.url ? 'busy' : ''}`} onClick={() => void go(p.url)}>
                <span className="num">#{p.number}</span>
                <span className="title">{p.title}</span>
                <span className="meta">{p.owner}/{p.repo} · {p.author}</span>
                <span className="progress">{progress(p)}{p.open ? ' · open now' : ''}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function progress(p: KnownPr): string {
  if (!p.files) return 'open to load';
  if (p.read === 0) return `${p.files} file${p.files === 1 ? '' : 's'}, none read`;
  if (p.read >= p.files) return `all ${p.files} file${p.files === 1 ? '' : 's'} read`;
  return `${p.read} of ${p.files} files read`;
}
