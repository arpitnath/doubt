// Three themes as CSS variables on <html data-theme>, remembered per browser. Dim uses the dark
// syntax colors; light uses the light ones.
export type Theme = 'dark' | 'dim' | 'light';
export const THEMES: Theme[] = ['dark', 'dim', 'light'];

export function readTheme(): Theme {
  try {
    const t = localStorage.getItem('doubt.theme');
    if (t === 'dark' || t === 'dim' || t === 'light') return t;
  } catch { /* storage blocked: default */ }
  return 'dark';
}

export function applyTheme(t: Theme): void {
  document.documentElement.dataset.theme = t;
  try { localStorage.setItem('doubt.theme', t); } catch { /* storage blocked: still applied for this page */ }
}

// the terminal draws its own canvas, so it takes the colors as values, not CSS
export function termColors(): { background: string; foreground: string; cursor: string } {
  const s = getComputedStyle(document.documentElement);
  const v = (name: string) => s.getPropertyValue(name).trim();
  return { background: v('--bg'), foreground: v('--text'), cursor: v('--accent') };
}
