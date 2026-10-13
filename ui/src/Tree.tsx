// Editor-style file tree: nested directories, single-child directories collapsed into one row,
// folders collapsible. Changed files carry status, counts, a kind badge and a read mark; in repo
// mode unchanged files are listed too, muted, and only the directories holding changes start open.
import { useMemo, useState, type ReactElement } from 'react';
import { isNoise, type PrFile, type Signal } from './api';

interface Dir { name: string; dirs: Map<string, Dir>; files: string[] }

function build(paths: string[]): Dir {
  const root: Dir = { name: '', dirs: new Map(), files: [] };
  for (const path of paths) {
    const segs = path.split('/');
    let d = root;
    for (const s of segs.slice(0, -1)) {
      let n = d.dirs.get(s);
      if (!n) { n = { name: s, dirs: new Map(), files: [] }; d.dirs.set(s, n); }
      d = n;
    }
    d.files.push(path);
  }
  return root;
}

// a/b/c with nothing else inside a or b renders as one row, like GitHub and VS Code
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
const SIG: Record<Signal['kind'], string> = { rewritten: '↻', tests: '−t', deps: '+dep', todo: 'todo', dup: '=', sensitive: '!', owners: '' };

interface Props {
  paths: string[]; // every path to show
  meta: Map<string, PrFile>; // changed files, by path
  readFiles: Record<string, string>;
  changed?: Set<string>; // files whose content changed at the last sync
  signals?: Record<string, Signal[]>; // attention markers, facts only
  current: string | null;
  onPick: (path: string) => void;
  repo?: boolean; // repo mode: start folded except where changes live
}

export function Tree({ paths, meta, readFiles, changed, signals, current, onPick, repo = false }: Props) {
  const root = useMemo(() => compress(build(paths)), [paths]);

  // keys of directories that hold a changed file, so repo mode opens only those
  const changedDirs = useMemo(() => {
    const keys = new Set<string>();
    const walk = (d: Dir, prefix: string) => {
      let hit = d.files.some((f) => meta.has(f));
      for (const [, sub] of d.dirs) if (walk(sub, `${prefix}${sub.name}/`)) hit = true;
      if (hit && prefix) keys.add(prefix);
      return hit;
    };
    walk(root, '');
    return keys;
  }, [root, meta]);

  const [toggled, setToggled] = useState<Set<string>>(new Set());
  const isOpen = (key: string) => (repo ? changedDirs.has(key) : true) !== toggled.has(key);
  const toggle = (key: string) => setToggled((s) => { const n = new Set(s); n.has(key) ? n.delete(key) : n.add(key); return n; });

  const render = (d: Dir, prefix: string, depth: number): ReactElement[] => {
    const out: ReactElement[] = [];
    const dirs = [...d.dirs.values()].sort((a, b) => a.name.localeCompare(b.name));
    for (const sub of dirs) {
      const key = `${prefix}${sub.name}/`;
      const open = isOpen(key);
      const changed = countChanged(sub, meta);
      const read = countRead(sub, meta, readFiles);
      out.push(
        <div key={key} className={`node dir ${changed && read === changed ? 'done' : ''} ${repo && !changed ? 'plain' : ''}`} style={{ paddingLeft: 8 + depth * 14 }} onClick={() => toggle(key)}>
          <span className="arrow">{open ? '▾' : '▸'}</span>
          <span className="name">{sub.name}</span>
          {changed > 0 && <span className="count">{read === changed ? '✓' : `${changed - read}`}</span>}
        </div>
      );
      if (open) out.push(...render(sub, key, depth + 1));
    }
    for (const path of [...d.files].sort((a, b) => a.localeCompare(b))) {
      const f = meta.get(path);
      const name = path.slice(path.lastIndexOf('/') + 1);
      const isRead = f ? readFiles[path] !== undefined : false;
      out.push(
        <div key={path} className={`node file ${f ? `st-${f.status}` : 'plain'} ${isRead ? 'read' : ''} ${f && isNoise(f) ? 'noise' : ''} ${path === current ? 'current' : ''}`} style={{ paddingLeft: 8 + depth * 14 }} onClick={() => onPick(path)} title={f?.oldPath ? `${f.oldPath} → ${path}` : path}>
          <span className="mark">{isRead ? '✓' : ''}</span>
          <span className="status">{f ? f.status : ''}</span>
          <span className="name">{name}</span>
          {f && changed?.has(path) && <span className="badge new">new</span>}
          {f && (signals?.[path] ?? []).filter((x) => x.kind !== 'owners').map((x) => <span key={x.kind} className={`badge sig ${x.kind}`} title={x.note}>{SIG[x.kind]}</span>)}
          {f?.wsOnly && <span className="badge">ws</span>}
          {f && !f.wsOnly && BADGE[f.kind] && <span className="badge">{BADGE[f.kind]}</span>}
          {f && <span className="stat">+{f.adds}/-{f.dels}</span>}
        </div>
      );
    }
    return out;
  };

  return <div className="tree">{render(root, '', 0)}</div>;
}

function countChanged(d: Dir, meta: Map<string, PrFile>): number {
  let n = d.files.filter((f) => meta.has(f)).length;
  for (const [, s] of d.dirs) n += countChanged(s, meta);
  return n;
}
function countRead(d: Dir, meta: Map<string, PrFile>, readFiles: Record<string, string>): number {
  let n = d.files.filter((f) => meta.has(f) && readFiles[f] !== undefined).length;
  for (const [, s] of d.dirs) n += countRead(s, meta, readFiles);
  return n;
}
