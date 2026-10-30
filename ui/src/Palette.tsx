// The one palette: ⌘K lists every action and, as you type, files in the whole repo. Repo search,
// the outline, definitions, references and line history reuse it as lists of places.
export type PaletteMode = 'all' | 'search' | 'outline' | 'locs' | 'history';
export interface Row { label: string; sub?: string; kind?: string; line?: number; path?: string; hint?: string; run?: () => void; terms?: string }
export interface PaletteState { mode: PaletteMode; query: string; rows: Row[]; title?: string }

interface Props {
  palette: PaletteState;
  rows: Row[];
  index: number;
  fileCount: number;
  onIndex: (i: number) => void;
  onQuery: (q: string) => void;
  onPick: (r: Row) => void;
  onClose: () => void;
}

const HEADING: Record<PaletteMode, string> = { all: 'open, search, actions', search: 'search repo', outline: 'outline', locs: '', history: 'history' };

export function Palette({ palette, rows, index, fileCount, onIndex, onQuery, onPick, onClose }: Props) {
  const typed = palette.mode === 'all' || palette.mode === 'search' || palette.mode === 'outline';
  const empty = palette.mode === 'all' ? `type a file name, or an action · ${fileCount} files in the repo`
    : palette.mode === 'outline' ? 'no symbols found'
    : palette.query.length < 2 ? 'type at least two characters' : 'no match';
  return (
    <div className="palette" onClick={onClose}>
      <div className="box" onClick={(e) => e.stopPropagation()}>
        <div className="mode">
          <span><b>{HEADING[palette.mode] || palette.title}</b></span>
          {palette.mode === 'history' && <span>{palette.title} · who last touched these lines, at the PR head</span>}
          {palette.mode === 'outline' && <span>{palette.title}</span>}
          {palette.mode === 'locs' && <span>{palette.rows.length} places</span>}
          {palette.mode === 'search' && <span>{palette.rows.length ? `${palette.rows.length} hits` : 'git grep, case-insensitive'}</span>}
        </div>
        {typed && (
          <input autoFocus value={palette.query} aria-label={HEADING[palette.mode]}
            placeholder={palette.mode === 'all' ? 'file name or action…' : palette.mode === 'search' ? 'text to find…' : 'symbol…'}
            onChange={(e) => onQuery(e.target.value)} />
        )}
        <div className="list" role="listbox" aria-label="results">
          {rows.length === 0
            ? <div className="none">{empty}</div>
            : rows.map((r, i) => (
              <div key={`${r.kind ?? ''}:${r.path ?? r.label}:${r.line ?? ''}:${i}`} role="option" aria-selected={i === index}
                className={`row ${i === index ? 'on' : ''} ${r.run ? 'act' : ''}`} onMouseMove={() => { if (i !== index) onIndex(i); }} onClick={() => onPick(r)}>
                {r.kind && <span className="kind">{r.kind}</span>}
                <span className={r.run ? '' : 'text'}>{r.label}</span>
                {r.sub !== undefined && <span className="dir">{r.sub}</span>}
                {r.line !== undefined && <span className="line">{r.line}</span>}
                {r.hint && <kbd>{r.hint}</kbd>}
              </div>
            ))}
        </div>
      </div>
    </div>
  );
}
