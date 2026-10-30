// The card under a hovered name: what TypeScript knows about it, and what this PR did to it.
import type { HoverInfo } from './api';

interface Props {
  info: HoverInfo | null; // null while loading
  name: string;
  x: number;
  y: number;
  onOpen: (path: string, line?: number) => void;
  onEnter: () => void;
  onLeave: () => void;
}

export function HoverCard({ info, name, x, y, onOpen, onEnter, onLeave }: Props) {
  const left = Math.max(8, Math.min(x, window.innerWidth - 470));
  const short = (p: string) => p.split('/').slice(-3).join('/');
  return (
    <div className="hovercard" style={{ left, top: y }} onMouseEnter={onEnter} onMouseLeave={onLeave} role="tooltip">
      {!info ? <div className="muted">{name}…</div> : (
        <>
          <code className="sig">{info.lib && /^import /.test(info.sig) ? `${name} from '${info.lib}'` : info.sig}</code>
          {info.lib && <div className="lib">From <code>{info.lib}</code>. Its types are not installed in this checkout, so there is no signature to show.</div>}
          {info.doc && <div className="doc">{info.doc}</div>}
          {info.before && (
            <div className="before">
              <div className="label">Signature changed in this PR</div>
              <code>before {info.before}</code>
              <code>after {info.sig}</code>
            </div>
          )}
          <div className="facts">
            {info.builtIn
              ? <span>Built into JavaScript and the browser</span>
              : info.def
                ? <button className="link" onClick={() => onOpen(info.def!.path, info.def!.line)}>Defined at {short(info.def.path)}:{info.def.line}</button>
                : <span>Definition not found in this checkout</span>}
            {!info.builtIn && <span>Used in {info.refs} file{info.refs === 1 ? '' : 's'}{info.changed.length ? `, ${info.changed.length} changed in this PR:` : ''}</span>}
            {info.changed.map((p) => <button key={p} className="link changed" onClick={() => onOpen(p)}>● {short(p)}</button>)}
          </div>
        </>
      )}
    </div>
  );
}
