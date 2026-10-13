// GitHub-style file tree: nested directories, single-child directories collapsed into one row,
// folders collapsible, each file with its status, counts, kind badge and read mark.
import { useMemo, useState, type ReactElement } from 'react';
import { isNoise, type PrFile } from './api';

interface Dir { name: string; dirs: Map<string, Dir>; files: PrFile[] }

function build(files: PrFile[]): Dir {
  const root: Dir = { name: '', dirs: new Map(), files: [] };
  for (const f of files) {
    const segs = f.path.split('/');
    let d = root;
    for (const s of segs.slice(0, -1)) {
      let n = d.dirs.get(s);
      if (!n) { n = { name: s, dirs: new Map(), files: [] }; d.dirs.set(s, n); }
      d = n;
    }
    d.files.push(f);
  }
  return root;
}

// a/b/c with nothing else inside a or b renders as one row, like GitHub
function compress(d: Dir): Dir {
  const dirs = new Map<string, Dir>();
  for (const [, sub] of d.dirs) {
    let node = compress(sub);
    let name = node.name;
    while (node.files.length === 0 && node.dirs.size === 1) {
      const only = [...node.dirs.values()][0];
      name = `${name}/${only.name}`;
      node = only;
    }
    dirs.set(name, { ...node, name });
  }
  return { ...d, dirs };
}

const BADGE: Partial<Record<PrFile['kind'], string>> = { lock: 'lock', generated: 'gen', snapshot: 'snap', docs: 'docs', config: 'cfg', test: 'test' };

export function Tree({ files, readFiles, current, onPick }: { files: PrFile[]; readFiles: Record<string, string>; current: string | null; onPick: (path: string) => void }) {
  const root = useMemo(() => compress(build(files)), [files]);
  const [closed, setClosed] = useState<Set<string>>(new Set());
  const toggle = (key: string) => setClosed((s) => { const n = new Set(s); n.has(key) ? n.delete(key) : n.add(key); return n; });

  const render = (d: Dir, prefix: string, depth: number): ReactElement[] => {
    const out: ReactElement[] = [];
    const dirs = [...d.dirs.values()].sort((a, b) => a.name.localeCompare(b.name));
    for (const sub of dirs) {
      const key = `${prefix}${sub.name}/`;
      const open = !closed.has(key);
      const all = countFiles(sub);
      const read = countRead(sub, readFiles);
      out.push(
        <div key={key} className={`node dir ${read === all ? 'done' : ''}`} style={{ paddingLeft: 8 + depth * 14 }} onClick={() => toggle(key)}>
          <span className="arrow">{open ? '▾' : '▸'}</span>
          <span className="name">{sub.name}</span>
          <span className="count">{read === all ? '✓' : `${all - read}`}</span>
        </div>
      );
      if (open) out.push(...render(sub, key, depth + 1));
    }
    for (const f of [...d.files].sort((a, b) => a.path.localeCompare(b.path))) {
      const name = f.path.slice(f.path.lastIndexOf('/') + 1);
      const isRead = readFiles[f.path] !== undefined;
      out.push(
        <div key={f.path} className={`node file st-${f.status} ${isRead ? 'read' : ''} ${isNoise(f) ? 'noise' : ''} ${f.path === current ? 'current' : ''}`} style={{ paddingLeft: 8 + depth * 14 }} onClick={() => onPick(f.path)} title={f.oldPath ? `${f.oldPath} → ${f.path}` : f.path}>
          <span className="mark">{isRead ? '✓' : ''}</span>
          <span className="status">{f.status}</span>
          <span className="name">{name}</span>
          {f.wsOnly && <span className="badge">ws</span>}
          {!f.wsOnly && BADGE[f.kind] && <span className="badge">{BADGE[f.kind]}</span>}
          <span className="stat">+{f.adds}/-{f.dels}</span>
        </div>
      );
    }
    return out;
  };

  return <div className="tree">{render(root, '', 0)}</div>;
}

function countFiles(d: Dir): number {
  let n = d.files.length;
  for (const [, s] of d.dirs) n += countFiles(s);
  return n;
}
function countRead(d: Dir, readFiles: Record<string, string>): number {
  let n = d.files.filter((f) => readFiles[f.path] !== undefined).length;
  for (const [, s] of d.dirs) n += countRead(s, readFiles);
  return n;
}
