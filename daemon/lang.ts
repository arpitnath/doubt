// Code intelligence over a PR checkout, px0's LSP layer in miniature: one TypeScript language
// service per PR, built lazily from the files in the tree. Resolves relative imports and, for a
// monorepo, workspace packages by name through `paths`. Other languages get nothing here yet.
import ts from 'ts5';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, dirname, relative, resolve } from 'node:path';

export interface Loc { path: string; line: number; col: number; text?: string }

const SCRIPT = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
const SKIP = /(^|\/)(node_modules|dist|build|coverage|\.next|out)\//;

export class Lang {
  private service: ts.LanguageService;
  private files = new Map<string, { version: number; text: string }>();
  private names: string[];

  constructor(private dir: string, treePaths: string[]) {
    this.names = treePaths.filter((p) => SCRIPT.test(p) && !SKIP.test(p)).map((p) => join(dir, p));
    const paths = workspacePaths(dir, treePaths);
    const options: ts.CompilerOptions = {
      allowJs: true,
      checkJs: false,
      jsx: ts.JsxEmit.Preserve,
      target: ts.ScriptTarget.ESNext,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      baseUrl: dir,
      paths,
      noEmit: true,
      skipLibCheck: true,
      allowSyntheticDefaultImports: true,
      esModuleInterop: true,
      resolveJsonModule: true
    };
    const read = (f: string) => {
      const have = this.files.get(f);
      if (have) return have.text;
      if (!existsSync(f) || !statSync(f).isFile()) return undefined;
      const text = readFileSync(f, 'utf8');
      this.files.set(f, { version: 1, text });
      return text;
    };
    const host: ts.LanguageServiceHost = {
      getScriptFileNames: () => this.names,
      getScriptVersion: (f) => String(this.files.get(f)?.version ?? 1),
      getScriptSnapshot: (f) => { const t = read(f); return t === undefined ? undefined : ts.ScriptSnapshot.fromString(t); },
      getCurrentDirectory: () => dir,
      getCompilationSettings: () => options,
      getDefaultLibFileName: (o) => ts.getDefaultLibFilePath(o),
      fileExists: (f) => existsSync(f),
      readFile: (f) => read(f),
      readDirectory: ts.sys.readDirectory,
      directoryExists: ts.sys.directoryExists,
      getDirectories: ts.sys.getDirectories
    };
    this.service = ts.createLanguageService(host, ts.createDocumentRegistry());
  }

  private offset(path: string, line: number, col: number): { file: string; pos: number } | null {
    const file = join(this.dir, path);
    const text = this.service.getProgram()?.getSourceFile(file)?.text ?? (existsSync(file) ? readFileSync(file, 'utf8') : null);
    if (text === null || text === undefined) return null;
    let pos = 0;
    for (let i = 1; i < line; i++) { const nl = text.indexOf('\n', pos); if (nl < 0) return null; pos = nl + 1; }
    return { file, pos: pos + Math.max(0, col) };
  }

  private toLoc(fileName: string, span: ts.TextSpan): Loc | null {
    const rel = relative(this.dir, resolve(fileName));
    if (rel.startsWith('..') || fileName.includes('/node_modules/typescript/')) return null; // outside the checkout, e.g. lib.d.ts
    const sf = this.service.getProgram()?.getSourceFile(fileName);
    if (!sf) return null;
    const lc = sf.getLineAndCharacterOfPosition(span.start);
    const lineText = sf.text.split('\n')[lc.line] ?? '';
    return { path: rel, line: lc.line + 1, col: lc.character, text: lineText.trim().slice(0, 160) };
  }

  definitions(path: string, line: number, col: number): Loc[] {
    const at = this.offset(path, line, col);
    if (!at) return [];
    const defs = this.service.getDefinitionAtPosition(at.file, at.pos) ?? [];
    return dedupe(defs.map((d) => this.toLoc(d.fileName, d.textSpan)));
  }

  references(path: string, line: number, col: number): Loc[] {
    const at = this.offset(path, line, col);
    if (!at) return [];
    const refs = this.service.getReferencesAtPosition(at.file, at.pos) ?? [];
    return dedupe(refs.map((r) => this.toLoc(r.fileName, r.textSpan)));
  }
}

function dedupe(locs: Array<Loc | null>): Loc[] {
  const seen = new Set<string>();
  const out: Loc[] = [];
  for (const l of locs) {
    if (!l) continue;
    const k = `${l.path}:${l.line}:${l.col}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(l);
  }
  return out.slice(0, 200);
}

// ponytail: workspace packages by name -> their source dir, from every package.json in the tree.
// Enough for `import x from '@scope/pkg'` in a monorepo; no exports-map parsing.
function workspacePaths(dir: string, treePaths: string[]): Record<string, string[]> {
  const paths: Record<string, string[]> = {};
  for (const p of treePaths) {
    if (!p.endsWith('/package.json') || SKIP.test(p)) continue;
    try {
      const pkg = JSON.parse(readFileSync(join(dir, p), 'utf8')) as { name?: string; main?: string; source?: string; types?: string };
      if (!pkg.name) continue;
      const pkgDir = dirname(p);
      const entry = [pkg.source, pkg.types, 'src/index.ts', 'src/index.tsx', 'src/index.js', 'index.ts', 'index.js', pkg.main]
        .filter((e): e is string => !!e)
        .map((e) => e.replace(/\.(js|cjs|mjs)$/, ''))
        .find((e) => ['', '.ts', '.tsx', '.js', '.jsx', '.d.ts'].some((ext) => existsSync(join(dir, pkgDir, e + ext))));
      if (entry) paths[pkg.name] = [join(pkgDir, entry)];
      paths[`${pkg.name}/*`] = [join(pkgDir, 'src', '*'), join(pkgDir, '*')];
    } catch { /* not a readable package.json */ }
  }
  return paths;
}
